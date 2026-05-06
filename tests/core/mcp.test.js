import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

describe('McpNativeClient', () => {
  let McpNativeClient;

  before(async () => {
    const mod = await import('../../src/core/mcp.js');
    McpNativeClient = mod.McpNativeClient;
  });

  it('constructor sets default properties', () => {
    const config = {
      command: 'echo',
      args: ['hello'],
      env: { FOO: 'bar' },
      timeout: 5000,
    };
    const client = new McpNativeClient(config);
    assert.ok(client instanceof EventEmitter);
    assert.equal(client.config, config);
    assert.equal(client.process, null);
    assert.equal(client.rl, null);
    assert.equal(client.requestId, 0);
    assert.ok(client.pendingRequests instanceof Map);
    assert.equal(client.initialized, false);
    assert.equal(client.capabilities, null);
    assert.equal(client.serverInfo, null);
    assert.equal(client.defaultTimeout, 5000);
  });

  it('constructor uses default MCP_TIMEOUT when timeout not provided', async () => {
    const { CONSTANTS } = await import('../../src/core/utils.js');
    const client = new McpNativeClient({ command: 'echo' });
    assert.equal(client.defaultTimeout, CONSTANTS.MCP_TIMEOUT);
    assert.equal(client.defaultTimeout, 30000);
  });

  it('constructor with minimal config', () => {
    const client = new McpNativeClient({ command: 'cat' });
    assert.equal(client.config.command, 'cat');
    assert.equal(client.config.args, undefined);
    assert.equal(client.config.env, undefined);
    assert.equal(client.initialized, false);
  });
});

describe('McpClientWrapper', () => {
  let McpClientWrapper;
  let McpNativeClient;

  before(async () => {
    const mod = await import('../../src/core/mcp.js');
    McpClientWrapper = mod.McpClientWrapper;
    McpNativeClient = mod.McpNativeClient;
  });

  it('constructor creates an McpNativeClient instance', () => {
    const wrapper = new McpClientWrapper({
      command: 'test-server',
      args: ['--port', '8080'],
      env: { PATH: '/usr/bin' },
    });
    assert.ok(wrapper.client instanceof McpNativeClient);
    assert.equal(wrapper.client.config.command, 'test-server');
    assert.deepEqual(wrapper.client.config.args, ['--port', '8080']);
    assert.deepEqual(wrapper.client.config.env, { PATH: '/usr/bin' });
  });

  it('constructor with minimal options', () => {
    const wrapper = new McpClientWrapper({ command: 'simple' });
    assert.ok(wrapper.client instanceof McpNativeClient);
    assert.equal(wrapper.client.config.command, 'simple');
  });

  it('has connectAndGetTools, executeTool, and close methods', () => {
    const wrapper = new McpClientWrapper({ command: 'dummy' });
    assert.equal(typeof wrapper.connectAndGetTools, 'function');
    assert.equal(typeof wrapper.executeTool, 'function');
    assert.equal(typeof wrapper.close, 'function');
  });
});
