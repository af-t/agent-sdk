import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

function makeJsonResponse(body) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text };
}

function stubFinal(content = 'ok') {
  return async (_url, opts) => {
    stubFinal.last = JSON.parse(opts.body);
    return makeJsonResponse({
      choices: [{ message: { content, reasoning: null, tool_calls: null } }],
      usage: { cost: 0, total_tokens: 5 },
    });
  };
}

function captureFetch() {
  const captured = [];
  const fn = async (_url, opts) => {
    captured.push(JSON.parse(opts.body));
    return makeJsonResponse({
      choices: [{ message: { content: 'ok', reasoning: null, tool_calls: null } }],
      usage: { cost: 0, total_tokens: 5 },
    });
  };
  fn.captured = captured;
  return fn;
}

function findReminderPart(payload) {
  // Aggregates every <system-reminder> part on the last user message.
  // First-turn and per-turn now produce separate blocks; tests inspect joined text.
  const userMessages = payload.messages.filter((m) => m.role === 'user');
  const userMsg = userMessages[userMessages.length - 1];
  if (!userMsg || !Array.isArray(userMsg.content)) return null;
  const parts = userMsg.content.filter(
    (p) =>
      typeof p.text === 'string' && p.text.startsWith('<system-reminder>') && p.text.endsWith('</system-reminder>'),
  );
  if (parts.length === 0) return null;
  return { text: parts.map((p) => p.text).join('\n\n') };
}

describe('Agent — injector registry', () => {
  let Agent;
  let ConfigError;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    const errMod = await import('../../src/core/errors.js');
    ConfigError = errMod.ConfigError;
  });

  it('registers and unregisters an injector roundtrip', () => {
    const agent = new Agent({ apiKey: 'sk' });
    agent.registerInjector({ name: 'demo', scope: 'per-turn', fn: () => 'x' });
    agent.unregisterInjector('demo');
    // Re-register after removal should succeed (no duplicate error).
    agent.registerInjector({ name: 'demo', scope: 'per-turn', fn: () => 'x' });
  });

  it('throws ConfigError on invalid scope', () => {
    const agent = new Agent({ apiKey: 'sk' });
    assert.throws(
      () => agent.registerInjector({ name: 'demo', scope: 'system', fn: () => 'x' }),
      (err) => err instanceof ConfigError && /scope must be one of/i.test(err.message),
    );
  });

  it('throws ConfigError on duplicate name within same scope', () => {
    const agent = new Agent({ apiKey: 'sk' });
    agent.registerInjector({ name: 'dup', scope: 'per-turn', fn: () => 'a' });
    assert.throws(
      () => agent.registerInjector({ name: 'dup', scope: 'per-turn', fn: () => 'b' }),
      (err) => err instanceof ConfigError && /already registered/i.test(err.message),
    );
  });

  it('allows same name across different scopes', () => {
    const agent = new Agent({ apiKey: 'sk' });
    agent.registerInjector({ name: 'shared', scope: 'per-turn', fn: () => 'p' });
    agent.registerInjector({ name: 'shared', scope: 'first-turn', fn: () => 'f' });
  });

  it('unregisterInjector is a no-op for unknown names', () => {
    const agent = new Agent({ apiKey: 'sk' });
    agent.unregisterInjector('nonexistent');
  });

  it('throws ConfigError when fn is not a function', () => {
    const agent = new Agent({ apiKey: 'sk' });
    assert.throws(
      () => agent.registerInjector({ name: 'bad', scope: 'per-turn', fn: 'not a fn' }),
      (err) => err instanceof ConfigError,
    );
  });
});

