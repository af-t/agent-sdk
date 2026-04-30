import { describe, it, beforeEach, mock } from 'node:test';
import assert from 'node:assert';
import * as DelegateTool from '../../../src/tools/system/delegate.js';
import Agent from '../../../src/core/agent.js';

describe('DelegateTool', () => {
  const mockAgentInstance = {
    apiKey: 'test-key',
    model: 'test-model',
    tools: { register: () => {} },
    terminalManager: {}
  };

  beforeEach(() => {
    mock.restoreAll();
  });

  it('should have correct metadata', () => {
    assert.strictEqual(DelegateTool.name, 'Delegate');
    assert.strictEqual(typeof DelegateTool.description, 'string');
    assert.ok(DelegateTool.input_schema);
  });

  it('should execute successfully and return report', async () => {
    const dummyReport = {
      summary: 'Did the task',
      data: JSON.stringify({ changes: ['file.txt'] })
    };

    mock.method(Agent.prototype, 'run', async () => dummyReport);

    const result = await DelegateTool.execute({ task: 'do something' }, { agent: mockAgentInstance });

    assert.match(result, /Summary: Did the task/);
    assert.match(result, /"changes": \[\s+"file.txt"\s+\]/);
  });

  it('should pass context_files to the agent', async () => {
    const dummyReport = {
      summary: 'Reviewed files',
      data: JSON.stringify({})
    };

    let passedTask = '';
    mock.method(Agent.prototype, 'run', async (task) => {
      passedTask = task;
      return dummyReport;
    });

    await DelegateTool.execute({ task: 'review', context_files: ['a.js', 'b.js'] }, { agent: mockAgentInstance });

    assert.match(passedTask, /a\.js, b\.js/);
    assert.match(passedTask, /review/);
  });

  it('should handle failed JSON parsing in agent report data gracefully', async () => {
    const dummyReport = {
      summary: 'Did the task',
      data: 'invalid json'
    };

    mock.method(Agent.prototype, 'run', async () => dummyReport);

    const result = await DelegateTool.execute({ task: 'do something' }, { agent: mockAgentInstance });

    assert.match(result, /Summary: Did the task/);
    assert.match(result, /\{\}/);
  });

  it('should handle agent errors gracefully', async () => {
    mock.method(Agent.prototype, 'run', async () => { throw new Error('Agent failed'); });

    const result = await DelegateTool.execute({ task: 'do something' }, { agent: mockAgentInstance });

    assert.match(result, /Delegation failed: Agent failed/);
  });
});
