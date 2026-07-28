import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { removeSecrets, sanitizeChildEnvironment } from '../support/environment.js';
import { LIMITS } from '../support/payload.js';
import { resolveLogger } from '../support/logger.js';

export class McpNativeClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = config;
    this.logger = resolveLogger(config.logger).child({ component: 'mcpClient', server: config.server });
    this.process = null;
    this.rl = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.initialized = false;
    this.capabilities = null;
    this.serverInfo = null;
    this.defaultTimeout = config.timeout || LIMITS.mcpTimeoutMs;
  }

  async connect() {
    const childEnv =
      this.config.restricted !== false
        ? { ...removeSecrets(process.env), ...sanitizeChildEnvironment(this.config.env || {}) }
        : { ...process.env, ...(this.config.env || {}) };
    this.process = spawn(this.config.command, this.config.args || [], {
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process.stderr.on('data', (data) => {
      this.logger.warn({ server: this.config.server, diagnostic: data.toString().trim() }, 'MCP server stderr');
    });
    this.rl = createInterface({ input: this.process.stdout, terminal: false });
    this.rl.on('line', (line) => {
      const message = this.#parseMessage(line);
      if (message) this.#handleMessage(message);
    });
    this.process.on('error', (error) => this.emit('error', error));
    this.process.on('exit', (code) => {
      this.emit('exit', code);
      this.#cleanup();
    });

    try {
      const response = await this.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'mcp-native-client', version: '1.0.0' },
      });
      this.initialized = true;
      this.capabilities = response.capabilities;
      this.serverInfo = response.serverInfo;
      await this.notify('notifications/initialized', {});
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async request(method, params, timeout) {
    const effectiveTimeout = timeout || this.defaultTimeout;
    if (!this.process || this.process.killed) throw new Error('Process not running');
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${method} timed out after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      try {
        this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      } catch (error) {
        this.pendingRequests.delete(requestId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  async listTools() {
    return this.request('tools/list', {});
  }
  async callTool(name, args) {
    return this.request('tools/call', { name, arguments: args });
  }
  async listResources() {
    return this.request('resources/list', {});
  }
  async readResource(uri) {
    return this.request('resources/read', { uri });
  }
  async listPrompts() {
    return this.request('prompts/list', {});
  }
  async getPrompt(name, args) {
    return this.request('prompts/get', { name, arguments: args });
  }

  async notify(method, params) {
    if (!this.process || this.process.killed) throw new Error('Process not running');
    try {
      this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch (error) {
      this.logger.error({ server: this.config.server, method, error }, 'Failed to send MCP notification');
    }
  }

  async close() {
    if (!this.process) return;
    const processToClose = this.process;
    try {
      processToClose.stdin.end();
    } catch {}
    this.#cleanup();
    setTimeout(() => {
      try {
        if (processToClose.exitCode === null) processToClose.kill();
      } catch {}
    }, 1000).unref();
  }

  #cleanup() {
    this.rl?.close();
    this.rl = null;
    this.process = null;
    for (const { reject } of this.pendingRequests.values()) reject(new Error('Connection closed'));
    this.pendingRequests.clear();
  }

  #handleMessage(message) {
    if (typeof message.method === 'string' && message.method !== '') {
      if (message.id !== undefined) {
        try {
          this.process?.stdin?.write(
            JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) +
              '\n',
          );
        } catch (error) {
          this.logger.debug(
            { server: this.config.server, method: message.method, requestId: message.id, error },
            'Failed to reject MCP method',
          );
        }
      } else {
        this.emit('notification', message);
      }
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      this.logger.debug(
        { server: this.config.server, requestId: message.id },
        'Ignoring MCP response for unknown request',
      );
      return;
    }
    this.pendingRequests.delete(message.id);
    if (message.error) pending.reject(message.error);
    else pending.resolve(message.result);
  }

  #parseMessage(line) {
    try {
      return JSON.parse(line.trim());
    } catch (error) {
      this.logger.debug({ server: this.config.server, error, line: line.slice(0, 200) }, 'Failed to parse MCP message');
      return null;
    }
  }
}

export class McpClientWrapper {
  constructor({ command, args, env, restricted = true, logger, server, timeout } = {}) {
    this.restricted = restricted !== false;
    this.client = new McpNativeClient({ command, args, env, restricted: this.restricted, logger, server, timeout });
  }

  async connectAndGetTools() {
    await this.client.connect();
    const response = await this.client.listTools();
    return response.tools || [];
  }

  async executeTool(name, args) {
    return this.client.callTool(name, args);
  }
  async close() {
    await this.client.close();
  }
}