describe('Agent — first-turn vs per-turn semantics', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('first-turn injector runs once on turn 1 and not on subsequent turns', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({ apiKey: 'sk-test', injectors: { date: false } });
    let firstTurnCalls = 0;
    let perTurnCalls = 0;
    agent.registerInjector({
      name: 'first',
      scope: 'first-turn',
      fn: () => {
        firstTurnCalls++;
        return 'FIRST_CONTENT';
      },
    });
    agent.registerInjector({
      name: 'per',
      scope: 'per-turn',
      fn: () => {
        perTurnCalls++;
        return 'PER_CONTENT';
      },
    });

    await agent.run('hello');
    await agent.run('again');

    assert.equal(firstTurnCalls, 1, 'first-turn should fire exactly once across two runs');
    assert.equal(perTurnCalls, 2, 'per-turn should fire on every run');

    const r1 = findReminderPart(fetchStub.captured[0]);
    assert.ok(r1, 'turn 1 should have a reminder block');
    assert.match(r1.text, /FIRST_CONTENT/);
    assert.match(r1.text, /PER_CONTENT/);

    const r2 = findReminderPart(fetchStub.captured[1]);
    assert.ok(r2, 'turn 2 should have a reminder block');
    assert.doesNotMatch(r2.text, /FIRST_CONTENT/);
    assert.match(r2.text, /PER_CONTENT/);
  });

  it('reset() makes the next run() a fresh first-turn', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({ apiKey: 'sk-test', injectors: { date: false } });
    let firstTurnCalls = 0;
    agent.registerInjector({
      name: 'first',
      scope: 'first-turn',
      fn: () => {
        firstTurnCalls++;
        return 'FIRST';
      },
    });

    await agent.run('a');
    agent.reset();
    await agent.run('b');

    assert.equal(firstTurnCalls, 2);
  });
});

describe('Agent — builtin date injector', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('default agent emits a date line via per-turn injector', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({ apiKey: 'sk-test' });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.ok(part, 'expected a <system-reminder> block');
    assert.match(part.text, /Current date: \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  });

  it('disable via injectors: { date: false } omits the date line', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, memoryIndex: false, memoryHint: false, skillList: false, contextFiles: false },
    });
    await agent.run('hi');

    // No other injectors registered, so no reminder block should appear at all.
    const part = findReminderPart(fetchStub.captured[0]);
    assert.equal(part, null, 'expected no reminder block when date is disabled and no other injectors registered');
  });
});

describe('Agent — empty injectors yield no reminder block', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('all-empty injector outputs skip the <system-reminder> tags entirely', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, memoryIndex: false, memoryHint: false, skillList: false, contextFiles: false },
    });
    agent.registerInjector({ name: 'blank', scope: 'per-turn', fn: () => '' });
    agent.registerInjector({ name: 'spaces', scope: 'per-turn', fn: () => '   \n\n  ' });

    await agent.run('hi');
    const part = findReminderPart(fetchStub.captured[0]);
    assert.equal(part, null);
  });
});

