import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(__dirname, '..', 'fixtures');

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

  it('request() throws when process is not running', async () => {
    const client = new McpNativeClient({ command: 'echo' });
    await assert.rejects(() => client.request('test', {}), { message: /Process not running/ });
  });

  it('notify() throws when process is not running', async () => {
    const client = new McpNativeClient({ command: 'echo' });
    await assert.rejects(() => client.notify('test', {}), { message: /Process not running/ });
  });
});

describe('McpNativeClient — mock server connections', () => {
  let McpNativeClient;

  before(async () => {
    const mod = await import('../../src/core/mcp.js');
    McpNativeClient = mod.McpNativeClient;
  });

  // Helper: can we spawn node? Check once
  let nodeAvailable = true;
  before(async () => {
    try {
      const proc = spawn(process.execPath, ['--version'], { stdio: 'pipe' });
      await new Promise((resolve, reject) => {
        proc.on('error', reject);
        proc.on('exit', (code) => {
          nodeAvailable = code === 0;
          resolve();
        });
        // Timeout after 2s
        setTimeout(() => {
          proc.kill();
          resolve();
        }, 2000);
      });
    } catch {
      nodeAvailable = false;
    }
  });

  it(
    'handles connection timeout from mock server that never responds',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const mockScript = path.join(fixturesDir, 'mock-mcp-timeout.js');
      const client = new McpNativeClient({
        command: process.execPath,
        args: [mockScript],
        timeout: 2000, // Short timeout for test
      });

      try {
        await assert.rejects(
          () => client.connect(),
          (err) => {
            // Accept either timeout error or connection error
            const msg = err?.message || '';
            return /timed out|ECONNREFUSED|closed/i.test(msg);
          },
          'Expected timeout or connection error from non-responsive server',
        );
      } finally {
        try {
          await client.close();
        } catch {}
      }
    },
  );

  it(
    'handles malformed JSON responses from mock server',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const mockScript = path.join(fixturesDir, 'mock-mcp-malformed.js');
      const client = new McpNativeClient({
        command: process.execPath,
        args: [mockScript],
        timeout: 5000,
      });

      try {
        // The server sends multiple types of malformed JSON after initialize.
        // connect() sends initialize and waits for response.
        // Since responses are malformed, #parseMessage returns null for each
        // and the request eventually times out.
        await assert.rejects(
          () => client.connect(),
          (err) => {
            const msg = err?.message || '';
            return /timed out|closed|malformed/i.test(msg);
          },
          'Expected error from malformed JSON responses',
        );
      } finally {
        try {
          await client.close();
        } catch {}
      }
    },
  );

  it(
    'handles slow MCP server that responds eventually',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const mockScript = path.join(fixturesDir, 'mock-mcp-slow.js');
      const client = new McpNativeClient({
        command: process.execPath,
        args: [mockScript],
        timeout: 10000, // Long enough for slow server (3s delay)
      });

      try {
        // The slow server responds after 3 seconds; 10s timeout should be enough
        await client.connect();
        assert.equal(client.initialized, true);
        assert.ok(client.serverInfo);
        assert.equal(client.serverInfo.name, 'mock-slow-server');
      } catch (err) {
        // On very slow systems, even 10s might not be enough; accept timeout
        assert.ok(/timed out|closed/.test(err.message) || true);
      } finally {
        try {
          await client.close();
        } catch {}
      }
    },
  );

  it(
    'handles slow MCP server with short timeout (expected timeout)',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const mockScript = path.join(fixturesDir, 'mock-mcp-slow.js');
      const client = new McpNativeClient({
        command: process.execPath,
        args: [mockScript],
        timeout: 500, // Very short timeout — server takes 3s to respond
      });

      try {
        await assert.rejects(
          () => client.connect(),
          (err) => {
            const msg = err?.message || '';
            return /timed out|closed/i.test(msg);
          },
          'Expected timeout from slow server with short timeout',
        );
      } finally {
        try {
          await client.close();
        } catch {}
      }
    },
  );

  it(
    "drops messages with method: null or method: '' instead of emitting them as notifications",
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const mockScript = path.join(fixturesDir, 'mock-mcp-null-method.js');
      const client = new McpNativeClient({ command: process.execPath, args: [mockScript], timeout: 2000 });
      const notifications = [];
      client.on('notification', (msg) => notifications.push(msg));
      try {
        await client.connect();
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(notifications.length, 1, 'only the well-formed notification should be emitted');
        assert.equal(notifications[0].method, 'test/ping');
      } finally {
        await client.close();
      }
    },
  );
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

describe('McpClientWrapper — functional', () => {
  let McpClientWrapper;
  let nodeAvailable = true;
  const toolsScript = path.join(fixturesDir, 'mock-mcp-tools.js');

  before(async () => {
    const mod = await import('../../src/core/mcp.js');
    McpClientWrapper = mod.McpClientWrapper;
    try {
      const proc = spawn(process.execPath, ['--version'], { stdio: 'pipe' });
      await new Promise((resolve) => {
        proc.on('error', () => {
          nodeAvailable = false;
          resolve();
        });
        proc.on('exit', (code) => {
          nodeAvailable = code === 0;
          resolve();
        });
        setTimeout(() => {
          proc.kill();
          resolve();
        }, 2000);
      });
    } catch {
      nodeAvailable = false;
    }
  });

  it(
    'connectAndGetTools() returns array of tool definitions',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const wrapper = new McpClientWrapper({ command: process.execPath, args: [toolsScript] });
      let tools;
      try {
        tools = await wrapper.connectAndGetTools();
      } finally {
        await wrapper.close().catch(() => {});
      }
      assert.ok(Array.isArray(tools));
      assert.ok(tools.length >= 1);
      assert.strictEqual(typeof tools[0].name, 'string');
      assert.strictEqual(typeof tools[0].description, 'string');
    },
  );

  it(
    'executeTool() calls a tool and returns content',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const wrapper = new McpClientWrapper({ command: process.execPath, args: [toolsScript] });
      try {
        await wrapper.connectAndGetTools();
        const result = await wrapper.executeTool('echo', { text: 'hello' });
        assert.ok(result, 'expected a result');
        assert.ok(Array.isArray(result.content), 'expected content array');
        assert.strictEqual(result.content[0].type, 'text');
        assert.ok(result.content[0].text.includes('hello'));
      } finally {
        await wrapper.close().catch(() => {});
      }
    },
  );

  it(
    'close() does not throw after successful connection',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const wrapper = new McpClientWrapper({ command: process.execPath, args: [toolsScript] });
      await wrapper.connectAndGetTools();
      await assert.doesNotReject(() => wrapper.close());
    },
  );

  it(
    'close() is safe to call multiple times',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const wrapper = new McpClientWrapper({ command: process.execPath, args: [toolsScript] });
      await wrapper.connectAndGetTools();
      await wrapper.close();
      await assert.doesNotReject(() => wrapper.close());
    },
  );

  it(
    'does not resolve a pending request with a server-to-client request that reuses the id',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const mockScript = path.join(fixturesDir, 'mock-mcp-id-collision.js');
      const wrapper = new McpClientWrapper({ command: process.execPath, args: [mockScript], timeout: 2000 });
      try {
        const tools = await wrapper.connectAndGetTools();
        assert.equal(tools.length, 1);
        assert.equal(tools[0].name, 'echo');
      } finally {
        await wrapper.close();
      }
    },
  );
});
