import fs from 'node:fs';

const INT32_MAX = 2 ** 31 - 1;
const DEFAULT_TAIL = 4096;

export const name = 'Remind';
export const description =
  'Pause execution until a duration elapses or an absolute time is reached. Useful for scheduled actions ("run X at 5am"), pacing between actions, or waiting on background jobs. Optionally watches background job IDs to short-circuit early and tail their logs on return.';
export const input_schema = {
  type: 'object',
  properties: {
    wait_ms: {
      type: 'number',
      description: 'Milliseconds to wait. Mutually exclusive with `until`.',
    },
    until: {
      type: 'string',
      description:
        'ISO-8601 timestamp to wait until (with timezone offset, e.g. 2026-05-28T05:00:00+07:00). Mutually exclusive with `wait_ms`.',
    },
    watch: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Optional background job IDs. If any of them exits during the wait, Remind short-circuits and returns early.',
    },
    tail_bytes: {
      type: 'number',
      description: 'Bytes to tail from each watched job log (default 4096). Ignored if `watch` is empty.',
    },
  },
};

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

function describeJob(agent, id, tailBytes) {
  const job = agent.backgroundJobs?.get(id);
  if (!job) return `- ${id}: not found in agent.backgroundJobs`;
  const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
  const head = `- ${id} (${job.kind}): ${job.status}${
    job.exitCode != null ? `, code ${job.exitCode}` : ''
  }, ${elapsed.toFixed(1)}s`;
  if (!job.logPath) return head;
  const tail = tailFile(job.logPath, tailBytes);
  return `${head}\n  tail (${tailBytes} bytes):\n${tail
    .split('\n')
    .map((l) => '    ' + l)
    .join('\n')}`;
}

export const execute = async (input, ctx = {}) => {
  const { wait_ms, until, watch = [], tail_bytes = DEFAULT_TAIL } = input;
  const signal = ctx.signal;

  if (wait_ms == null && !until) {
    throw new Error('Remind requires either `wait_ms` or `until`.');
  }
  if (wait_ms != null && until) {
    throw new Error('`wait_ms` and `until` are mutually exclusive.');
  }

  let durationMs;
  if (wait_ms != null) {
    if (typeof wait_ms !== 'number' || wait_ms < 0) {
      throw new Error('`wait_ms` must be a non-negative number.');
    }
    if (wait_ms > INT32_MAX) {
      throw new Error(`\`wait_ms\` is too large (max ${INT32_MAX}). Use a shorter wait.`);
    }
    durationMs = wait_ms;
  } else {
    const target = new Date(until).getTime();
    if (Number.isNaN(target)) {
      throw new Error(`Invalid \`until\` timestamp: ${until}`);
    }
    durationMs = Math.max(0, target - Date.now());
    if (durationMs > INT32_MAX) {
      throw new Error(`\`until\` is too far in the future (max ${INT32_MAX}ms ahead).`);
    }
  }

  const agent = ctx.agent;
  if (watch.length && agent?.backgroundJobs) {
    const alreadyDone = watch.find((id) => {
      const j = agent.backgroundJobs.get(id);
      return j && j.status !== 'running';
    });
    if (alreadyDone) {
      const lines = watch.map((id) => describeJob(agent, id, tail_bytes));
      return `Waited 0ms (watched job already exited).\nWatched jobs:\n${lines.join('\n')}`;
    }
  }

  const startedAt = Date.now();

  await new Promise((resolve, reject) => {
    let bgDispose;
    let abortHandler;

    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, durationMs);

    const cleanup = () => {
      clearTimeout(timer);
      if (bgDispose) bgDispose();
      if (signal && abortHandler) signal.removeEventListener('abort', abortHandler);
    };

    if (signal) {
      if (signal.aborted) {
        cleanup();
        return reject(new Error(`Remind aborted after 0ms`));
      }
      abortHandler = () => {
        cleanup();
        reject(new Error(`Remind aborted after ${Date.now() - startedAt}ms`));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (watch.length && agent?._onBackgroundExitRaw) {
      bgDispose = agent._onBackgroundExitRaw((event) => {
        if (watch.includes(event.id)) {
          cleanup();
          resolve();
        }
      });
    }
  });

  const elapsed = Date.now() - startedAt;
  if (!watch.length) return `Waited ${elapsed}ms. Resuming.`;
  const lines = watch.map((id) => describeJob(agent, id, tail_bytes));
  return `Waited ${elapsed}ms.\nWatched jobs:\n${lines.join('\n')}`;
};
