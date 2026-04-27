import Agent from './core/agent.js';
import fs from 'node:fs';
import config from './config.js';
import path from 'node:path';
import { ToolRegistry, loadTools } from './core/utils.js';

async function createAgent(options = {}) {
  const tools = new ToolRegistry();
  for await (const tool of loadTools(path.join(import.meta.dirname, 'tools'))) {
    tools.register(tool);
  }

  return new Agent({
    apiKey: config.API_KEY || options.apiKey,
    model: config.MODEL || options.model,
    order: config.ORDERS || options.order,
    only: config.ONLY || options.only,
    tools
  });
}

export default createAgent;
