import Agent from './core/agent.js';
import process from 'node:process';
import { loadEnvironmentConfig } from './config/environment.js';
import { ToolRegistry } from './registry/tool.js';
import { resolveLogger } from './support/logger.js';
import { builtinTools } from './tools/index.js';

try {
  process.loadEnvFile();
} catch {
  // Ignore if .env doesn't exist.
}

export async function createAgent(options = {}) {
  const config = loadEnvironmentConfig();
  const logger = resolveLogger(options.logger, { debug: config.debug });
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
    model: options.model || config.model,
    restricted,
    tools,
    logger,
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
