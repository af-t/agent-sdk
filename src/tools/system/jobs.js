export const name = 'Jobs';
export const description =
  'Inspect and control background jobs started in this session: Bash background commands (Bash({background:true})), background Delegate subagents (Delegate({background:true})), and Wakeup timers. action="list" enumerates jobs (running only by default; pass all=true to include finished ones). action="stop" terminates a running job by its job_id (the bg-xxxxx id returned when you started it). Side effect: "stop" sends SIGTERM/SIGKILL to a background process or aborts a background subagent. Stopping a Bash job takes effect immediately; stopping a Delegate takes effect at its next turn boundary.';
export const input_schema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'stop'],
      description: 'list = show background jobs; stop = terminate a running job by job_id.',
    },
    job_id: {
      type: 'string',
      description: 'Background job id (bg-xxxxx). Required when action="stop".',
    },
    all: {
      type: 'boolean',
      description:
        'When action="list", include finished jobs (exited/crashed/killed/done) in addition to running ones. Default false.',
    },
  },
  required: ['action'],
};

export const execute = async (input, ctx = {}) => {
  const { action, job_id, all = false } = input;
  const agent = ctx.agent;
  if (!agent || !agent.backgroundJobs) {
    throw new Error('Jobs requires ctx.agent (an Agent instance).');
  }

  if (action === 'list') {
    return listJobs(agent, all);
  }

  if (action === 'stop') {
    if (!job_id) {
      throw new Error('Jobs stop requires `job_id`.');
    }
    if (typeof agent._killBackgroundJob !== 'function') {
      throw new Error('Jobs stop requires an Agent that supports _killBackgroundJob.');
    }
    const res = agent._killBackgroundJob(job_id);
    if (res.status === 'not_found') {
      return `Job ${job_id} not found.`;
    }
    if (res.status === 'already_finished') {
      return `Job ${job_id} already finished (${res.jobStatus}); nothing to stop.`;
    }
    return `Stopped ${job_id} (${res.kind}).`;
  }

  throw new Error(`Unknown action: ${action}. Use "list" or "stop".`);
};

function listJobs(agent, all) {
  const lines = [];
  for (const job of agent.backgroundJobs.values()) {
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
