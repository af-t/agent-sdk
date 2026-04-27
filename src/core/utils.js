import { McpClientWrapper } from './mcp.js';
import config from '../config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import logger from './logger.js';


export async function getIgnoreFilter() {
  try {
    const gitignorePath = path.join(process.cwd(), '.gitignore');
    const content = await fs.readFile(gitignorePath, 'utf8');
    return ignore().add(content);
  } catch {
    return ignore();
  }
}

export function formatSize(bytes) {
  if (bytes === 0) return '0B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + sizes[i];
}

export async function withRetry(func, count = config.MAX_RETRIES) {
  let delay = 5000;
  let lastError;

  for (let i = 0; i < count; i++) {
    try {
      const res = await func();
      return res;
    } catch (err) {
      await new Promise(resolve => setTimeout(resolve, delay));
      lastError = err;
      delay *= 1.3;
    }
  }

  throw lastError;
}

export class ToolRegistry {
  _tools = new Map();
  _mcpClients = [];

  getDefinitions() {
    const res = [];
    for (const [name, val] of this._tools) {
      res.push({
        name,
        description: val.description,
        input_schema: val.input_schema
      });
    }
    return res;
  }

  register({ name, description, input_schema, execute }) {
    if (typeof execute !== 'function') throw Error('tools cannot be executed');
    this._tools.set(name, { description, input_schema, execute });
  }

  async execute(name, input, context) {
    const tool = this._tools.get(name);
    if (!tool) throw Error(`Tool ${name} not found`);
    return await tool.execute(input, context);
  }

  async connectMcpServer({ name, command, args, env }) {
    const client = new McpClientWrapper({ command, args, env });
    const remoteTools = await client.connectAndGetTools();
    
    for (const remoteTool of remoteTools) {
      const toolName = `${name}_${remoteTool.name}`;
      
      this.register(
        toolName,
        remoteTool.description || `Tool ${remoteTool.name} from ${name}`,
        remoteTool.inputSchema || { type: 'object', properties: {} },
        async (input) => {
          const result = await client.executeTool(remoteTool.name, input);
          if (result.isError) {
            throw new Error(result.content.map(c => c.text).join('\n'));
          }
          return result.content.map(c => {
             if (c.type === 'text') return c.text;
             if (c.type === 'resource') return `[Resource: ${c.resource.uri}]`;
             return JSON.stringify(c);
          }).join('\n');
        }
      );
    }
    this._mcpClients.push(client);
  }
  
  async cleanup() {
    for (const client of this._mcpClients) {
      try {
        await client.close();
      } catch (err) {
      }
    }
    this._mcpClients = [];
  }
}

async function isDirectory(dirPath) {
  const stat = await fs.stat(dirPath);
  return stat.isDirectory();
}

export async function* loadTools(dirPath) {
  if (!(await isDirectory(dirPath))) return;

  logger.debug(`Loading tools from: ${dirPath}`);
  const entries = (await fs.readdir(dirPath, { recursive: true, withFileTypes: true })).filter(x => x.isFile());
  for (const entry of entries) {
    const fullPath = path.resolve(path.join(entry.parentPath, entry.name));
    try {
      const mod = await import(fullPath);
      const tool = {
        name: mod.name || mod.default?.name,
        description: mod.description || mod.default?.description,
        input_schema: mod.input_schema || mod.default?.input_schema,
        execute: mod.execute || mod.default?.execute
      };

      if (!tool.name || !tool.input_schema || !tool.execute) {
        throw Error(`File '${entry.name}' does not have mandatory properties`);
      }

      logger.debug(`Tool loaded: ${tool.name}`);
      yield tool;
    } catch (err) {
      logger.error(`Failed to load tool from ${entry.name}: ${err.message}`);
    }
  }
}
