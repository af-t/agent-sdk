import crypto from 'node:crypto';
import fs from 'node:fs';

// How long a killed process is given to exit on SIGTERM before SIGKILL.
export const BG_KILL_GRACE_MS = 2000;

const DEFAULT_TAIL_BYTES = 4096;

function generateJobId() {
  return 'bg-' + crypto.randomBytes(4).toString('hex').slice(0, 5);
}

function tailFile(logPath, bytes) {
  try {
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(logPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch (err) {
    return `(unable to tail: ${err.message})`;
  }
}

function indent(text) {
  return text
    .split('\n')
    .map((line) => '    ' + line)
    .join('\n');
}

// Send SIGTERM, then SIGKILL once the grace period passes. Resolves as soon as
// the child reports its exit, or after the SIGKILL, whichever comes first.
// `unref` keeps a pending grace timer from holding the process open, which is
// what a single kill wants and a shutdown that waits for the result does not.
function terminateChild(child, { unref = false } = {}) {
  try {
    child.kill('SIGTERM');
  } catch {}
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {}
      resolve();
    }, BG_KILL_GRACE_MS);
    if (unref && typeof timer.unref === 'function') timer.unref();
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    if (typeof child.on === 'function') child.on('exit', onExit);
    else if (typeof child.onExit === 'function') child.onExit(onExit);
  });
}

// This registry owns detached shell commands, delegated subagents, and wake-up
// timers started by the agent. Jobs are registered by
// whoever spawned them and stay owned here until they exit or are killed, so
// nothing outside this class can add or drop an entry behind its back.
//
// Exit events are reported back through `reportExit`. Raw listeners see every
// event as it happens; the queue behind `drainExitEvents` is what the run loop
// folds into the conversation. `isBusy` tells this class that a run loop is
// active, in which case the loop drains the queue itself and the persistent
// listeners stay quiet until it finishes.
export class BackgroundJobs {
  #jobs = new Map();
  #exitListeners = new Set();
  #rawListeners = new Set();
  #pendingExits = [];
  #logDirectory;
  #resolvedLogDirectory = null;
  #isBusy;

  constructor({ logger, logDirectory, isBusy } = {}) {
    this.logger = logger.child({ component: 'backgroundJobs' });
    this.#logDirectory = logDirectory;
    this.#isBusy = typeof isBusy === 'function' ? isBusy : () => false;
  }

  // The log directory once it has been created, otherwise null.
  get logDirectory() {
    return this.#resolvedLogDirectory;
  }

  register(job) {
    this.#jobs.set(job.id, job);
    return job;
  }

  // Drop a job that never really started, so a failed setup leaves no trace.
  remove(id) {
    return this.#jobs.delete(id);
  }

  get(id) {
    return this.#jobs.get(id);
  }

