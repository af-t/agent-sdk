import Agent from '../../core/agent.js';
import { CONSTANTS } from '../../core/utils.js';
import logger from '../../core/logger.js';

export const name = 'Delegate';
export const description =
  'Delegate a specific task to a specialized sub-agent. Use this for complex research, repetitive operations, or tasks with high-volume output to keep the main session history clean.';
export const input_schema = {
  type: 'object',
  properties: {
    description: { type: 'string', description: 'Explain why to use this tool' },
    prompt: {
      type: 'string',
      description:
        'Specific instructions for the subagent\n\nIt is highly recommended to ask for a summary so that the context obtained is clear',
    },
    persona: { type: 'string', description: 'Specific System instruction or Rule or Personality for subagent' },
    context_files: {
      type: 'array',
      items: { type: 'string' },
      description: 'Paths to files the subagent should read first',
    },
  },
  required: ['prompt', 'description'],
};

export const execute = async ({ description, prompt, persona, context_files }, { agent }) => {
  const depth = (agent._delegateDepth || 0) + 1;
  const MAX_DELEGATE_DEPTH = 3;
  if (depth > MAX_DELEGATE_DEPTH) {
    throw new Error(`Delegate depth limit reached (${MAX_DELEGATE_DEPTH}). Cannot nest deeper.`);
  }

  const subagent = new Agent({
    apiKey: agent.apiKey,
    model: agent.model,
    provider: agent.provider,
    tools: agent.tools, // inherit all tools including Delegate (depth check prevents unbounded recursion)
    systemPrompt: persona,
    maxTokens: agent.maxTokens || CONSTANTS.MAX_TOKENS_SUBAGENT,
    maxTurns: 1000, // subagents need more iterations than the default 25
    isSubagent: true,
  });

  let task = prompt;
  if (context_files?.length) {
    task = `I need you to work on these files: ${context_files.join(', ')}\n\nTask: ${prompt}`;
  }

  logger.info('Spawning subagent for:', description);

  try {
    const report = await subagent.run(task);
    return report;
  } catch (err) {
    throw new Error(`Delegation failed: ${err.message}`);
  }
};
