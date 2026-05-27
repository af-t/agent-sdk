import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
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

    child.on('close', (code) => {
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

function generateJobId() {
  return 'bg-' + crypto.randomBytes(4).toString('hex').slice(0, 5);
}

function runWithSpawnBackground(command, cwd, env, signal, agent) {
  const id = generateJobId();
  const dir = agent._resolveBackgroundLogDir();
  const logPath = path.join(dir, `background-${id}.log`);
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  const child = spawn('bash', ['-c', 'exec 2>&1; ' + command], { cwd, env });
  child.stdout.pipe(stream);

  const job = {
    id,
    kind: 'bash',
    child,
    logPath,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    status: 'running',
    reason: 'explicit',
  };
  agent.backgroundJobs.set(id, job);

  child.on('close', (code) => {
    stream.end();
    job.endedAt = Date.now();
    job.exitCode = code;
    job.status = code === 0 ? 'exited' : code === null ? 'killed' : 'crashed';
    agent._fireBackgroundExit({
      id,
      kind: 'bash',
      exitCode: code,
      durationMs: job.endedAt - job.startedAt,
      status: job.status,
      logPath,
    });
  });

  child.on('error', (err) => {
    stream.end();
    job.endedAt = Date.now();
    job.status = 'crashed';
    job.exitCode = -1;
    agent._fireBackgroundExit({
      id,
      kind: 'bash',
      exitCode: -1,
      durationMs: job.endedAt - job.startedAt,
      status: 'crashed',
      error: err.message,
      logPath,
    });
  });

  if (signal) {
    signal.addEventListener(
      'abort',
      () => {
        try {
          child.kill('SIGTERM');
        } catch {}
      },
      { once: true },
    );
  }

  return { id, logPath, pid: child.pid };
}

function runWithPtyBackground(command, cwd, env, signal, agent) {
  const id = generateJobId();
  const dir = agent._resolveBackgroundLogDir();
  const logPath = path.join(dir, `background-${id}.log`);
  const stream = fs.createWriteStream(logPath, { flags: 'a' });

  let ptyProcess;
  try {
    ptyProcess = _ptyModule.spawn('bash', ['-c', command], {
      name: 'xterm-color',
      cols: 80,
      rows: 24,
      cwd,
      env,
    });
  } catch (err) {
    stream.end();
    throw err;
  }

  ptyProcess.onData((d) => stream.write(d));

  const job = {
    id,
    kind: 'bash',
    child: ptyProcess,
    logPath,
    startedAt: Date.now(),
    endedAt: null,
    exitCode: null,
    status: 'running',
    reason: 'explicit',
  };
  agent.backgroundJobs.set(id, job);

  ptyProcess.onExit(({ exitCode, signal: sig }) => {
    stream.end();
    job.endedAt = Date.now();
    job.exitCode = exitCode;
    job.status = exitCode === 0 ? 'exited' : sig ? 'killed' : 'crashed';
    agent._fireBackgroundExit({
      id,
      kind: 'bash',
      exitCode,
      durationMs: job.endedAt - job.startedAt,
      status: job.status,
      logPath,
    });
  });

  if (signal) {
    signal.addEventListener(
      'abort',
      () => {
        try {
          ptyProcess.kill('SIGTERM');
        } catch {}
      },
      { once: true },
    );
  }

  return { id, logPath, pid: ptyProcess.pid };
}

export const name = 'Bash';
export const description =
  'Execute a shell command. Use this for system operations that do not have a specialized tool, such as running tests, performing builds, or using complex CLI utilities. Side effect: executes arbitrary shell commands. The agent may issue multiple tool calls in one turn that run concurrently — do not request parallel calls that mutate the same files or processes.';
export const input_schema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command to execute' },
    cwd: { type: 'string', description: 'Working directory' },
    env: { type: 'object', description: 'Environment variables' },
    timeout: { type: 'number', description: 'Timeout in ms (default 300000)' },
    background: {
      type: 'boolean',
      description:
        'Start the command in the background. Returns immediately with a job ID and log path; the agent receives an exit notification when the process finishes.',
    },
    on_timeout: {
      type: 'string',
      enum: ['kill', 'background'],
      description:
        "Action when the timeout fires: 'kill' aborts the process (original behavior), 'background' detaches it into a background job. Default 'background'.",
    },
  },
  required: ['command'],
};

export const execute = async (
  {
    command,
    cwd = process.cwd(),
    env = process.env,
    timeout = 300000,
    background = false,
    on_timeout: _on_timeout = 'background',
  },
  ctx = {},
) => {
  const signal = ctx.signal;
  const restricted = ctx.agent?.restricted !== false;

  if (signal?.aborted) {
    throw new Error('Bash execution aborted before start');
  }

  if (restricted) {
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
  }

  let safeEnv;
  if (restricted) {
    safeEnv = {};
    for (const key of SAFE_ENV_KEYS) {
      if (key in process.env) safeEnv[key] = process.env[key];
    }
    if (env !== process.env) {
      Object.assign(safeEnv, stripSecrets(env));
    }
  } else {
    // Trust mode: passthrough full process.env, merge user-supplied env raw.
    safeEnv = { ...process.env };
    if (env !== process.env) Object.assign(safeEnv, env);
  }

  const ptyMod = await getPty();
  if (ptyMod) _ptyModule = ptyMod;

  if (background) {
    if (!ctx.agent) {
      throw new Error('Bash background mode requires ctx.agent (an Agent instance).');
    }
    const info = ptyMod
      ? runWithPtyBackground(command, cwd, safeEnv, signal, ctx.agent)
      : runWithSpawnBackground(command, cwd, safeEnv, signal, ctx.agent);
    return `Started in background.\nJob ID: ${info.id} (kind: bash)\nLog: ${info.logPath}\nPID: ${info.pid ?? 'n/a'}\nUse Remind({ wait_ms, watch: ['${info.id}'] }) to wait/peek, or Read the log.`;
  }

  if (ptyMod) {
    return runWithPty(command, cwd, safeEnv, timeout, signal);
  }

  logger.debug('node-pty unavailable, falling back to spawn');
  return runWithSpawn(command, cwd, safeEnv, timeout, signal);
};
