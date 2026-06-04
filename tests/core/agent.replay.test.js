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
