import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class McpClientWrapper {
  constructor({ command, args, env }) {
    this.command = command;
    this.args = args;
    this.env = env;
    
    this.transport = new StdioClientTransport({
      command,
      args,
      env
    });
    
    this.client = new Client(
      { name: "openrouter-agent", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );
  }

  async connectAndGetTools() {
    await this.client.connect(this.transport);
    const response = await this.client.listTools();
    return response.tools || [];
  }

  async executeTool(name, args) {
    return await this.client.callTool({
      name,
      arguments: args
    });
  }

  async close() {
    await this.client.close();
  }
}