describe('Agent — cache_control preservation with injection', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('reminder is inserted as second-to-last part; ephemeral marker stays on absolute last part', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryIndex: false, memoryHint: false, skillList: false },
    });
    agent.registerInjector({ name: 'marker', scope: 'per-turn', fn: () => 'REMINDER_TEXT' });

    await agent.run('hello user');

    const payload = fetchStub.captured[0];
    const userMsg = payload.messages.find((m) => m.role === 'user');
    assert.ok(Array.isArray(userMsg.content));
    assert.ok(userMsg.content.length >= 2, 'user message should have reminder + original parts');

    const last = userMsg.content[userMsg.content.length - 1];
    const secondToLast = userMsg.content[userMsg.content.length - 2];

    assert.deepEqual(last.cache_control, { type: 'ephemeral' }, 'cache_control must be on the absolute last part');
    assert.match(secondToLast.text, /<system-reminder>/);
    assert.match(secondToLast.text, /REMINDER_TEXT/);
    assert.equal(secondToLast.cache_control, undefined, 'reminder part should NOT have cache_control');

    // Per-turn injector output IS persisted into this.messages (cache consistency).
    const origUser = agent.messages.find((m) => m.role === 'user');
    assert.equal(origUser.content.length, 2, 'per-turn output is persisted in this.messages');
    assert.match(origUser.content[0].text, /REMINDER_TEXT/);
    assert.equal(origUser.content[0].cache_control, undefined, 'cache_control must not leak into this.messages');
    assert.equal(origUser.content[1].cache_control, undefined, 'cache_control must not leak into this.messages');
  });

  it('first-turn and per-turn injectors both persist in this.messages', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryIndex: false, memoryHint: false, skillList: false },
    });
    agent.registerInjector({ name: 'first', scope: 'first-turn', fn: () => 'FIRST_BODY' });
    agent.registerInjector({ name: 'per', scope: 'per-turn', fn: () => 'PER_BODY' });

    await agent.run('hello');

    const origUser = agent.messages.find((m) => m.role === 'user');
    // First-turn block + per-turn block + original prompt = 3 parts in persisted history.
    assert.equal(origUser.content.length, 3, 'both injectors persist in this.messages');
    assert.match(origUser.content[0].text, /FIRST_BODY/);
    assert.match(origUser.content[1].text, /PER_BODY/);
    assert.equal(origUser.content[2].text, 'hello');

    // Payload sees BOTH blocks (separate parts) — both from history now.
    const userMsg = fetchStub.captured[0].messages.find((m) => m.role === 'user');
    const reminderTexts = userMsg.content
      .filter((p) => typeof p.text === 'string' && p.text.startsWith('<system-reminder>'))
      .map((p) => p.text);
    assert.equal(reminderTexts.length, 2, 'payload should carry two reminder blocks (first-turn + per-turn)');
    assert.ok(reminderTexts.some((t) => t.includes('FIRST_BODY')));
    assert.ok(reminderTexts.some((t) => t.includes('PER_BODY')));
  });
});

