const INT32_MAX = 2 ** 31 - 1;
const DEFAULT_TAIL = 4096;

export const name = 'Remind';
export const description =
  'Schedule a non-blocking reminder timer. Registers a background timer and returns immediately; when it fires, the agent receives a notification (and, if `watch` is set, a tail of those job logs). Use for timed check-ins or pacing without blocking the run loop.';
export const input_schema = {
  type: 'object',
  properties: {
    wait_ms: { type: 'number', description: 'Milliseconds until the timer fires. Mutually exclusive with `until`.' },
    until: {
      type: 'string',
      description:
        'ISO-8601 timestamp to fire at (with timezone offset, e.g. 2026-05-28T05:00:00+07:00). Mutually exclusive with `wait_ms`.',
    },
    watch: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional background job IDs. When the timer fires, a tail of each job log is included.',
    },
    tail_bytes: { type: 'number', description: 'Bytes to tail from each watched job log (default 4096).' },
  },
};

export const execute = async (input, ctx = {}) => {
  const { wait_ms, until, watch = [], tail_bytes = DEFAULT_TAIL } = input;

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
  if (!agent || typeof agent._scheduleTimer !== 'function') {
    throw new Error('Remind requires ctx.agent (an Agent instance).');
  }

  const { id } = agent._scheduleTimer({ durationMs, watch, tailBytes: tail_bytes });
  const watchNote = watch.length ? ` (watching: ${watch.join(', ')})` : '';
  return `Reminder ${id} set; fires in ${durationMs}ms${watchNote}. Exit will be reported automatically.`;
};
