import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../../src/registry/tool.js';
import { Recording } from '../../src/core/recording.js';

const NO_INJECTORS = {
  date: false,
  contextFiles: false,
  memoryIndex: false,
  memoryHint: false,
  skillList: false,
};

function nonStreamResponse(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

test('a full-level run records request/response and applies redact', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentfull-'));
  const Agent = (await import('../../src/core/agent.js')).default;
  const orig = global.fetch;
  let n = 0;
  global.fetch = async () => {
    n++;
    if (n === 1) {
      return nonStreamResponse({
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'let me echo',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Echo', arguments: '{"msg":"hi"}' } }],
            },
          },
        ],
        usage: { cost: 0, total_tokens: 0 },
      });
    }
    return nonStreamResponse({
      choices: [{ message: { role: 'assistant', content: 'done' } }],
      usage: { cost: 0, total_tokens: 0 },
    });
  };

  try {
    const agent = new Agent({
      apiKey: 'sk-test',
      injectors: NO_INJECTORS,
      record: {
        dir,
        level: 'full',
        redact: (rec) => (rec.type === 'request' ? { ...rec, payload: '[REDACTED]' } : rec),
      },
    });
    agent.use({
      name: 'Echo',
      description: 'echo',
      input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async ({ msg }) => msg,
    });
    await agent.run('go'); // no notify -> non-streaming #send path
    await agent.cleanup();

    const file = fs.readdirSync(dir).find((f) => f.endsWith('.jsonl'));
    const recs = fs
      .readFileSync(path.join(dir, file), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const types = recs.map((x) => x.type);
    assert.ok(types.includes('request'), 'full level must record request');
    assert.ok(types.includes('response'), 'full level must record response');
    const req = recs.find((x) => x.type === 'request');
    assert.equal(req.payload, '[REDACTED]', 'redact must scrub the request payload');
    const resp = recs.find((x) => x.type === 'response' && x.turn === 1);
    assert.equal(resp.raw.choices[0].message.tool_calls[0].id, 'c1', 'response raw must preserve tool call ids');
  } finally {
    global.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent threads tool_call_id into the tool ctx', async () => {
  const Agent = (await import('../../src/core/agent.js')).default;
  const agent = new Agent({ apiKey: 'sk-test', injectors: NO_INJECTORS });
  let seenId;
  agent.use({
    name: 'Echo',
    description: 'echo',
    input_schema: { type: 'object', properties: {} },
    execute: async (_input, ctx) => {
      seenId = ctx.tool_call_id;
      return 'ok';
    },
  });

  let n = 0;
  agent._sendForTest = async () => {
    n++;
    if (n === 1) {
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: 'callX', type: 'function', function: { name: 'Echo', arguments: '{}' } }],
            },
          },
        ],
      };
    }
    return { choices: [{ message: { content: 'done' } }] };
  };

  const out = await agent.run('go');
  assert.equal(out, 'done');
  assert.equal(seenId, 'callX', 'ctx.tool_call_id must equal the assistant tool call id');
});

