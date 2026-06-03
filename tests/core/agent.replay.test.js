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
