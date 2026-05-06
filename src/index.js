import Agent from './core/agent.js';
import fs from 'node:fs';
import { getDirname } from './core/dirname.js';
import config from './config.js';
import path from 'node:path';
import { ToolRegistry, loadTools } from './core/utils.js';

const __dirname = getDirname(import.meta);

async function createAgent(options = {}) {
  const tools = new ToolRegistry();
  for await (const tool of loadTools(path.join(__dirname, 'tools'))) {
    tools.register(tool);
  }

  return new Agent({
    apiKey: config.API_KEY || options.apiKey,
    model: config.MODEL || options.model,
    order: config.ORDER || options.order,
    only: config.ONLY || options.only,
    tools
  });
}

export default createAgent;
