import Agent from './agent/agent.js';
import process from 'node:process';
import { loadEnvironmentConfig } from './config/environment.js';
import { ToolRegistry } from './registries/tool-registry.js';
import { resolveLogger } from './support/logger.js';
import { SkillRegistry } from './registries/skill-registry.js';
import { createBuiltinTools } from './tools/index.js';

try {
  process.loadEnvFile();
} catch {
  // Ignore if .env doesn't exist.
}

export async function createAgent(options = {}) {
  const config = loadEnvironmentConfig();
  const logger = resolveLogger(options.logger, { debug: config.debug });
  const skillRegistry = new SkillRegistry({ logger });
  const restricted = options.restricted !== false;
  // Honor a caller-supplied registry; otherwise auto-discover builtins
  let tools = options.tools;
  if (!tools) {
    tools = new ToolRegistry({ restricted, logger });
    for (const tool of createBuiltinTools(skillRegistry)) {
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
    skillRegistry,
  });
}

export default createAgent;
export { createCopilot } from './automation/copilot.js';
export { createDaemon, createTimerSource } from './automation/daemon.js';
export { createFileWatchSource } from './automation/file-watch-source.js';
export { createHttpSource } from './automation/http-source.js';
export { recallMemories } from './memory/memory-recall.js';
export { Recording } from './recording/recording.js';
export { McpClientWrapper, McpNativeClient } from './integrations/mcp-client.js';
export { SkillRegistry } from './registries/skill-registry.js';
export { ToolRegistry } from './registries/tool-registry.js';
