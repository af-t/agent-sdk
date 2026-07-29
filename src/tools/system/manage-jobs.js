const description =
  'List or stop background shell commands, subagents, and wake-up timers from this session. Listing shows running jobs by default. Stopping terminates a process or aborts a subagent.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'stop'],
      description: 'List jobs or stop one running job.',
    },
    jobId: {
      type: 'string',
      description: 'Background job ID. Required for stop.',
    },
    all: {
      type: 'boolean',
      description: 'Include finished jobs when listing. The default is false.',
    },
  },
  required: ['action'],
};

const execute = async (input, ctx = {}) => {
  const { action, jobId, all = false } = input;
  const agent = ctx.agent;
  if (!agent || !agent.backgroundJobs) {
    throw new Error('manageJobs requires ctx.agent (an Agent instance).');
  }

  if (action === 'list') {
    return listJobs(agent, all);
  }

  if (action === 'stop') {
    if (!jobId) {
      throw new Error('manageJobs stop requires `jobId`.');
    }
    const res = agent.backgroundJobs.kill(jobId);
    if (res.status === 'notFound') {
      return `Job ${jobId} not found.`;
    }
    if (res.status === 'alreadyFinished') {
      return `Job ${jobId} already finished (${res.jobStatus}); nothing to stop.`;
    }
    return `Stopped ${jobId} (${res.kind}).`;
  }

  throw new Error(`Unknown action: ${action}. Use "list" or "stop".`);
};

function listJobs(agent, all) {
  const lines = [];
  for (const job of agent.backgroundJobs.list()) {
    if (!all && job.status !== 'running') continue;
    const elapsed = ((job.endedAt ?? Date.now()) - job.startedAt) / 1000;
    let line = `${job.id} (${job.kind}): ${job.status}, ${elapsed.toFixed(1)}s`;
    if (job.exitCode != null) line += `, code ${job.exitCode}`;
    if (job.logPath) line += `, log ${job.logPath}`;
    if (job.reason) line += `, reason: "${job.reason}"`;
    lines.push(line);
  }
  if (lines.length === 0) {
    return all ? 'No background jobs.' : 'No running background jobs.';
  }
  return lines.join('\n');
}

export const manageJobs = { name: 'manageJobs', description, inputSchema, execute };
