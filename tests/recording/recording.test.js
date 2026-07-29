import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { Recording } from '../../src/recording/recording.js';
import { ToolRegistry } from '../../src/registries/tool-registry.js';
import { resolveLogger } from '../../src/support/logger.js';
import { createTestTempDir } from '../support/temp.js';

function writeFixture(t, lines) {
  const dir = createTestTempDir(t, 'recload-');
  const file = path.join(dir, 'session-fixture.jsonl');
  fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return { dir, file };
}

test('load parses meta, events, and snapshots and skips malformed lines', async (t) => {
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' },
    { t: 'x', type: 'toolCalls', turn: 1, calls: [{ id: 'c1', name: 'Echo' }] },
    {
      t: 'x',
      type: 'turnSnapshot',
      turn: 1,
      messages: [{ role: 'user', content: 'hi' }],
      usage: { cost: 1, tokens: 2 },
    },
    { t: 'x', type: 'sessionEnd', reason: 'closed' },
  ]);
  fs.appendFileSync(file, 'not json\n');

  const rec = await Recording.load(file);
  assert.equal(rec.id, 's1');
  assert.equal(rec.level, 'snapshots');
  assert.equal(rec.model, 'm');
  assert.equal(rec.events.length, 1);
  assert.equal(rec.events[0].type, 'toolCalls');
  assert.equal(rec.snapshots.length, 1);
  assert.deepEqual(rec.snapshotAt(1).usage, { cost: 1, tokens: 2 });
  assert.equal(rec.snapshotAt(99), null);
});

test('load routes a malformed line through an injected logger', async (t) => {
  const { file } = writeFixture(t, [{ t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' }]);
  fs.appendFileSync(file, 'not json\n');

  const records = [];
  const target = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (context, message) => records.push({ level, context, message }),
    ]),
  );

  await Recording.load(file, { logger: resolveLogger(target) });

  assert.equal(records[0].level, 'warn');
  assert.equal(records[0].context.component, 'recording');
  assert.equal(records[0].context.filePath, file);
  assert.equal(records[0].message, 'Skipping malformed line while loading a recording');
});

test('load falls back to a resolved default logger when none is injected', async (t) => {
  const { file } = writeFixture(t, [{ t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' }]);
  fs.appendFileSync(file, 'not json\n');

  await assert.doesNotReject(() => Recording.load(file));
});

test('forkAt seeds a new independent Agent from the snapshot', async (t) => {
  const Agent = (await import('../../src/agent/agent.js')).default;
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' },
    {
      t: 'x',
      type: 'turnSnapshot',
      turn: 2,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: 'hello' },
      ],
      usage: { cost: 0.3, tokens: 7 },
    },
  ]);

  const rec = await Recording.load(file);
  const parent = new Agent({ apiKey: 'sk-test', model: 'parent-model' });
  parent.registerTools({
    name: 'Echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'x',
  });

  const child = parent.forkAt(rec, 2);
  assert.notEqual(child, parent);
  assert.equal(child.messages.length, 2);
  assert.equal(child.messages[1].content, 'hello');
  assert.deepEqual(child.usage, { cost: 0.3, tokens: 7 });
  assert.notEqual(child.tools, parent.tools);
  child.registerTools({
    name: 'BranchOnly',
    description: 'Only the fork can call this tool.',
    inputSchema: { type: 'object', properties: {} },
    execute: async () => 'branch',
  });
  assert.ok(child.tools.listTools().some((tool) => tool.name === 'Echo'));
  assert.ok(!parent.tools.listTools().some((tool) => tool.name === 'BranchOnly'));

  child.messages.push({ role: 'user', content: 'new branch' });
  assert.equal(parent.messages.length, 0, 'forking must not push into the parent');
  child.messages[0].content[0].text = 'mutated';
  assert.equal(
    rec.snapshotAt(2).messages[0].content[0].text,
    'hi',
    'forking must deep-clone, not alias the recording snapshot',
  );

  assert.throws(() => parent.forkAt(rec, 99), /no snapshot/i);
});

