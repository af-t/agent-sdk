import { describe, it, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { BackgroundJobs, BG_KILL_GRACE_MS } from '../../src/agent/background-jobs.js';
import { resolveLogger } from '../../src/support/logger.js';

const silentLogger = resolveLogger({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});

function makeJobs(overrides = {}) {
  return new BackgroundJobs({
    logger: silentLogger,
    logDirectory: path.join(os.tmpdir(), `bgjobs-test-${process.pid}-${Math.random().toString(36).slice(2, 7)}`),
    ...overrides,
  });
}

function runningJob(id, extra = {}) {
  return { id, kind: 'bash', status: 'running', startedAt: Date.now(), ...extra };
}

describe('BackgroundJobs: registry', () => {
  it('registers a job and reads it back by id', () => {
    const jobs = makeJobs();
    const job = runningJob('bg-aaaaa');
    jobs.register(job);
    assert.equal(jobs.get('bg-aaaaa'), job);
    assert.deepEqual(jobs.list(), [job]);
  });

  it('get returns undefined for an unknown id', () => {
    assert.equal(makeJobs().get('bg-nope'), undefined);
  });

  it('starts with no jobs', () => {
    assert.deepEqual(makeJobs().list(), []);
  });

  it('remove drops a job so it is gone from get and list', () => {
    const jobs = makeJobs();
    jobs.register(runningJob('bg-gone'));
    jobs.remove('bg-gone');
    assert.equal(jobs.get('bg-gone'), undefined);
    assert.deepEqual(jobs.list(), []);
  });

  it('list preserves registration order', () => {
    const jobs = makeJobs();
    jobs.register(runningJob('bg-1'));
    jobs.register(runningJob('bg-2'));
    jobs.register(runningJob('bg-3'));
    assert.deepEqual(
      jobs.list().map((j) => j.id),
      ['bg-1', 'bg-2', 'bg-3'],
    );
  });

  it('hasRunning reports whether any job is still running', () => {
    const jobs = makeJobs();
    assert.equal(jobs.hasRunning(), false);
    const job = runningJob('bg-run');
    jobs.register(job);
    assert.equal(jobs.hasRunning(), true);
    job.status = 'exited';
    assert.equal(jobs.hasRunning(), false);
  });
});

describe('BackgroundJobs: timers', () => {
  it('scheduleTimer registers a running timer job and reports its exit', async () => {
    const jobs = makeJobs();
    const events = [];
    jobs.onRawExit((e) => events.push(e));

    const { id } = jobs.scheduleTimer({ durationMs: 20, watch: [], tailBytes: 4096 });
    assert.match(id, /^bg-[0-9a-f]{5}$/);
    assert.equal(jobs.get(id).kind, 'timer');
    assert.equal(jobs.get(id).status, 'running');

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(jobs.get(id).status, 'done');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'timer');
    assert.equal(events[0].exitCode, 0);
    assert.equal(events[0].id, id);
    assert.equal(events[0].status, 'done');
    assert.equal(events[0].logPath, null);
    // A timer has no process, so no signal terminated it.
    assert.equal(events[0].signal, null);
    assert.equal(events[0].startedAt, jobs.get(id).startedAt);
    assert.equal(events[0].finishedAt, jobs.get(id).endedAt);
    assert.equal(events[0].durationMs, events[0].finishedAt - events[0].startedAt);
  });

  it('threads reason, prompt, watch and tailBytes onto the job and the exit event', async () => {
    const jobs = makeJobs();
    const events = [];
    jobs.onRawExit((e) => events.push(e));

    const { id } = jobs.scheduleTimer({
      durationMs: 20,
      watch: ['bg-zzzzz'],
      tailBytes: 256,
      reason: 'pace check-in',
      prompt: 'resume the task',
    });
    const job = jobs.get(id);
    assert.deepEqual(job.watch, ['bg-zzzzz']);
    assert.equal(job.tailBytes, 256);
    assert.equal(job.reason, 'pace check-in');
    assert.equal(job.prompt, 'resume the task');

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].watch, ['bg-zzzzz']);
    assert.equal(events[0].tailBytes, 256);
    assert.equal(events[0].reason, 'pace check-in');
    assert.equal(events[0].prompt, 'resume the task');
  });
});

