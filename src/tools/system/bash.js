import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import logger from '../../core/logger.js';
import { stripUnsafeEnv } from '../../core/utils.js';

// Lazy-loaded PTY module — may be unavailable on platforms without native build support
let _ptyModule = null;

async function getPty() {
  if (_ptyModule === null) {
    // node-pty data loss under Bun
    if (process.versions.bun) {
      _ptyModule = false;
      return _ptyModule;
    }
    try {
      const pty = await import('node-pty');
      // Probe if node-pty actually works and produces output in this environment
      const works = await new Promise((resolve) => {
        try {
          const proc = pty.spawn('echo', ['1'], {
            cols: 80,
            rows: 24,
          });
          let hasData = false;
          const timer = setTimeout(() => {
            try {
              proc.kill();
            } catch {}
            resolve(false);
          }, 1000);
          proc.onData(() => {
            hasData = true;
          });
          proc.onExit(({ exitCode }) => {
            clearTimeout(timer);
            resolve(hasData && exitCode === 0);
          });
        } catch {
          resolve(false);
        }
      });

      if (works) {
        _ptyModule = pty;
      } else {
        logger.warn(
          'node-pty is available but failed to execute commands or produce output; falling back to child_process.spawn',
        );
        _ptyModule = false;
      }
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
  'PAGER',
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
  '> /dev/mem',
  '> /dev/kmem',
  '> /dev/port',
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

// Space out pipe/redirect operators so glued forms (`x>/dev/sda`, `x|bash`) still match
function normalizeCommand(command) {
  return command
    .replace(/([|<>])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Patterns normalized the same way as input, paired with the raw form for error text
const NORMALIZED_BLOCKED = BLOCKED_COMMANDS.map((raw) => ({ raw, norm: normalizeCommand(raw) }));

// rm with recursive + force flags (any order/spelling) aimed at / ~ or wildcard root
function isCatastrophicRm(normalized) {
  if (!/(^|\s)rm(\s|$)/.test(normalized)) return false;
  const recursive = /(^|\s)(-[a-z]*r[a-z]*|--recursive)(\s|$)/.test(normalized);
  const force = /(^|\s)(-[a-z]*f[a-z]*|--force)(\s|$)/.test(normalized);
  if (!recursive || !force) return false;
  return /--no-preserve-root/.test(normalized) || /(^|\s)(\/\*|\/|~)(\s|$)/.test(normalized);
}

// A shell reading a script via input redirection: `bash < file` (not a heredoc)
const SHELL_REDIRECT_IN = /(^|\s)(sh|bash|zsh|ksh|dash|csh|tcsh)\s+<\s+(?!<)/;

function isBlocked(command) {
  const normalized = normalizeCommand(command);
  for (const { raw, norm } of NORMALIZED_BLOCKED) {
    if (normalized.includes(norm)) return raw;
  }
  if (isCatastrophicRm(normalized)) return 'rm with recursive+force on root/home';
  if (SHELL_REDIRECT_IN.test(normalized)) return 'redirecting a file into a shell';
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

function getExitStatus(code, signal) {
  if (code === 0) return 'exited';
  if (code === null || signal) return 'killed';
  return 'crashed';
}

function setupBackgroundJob(agent, child, startedAt, reason, kind = 'bash') {
  const id = generateJobId();
  const dir = agent._resolveBackgroundLogDir();
  const logPath = path.join(dir, `background-${id}.log`);
  const stream = fs.createWriteStream(logPath, { flags: 'a' });

  const job = {
    id,
    kind,
    child,
    logPath,
    startedAt,
    endedAt: null,
    exitCode: null,
    status: 'running',
    reason,
  };
  agent.backgroundJobs.set(id, job);

  const handleExit = (exitCode, status) => {
    stream.end();
    job.endedAt = Date.now();
    job.exitCode = exitCode;
    job.status = status;
    agent._fireBackgroundExit({
      id,
      kind,
      exitCode,
      durationMs: job.endedAt - job.startedAt,
      status,
      logPath,
    });
  };

  return { id, logPath, stream, handleExit, job };
}

function handleForegroundExit({
  detachedToBackground,
  timer,
  killTimer,
  signal,
  onAbort,
  aborted,
  output,
  exitCode,
  exitSignal,
  resolve,
  reject,
}) {
  if (detachedToBackground) return;
  clearTimeout(timer);
  clearTimeout(killTimer);
  if (signal) signal.removeEventListener('abort', onAbort);
  if (aborted) {
    reject(new Error(`Bash execution aborted\n\nPartial Output:\n${output}`));
    return;
  }
  if (exitCode !== 0) {
    const signalMsg = exitSignal ? ` (signal ${exitSignal})` : '';
    const msg = output
      ? `Process exited with code ${exitCode}${signalMsg}\n\nOutput:\n${output}`
      : `Process exited with code ${exitCode}${exitSignal ? ' and signal ' + exitSignal : ''}`;
    reject(new Error(msg));
  } else {
    resolve(output);
  }
}

function runWithSpawn(command, cwd, env, timeout, signal, agent) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn('bash', ['-c', 'exec 2>&1; ' + command], {
      cwd,
      env,
    });
    let output = '';
    let aborted = false;
    let killTimer;
    let detachedToBackground = false;

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
      if (agent) {
        detachedToBackground = true;
        const { id, logPath, stream, handleExit } = setupBackgroundJob(agent, child, startedAt, 'timeout');
        stream.write(output);
        // stderr is folded into stdout at the shell level (exec 2>&1), so only stdout carries output
        child.stdout.removeAllListeners('data');
        child.stdout.pause();
        child.stdout.pipe(stream);
        child.on('close', (code) => {
          handleExit(code, getExitStatus(code, null));
        });
        resolve(
          `Command exceeded timeout (${timeout}ms) — transitioned to background.\n` +
            `Job ID: ${id}\nLog: ${logPath}\n` +
            `Output so far (first 4KB):\n${output.slice(0, 4096)}`,
        );
      } else {
        logger.warn('Bash timeout cannot detach to background without ctx.agent; killing the process');
        child.kill();
        reject(new Error(`Execution timed out after ${timeout}ms\n\nPartial Output:\n${output}`));
      }
    }, timeout);

    child.on('close', (code) => {
      handleForegroundExit({
        detachedToBackground,
        timer,
        killTimer,
        signal,
        onAbort,
        aborted,
        output,
        exitCode: code,
        exitSignal: null,
        resolve,
        reject,
      });
    });

    child.on('error', (err) => {
      if (detachedToBackground) return;
      clearTimeout(timer);
      clearTimeout(killTimer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
  });
}

// PTY mode (primary, uses node-pty)

function runWithPty(command, cwd, env, timeout, signal, agent) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
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
    let detachedToBackground = false;

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
      if (agent) {
        detachedToBackground = true;
        const { id, logPath, stream, handleExit } = setupBackgroundJob(agent, ptyProcess, startedAt, 'timeout');
        stream.write(output);
        // Stop accumulating into output; pipe remaining data to the log stream.
        dataDisposer.dispose();
        ptyProcess.onData((d) => stream.write(d));
        ptyProcess.onExit(({ exitCode, signal: sig }) => {
          handleExit(exitCode, getExitStatus(exitCode, sig));
        });
        resolve(
          `Command exceeded timeout (${timeout}ms) — transitioned to background.\n` +
            `Job ID: ${id}\nLog: ${logPath}\n` +
            `Output so far (first 4KB):\n${output.slice(0, 4096)}`,
        );
      } else {
        logger.warn('Bash timeout cannot detach to background without ctx.agent; killing the process');
        ptyProcess.kill();
        reject(new Error(`Execution timed out after ${timeout}ms\n\nPartial Output:\n${output}`));
      }
    }, timeout);

    const dataDisposer = ptyProcess.onData((data) => {
      output += data;
    });

    ptyProcess.onExit(({ exitCode, signal: exitSignal }) => {
      handleForegroundExit({
        detachedToBackground,
        timer,
        killTimer,
        signal,
        onAbort,
        aborted,
        output,
        exitCode,
        exitSignal,
        resolve,
        reject,
      });
    });
  });
}

