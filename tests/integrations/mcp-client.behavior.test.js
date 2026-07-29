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
    const mod = await import('../../src/integrations/mcp-client.js');
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

  it('constructor uses default mcpTimeoutMs when timeout not provided', async () => {
    const { LIMITS } = await import('../../src/support/payload.js');
    const client = new McpNativeClient({ command: 'echo' });
    assert.equal(client.defaultTimeout, LIMITS.mcpTimeoutMs);
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

  it('rejects a missing command without terminating a child probe', async () => {
    const probe = path.join(fixturesDir, 'mcp-spawn-probe.fixture.js');
    const child = spawn(process.execPath, [probe], { stdio: 'ignore' });
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(exitCode, 0);
  });
});

describe('McpNativeClient: mock server connections', () => {
  let McpNativeClient;

  before(async () => {
    const mod = await import('../../src/integrations/mcp-client.js');
    McpNativeClient = mod.McpNativeClient;
  });

  // The suite checks Node process availability once.
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
        // The fixture allows two seconds for the timeout.
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
            // Platform timing may surface a timeout or connection error.
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
    'rejects pre-aborted and in-flight requests with AbortError',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const client = new McpNativeClient({
        command: process.execPath,
        args: [path.join(fixturesDir, 'mock-mcp-hanging-call.js')],
      });
      await client.connect();
      try {
        const preAborted = new AbortController();
        preAborted.abort();
        await assert.rejects(
          () => client.callTool('hang', {}, { signal: preAborted.signal }),
          (error) => error?.code === 'ABORT_ERROR',
        );

        const controller = new AbortController();
        const request = client.callTool('hang', {}, { signal: controller.signal });
        controller.abort();
        await assert.rejects(request, (error) => error?.code === 'ABORT_ERROR');
        assert.equal(client.pendingRequests.size, 0);
      } finally {
        await client.close();
      }
    },
  );

  it(
    'waits for the child process to exit before close resolves',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const client = new McpNativeClient({
        command: process.execPath,
        args: [path.join(fixturesDir, 'mock-mcp-hanging-call.js')],
      });
      await client.connect();
      const processId = client.process.pid;
      await client.close();
      assert.throws(() => process.kill(processId, 0), { code: 'ESRCH' });
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
        // The 10-second timeout exceeds the slow server's three-second delay.
        await client.connect();
        assert.equal(client.initialized, true);
        assert.ok(client.serverInfo);
        assert.equal(client.serverInfo.name, 'mock-slow-server');
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
        timeout: 500, // Very short timeout: server takes 3s to respond
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
    'redacts MCP diagnostics before delivering structured logs',
    { skip: !nodeAvailable ? 'node not spawnable' : undefined },
    async () => {
      const records = [];
      const client = new McpNativeClient({
        command: process.execPath,
        args: [path.join(fixturesDir, 'mock-mcp-hanging-call.js')],
        logger: {
          debug() {},
          info() {},
          error() {},
          warn(context, message) {
            records.push({ context, message });
          },
        },
      });
      try {
        await client.connect();
      } finally {
        await client.close();
      }
      const record = records.find((entry) => entry.message === 'MCP server stderr');
      assert.equal(record?.context.server, undefined);
      assert.doesNotMatch(JSON.stringify(record), /mcp-diagnostic-secret/);
      assert.match(JSON.stringify(record), /REDACTED/);
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
    const mod = await import('../../src/integrations/mcp-client.js');
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

describe('McpClientWrapper: functional', () => {
  let McpClientWrapper;
  let nodeAvailable = true;
  const toolsScript = path.join(fixturesDir, 'mock-mcp-tools.js');

  before(async () => {
    const mod = await import('../../src/integrations/mcp-client.js');
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
