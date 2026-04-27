import { McpNativeClient } from './mcp-native.js';

export class McpClientWrapper {
  constructor({ command, args, env }) {
    this.client = new McpNativeClient({ command, args, env });
  }

  async connectAndGetTools() {
    await this.client.connect();
    const response = await this.client.listTools();
    return response.tools || [];
  }

  async executeTool(name, args) {
    return await this.client.callTool(name, args);
  }

  async close() {
    await this.client.close();
  }
}
