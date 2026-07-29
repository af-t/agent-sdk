// A terminal turn (the model returns no tool calls) is routed through stop
// hooks. Empty-turn recovery retries responses that contain reasoning but no
// answer, which can happen when a proxy reports a truncated response as a
// clean stop.

import createAgent from '../src/index.js';

const agent = await createAgent({
  emptyTurnRecovery: {
    enabled: true,
    retries: 2,
    nudge: 'You produced reasoning but no answer. Give your final answer now, or call a tool.',
  },
});

// User hooks run before built-in recovery. A hook can stop, retry the same
// payload, or continue with another prompt.
const off = agent.onStop(({ content, reasoning, finish_reason, turn, attempt }) => {
  const preview = (content ?? '').slice(0, 60);
  console.log(
    `[onStop] turn=${turn} attempt=${attempt} finish_reason=${finish_reason} ` +
      `reasoning=${reasoning ? 'yes' : 'no'} content="${preview}"`,
  );
  if ((content == null || content.trim() === '') && attempt === 0) {
    return { action: 'continue', prompt: 'Please provide your final answer.' };
  }
  return undefined;
});

try {
  const reply = await agent.run('In one sentence, what does a stop hook do in this SDK?');
  console.log('Agent reply:');
  console.log(reply);
  console.log('Usage:');
  console.log(agent.usage);
} finally {
  off();
  await agent.cleanup();
}