test('cleaning a fork leaves parent MCP clients open', async (t) => {
  const Agent = (await import('../../src/agent/agent.js')).default;
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' },
    { t: 'x', type: 'turnSnapshot', turn: 1, messages: [], usage: { cost: 0, tokens: 0 } },
  ]);
  let closeCalls = 0;
  const client = {
    async connectAndGetTools() {
      return [
        {
          name: 'echo',
          description: 'Echo text.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
          },
        },
      ];
    },
    async executeTool(_name, input) {
      return { content: [{ type: 'text', text: input.text }] };
    },
    async close() {
      closeCalls += 1;
    },
  };
  const tools = new ToolRegistry({ mcpClientFactory: () => client });
  await tools.connectMcpServer({ name: 'remote', command: 'unused' });
  const parent = new Agent({ apiKey: 'sk-test', tools });
  t.after(() => parent.cleanup());
  const child = parent.forkAt(await Recording.load(file), 1);

  await child.cleanup();

  assert.equal(closeCalls, 0);
  assert.equal(await parent.tools.execute('remote.echo', { text: 'still open' }), 'still open');
  await parent.cleanup();
  assert.equal(closeCalls, 1);
});

test('forkAt keeps the parent transport injection', async (t) => {
  const Agent = (await import('../../src/agent/agent.js')).default;
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' },
    { t: 'x', type: 'turnSnapshot', turn: 1, messages: [], usage: { cost: 0, tokens: 0 } },
  ]);
  let calls = 0;
  const parent = new Agent({
    apiKey: 'sk-test',
    transport: async () => {
      calls += 1;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'fork response' }, finish_reason: 'stop' }],
            usage: { cost: 0, total_tokens: 1 },
          }),
      };
    },
  });
  t.after(() => parent.cleanup());
  const child = parent.forkAt(await Recording.load(file), 1);
  t.after(() => child.cleanup());
  const originalFetch = global.fetch;
  let globalCalls = 0;
  global.fetch = async () => {
    globalCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'global response' }, finish_reason: 'stop' }],
          usage: { cost: 0, total_tokens: 1 },
        }),
    };
  };
  t.after(() => {
    global.fetch = originalFetch;
  });

  assert.equal(await child.run('continue'), 'fork response');
  assert.equal(calls, 1);
  assert.equal(globalCalls, 0);
});

test('forkAt shares the SkillRegistry used by loadSkill', async (t) => {
  const createAgent = (await import('../../src/index.js')).default;
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' },
    { t: 'x', type: 'turnSnapshot', turn: 1, messages: [], usage: { cost: 0, tokens: 0 } },
  ]);
  const parent = await createAgent({ apiKey: 'sk-test' });
  await parent.skillRegistry._ensureDiscovered();
  parent.skillRegistry.skills.set('fork-marker', { description: 'shared marker', content: 'Fork marker body.' });
  const child = parent.forkAt(await Recording.load(file), 1);

  assert.equal(child.skillRegistry, parent.skillRegistry);
  assert.match(
    await child.tools.execute('loadSkill', { action: 'load', argument: 'fork-marker' }, { agent: child }),
    /Fork marker body/,
  );
});

test('forkAt inherits parent appName', async (t) => {
  const Agent = (await import('../../src/agent/agent.js')).default;
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' },
    {
      t: 'x',
      type: 'turnSnapshot',
      turn: 1,
      messages: [{ role: 'user', content: 'hi' }],
      usage: { cost: 0, tokens: 0 },
    },
  ]);

  const rec = await Recording.load(file);
  const parent = new Agent({ apiKey: 'sk-test', appName: 'lumen' });
  const child = parent.forkAt(rec, 1);
  assert.equal(child.appName, 'lumen');
  assert.equal(child._memoryDir, path.resolve('.lumen/memory'));
});

test('forkAt creates an Agent child logger', async (t) => {
  const Agent = (await import('../../src/agent/agent.js')).default;
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' },
    {
      t: 'x',
      type: 'turnSnapshot',
      turn: 1,
      messages: [{ role: 'user', content: 'hi' }],
      usage: { cost: 0, tokens: 0 },
    },
  ]);
  const records = [];
  const target = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (context, message) => records.push({ level, context, message }),
    ]),
  );

  const parent = new Agent({ apiKey: 'sk-test', logger: resolveLogger(target) });
  const child = parent.forkAt(await Recording.load(file), 1);
  child.logger.info({ turn: 1 }, 'Fork started');

  assert.deepEqual(
    records.find((record) => record.message === 'Fork started'),
    {
      level: 'info',
      context: { component: 'agent', agent: 'fork', turn: 1 },
      message: 'Fork started',
    },
  );
});

