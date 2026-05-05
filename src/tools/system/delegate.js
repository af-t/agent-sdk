import Agent from '../../core/agent.js';
import { CONSTANTS } from '../../core/utils.js';

export const name = 'Delegate';
export const description = 'Delegate a specific task to a specialized sub-agent. Use this for complex research, repetitive operations, or tasks with high-volume output to keep the main session history clean.';
export const input_schema = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'Explain why to use this tool' },
    prompt: { type: 'string', description: 'Specific instructions for the subagent\n\nIt is highly recommended to ask for a summary so that the context obtained is clear' },
    persona: { type: 'string', description: 'Specific System instruction or Rule or Personality for subagent' },
    context_files: { type: 'array', items: { type: 'string' }, description: 'Paths to files the subagent should read first' }
  },
  required: ['prompt', 'description']
};

export const execute = async ({ description, prompt, persona, context_files }, { agent }) => {
  const subagent = new Agent({
    apiKey: agent.apiKey,
    model: agent.model,
    tools: agent.tools,
    systemPrompt: persona,
    maxTokens: CONSTANTS.MAX_TOKENS_SUBAGENT
  });

  let task = prompt;
  if (context_files?.length) {
    task = `I need you to work on these files: ${context_files.join(', ')}\n\nTask: ${prompt}`;
  }

  console.log('Spawning subagent for:', description);

  try {
    const report = await subagent.run(task);
    return report;
  } catch (err) {
    return `Delegation failed: ${err.message}`;
  }
};
