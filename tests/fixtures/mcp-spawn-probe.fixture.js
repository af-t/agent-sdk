import { McpNativeClient } from '../../src/integrations/mcp-client.js';

const client = new McpNativeClient({ command: 'missing-mcp-command-for-test' });
try {
  await client.connect();
  process.exitCode = 1;
} catch (error) {
  if (!error?.message) process.exitCode = 1;
}
