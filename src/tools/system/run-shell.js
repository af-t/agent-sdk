import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeChildEnvironment } from '../../support/environment.js';

// node-pty is optional and may be unavailable without native build support.
let _ptyModule = null;

async function getPty(logger) {
  if (_ptyModule === null) {
    // Bun's node-pty integration can drop output, so Bun uses child_process.
    if (process.versions.bun) {
      _ptyModule = false;
      return _ptyModule;
    }
    try {
      const pty = await import('node-pty');
      // Import success does not prove that this native module can spawn a PTY.
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
        logger?.warn({ component: 'runShell' }, 'node-pty is unavailable, so runShell is using a child process');
        _ptyModule = false;
      }
    } catch {
      _ptyModule = false;
    }
  }
  return _ptyModule;
}

// In restricted mode, child processes inherit only these environment variables.
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

// Restricted mode blocks these command forms.
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
  'echo "*/1 * * * *"', // cron persistence attempt
];

// Restricted mode warns about these command forms without blocking them.
const SUSPICIOUS_PATTERNS = [
  /\b(kill|pkill|killall)\b/,
  /\bsudo\b/,
  /\bchown\b/,
  /\bchmod\s+[0-7]{3,4}\b/,
  /\b(wget|curl)\s+/,
  />\s*\/dev\//,
  /\|&\s*$/, // background pipe
];

