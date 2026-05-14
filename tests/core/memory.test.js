import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function makeJsonResponse(body) {
  const text = JSON.stringify(body);
  return { ok: true, status: 200, text: async () => text };
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

function findReminderText(payload) {
  const userMessages = payload.messages.filter((m) => m.role === 'user' && Array.isArray(m.content));
  const userMsg = userMessages[userMessages.length - 1];
  if (!userMsg) return '';
  const parts = userMsg.content.filter(
    (p) => typeof p.text === 'string' && p.text.startsWith('<system-reminder>') && p.text.endsWith('</system-reminder>'),
  );
  return parts.map((p) => p.text).join('\n\n');
}

describe('Agent — memoryHint injector', () => {
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

  it('default memory hint lists the four builtin type names', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryIndex: false, skillList: false },
    });
    await agent.run('hi');

    const text = findReminderText(fetchStub.captured[0]);
    assert.match(text, /## Memory system/);
    assert.match(text, /\*\*user\*\*/);
    assert.match(text, /\*\*feedback\*\*/);
    assert.match(text, /\*\*project\*\*/);
    assert.match(text, /\*\*reference\*\*/);
  });

  it('custom memoryTypes merge on top of defaults', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryIndex: false, skillList: false },
      memoryTypes: { observation: 'Things observed about the environment.' },
    });
    await agent.run('hi');

    const text = findReminderText(fetchStub.captured[0]);
    // custom type rendered
    assert.match(text, /\*\*observation\*\*: Things observed about the environment\./);
    // defaults still present
    assert.match(text, /\*\*user\*\*/);
    assert.match(text, /\*\*feedback\*\*/);
  });

  it('memoryHint references the using-memory skill and Skill tool', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryIndex: false, skillList: false },
    });
    await agent.run('hi');

    const text = findReminderText(fetchStub.captured[0]);
    assert.match(text, /using-memory/);
    assert.match(text, /Skill tool/);
    assert.match(text, /argument="using-memory"/);
    assert.match(text, /MUST/);
  });

  it('memoryHint emits the configured memoryDir path', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryIndex: false, skillList: false },
      memoryDir: '/tmp/custom/memory',
    });
    await agent.run('hi');

    const text = findReminderText(fetchStub.captured[0]);
    assert.match(text, /\/tmp\/custom\/memory/);
  });

  it('memoryHint disabled via injectors map produces no hint content', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryIndex: false, memoryHint: false, skillList: false },
    });
    await agent.run('hi');

    const text = findReminderText(fetchStub.captured[0]);
    assert.doesNotMatch(text, /Memory system/);
    assert.doesNotMatch(text, /using-memory/);
  });
});

describe('Agent — memoryIndex injector', () => {
  let Agent;
  let originalFetch;
  let tempDir;

  before(async () => {
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
    originalFetch = global.fetch;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'));
  });

  after(() => {
    global.fetch = originalFetch;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns empty when memoryDir is missing entirely', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryHint: false, skillList: false },
      memoryDir: path.join(tempDir, 'does-not-exist'),
    });
    await agent.run('hi');

    const text = findReminderText(fetchStub.captured[0]);
    assert.doesNotMatch(text, /Memory index/);
  });

  it('returns empty when MEMORY.md is missing inside an existing memoryDir', async () => {
    const subDir = path.join(tempDir, 'exists-without-index');
    fs.mkdirSync(subDir, { recursive: true });

    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryHint: false, skillList: false },
      memoryDir: subDir,
    });
    await agent.run('hi');

    const text = findReminderText(fetchStub.captured[0]);
    assert.doesNotMatch(text, /Memory index/);
  });

  it('returns empty when MEMORY.md exists but contains only whitespace', async () => {
    const subDir = path.join(tempDir, 'empty-index');
    fs.mkdirSync(subDir, { recursive: true });
    fs.writeFileSync(path.join(subDir, 'MEMORY.md'), '   \n\n   \n');

    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryHint: false, skillList: false },
      memoryDir: subDir,
    });
    await agent.run('hi');

    const text = findReminderText(fetchStub.captured[0]);
    assert.doesNotMatch(text, /Memory index/);
  });

  it('memoryDir resolution respects ensureSafePath (path outside cwd is rejected silently)', async () => {
    const fetchStub = captureFetch();
    global.fetch = fetchStub;

    // /etc is outside cwd, ensureSafePath should reject and the injector returns ''.
    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: { date: false, contextFiles: false, memoryHint: false, skillList: false },
      memoryDir: '/etc/openrouter-memory',
    });

    // Should not throw — injector swallows the rejection.
    await agent.run('hi');

    const text = findReminderText(fetchStub.captured[0]);
    assert.doesNotMatch(text, /Memory index/);
  });
});

describe('Agent — using-memory skill discovery', () => {
  it('using-memory is discoverable via SkillRegistry', async () => {
    const registryMod = await import('../../src/registry/skill.js');
    const registry = registryMod.default;
    await registry._ensureDiscovered();
    const skill = registry.get('using-memory');
    assert.ok(skill, 'expected built-in using-memory skill to be discovered');
    assert.ok(typeof skill.description === 'string' && skill.description.length > 0);
  });
});
