import { recallMemories } from '../../memory/memory-recall.js';

const description =
  'Search stored memory files by meaning and return complete entries ranked by relevance. This tool does not modify memory files.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'Natural-language memory query.' },
    limit: { type: 'number', description: 'Maximum entries to return. The default is 5 and the limit is 20.' },
  },
  required: ['query'],
};

const execute = async ({ query, limit }, ctx = {}) => {
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
    logger: ctx.logger,
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

export const recallMemory = { name: 'recallMemory', description, inputSchema, execute };
