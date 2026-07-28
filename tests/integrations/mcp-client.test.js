import { test } from 'node:test';
import assert from 'node:assert/strict';
import { McpClientWrapper, McpNativeClient } from '../../src/integrations/mcp-client.js';

test('exposes MCP client classes with a restricted default', () => {
  const wrapper = new McpClientWrapper({ command: 'true' });
  assert.ok(wrapper.client instanceof McpNativeClient);
  assert.equal(wrapper.restricted, true);
});
