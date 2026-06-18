import { recallMemories } from '../../core/memory-recall.js';

export const name = 'RecallMemory';
export const description =
  'Search your stored memories by meaning and return the most relevant ones in full. ' +
  'Use this when the memory index hints at a memory whose details you need, or when the ' +
  'user references past context that is not in your current window. Returns memory bodies ' +
  'ranked by relevance to your query. Read-only: it does not modify any memory file.';
export const input_schema = {
  type: 'object',
  properties: {
    query: { type: 'string', description: 'What to search your memories for, in natural language.' },
    limit: { type: 'number', description: 'Maximum memories to return (default 5, capped at 20).' },
  },
  required: ['query'],
};

export const execute = async ({ query, limit }, ctx = {}) => {
  const agent = ctx.agent || {};
  const memoryDir = agent._memoryDir || `.${agent.appName || 'agent-sdk'}/memory`;

  let n = Number.isFinite(limit) ? Math.floor(limit) : 5;
  if (n < 1) n = 1;
  if (n > 20) n = 20;

  const { results, usage, ranker, total } = await recallMemories({
    memoryDir,
    query,
    limit: n,
    apiKey: agent.apiKey,
    baseUrl: agent.baseUrl,
    model: agent.embeddingModel,
    trustedPaths: agent.trustedPaths,
    restricted: agent.restricted !== false,
    signal: ctx.signal,
  });

  if (usage && agent.usage) {
    agent.usage.tokens += usage.total_tokens || 0;
    agent.usage.cost += usage.cost || 0;
  }

  if (results.length === 0) {
    return `No memories are stored in ${memoryDir} yet.`;
  }

  const header = `## Recalled memories (top ${results.length} of ${total}, ${ranker} ranking)`;
  const blocks = results.map((r) => `### ${r.name} (score ${r.score.toFixed(2)})\n${r.body}`);
  return [header, ...blocks].join('\n\n');
};
