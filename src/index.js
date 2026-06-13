import Agent from './core/agent.js';
import config from './config.js';
import { ToolRegistry } from './registry/tool.js';
import { builtinTools } from './tools/index.js';

async function createAgent(options = {}) {
  const restricted = options.restricted !== false;
  // Honor a caller-supplied registry; otherwise auto-discover builtins
  let tools = options.tools;
  if (!tools) {
    tools = new ToolRegistry({ restricted });
    for (const tool of builtinTools) {
      tools.register(tool);
    }
  }

  // Explicit options win over env config
  return new Agent({
    ...options,
    model: options.model || config.MODEL,
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
export { Recording } from './core/recording.js';
export { SkillRegistry } from './registry/skill.js';
export { ToolRegistry } from './registry/tool.js';
