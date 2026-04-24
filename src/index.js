import Agent from './core/agent.js';
import fs from 'node:fs';
import config from './config.js';
import path from 'node:path';
import { ToolRegistry, loadTools } from './core/utils.js';

async function createAgent() {
  const tools = new ToolRegistry();
  for await (const tool of loadTools(path.join(import.meta.dirname, 'tools'))) {
    tools.register(
      tool.name,
      tool.description,
      tool.input_schema,
      tool.execute
    );
  }

  return new Agent({
    apiKey: config.API_KEY,
    model: config.MODEL,
    order: config.ORDERS,
    tools
  });
}

export default createAgent;
