const INT32_MAX = 2 ** 31 - 1;
const DEFAULT_TAIL = 4096;

const description =
  'Schedule a non-blocking wake-up timer. Registers a background timer and returns immediately; when it fires, the agent receives a notification (the custom `prompt` if given, otherwise a generic exit notice; plus, if `watch` is set, a tail of those job logs). Use for timed check-ins or pacing without blocking the run loop.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    delayMs: { type: 'number', description: 'Milliseconds until the timer fires. Mutually exclusive with `at`.' },
    at: {
      type: 'string',
      description:
        'ISO-8601 timestamp to fire at (with timezone offset, e.g. 2026-05-28T05:00:00+07:00). Mutually exclusive with `delayMs`.',
    },
    watch: {
      type: 'array',
      items: { type: 'string' },
      description: 'Optional background job IDs. When the timer fires, a tail of each job log is included.',
    },
    tailBytes: { type: 'number', description: 'Bytes to tail from each watched job log (default 4096).' },
    reason: {
      type: 'string',
      description: 'Short free-text description of why this wait was scheduled. Shown in manageJobs({action:"list"}).',
    },
    prompt: {
      type: 'string',
      description:
        'Custom text to surface as the wake-up message when the timer fires, instead of the generic exit notice.',
    },
  },
};

const execute = async (input, ctx = {}) => {
  const { delayMs, at, watch = [], tailBytes = DEFAULT_TAIL, reason, prompt } = input;

  if (delayMs == null && !at) {
    throw new Error('scheduleWakeup requires either `delayMs` or `at`.');
  }
  if (delayMs != null && at) {
    throw new Error('`delayMs` and `at` are mutually exclusive.');
  }

  let durationMs;
  if (delayMs != null) {
    if (typeof delayMs !== 'number' || delayMs < 0) {
      throw new Error('`delayMs` must be a non-negative number.');
    }
    if (delayMs > INT32_MAX) {
      throw new Error(`\`delayMs\` is too large (max ${INT32_MAX}). Use a shorter wait.`);
    }
    durationMs = delayMs;
  } else {
    const target = new Date(at).getTime();
    if (Number.isNaN(target)) {
      throw new Error(`Invalid \`at\` timestamp: ${at}`);
    }
    durationMs = Math.max(0, target - Date.now());
    if (durationMs > INT32_MAX) {
      throw new Error(`\`at\` is too far in the future (max ${INT32_MAX}ms ahead).`);
    }
  }

  const agent = ctx.agent;
  if (!agent || typeof agent._scheduleTimer !== 'function') {
    throw new Error('scheduleWakeup requires ctx.agent (an Agent instance).');
  }

  const { id } = agent._scheduleTimer({ durationMs, watch, tailBytes, reason, prompt });
  const watchNote = watch.length ? ` (watching: ${watch.join(', ')})` : '';
  const reasonNote = reason ? ` (reason: ${reason})` : '';
  return `Wake-up timer ${id} set${reasonNote}; fires in ${durationMs}ms${watchNote}. Exit will be reported automatically.`;
};

export const scheduleWakeup = { name: 'scheduleWakeup', description, inputSchema, execute };