  list() {
    return [...this.#jobs.values()];
  }

  hasRunning() {
    for (const job of this.#jobs.values()) {
      if (job.status === 'running') return true;
    }
    return false;
  }

  // Register a wake-up timer. It reports its own exit when it fires, carrying
  // the watch list and prompt so the run loop can render them.
  scheduleTimer({ durationMs, watch = [], tailBytes = DEFAULT_TAIL_BYTES, reason, prompt }) {
    const id = generateJobId();
    const job = {
      id,
      kind: 'timer',
      status: 'running',
      startedAt: Date.now(),
      endedAt: null,
      exitCode: null,
      logPath: null,
      watch,
      tailBytes,
      reason,
      prompt,
      timer: null,
    };
    job.timer = setTimeout(() => {
      job.endedAt = Date.now();
      job.status = 'done';
      job.exitCode = 0;
      this.reportExit({
        id,
        kind: 'timer',
        status: 'done',
        startedAt: job.startedAt,
        finishedAt: job.endedAt,
        exitCode: 0,
        // A timer has no process to signal.
        signal: null,
        durationMs: job.endedAt - job.startedAt,
        logPath: null,
        watch,
        tailBytes,
        reason,
        prompt,
      });
    }, durationMs);
    this.register(job);
    return { id };
  }

  // Stop one running job. A timer clears its timeout, a delegated subagent gets
  // its controller aborted, and a shell command gets SIGTERM then SIGKILL. The
  // real exit event still comes from the process itself.
  kill(id) {
    const job = this.#jobs.get(id);
    if (!job) return { ok: false, status: 'notFound' };
    if (job.status !== 'running') return { ok: false, status: 'alreadyFinished', jobStatus: job.status };

    if (job.kind === 'timer') {
      if (job.timer) clearTimeout(job.timer);
      job.endedAt = Date.now();
      job.status = 'killed';
      return { ok: true, kind: 'timer' };
    }

    if (job.kind === 'delegate') {
      try {
        job.controller?.abort();
      } catch {}
      job.status = 'killed';
      return { ok: true, kind: 'delegate' };
    }

    // Shell jobs signal the process and let its exit handler finalize status.
    const child = job.child;
    if (child && typeof child.kill === 'function') {
      terminateChild(child, { unref: true });
    }
    job.status = 'killed';
    return { ok: true, kind: 'bash' };
  }

  // The first use creates the log directory and remembers its real path. Callers
  // that need the directory to be readable by tools are responsible for
  // trusting the returned path.
  resolveLogDir() {
    if (this.#resolvedLogDirectory) return this.#resolvedLogDirectory;
    fs.mkdirSync(this.#logDirectory, { recursive: true });
    this.#resolvedLogDirectory = fs.realpathSync(this.#logDirectory);
    return this.#resolvedLogDirectory;
  }

  // Persistent listener, fired only while no run loop is active. Returns a disposer.
  onExit(fn) {
    if (typeof fn !== 'function') throw new TypeError('Background exit listener must be a function');
    this.#exitListeners.add(fn);
    return () => this.#exitListeners.delete(fn);
  }

  // Listener for every exit as it happens, whether or not a run is active.
  onRawExit(fn) {
    if (typeof fn !== 'function') throw new TypeError('Background exit listener must be a function');
    this.#rawListeners.add(fn);
    return () => this.#rawListeners.delete(fn);
  }

  reportExit(event) {
    for (const fn of this.#rawListeners) {
      try {
        fn(event);
      } catch (err) {
        this.logger.warn({ error: err }, 'Background listener failed');
      }
    }

    // Queue the event whatever the agent's auto-wake setting is, so a caller who
    // wakes the agent manually still gets the reminder on the next run.
    this.#pendingExits.push(event);

    // An active run loop drains the queue at each tool boundary and before
    // it terminates, and persistent listeners wait until it is done.
    if (this.#isBusy()) return;

    for (const fn of this.#exitListeners) {
      try {
        fn(event);
      } catch (err) {
        this.logger.warn({ error: err }, 'Background exit listener failed');
      }
    }
  }

  hasPendingExits() {
    return this.#pendingExits.length > 0;
  }

  // Hand over the queued exit events. Turning them into a conversation message
  // belongs to the run loop, which is the only place that owns history.
  drainExitEvents() {
    return this.#pendingExits.splice(0);
  }

  // One-line status for a job, plus a tail of whatever it wrote.
  describe(id, tailBytes) {
    const job = this.#jobs.get(id);
    if (!job) return `- ${id}: not found`;
    const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
    let out = `- ${id} (${job.kind}): ${job.status}${
      job.exitCode != null ? `, code ${job.exitCode}` : ''
    }, ${elapsed.toFixed(1)}s`;
    if (job.logPath) {
      out += `\n  tail (${tailBytes} bytes):\n${indent(tailFile(job.logPath, tailBytes))}`;
    }
    if (job.traceLogPath) {
      out += `\n  trace tail (${tailBytes} bytes):\n${indent(tailFile(job.traceLogPath, tailBytes))}`;
    }
    return out;
  }

  // Stop everything still running. Resolves once every child has exited or been
  // SIGKILLed, so a caller can delete the log directory afterwards.
  async cleanup() {
    const killing = [];
    for (const job of this.#jobs.values()) {
      if (job.status !== 'running') continue;
      if (job.kind === 'timer') {
        if (job.timer) clearTimeout(job.timer);
        job.status = 'killed';
        continue;
      }
      if (job.controller) {
        try {
          job.controller.abort();
        } catch {}
      }
      const child = job.child;
      if (child && typeof child.kill === 'function') {
        killing.push(terminateChild(child));
      }
      job.status = 'killed';
    }
    await Promise.all(killing);
  }
}