describe('Agent — onBeforeRequest hook', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('fires after injector assembly with mutable payload, in registration order', async () => {
    let captured;
    global.fetch = async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return makeJsonResponse({
        choices: [{ message: { content: 'ok', reasoning: null, tool_calls: null } }],
        usage: { cost: 0, total_tokens: 5 },
      });
    };

    const agent = new Agent({ apiKey: 'sk-test', injectors: { date: false } });
    agent.registerInjector({ name: 'reminder', scope: 'per-turn', fn: () => 'INJ_TEXT' });

    const order = [];
    agent.onBeforeRequest((p) => {
      order.push('first');
      // reminder present when hook fires
      const userMsg = p.messages.find((m) => m.role === 'user');
      assert.ok(userMsg.content.some((c) => typeof c.text === 'string' && c.text.includes('INJ_TEXT')));
      p.tag_a = true;
    });
    agent.onBeforeRequest((p) => {
      order.push('second');
      p.tag_b = true;
    });

    await agent.run('hi');

    assert.deepEqual(order, ['first', 'second']);
    assert.equal(captured.tag_a, true);
    assert.equal(captured.tag_b, true);
  });

  it('returns a disposer that removes the hook', async () => {
    let captured;
    global.fetch = async (_url, opts) => {
      captured = JSON.parse(opts.body);
      return makeJsonResponse({
        choices: [{ message: { content: 'ok', reasoning: null, tool_calls: null } }],
        usage: { cost: 0, total_tokens: 5 },
      });
    };

    const agent = new Agent({ apiKey: 'sk-test', injectors: { date: false } });
    const dispose = agent.onBeforeRequest((p) => {
      p.tag = true;
    });
    dispose();
    await agent.run('hi');
    assert.equal(captured.tag, undefined);
  });

  it('throws from onBeforeRequest propagate to caller', async () => {
    global.fetch = stubFinal('ok');
    const agent = new Agent({ apiKey: 'sk-test', injectors: { date: false } });
    agent.onBeforeRequest(() => {
      // non-retryable so withRetry surfaces fast
      const err = new Error('hook failure');
      err.status = 400;
      throw err;
    });
    await assert.rejects(() => agent.run('hi'), /hook failure/);
  });

  it('hooks and per-turn injectors fire once per turn, not per retry', async () => {
    // Speed up withRetry delay so test stays fast.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    let fetchCalls = 0;
    global.fetch = async (_url, _opts) => {
      fetchCalls++;
      if (fetchCalls === 1) {
        // First attempt: retryable 5xx error so withRetry triggers a retry.
        return { ok: false, status: 503, json: async () => ({ error: { message: 'transient' } }) };
      }
      return makeJsonResponse({
        choices: [{ message: { content: 'ok', reasoning: null, tool_calls: null } }],
        usage: { cost: 0, total_tokens: 5 },
      });
    };

    try {
      const agent = new Agent({
        apiKey: 'sk-test',
        injectors: { date: false, contextFiles: false, memoryIndex: false, memoryHint: false, skillList: false },
      });
      let hookCalls = 0;
      let injectorCalls = 0;
      agent.onBeforeRequest(() => {
        hookCalls++;
      });
      agent.registerInjector({
        name: 'counter',
        scope: 'per-turn',
        fn: () => {
          injectorCalls++;
          return 'COUNTED';
        },
      });

      await agent.run('hi');

      assert.equal(fetchCalls, 2, 'fetch should retry after 503');
      assert.equal(hookCalls, 1, 'onBeforeRequest hook must run once, not per retry');
      assert.equal(injectorCalls, 1, 'per-turn injector must run once, not per retry');
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('Agent — async injectors', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('awaits Promise-returning injectors', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({ apiKey: 'sk-test', injectors: { date: false } });
    agent.registerInjector({
      name: 'async',
      scope: 'per-turn',
      fn: async () => {
        await new Promise((r) => setTimeout(r, 5));
        return 'ASYNC_VALUE';
      },
    });

    await agent.run('hi');
    const part = findReminderPart(fetchStub.captured[0]);
    assert.ok(part);
    assert.match(part.text, /ASYNC_VALUE/);
  });
});

describe('Agent — contextFiles first-turn injector', () => {
  let Agent;
  let originalFetch;
  const fixtureDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'context-files');

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('AGENTS.md loaded when present', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false },
      contextFiles: [path.join(fixtureDir, 'AGENTS.md')],
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.ok(part, 'expected a <system-reminder> block with context file content');
    assert.match(part.text, /This is a test agent context file/);
  });

  it('missing file is silent (no throw)', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, memoryIndex: false, memoryHint: false, skillList: false },
      contextFiles: ['does-not-exist.md'],
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.equal(part, null, 'expected no reminder block when context file is missing');
  });

  it('multiple files read in order with headers', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false },
      contextFiles: [path.join(fixtureDir, 'AGENTS.md'), path.join(fixtureDir, 'PROJECT.md')],
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.ok(part, 'expected a <system-reminder> block with multiple file content');
    assert.match(part.text, /## AGENTS\.md/);
    assert.match(part.text, /## PROJECT\.md/);
    assert.match(part.text, /This is a test agent context file/);
    assert.match(part.text, /Some project notes here/);
  });

  it('path traversal attempt rejected by ensureSafePath', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, memoryIndex: false, memoryHint: false, skillList: false },
      contextFiles: ['../../../etc/passwd'],
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.equal(part, null, 'expected no reminder block for path traversal attempt');
  });

  it('disable via injectors: { contextFiles: false } omits context injection', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryIndex: false, memoryHint: false, skillList: false },
      contextFiles: [path.join(fixtureDir, 'AGENTS.md')],
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.equal(part, null, 'expected no reminder block when contextFiles injector is disabled');
  });

  it('default contextFiles is [AGENTS.md] when no option provided', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    // Create a temp project dir with AGENTS.md at cwd
    const tmpDir = path.join(fixtureDir, 'tmp-test-project');
    const origCwd = process.cwd();
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'AGENTS.md'), '# Default Agent\nDefault context.');
      process.chdir(tmpDir);

      const agent = new Agent({
        apiKey: 'sk-test',
        injectors: { date: false },
      });
      await agent.run('hi');

      const part = findReminderPart(fetchStub.captured[0]);
      assert.ok(part, 'expected a <system-reminder> block from default AGENTS.md');
      assert.match(part.text, /Default context/);
    } finally {
      process.chdir(origCwd);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('Agent — skillList first-turn injector', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('builtin skills appear in skill list', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: {
        date: false,
        contextFiles: false,
        memoryIndex: false,
        memoryHint: false,
      },
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.ok(part, 'expected a <system-reminder> block with skill list');
    assert.match(part.text, /Available skills/);
    // builtin skills should appear
    assert.match(part.text, /code-remediation/);
    assert.match(part.text, /tmux/);
    assert.match(part.text, /using-memory/);
  });

  it('disable via injectors: { skillList: false } omits skill list', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: {
        date: false,
        contextFiles: false,
        memoryIndex: false,
        memoryHint: false,
        skillList: false,
      },
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.equal(part, null, 'expected no reminder block when all injectors disabled');
  });

  it('skill descriptions are truncated to ~120 chars', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: {
        date: false,
        contextFiles: false,
        memoryIndex: false,
        memoryHint: false,
      },
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.ok(part);
    // Find the skill list section
    const lines = part.text.split('\n');
    for (const line of lines) {
      if (line.startsWith('- ') && line.includes(' — ')) {
        const desc = line.split(' — ')[1];
        assert.ok(desc.length <= 120, `description for '${line}' is too long: ${desc.length} chars`);
      }
    }
  });
});

