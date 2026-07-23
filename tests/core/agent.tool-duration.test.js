import { test } from 'node:test';
import assert from 'node:assert/strict';
import Agent from '../../src/core/agent.js';

const NO_INJECTORS = {
  date: false,
  contextFiles: false,
  memoryIndex: false,
  memoryHint: false,
  skillList: false,
};

// Drives exactly one tool call (turn 1) then a terminal assistant message
// (turn 2). `onPayload` observes each outgoing payload — the #buildPayload
// output handed to the transport — so tests can assert the wire shape.
function makeSend(onPayload) {
  let n = 0;
  return async (payload) => {
    onPayload?.(payload);
    n++;
    if (n === 1) {
      return {
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [{ id: 'c1', type: 'function', function: { name: 'T', arguments: '{}' } }],
            },
          },
        ],
        usage: {},
      };
    }
    return { choices: [{ message: { content: 'done' } }], usage: {} };
  };
}

function makeAgent(execute) {
  const agent = new Agent({ apiKey: 'sk-test', injectors: NO_INJECTORS });
  agent.use({
    name: 'T',
    description: 't',
    input_schema: { type: 'object', properties: {} },
    execute,
  });
  return agent;
}

test('a successful tool call persists a numeric duration_ms in history', async () => {
  const agent = makeAgent(async () => 'ok');
  agent._sendForTest = makeSend();

  const out = await agent.run('go');
  assert.equal(out, 'done');

  const toolMsg = agent.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'a tool message is recorded in history');
  assert.equal(toolMsg.content, 'ok');
  assert.equal(typeof toolMsg.duration_ms, 'number', 'history retains duration_ms');
  assert.ok(toolMsg.duration_ms >= 0, 'duration_ms is non-negative');
});

test('duration_ms is stripped from the tool message before it reaches the provider', async () => {
  const payloads = [];
  const agent = makeAgent(async () => 'ok');
  agent._sendForTest = makeSend((p) => payloads.push(p));

  await agent.run('go');

  // Turn 2 replays the tool result back to the provider.
  const second = payloads[1];
  assert.ok(second, 'a second request carrying tool history was sent');
  const wireTool = second.messages.find((m) => m.role === 'tool');
  assert.ok(wireTool, 'tool message present in the outgoing payload');
  assert.deepEqual(wireTool.content, [
    { type: 'text', text: 'ok', cache_control: { type: 'ephemeral' } },
  ]);
  assert.ok(!('duration_ms' in wireTool), 'duration_ms must not be sent to the provider');

  // History itself still carries it — the strip is payload-only, not destructive.
  const histTool = agent.messages.find((m) => m.role === 'tool');
  assert.equal(typeof histTool.duration_ms, 'number', 'history is untouched by the strip');
});

test('a failed tool call still persists duration_ms in history', async () => {
  const agent = makeAgent(async () => {
    throw new Error('kaboom');
  });
  agent._sendForTest = makeSend();

  await agent.run('go');

  const toolMsg = agent.messages.find((m) => m.role === 'tool');
  assert.ok(toolMsg, 'an error tool message is recorded');
  assert.match(toolMsg.content, /Error: kaboom/);
  assert.equal(typeof toolMsg.duration_ms, 'number', 'the error path also records duration_ms');
  assert.ok(toolMsg.duration_ms >= 0);
});