describe('BackgroundJobs: kill', () => {
  it('returns not_found for an unknown id', () => {
    assert.deepEqual(makeJobs().kill('bg-nope'), { ok: false, status: 'not_found' });
  });

  it('returns already_finished for a job that is no longer running', () => {
    const jobs = makeJobs();
    jobs.register({ id: 'bg-x', kind: 'bash', status: 'crashed', startedAt: Date.now() });
    const res = jobs.kill('bg-x');
    assert.equal(res.ok, false);
    assert.equal(res.status, 'already_finished');
    assert.equal(res.jobStatus, 'crashed');
  });

  it('clears a timer and marks it killed', async () => {
    const jobs = makeJobs();
    const events = [];
    jobs.onRawExit((e) => events.push(e));
    const { id } = jobs.scheduleTimer({ durationMs: 30 });
    assert.deepEqual(jobs.kill(id), { ok: true, kind: 'timer' });
    assert.equal(jobs.get(id).status, 'killed');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(events.length, 0, 'a killed timer must not fire its exit event');
  });

  it('aborts a delegate controller and marks it killed', () => {
    const jobs = makeJobs();
    const controller = new AbortController();
    const job = { id: 'bg-del', kind: 'delegate', status: 'running', startedAt: Date.now(), controller };
    jobs.register(job);
    assert.deepEqual(jobs.kill('bg-del'), { ok: true, kind: 'delegate' });
    assert.equal(controller.signal.aborted, true);
    assert.equal(job.status, 'killed');
  });

  it('sends SIGTERM to a bash child and marks it killed', () => {
    const jobs = makeJobs();
    const signals = [];
    const child = {
      kill: (s) => signals.push(s),
      on: (event, cb) => {
        if (event === 'exit') cb();
      },
    };
    const job = { id: 'bg-bash', kind: 'bash', status: 'running', startedAt: Date.now(), child };
    jobs.register(job);
    assert.deepEqual(jobs.kill('bg-bash'), { ok: true, kind: 'bash' });
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(job.status, 'killed');
  });

  it('escalates to SIGKILL when a bash child ignores SIGTERM', async () => {
    const jobs = makeJobs();
    const signals = [];
    // A child that never reports an exit: the grace timer must escalate.
    const child = { kill: (s) => signals.push(s), on: () => {} };
    jobs.register({ id: 'bg-stubborn', kind: 'bash', status: 'running', startedAt: Date.now(), child });
    jobs.kill('bg-stubborn');
    assert.deepEqual(signals, ['SIGTERM']);
    await new Promise((r) => setTimeout(r, BG_KILL_GRACE_MS + 200));
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });
});

describe('BackgroundJobs: exit reporting', () => {
  it('calls raw listeners synchronously and returns a disposer', () => {
    const jobs = makeJobs();
    let calls = 0;
    const dispose = jobs.onRawExit(() => calls++);
    jobs.reportExit({ id: 'bg-1', kind: 'bash', exitCode: 0 });
    assert.equal(calls, 1);
    dispose();
    jobs.reportExit({ id: 'bg-1', kind: 'bash', exitCode: 0 });
    assert.equal(calls, 1);
  });

  it('calls every exit listener when idle and returns a disposer', () => {
    const jobs = makeJobs();
    let a = 0;
    let b = 0;
    const dispose = jobs.onExit(() => a++);
    jobs.onExit(() => b++);
    jobs.reportExit({ id: 'bg-1', kind: 'bash', exitCode: 0 });
    assert.equal(a, 1);
    assert.equal(b, 1);
    dispose();
    jobs.reportExit({ id: 'bg-2', kind: 'bash', exitCode: 0 });
    assert.equal(a, 1);
    assert.equal(b, 2);
  });

  it('rejects a non-function listener', () => {
    const jobs = makeJobs();
    assert.throws(() => jobs.onExit('nope'), TypeError);
    assert.throws(() => jobs.onRawExit('nope'), TypeError);
  });

  it('isolates a throwing listener from the rest', () => {
    const jobs = makeJobs();
    let reached = false;
    jobs.onRawExit(() => {
      throw new Error('raw boom');
    });
    jobs.onExit(() => {
      throw new Error('exit boom');
    });
    jobs.onExit(() => {
      reached = true;
    });
    jobs.reportExit({ id: 'bg-1', kind: 'bash', exitCode: 0 });
    assert.equal(reached, true);
  });

  it('defers exit listeners while busy but still queues the event', () => {
    let busy = true;
    const jobs = makeJobs({ isBusy: () => busy });
    let calls = 0;
    let rawCalls = 0;
    jobs.onExit(() => calls++);
    jobs.onRawExit(() => rawCalls++);

    jobs.reportExit({ id: 'bg-busy', kind: 'bash', exitCode: 0 });
    assert.equal(calls, 0, 'exit listeners wait until the loop is idle');
    assert.equal(rawCalls, 1, 'raw listeners always fire');
    assert.equal(jobs.hasPendingExits(), true);

    busy = false;
    jobs.reportExit({ id: 'bg-idle', kind: 'bash', exitCode: 0 });
    assert.equal(calls, 1);
  });

  it('drainExitEvents returns queued events once and empties the queue', () => {
    const jobs = makeJobs();
    assert.equal(jobs.hasPendingExits(), false);
    assert.deepEqual(jobs.drainExitEvents(), []);

    jobs.reportExit({ id: 'bg-1', kind: 'bash', exitCode: 0 });
    jobs.reportExit({ id: 'bg-2', kind: 'timer', exitCode: 0 });
    assert.equal(jobs.hasPendingExits(), true);

    const drained = jobs.drainExitEvents();
    assert.deepEqual(
      drained.map((e) => e.id),
      ['bg-1', 'bg-2'],
    );
    assert.equal(jobs.hasPendingExits(), false);
    assert.deepEqual(jobs.drainExitEvents(), []);
  });
});