describe('Agent — pluginInstructions first-turn injector', () => {
  let Agent;
  let skillRegistry;
  let originalFetch;
  let pluginsDir;

  before(async () => {
    Agent = (await import('../../src/core/agent.js')).default;
    skillRegistry = (await import('../../src/registry/skill.js')).default;
    originalFetch = global.fetch;

    pluginsDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-plugins-test-'));
    await fs.promises.mkdir(path.join(pluginsDir, 'alpha'), { recursive: true });
    await fs.promises.writeFile(
      path.join(pluginsDir, 'alpha', 'AGENTS.md'),
      'Use alpha skills when the task is about alpha things.',
      'utf8',
    );
  });

  after(async () => {
    global.fetch = originalFetch;
    skillRegistry.configure({ pluginsDir: null });
    skillRegistry.reset();
    await fs.promises.rm(pluginsDir, { recursive: true, force: true });
  });

  it('injects plugin AGENTS.md into the first-turn reminder', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryIndex: false, memoryHint: false, skillList: false },
      storagePaths: { pluginsDir },
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    assert.ok(part, 'expected a reminder block');
    assert.match(part.text, /## Plugin instructions/);
    assert.match(part.text, /### alpha/);
    assert.match(part.text, /Use alpha skills when/);
  });

  it('opt-out via injectors.pluginInstructions = false omits the section', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: {
        date: false,
        contextFiles: false,
        memoryIndex: false,
        memoryHint: false,
        skillList: false,
        pluginInstructions: false,
      },
      storagePaths: { pluginsDir },
    });
    await agent.run('hi');

    const part = findReminderPart(fetchStub.captured[0]);
    if (part) assert.doesNotMatch(part.text, /## Plugin instructions/);
  });

  it('no plugin AGENTS.md yields no plugin section', async () => {
    const emptyDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'agent-plugins-empty-'));
    try {
      const fetchStub = captureFetch();
      global.fetch = fetchStub;

      const agent = new Agent({
        apiKey: 'sk-test',
        injectors: { date: false, contextFiles: false, memoryIndex: false, memoryHint: false, skillList: false },
        storagePaths: { pluginsDir: emptyDir },
      });
      await agent.run('hi');

      const part = findReminderPart(fetchStub.captured[0]);
      if (part) assert.doesNotMatch(part.text, /## Plugin instructions/);
    } finally {
      await fs.promises.rm(emptyDir, { recursive: true, force: true });
    }
  });
});
