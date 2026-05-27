import Agent from '../../core/agent.js';
import { CONSTANTS } from '../../core/utils.js';
import logger from '../../core/logger.js';

export const name = 'Delegate';
export const description =
  'Delegate a specific task to a specialized sub-agent. Use this for complex research, repetitive operations, or tasks with high-volume output to keep the main session history clean. Side effect: spawns a subagent that may itself touch the filesystem and shell. Avoid parallel Delegate calls targeting overlapping work.';
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
    id: {
      type: 'string',
      description:
        'Subagent ID. If provided and already exists, the same subagent is reused (history preserved). If omitted, a short random ID is auto-generated.',
    },
  },
  required: ['prompt', 'description'],
};

export const execute = async ({ description, prompt, persona, id }, { agent, signal }) => {
  if (signal?.aborted) {
    throw new Error('Delegate aborted');
  }

  const depth = (agent._delegateDepth || 0) + 1;
  const MAX_DELEGATE_DEPTH = 3;
  if (depth > MAX_DELEGATE_DEPTH) {
    throw new Error(`Delegate depth limit reached (${MAX_DELEGATE_DEPTH}). Cannot nest deeper.`);
  }

  let resolvedId = id;
  if (!resolvedId) {
    resolvedId = Math.random().toString(36).slice(2, 7);
    if (agent.subagents.has(resolvedId)) resolvedId = Math.random().toString(36).slice(2, 7);
  }

  const isNew = !agent.subagents.has(resolvedId);
  let subagent;

  if (isNew) {
    subagent = new Agent({
      apiKey: agent.apiKey,
      model: agent.model,
      provider: agent.provider,
      tools: agent.tools,
      systemPrompt: persona,
      maxTokens: agent.maxTokens || CONSTANTS.MAX_TOKENS_SUBAGENT,
      maxTurns: 1000,
      isSubagent: true,
      restricted: agent.restricted,
      storagePaths: agent._storagePaths ?? undefined,
    });
    agent.subagents.set(resolvedId, subagent);
  } else {
    subagent = agent.subagents.get(resolvedId);
  }

  logger.info('Spawning subagent for:', description);

  try {
    const usageBefore = { cost: subagent.usage.cost, tokens: subagent.usage.tokens };
    const msgsBefore = subagent.messages.length;
    const startTime = Date.now();

    const report = await subagent.run(prompt, null, { signal });

    const elapsed = Date.now() - startTime;
    const toolCalls = subagent.messages.slice(msgsBefore).filter((m) => m.role === 'tool').length;
    agent.usage.cost += subagent.usage.cost - usageBefore.cost;
    agent.usage.tokens += subagent.usage.tokens - usageBefore.tokens;

    const status = isNew ? 'new' : 'reused';
    const duration =
      elapsed < 60000
        ? `${Math.round(elapsed / 1000)}s`
        : `${Math.floor(elapsed / 60000)}m ${Math.round((elapsed % 60000) / 1000)}s`;
    const footer = `\n\n---\nSubagent ID: ${resolvedId} (${status})\nTool calls: ${toolCalls}\nDuration: ${duration}`;
    return report + footer;
  } catch (err) {
    throw new Error(`Delegation failed: ${err.message}`, { cause: err });
  }
};
