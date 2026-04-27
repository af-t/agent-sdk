import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { EventEmitter } from 'node:events';

export class McpNativeClient extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.process = null;
    this.rl = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.initialized = false;
    this.capabilities = null;
    this.serverInfo = null;
  }

  async connect() {
    this.process = spawn(this.config.command, this.config.args || [], {
      env: { ...process.env, ...(this.config.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stderr.on('data', (data) => {
      console.error(`[MCP Server Error]: ${data.toString()}`);
    });

    this.rl = createInterface({
      input: this.process.stdout,
      terminal: false
    });

    this.rl.on('line', (line) => {
      const message = this._parseMessage(line);
      if (!message) return;
      this._handleMessage(message);
    });

    this.process.on('error', (err) => {
      this.emit('error', err);
    });

    this.process.on('exit', (code) => {
      this.emit('exit', code);
      this._cleanup();
    });

    const response = await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'mcp-native-client', version: '1.0.0' }
    });

    this.initialized = true;
    this.capabilities = response.capabilities;
    this.serverInfo = response.serverInfo;

    await this.notify('notifications/initialized', {});
  }

  async request(method, params, timeout = 30000) {
    if (!this.process || this.process.killed) {
        throw new Error("Process not running");
    }
    const id = ++this.requestId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} timed out after ${timeout}ms`));
      }, timeout);
      
      this.pendingRequests.set(id, { 
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      
      try {
        this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + '\n');
      } catch (err) {
        this.pendingRequests.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  async listTools() {
    return this.request('tools/list', {});
  }

  async callTool(name, args) {
    return this.request('tools/call', {
      name,
      arguments: args
    });
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
    return this.request('prompts/get', {
      name,
      arguments: args
    });
  }

  async notify(method, params) {
    if (!this.process || this.process.killed) {
        throw new Error("Process not running");
    }
    const message = {
      jsonrpc: '2.0',
      method,
      params
    };
    try {
      this.process.stdin.write(JSON.stringify(message) + '\n');
    } catch (err) {
      // For notifications we might just log or ignore if it fails to write
      console.error(`Failed to send notification ${method}: ${err.message}`);
    }
  }

  async close() {
    if (this.process) {
      this.process.kill();
      this._cleanup();
    }
  }

  _cleanup() {
    this.rl?.close();
    this.process = null;
    for (const { reject } of this.pendingRequests.values()) {
      reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }

  _handleMessage(message) {
    if (message.id !== undefined) {
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        this.pendingRequests.delete(message.id);
        if (message.error) {
          pending.reject(message.error);
        } else {
          pending.resolve(message.result);
        }
      }
    } else if (message.method) {
      this.emit('notification', message);
    }
  }

  _parseMessage(line) {
    try {
      return JSON.parse(line.trim());
    } catch (e) {
      return null;
    }
  }
}