function writeFullFixture(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-'));
  const file = path.join(dir, 'session-fixture.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, file };
}

function fullFixtureLines() {
  return [
    { t: 'x', type: 'session_start', id: 's1', level: 'full', model: 'm' },
    { t: 'x', type: 'request', turn: 1, payload: { messages: [] } },
    {
      t: 'x',
      type: 'response',
      turn: 1,
      raw: {
        choices: [
          {
            message: {
              content: 'let me echo',
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Echo', arguments: '{"msg":"hi"}' } }],
            },
          },
        ],
      },
    },
    { t: 'x', type: 'assistant', turn: 1, content: 'let me echo', reasoning: '' },
    { t: 'x', type: 'tool_calls', turn: 1, calls: [{ id: 'c1', name: 'Echo' }] },
    { t: 'x', type: 'tool_start', turn: 1, tool_call_id: 'c1', name: 'Echo', input: { msg: 'hi' } },
    { t: 'x', type: 'tool_end', turn: 1, tool_call_id: 'c1', name: 'Echo', duration_ms: 3, output: 'recorded-echo' },
    { t: 'x', type: 'request', turn: 2, payload: { messages: [] } },
    { t: 'x', type: 'response', turn: 2, raw: { choices: [{ message: { content: 'done' } }] } },
    { t: 'x', type: 'assistant', turn: 2, content: 'done', reasoning: '' },
    { t: 'x', type: 'session_end', reason: 'closed' },
  ];
}

test('Agent.replay throws on a non-full recording', async () => {
  const Agent = (await import('../../src/core/agent.js')).default;
  const { dir, file } = writeFullFixture([{ t: 'x', type: 'session_start', id: 's1', level: 'snapshots', model: 'm' }]);
  const rec = await Recording.load(file);
  assert.throws(() => Agent.replay(rec), /full/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Agent.replay reproduces a recorded run with zero network and recorded tool output', async () => {
  const Agent = (await import('../../src/core/agent.js')).default;
  const { dir, file } = writeFullFixture(fullFixtureLines());
  const rec = await Recording.load(file);

  const orig = global.fetch;
  let fetched = false;
  global.fetch = async () => {
    fetched = true;
    throw new Error('replay must not touch the network');
  };
  try {
    const agent = Agent.replay(rec); // default toolMode: 'replay'
    const out = await agent.run();
    assert.equal(out, 'done', 'replay reproduces the recorded final assistant content');
    assert.equal(fetched, false, 'replay must not call fetch');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.content, 'recorded-echo', 'replay returns the recorded tool output, not a live re-run');
  } finally {
    global.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent.replay toolMode live re-executes tools against the provided registry', async () => {
  const Agent = (await import('../../src/core/agent.js')).default;
  const { dir, file } = writeFullFixture(fullFixtureLines());
  const rec = await Recording.load(file);

  const registry = new ToolRegistry();
  let calls = 0;
  registry.register({
    name: 'Echo',
    description: 'echo',
    input_schema: { type: 'object', properties: { msg: { type: 'string' } } },
    execute: async ({ msg }) => {
      calls++;
      return 'LIVE:' + msg;
    },
  });

  const orig = global.fetch;
  global.fetch = async () => {
    throw new Error('replay must not touch the network');
  };
  try {
    const agent = Agent.replay(rec, { tools: registry, toolMode: 'live' });
    const out = await agent.run();
    assert.equal(out, 'done');
    assert.equal(calls, 1, 'live mode re-runs the real tool');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    assert.equal(toolMsg.content, 'LIVE:hi', 'live mode uses the freshly computed tool output');
  } finally {
    global.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent.replay reproduces a recorded tool error', async () => {
  const Agent = (await import('../../src/core/agent.js')).default;
  const lines = fullFixtureLines();
  const te = lines.find((l) => l.type === 'tool_end');
  delete te.output;
  te.error = 'recorded failure';
  const { dir, file } = writeFullFixture(lines);
  const rec = await Recording.load(file);

  const orig = global.fetch;
  global.fetch = async () => {
    throw new Error('no network');
  };
  try {
    const agent = Agent.replay(rec);
    const out = await agent.run();
    assert.equal(out, 'done');
    const toolMsg = agent.messages.find((m) => m.role === 'tool');
    assert.match(toolMsg.content, /recorded failure/, 'replay surfaces the recorded tool error');
  } finally {
    global.fetch = orig;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Agent.replay throws on an unknown toolMode', async () => {
  const Agent = (await import('../../src/core/agent.js')).default;
  const { dir, file } = writeFullFixture(fullFixtureLines());
  const rec = await Recording.load(file);
  assert.throws(() => Agent.replay(rec, { toolMode: 'bogus' }), /unknown toolMode/);
  fs.rmSync(dir, { recursive: true, force: true });
});
