import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { sanitizeChildEnvironment, sanitizeInheritedEnvironment } from '../support/environment.js';
import { LIMITS } from '../support/payload.js';
import { resolveLogger } from '../support/logger.js';
import { createAbortError } from '../support/retry.js';

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
    this.closePromise = null;
  }

  async connect() {
    const childEnv =
      this.config.restricted !== false
        ? { ...sanitizeInheritedEnvironment(process.env), ...sanitizeChildEnvironment(this.config.env || {}) }
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
    this.process.on('error', (error) => this.#handleTransportFailure(error));
    this.process.on('exit', (code) => {
      this.emit('exit', code);
      this.#cleanup();
      if (!this.closePromise) this.process = null;
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

  async request(method, params, { timeoutMs, signal } = {}) {
    const effectiveTimeout = timeoutMs || this.defaultTimeout;
    if (signal?.aborted) throw createAbortError('MCP request aborted');
    if (!this.process || this.process.killed) throw new Error('Process not running');
    const requestId = ++this.requestId;
    return new Promise((resolve, reject) => {
      const settle = (callback, value) => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending) return;
        this.pendingRequests.delete(requestId);
        clearTimeout(pending.timer);
        pending.signal?.removeEventListener('abort', pending.abortHandler);
        callback(value);
      };
      const timer = setTimeout(
        () => settle(reject, new Error(`Request ${method} timed out after ${effectiveTimeout}ms`)),
        effectiveTimeout,
      );
      const abortHandler = () => settle(reject, createAbortError('MCP request aborted'));
      this.pendingRequests.set(requestId, { resolve, reject, timer, signal, abortHandler });
      signal?.addEventListener('abort', abortHandler, { once: true });
      if (!this.pendingRequests.has(requestId)) return;
      try {
        this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      } catch (error) {
        settle(reject, error);
      }
    });
  }

  async listTools(options) {
    return this.request('tools/list', {}, options);
  }
  async callTool(name, args, options) {
    return this.request('tools/call', { name, arguments: args }, options);
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
    if (this.closePromise) return this.closePromise;
    if (!this.process) return;
    const processToClose = this.process;
    this.closePromise = new Promise((resolve) => {
      const killTimer = setTimeout(() => {
        try {
          if (processToClose.exitCode === null) processToClose.kill('SIGKILL');
        } catch {}
      }, 1000);
      const finish = () => {
        clearTimeout(killTimer);
        this.#cleanup();
        this.process = null;
        resolve();
      };
      processToClose.once('close', finish);
      try {
        processToClose.stdin.end();
      } catch {}
      try {
        if (processToClose.exitCode === null) processToClose.kill('SIGTERM');
      } catch {}
    });
    return this.closePromise;
  }

  #cleanup() {
    this.rl?.close();
    this.rl = null;
    for (const [requestId, pending] of this.pendingRequests) {
      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abortHandler);
      pending.reject(new Error('Connection closed'));
    }
  }

  #handleTransportFailure(error) {
    this.logger.error({ server: this.config.server, error }, 'MCP transport failed');
    for (const [requestId, pending] of this.pendingRequests) {
      this.pendingRequests.delete(requestId);
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.abortHandler);
      pending.reject(error);
    }
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
    clearTimeout(pending.timer);
    pending.signal?.removeEventListener('abort', pending.abortHandler);
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
    this.server = server;
    this.client = new McpNativeClient({ command, args, env, restricted: this.restricted, logger, server, timeout });
  }

  async connectAndGetTools() {
    await this.client.connect();
    const response = await this.client.listTools();
    return response.tools || [];
  }

  async executeTool(name, args, options) {
    return this.client.callTool(name, args, options);
  }
  async close() {
    await this.client.close();
  }
}
