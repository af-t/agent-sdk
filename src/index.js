import Agent from './core/agent.js';
import { getDirname } from './core/utils.js';
import config from './config.js';
import path from 'node:path';
import { ToolRegistry } from './registry/tool.js';
import { loadTools } from './core/utils.js';

const __dirname = getDirname(import.meta);

async function createAgent(options = {}) {
  const restricted = options.restricted !== false;
  const tools = new ToolRegistry({ restricted });
  for await (const tool of loadTools(path.join(__dirname, 'tools'))) {
    tools.register(tool);
  }

  return new Agent({
    ...options,
    apiKey: config.API_KEY || options.apiKey,
    baseUrl: config.BASE_URL || options.baseUrl,
    model: config.MODEL || options.model,
    order: config.ORDER || options.order,
    only: config.ONLY || options.only,
    restricted,
    tools,
  });
}

export default createAgent;
export { createCopilot } from './core/copilot.js';
export { createDaemon, createTimerSource } from './core/daemon.js';
export { createFileWatchSource } from './core/file-watch-source.js';
export { createHttpSource } from './core/http-source.js';
export { recallMemories } from './core/memory-recall.js';