test('forkAt forwards parent pluginsDir', async (t) => {
  const Agent = (await import('../../src/agent/agent.js')).default;
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'snapshots', model: 'm' },
    {
      t: 'x',
      type: 'turnSnapshot',
      turn: 1,
      messages: [{ role: 'user', content: 'hi' }],
      usage: { cost: 0, tokens: 0 },
    },
  ]);

  const rec = await Recording.load(file);
  const parent = new Agent({ apiKey: 'sk-test', storagePaths: { pluginsDir: '/tmp/custom-plugins-xyz' } });
  const child = parent.forkAt(rec, 1);
  assert.equal(child._pluginsDir, parent._pluginsDir);
});

test('renderTrace reconstructs the human trace from recorded events', async (t) => {
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'events', model: 'm' },
    { t: 'x', type: 'assistant', turn: 1, content: 'I will read the file', reasoning: 'thinking about the task' },
    { t: 'x', type: 'toolCalls', turn: 1, calls: [{ id: 'abc', name: 'readFile' }] },
    { t: 'x', type: 'toolStart', turn: 1, toolCallId: 'abc', name: 'readFile', input: { path: '/x.txt' } },
    { t: 'x', type: 'toolEnd', turn: 1, toolCallId: 'abc', name: 'readFile', durationMs: 12, output: 'file body' },
    { t: 'x', type: 'assistant', turn: 2, content: 'final answer', reasoning: '' },
  ]);

  const rec = await Recording.load(file);
  const trace = rec.renderTrace();
  assert.match(trace, /=== turn 1 ===/);
  assert.match(trace, /\[reasoning\]\nthinking about the task/);
  assert.match(trace, /\[assistant\]\nI will read the file/);
  assert.match(trace, /\[tool calls\] readFile/);
  assert.match(trace, /-> readFile#abc start: \{"path":"\/x.txt"\}/);
  assert.match(trace, /-> readFile#abc end \(12ms\): file body/);
  assert.match(trace, /=== turn 2 ===/);
  assert.match(trace, /\[assistant\]\nfinal answer/);
});

test('renderTrace shows tool errors', async (t) => {
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'events', model: 'm' },
    { t: 'x', type: 'toolCalls', turn: 1, calls: [{ id: 'e1', name: 'runShell' }] },
    { t: 'x', type: 'toolEnd', turn: 1, toolCallId: 'e1', name: 'runShell', durationMs: 5, error: 'boom' },
  ]);
  const rec = await Recording.load(file);
  assert.match(rec.renderTrace(), /-> runShell#e1 end \(5ms\): ERROR boom/);
});

test('reads request/response payloads and tool results from a full recording', async (t) => {
  const { file } = writeFixture(t, [
    { t: 'x', type: 'sessionStart', id: 's1', level: 'full', model: 'm' },
    { t: 'x', type: 'request', turn: 1, payload: { model: 'm', messages: [{ role: 'user', content: 'hi' }] } },
    {
      t: 'x',
      type: 'response',
      turn: 1,
      raw: { choices: [{ message: { content: 'a', tool_calls: [{ id: 'c1', function: { name: 'Echo' } }] } }] },
    },
    { t: 'x', type: 'toolEnd', turn: 1, toolCallId: 'c1', name: 'Echo', durationMs: 4, output: 'echoed' },
    { t: 'x', type: 'toolEnd', turn: 1, toolCallId: 'c2', name: 'runShell', durationMs: 9, error: 'boom' },
    { t: 'x', type: 'response', turn: 2, raw: { choices: [{ message: { content: 'done' } }] } },
    { t: 'x', type: 'sessionEnd', reason: 'closed' },
  ]);

  const rec = await Recording.load(file);
  assert.equal(rec.level, 'full');
  assert.equal(rec.responseAt(1).choices[0].message.content, 'a');
  assert.equal(rec.responseAt(2).choices[0].message.content, 'done');
  assert.equal(rec.responseAt(99), null);
  assert.deepEqual(rec.requestAt(1).messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(rec.requestAt(99), null);
  assert.deepEqual(rec.toolResult('c1'), { output: 'echoed' });
  assert.deepEqual(rec.toolResult('c2'), { error: 'boom' });
  assert.equal(rec.toolResult('missing'), null);
});