function generateJobId() {
  return 'bg-' + crypto.randomBytes(4).toString('hex').slice(0, 5);
}

function runWithSpawnBackground(command, cwd, env, signal, agent) {
  const startedAt = Date.now();
  const child = spawn('bash', ['-c', 'exec 2>&1; ' + command], { cwd, env });
  const { id, logPath, stream, handleExit, job } = setupBackgroundJob(agent, child, startedAt, 'explicit');
  child.stdout.pipe(stream);

  child.on('close', (code) => {
    handleExit(code, getExitStatus(code, null));
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
  const startedAt = Date.now();
  const ptyProcess = _ptyModule.spawn('bash', ['-c', command], {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd,
    env,
  });

  const { id, logPath, stream, handleExit } = setupBackgroundJob(agent, ptyProcess, startedAt, 'explicit');

  try {
    ptyProcess.onData((d) => stream.write(d));
  } catch (err) {
    stream.end();
    agent.backgroundJobs.delete(id);
    try {
      ptyProcess.kill();
    } catch {}
    throw err;
  }

  try {
    ptyProcess.onExit(({ exitCode, signal: sig }) => {
      handleExit(exitCode, getExitStatus(exitCode, sig));
    });
  } catch (err) {
    stream.end();
    agent.backgroundJobs.delete(id);
    try {
      ptyProcess.kill();
    } catch {}
    throw err;
  }

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
  },
  required: ['command'],
};

export const execute = async (
  { command, cwd = process.cwd(), env = process.env, timeout = 300000, background = false },
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
      Object.assign(safeEnv, stripUnsafeEnv(env));
    }
  } else {
    // Trust mode: passthrough full process.env, merge user-supplied env raw.
    safeEnv = { ...process.env };
    if (env !== process.env) Object.assign(safeEnv, env);
  }

  // Prevent git/etc pagination hang in interactive pseudo-terminals by defaulting to PAGER=cat
  if (!safeEnv.PAGER) {
    safeEnv.PAGER = 'cat';
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
    return `Started in background.\nJob ID: ${info.id} (kind: bash)\nLog: ${info.logPath}\nPID: ${info.pid ?? 'n/a'}\nExit will be reported automatically. Read the log, or use Wakeup({ delay_ms | at, watch: ['${info.id}'] }) only for a timed check-in with a log tail.`;
  }

  if (ptyMod) {
    return runWithPty(command, cwd, safeEnv, timeout, signal, ctx.agent);
  }

  logger.debug('node-pty unavailable, falling back to spawn');
  return runWithSpawn(command, cwd, safeEnv, timeout, signal, ctx.agent);
};
