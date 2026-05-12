import { spawn } from 'node:child_process';
import logger from '../../core/logger.js';
import { stripSecrets } from '../../core/utils.js';

// Lazy-loaded PTY module — may be unavailable on platforms without native build support
let _ptyModule = null;

async function getPty() {
  if (_ptyModule === null) {
    try {
      _ptyModule = await import('node-pty');
    } catch {
      _ptyModule = false;
    }
  }
  return _ptyModule;
}

// Whitelist of safe environment variables to pass to child processes
const SAFE_ENV_KEYS = [
  'HOME',
  'USER',
  'PATH',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'PWD',
  'OLDPWD',
  'NODE_PATH',
  'TMPDIR',
  'LD_PRELOAD',
  'PREFIX',
];

// Destruction-level commands that are ALWAYS blocked
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'rm -rf /*',
  'rm -rf ~',
  'rm -rf .*',
  'dd if=',
  'mkfs',
  'mkswap',
  ':(){ :|:& };:', // fork bomb
  'chmod 777 /',
  'chmod -R 777 /',
  '> /dev/sda',
  '> /dev/hda',
  '> /dev/nvme',
  '> /dev/mmc',
  'shutdown',
  'reboot',
  'poweroff',
  'halt',
  'init 0',
  'init 6',
  '| sh',
  '| bash',
  '| zsh',
  '| ksh',
  'wget',
  'curl',
  'echo "*/1 * * * *"', // cron backdoor attempt
];

// Suspicious operations that should be warned (but not outright blocked)
const SUSPICIOUS_PATTERNS = [
  /\b(kill|pkill|killall)\b/,
  /\bsudo\b/,
  /\bchown\b/,
  /\bchmod\s+[0-7]{3,4}\b/,
  /\b(wget|curl)\s+/,
  />\s*\/dev\//,
  /\|&\s*$/, // background pipe
];

function isBlocked(command) {
  const normalized = command.replace(/\s+/g, ' ').toLowerCase().trim();
  for (const blocked of BLOCKED_COMMANDS) {
    if (normalized.includes(blocked)) return blocked;
  }
  if (/\b(eval|exec|source)\s+.*(\/etc\/|\.ssh|\.env)/.test(normalized)) {
    return 'eval/exec/source on sensitive path';
  }
  return null;
}

function hasSuspiciousPattern(command) {
  const normalized = command.replace(/\s+/g, ' ').toLowerCase().trim();
  for (const pattern of SUSPICIOUS_PATTERNS) {
    if (pattern.test(normalized)) return pattern;
  }
  return null;
}

// spawn fallback (used when node-pty is unavailable)

function runWithSpawn(command, cwd, env, timeout) {
  return new Promise((resolve, reject) => {
    // Redirect stderr (2) to stdout (1) via stdio option
    const child = spawn('bash', ['-c', 'exec 2>&1; ' + command], {
      cwd,
      env,
      timeout,
    });
    let output = '';

    child.stdout.on('data', (data) => {
      output += data;
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Execution timed out after ${timeout}ms\n\nPartial Output:\n${output}`));
    }, timeout);

    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = output
          ? `Process exited with code ${code}\n\nOutput:\n${output}`
          : `Process exited with code ${code}`;
        reject(new Error(msg));
      } else {
        resolve(output);
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// PTY mode (primary, uses node-pty)

function runWithPty(command, cwd, env, timeout) {
  return new Promise((resolve, reject) => {
    let ptyProcess;
    try {
      ptyProcess = _ptyModule.spawn('bash', ['-c', command], {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        cwd,
        env,
      });
    } catch (err) {
      reject(err);
      return;
    }

    let output = '';
    const timer = setTimeout(() => {
      ptyProcess.kill();
      reject(new Error(`Execution timed out after ${timeout}ms\n\nPartial Output:\n${output}`));
    }, timeout);

    ptyProcess.onData((data) => {
      output += data;
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      if (exitCode !== 0) {
        const msg = output
          ? `Process exited with code ${exitCode}${signal ? ' (signal ' + signal + ')' : ''}\n\nOutput:\n${output}`
          : `Process exited with code ${exitCode}${signal ? ' and signal ' + signal : ''}`;
        reject(new Error(msg));
      } else {
        resolve(output);
      }
    });
  });
}

export const name = 'Bash';
export const description =
  'Execute a shell command. Use this for system operations that do not have a specialized tool, such as running tests, performing builds, or using complex CLI utilities.';
export const input_schema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command to execute' },
    cwd: { type: 'string', description: 'Working directory' },
    env: { type: 'object', description: 'Environment variables' },
    timeout: { type: 'number', description: 'Timeout in ms (default 300000)' },
  },
  required: ['command'],
};

export const execute = async ({ command, cwd = process.cwd(), env = process.env, timeout = 300000 }) => {
  // Check for blocked commands
  const blocked = isBlocked(command);
  if (blocked) {
    throw new Error(
      `BLOCKED: Command matches blocked pattern '${blocked}'. This command is not allowed for safety reasons.`,
    );
  }

  // Warn about suspicious patterns
  const suspicious = hasSuspiciousPattern(command);
  if (suspicious) {
    logger.warn(`Suspicious command pattern detected: ${suspicious}. Proceeding but this may be unsafe.`);
  }

  // Sanitize environment
  const safeEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (key in process.env) safeEnv[key] = process.env[key];
  }
  if (env !== process.env) {
    Object.assign(safeEnv, stripSecrets(env));
  }

  // Try PTY first, fall back to spawn if node-pty unavailable
  const ptyMod = await getPty();
  if (ptyMod) {
    _ptyModule = ptyMod;
    return runWithPty(command, cwd, safeEnv, timeout);
  }

  logger.debug('node-pty unavailable, falling back to spawn');
  return runWithSpawn(command, cwd, safeEnv, timeout);
};