describe('BackgroundJobs: describe', () => {
  it('renders status, exit code and a log tail', (t) => {
    const jobs = makeJobs();
    const dir = jobs.resolveLogDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logPath = path.join(dir, 'background-bg-aaaaa.log');
    fs.writeFileSync(logPath, 'hello-from-job\n');
    jobs.register({
      id: 'bg-aaaaa',
      kind: 'bash',
      status: 'exited',
      exitCode: 0,
      startedAt: 0,
      endedAt: 1000,
      logPath,
    });
    const out = jobs.describe('bg-aaaaa', 4096);
    assert.match(out, /bg-aaaaa \(bash\): exited, code 0, 1\.0s/);
    assert.match(out, /hello-from-job/);
  });

  it('appends a trace tail when the job has a traceLogPath', (t) => {
    const jobs = makeJobs();
    const dir = jobs.resolveLogDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const logPath = path.join(dir, 'background-jobX.log');
    const traceLogPath = path.join(dir, 'trace-jobX.log');
    fs.writeFileSync(logPath, 'REPORT BODY');
    fs.writeFileSync(traceLogPath, '=== turn 1 ===\n[assistant]\nTRACE BODY\n');
    jobs.register({
      id: 'jobX',
      kind: 'delegate',
      status: 'exited',
      exitCode: 0,
      logPath,
      traceLogPath,
      startedAt: 0,
      endedAt: 1000,
    });
    const out = jobs.describe('jobX', 4096);
    assert.match(out, /REPORT BODY/);
    assert.match(out, /TRACE BODY/);
  });

  it('reports an unknown id instead of throwing', () => {
    assert.match(makeJobs().describe('bg-nope', 128), /bg-nope: not found/);
  });

  it('reports an unreadable log instead of throwing', (t) => {
    const jobs = makeJobs();
    const dir = jobs.resolveLogDir();
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    jobs.register({
      id: 'bg-missing-log',
      kind: 'bash',
      status: 'exited',
      exitCode: 1,
      startedAt: 0,
      endedAt: 500,
      logPath: path.join(dir, 'does-not-exist.log'),
    });
    assert.match(jobs.describe('bg-missing-log', 128), /unable to tail/);
  });
});

describe('BackgroundJobs: log directory', () => {
  it('creates the configured directory and returns its real path', (t) => {
    const target = path.join(os.tmpdir(), `bgjobs-dir-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
    const jobs = makeJobs({ logDirectory: target });
    t.after(() => fs.rmSync(target, { recursive: true, force: true }));

    assert.equal(jobs.logDirectory, null, 'nothing is created until the directory is needed');
    const dir = jobs.resolveLogDir();
    assert.equal(dir, fs.realpathSync(target));
    assert.ok(fs.existsSync(dir));
    assert.equal(jobs.logDirectory, dir);
    assert.equal(jobs.resolveLogDir(), dir, 'the resolved path is cached');
  });
});

describe('BackgroundJobs: cleanup', () => {
  it('clears pending timers so no exit fires afterwards', async () => {
    const jobs = makeJobs();
    const events = [];
    jobs.onRawExit((e) => events.push(e));
    const { id } = jobs.scheduleTimer({ durationMs: 1000 });
    await jobs.cleanup();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(events.length, 0);
    assert.equal(jobs.get(id).status, 'killed');
  });

  it('aborts running delegate controllers', async () => {
    const jobs = makeJobs();
    const controller = new AbortController();
    jobs.register({ id: 'bg-del', kind: 'delegate', status: 'running', startedAt: Date.now(), controller });
    await jobs.cleanup();
    assert.equal(controller.signal.aborted, true);
  });

  it('leaves already-finished jobs alone', async () => {
    const jobs = makeJobs();
    const controller = new AbortController();
    jobs.register({ id: 'bg-done', kind: 'delegate', status: 'exited', startedAt: Date.now(), controller });
    await jobs.cleanup();
    assert.equal(controller.signal.aborted, false);
    assert.equal(jobs.get('bg-done').status, 'exited');
  });

  it('terminates a real child process', async () => {
    const jobs = makeJobs();
    const child = spawn('bash', ['-c', 'sleep 30']);
    jobs.register({ id: 'bg-real', kind: 'bash', status: 'running', startedAt: Date.now(), child });
    assert.equal(child.killed, false);
    await jobs.cleanup();
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(child.killed || child.exitCode !== null, 'child should be killed after cleanup');
    assert.equal(jobs.get('bg-real').status, 'killed');
  });

  it('escalates to SIGKILL when a child ignores SIGTERM, then resolves', async () => {
    const jobs = makeJobs();
    const signals = [];
    jobs.register({
      id: 'bg-stubborn',
      kind: 'bash',
      status: 'running',
      startedAt: Date.now(),
      child: { kill: (s) => signals.push(s), on: () => {} },
    });
    await jobs.cleanup();
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  });
});

test('BackgroundJobs keeps its job map private', () => {
  const jobs = makeJobs();
  assert.equal(jobs.jobs, undefined);
  assert.equal(typeof jobs.set, 'undefined', 'callers register jobs through register(), not a shared map');
  assert.equal(typeof jobs.delete, 'undefined');
});
