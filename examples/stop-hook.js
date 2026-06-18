// Stop-hook and empty-turn recovery example.
//
// A terminal turn (the model returns no tool calls) is routed through stop
// hooks before the run ends. The built-in empty-turn recovery (on by default)
// re-sends the same request, then nudges, when a turn comes back with only
// reasoning and no content — useful behind proxies that mislabel a truncated
// generation as a clean stop. You can also register your own onStop hook.

import createAgent from '../src/index.js';

const agent = await createAgent({
  // Tune (or disable with `false`) the built-in recovery. `nudge` is the inner
  // text; the SDK wraps it in a <system-reminder> when it injects it.
  emptyTurnRecovery: {
    enabled: true,
    retries: 2,
    nudge: 'You produced reasoning but no answer. Give your final answer now, or call a tool.',
  },
});

// A custom stop hook runs on every terminal turn, before the built-in recovery.
// Return undefined / { action: 'stop' } to allow the run to end,
// { action: 'retry' } to re-send the same payload, or
// { action: 'continue', prompt } to inject a message and keep looping.
const off = agent.onStop(({ content, reasoning, finish_reason, turn, attempt }) => {
  const preview = (content ?? '').slice(0, 60);
  console.log(
    `[onStop] turn=${turn} attempt=${attempt} finish_reason=${finish_reason} ` +
      `reasoning=${reasoning ? 'yes' : 'no'} content="${preview}"`,
  );
  // Example policy: if the model stops with no content at all, ask once more.
  if ((content == null || content.trim() === '') && attempt === 0) {
    return { action: 'continue', prompt: 'Please provide your final answer.' };
  }
  return undefined; // allow the built-in recovery (and then the stop) to proceed
});

const reply = await agent.run('In one sentence, what does a stop hook do in this SDK?');

off();

console.log('--- Agent reply ---');
console.log(reply);
console.log('--- Usage ---');
console.log(agent.usage);
