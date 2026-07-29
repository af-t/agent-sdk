const INT32_MAX = 2 ** 31 - 1;
const DEFAULT_TAIL = 4096;

const description =
  'Schedule a background timer and return immediately. When it fires, the agent receives the custom prompt or a timer-exit message, plus tails from watched job logs.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    delayMs: { type: 'number', description: 'Milliseconds until the timer fires. Mutually exclusive with `at`.' },
    at: {
      type: 'string',
      description: 'ISO 8601 timestamp with a time zone. Mutually exclusive with delayMs.',
    },
    watch: {
      type: 'array',
      items: { type: 'string' },
      description: 'Background job IDs whose log tails should be included.',
    },
    tailBytes: { type: 'number', description: 'Bytes to read from each watched log. The default is 4096.' },
    reason: {
      type: 'string',
      description: 'Reason shown when manageJobs lists the timer.',
    },
    prompt: {
      type: 'string',
      description: 'Message delivered when the timer fires.',
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
