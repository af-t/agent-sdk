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

const SIGKILL_GRACE_MS = 2000;

// spawn fallback (used when node-pty is unavailable)

function runWithSpawn(command, cwd, env, timeout, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('bash', ['-c', 'exec 2>&1; ' + command], {
      cwd,
      env,
      timeout,
    });
    let output = '';
    let aborted = false;
    let killTimer;

    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {}
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, SIGKILL_GRACE_MS);
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (data) => {
      output += data;
    });

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Execution timed out after ${timeout}ms\n\nPartial Output:\n${output}`));
    }, timeout);

    child.on('exit', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new Error(`Bash execution aborted\n\nPartial Output:\n${output}`));
        return;
      }
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
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

// PTY mode (primary, uses node-pty)

function runWithPty(command, cwd, env, timeout, signal) {
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
    let aborted = false;
    let killTimer;

    const onAbort = () => {
      aborted = true;
      try {
        ptyProcess.kill('SIGTERM');
      } catch {}
      killTimer = setTimeout(() => {
        try {
          ptyProcess.kill('SIGKILL');
        } catch {}
      }, SIGKILL_GRACE_MS);
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    const timer = setTimeout(() => {
      ptyProcess.kill();
      reject(new Error(`Execution timed out after ${timeout}ms\n\nPartial Output:\n${output}`));
    }, timeout);

    ptyProcess.onData((data) => {
      output += data;
    });

    ptyProcess.onExit(({ exitCode, signal: exitSignal }) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new Error(`Bash execution aborted\n\nPartial Output:\n${output}`));
        return;
      }
      if (exitCode !== 0) {
        const msg = output
          ? `Process exited with code ${exitCode}${exitSignal ? ' (signal ' + exitSignal + ')' : ''}\n\nOutput:\n${output}`
          : `Process exited with code ${exitCode}${exitSignal ? ' and signal ' + exitSignal : ''}`;
        reject(new Error(msg));
      } else {
        resolve(output);
      }
    });
  });
}

export const name = 'Bash';
export const parallelSafe = false;
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

export const execute = async ({ command, cwd = process.cwd(), env = process.env, timeout = 300000 }, ctx = {}) => {
  const signal = ctx.signal;

  if (signal?.aborted) {
    throw new Error('Bash execution aborted before start');
  }

  const blocked = isBlocked(command);
  if (blocked) {
    throw new Error(
      `BLOCKED: Command matches blocked pattern '${blocked}'. This command is not allowed for safety reasons.`,
    );
  }

  const suspicious = hasSuspiciousPattern(command);
  if (suspicious) {
    logger.warn(`Suspicious command pattern detected: ${suspicious}. Proceeding but this may be unsafe.`);
  }

  const safeEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (key in process.env) safeEnv[key] = process.env[key];
  }
  if (env !== process.env) {
    Object.assign(safeEnv, stripSecrets(env));
  }

  const ptyMod = await getPty();
  if (ptyMod) {
    _ptyModule = ptyMod;
    return runWithPty(command, cwd, safeEnv, timeout, signal);
  }

  logger.debug('node-pty unavailable, falling back to spawn');
  return runWithSpawn(command, cwd, safeEnv, timeout, signal);
};