// Spacing pipe and redirect operators lets glued forms such as `x>/dev/sda` still match.
function normalizeCommand(command) {
  return command
    .replace(/([|<>])/g, ' $1 ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

// Each pattern keeps its raw form for errors and its normalized form for matching.
const NORMALIZED_BLOCKED = BLOCKED_COMMANDS.map((raw) => ({ raw, norm: normalizeCommand(raw) }));

// Recursive force deletion aimed at root, home, or a root wildcard is catastrophic.
function isCatastrophicRm(normalized) {
  if (!/(^|\s)rm(\s|$)/.test(normalized)) return false;
  const recursive = /(^|\s)(-[a-z]*r[a-z]*|--recursive)(\s|$)/.test(normalized);
  const force = /(^|\s)(-[a-z]*f[a-z]*|--force)(\s|$)/.test(normalized);
  if (!recursive || !force) return false;
  return /--no-preserve-root/.test(normalized) || /(^|\s)(\/\*|\/|~)(\s|$)/.test(normalized);
}

// Input redirection can make a shell execute a file as a script.
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

// child_process is the fallback when node-pty is unavailable.

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
  agent.backgroundJobs.register(job);

  // The emitted `signal` follows Node's child_process convention: whatever
  // terminated the process, or null when it exited on its own. The two sources
  // spell "no signal" differently (spawn reports null, node-pty reports 0), so
  // both are normalized to null.
  const handleExit = (exitCode, status, exitSignal) => {
    stream.end();
    job.endedAt = Date.now();
    job.exitCode = exitCode;
    job.status = status;
    agent._fireBackgroundExit({
      id,
      kind,
      status,
      startedAt: job.startedAt,
      finishedAt: job.endedAt,
      exitCode,
      signal: exitSignal || null,
      durationMs: job.endedAt - job.startedAt,
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
    reject(new Error(`runShell execution aborted\n\nPartial Output:\n${output}`));
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

function runWithSpawn(command, cwd, env, timeout, signal, agent, logger) {
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
        // The shell redirects stderr into stdout before this listener runs.
        child.stdout.removeAllListeners('data');
        child.stdout.pause();
        child.stdout.pipe(stream);
        child.on('close', (code, sig) => {
          handleExit(code, getExitStatus(code, sig), sig);
        });
        resolve(
          `Command exceeded timeout (${timeout}ms), transitioned to background.\n` +
            `Job ID: ${id}\nLog: ${logPath}\n` +
            `Output so far (first 4KB):\n${output.slice(0, 4096)}`,
        );
      } else {
        logger?.warn(
          { component: 'runShell', timeout },
          'runShell cannot detach without an agent, so it is stopping the timed-out process',
        );
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

// node-pty provides the preferred interactive path.

function runWithPty(command, cwd, env, timeout, signal, agent, logger) {
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
          handleExit(exitCode, getExitStatus(exitCode, sig), sig);
        });
        resolve(
          `Command exceeded timeout (${timeout}ms), transitioned to background.\n` +
            `Job ID: ${id}\nLog: ${logPath}\n` +
            `Output so far (first 4KB):\n${output.slice(0, 4096)}`,
        );
      } else {
        logger?.warn(
          { component: 'runShell', timeout },
          'runShell cannot detach without an agent, so it is stopping the timed-out process',
        );
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

  child.on('close', (code, sig) => {
    handleExit(code, getExitStatus(code, sig), sig);
  });

  child.on('error', (err) => {
    stream.end();
    job.endedAt = Date.now();
    job.status = 'crashed';
    job.exitCode = -1;
    agent._fireBackgroundExit({
      id,
      kind: 'bash',
      status: 'crashed',
      startedAt: job.startedAt,
      finishedAt: job.endedAt,
      exitCode: -1,
      // The process failed to start, so nothing signalled it.
      signal: null,
      durationMs: job.endedAt - job.startedAt,
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
    agent.backgroundJobs.remove(id);
    try {
      ptyProcess.kill();
    } catch {}
    throw err;
  }

  try {
    ptyProcess.onExit(({ exitCode, signal: sig }) => {
      handleExit(exitCode, getExitStatus(exitCode, sig), sig);
    });
  } catch (err) {
    stream.end();
    agent.backgroundJobs.remove(id);
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

const description =
  'Run a shell command in the foreground or background. Use a dedicated tool when one exists. Tool calls in the same turn can run concurrently, so do not submit commands that may modify the same files or processes.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    command: { type: 'string', description: 'Shell command to run.' },
    workingDirectory: { type: 'string', description: 'Working directory.' },
    env: { type: 'object', description: 'Additional environment variables.' },
    timeout: { type: 'number', description: 'Timeout in milliseconds. The default is 300000.' },
    background: {
      type: 'boolean',
      description:
        'Return immediately with a job ID and log path. The agent receives an exit event when the process finishes.',
    },
  },
  required: ['command'],
};

const execute = async ({ command, workingDirectory, env, timeout = 300000, background = false }, ctx = {}) => {
  const { agent, signal, logger } = ctx;
  const config = agent?.config ?? {};
  const cwd = workingDirectory ?? config.workingDirectory ?? process.cwd();
  const baseEnvironment = config.environment ?? {};
  const requestedEnvironment = env ?? baseEnvironment;
  const restricted = ctx.agent?.restricted !== false;

  if (signal?.aborted) {
    throw new Error('runShell execution aborted before start');
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
      logger?.warn({ component: 'runShell', rule: String(suspicious) }, 'Suspicious command pattern detected');
    }
  }

  let safeEnv;
  if (restricted) {
    safeEnv = {};
    for (const key of SAFE_ENV_KEYS) {
      if (key in baseEnvironment) safeEnv[key] = baseEnvironment[key];
    }
    if (requestedEnvironment !== baseEnvironment) {
      Object.assign(safeEnv, sanitizeChildEnvironment(requestedEnvironment));
    }
  } else {
    safeEnv = { ...baseEnvironment };
    if (requestedEnvironment !== baseEnvironment) Object.assign(safeEnv, requestedEnvironment);
  }

  // PAGER=cat prevents interactive pagers from waiting for input in a PTY.
  if (!safeEnv.PAGER) {
    safeEnv.PAGER = 'cat';
  }

  const ptyMod = await getPty(logger);
  if (ptyMod) _ptyModule = ptyMod;

  if (background) {
    if (!ctx.agent) {
      throw new Error('runShell background mode requires ctx.agent (an Agent instance).');
    }
    const info = ptyMod
      ? runWithPtyBackground(command, cwd, safeEnv, signal, ctx.agent)
      : runWithSpawnBackground(command, cwd, safeEnv, signal, ctx.agent);
    return `Started in background.\nJob ID: ${info.id} (kind: bash)\nLog: ${info.logPath}\nPID: ${info.pid ?? 'n/a'}\nExit will be reported automatically. Use readFile for the log, or scheduleWakeup({ delayMs | at, watch: ['${info.id}'] }) for a timed check-in with a log tail.`;
  }

  if (ptyMod) {
    return runWithPty(command, cwd, safeEnv, timeout, signal, agent, logger);
  }

  logger?.debug({ component: 'runShell' }, 'node-pty is unavailable, so runShell is using a child process');
  return runWithSpawn(command, cwd, safeEnv, timeout, signal, agent, logger);
};

export const runShell = { name: 'runShell', description, inputSchema, execute };
