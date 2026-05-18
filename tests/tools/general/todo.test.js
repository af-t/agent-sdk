import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('Todo Tool', () => {
  let tmpDir;
  let testFile;
  let cleanup; // for helper

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'todo-test-'));
    testFile = path.join(tmpDir, 'test-todos.json');
    cleanup = async () => fs.rm(testFile, { force: true });
    mock.method(process, 'cwd', () => tmpDir);
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should export required fields', async () => {
    const mod = await import('../../../src/tools/general/todo.js');
    assert.strictEqual(mod.name, 'Todo');
    assert.ok(mod.description);
    assert.ok(mod.input_schema);
    assert.strictEqual(typeof mod.execute, 'function');
  });

  it('should add a new todo', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    const result = await mod.execute({
      action: 'add',
      text: 'Learn Unit Testing',
      priority: 'high',
      category: 'development',
      todo_file: testFile,
    });

    assert.ok(result.includes('Todo added'));
    assert.ok(result.includes('Learn Unit Testing'));
    assert.ok(result.includes('Priority: HIGH'));
    assert.ok(result.includes('Category: development'));
  });

  it('should reject add without text', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await assert.rejects(
      () =>
        mod.execute({
          action: 'add',
          todo_file: testFile,
        }),
      /Parameter "text" is required/,
    );
  });

  it('should list todos', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({
      action: 'add',
      text: 'Task 1',
      todo_file: testFile,
    });
    await mod.execute({
      action: 'add',
      text: 'Task 2',
      priority: 'high',
      todo_file: testFile,
    });

    const result = await mod.execute({
      action: 'list',
      todo_file: testFile,
    });

    assert.ok(result.includes('Task List'));
    assert.ok(result.includes('Task 1'));
    assert.ok(result.includes('Task 2'));
    assert.ok(result.includes('Total: 2'));
  });

  it('should list empty message when no todos', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    const result = await mod.execute({
      action: 'list',
      todo_file: testFile,
    });

    assert.ok(result.includes('No tasks'));
  });

  it('should filter pending todos', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Pending Task', todo_file: testFile });
    await mod.execute({ action: 'add', text: 'Completed Task', todo_file: testFile });

    // Complete the second task (created last, appears first in default sort)
    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const ids = [...listResult.matchAll(/ID: (\w+)/g)].map((m) => m[1]);
    const completedId = ids[0];

    await mod.execute({ action: 'complete', id: completedId, todo_file: testFile });

    // Check pending filter — should only show Pending Task
    const pendingResult = await mod.execute({
      action: 'list',
      filter: 'pending',
      todo_file: testFile,
    });

    assert.ok(pendingResult.includes('pending'));
    assert.ok(pendingResult.includes('Pending Task'));
    assert.ok(!pendingResult.includes('Completed Task'));
  });

  it('should filter completed todos', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task to complete', todo_file: testFile });

    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    await mod.execute({ action: 'complete', id: firstId, todo_file: testFile });

    const completedResult = await mod.execute({
      action: 'list',
      filter: 'completed',
      todo_file: testFile,
    });

    assert.ok(completedResult.includes('completed'));
    assert.ok(completedResult.includes('Task to complete'));
  });

  it('should complete a todo', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task to be completed', todo_file: testFile });

    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'complete',
      id: firstId,
      todo_file: testFile,
    });

    assert.ok(result.includes('Todo completed'));
    assert.ok(result.includes('Task to be completed'));

    // Verify in list
    const listAfter = await mod.execute({ action: 'list', filter: 'completed', todo_file: testFile });
    assert.ok(listAfter.includes('Task to be completed'));
  });

  it('should reject complete without id', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await assert.rejects(() => mod.execute({ action: 'complete', todo_file: testFile }), /Parameter "id" is required/);
  });

  it('should reject complete with non-existent id', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await assert.rejects(
      () => mod.execute({ action: 'complete', id: 'nonexistent', todo_file: testFile }),
      /not found/,
    );
  });

  it('should reject complete already completed todo', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task', todo_file: testFile });
    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    await mod.execute({ action: 'complete', id: firstId, todo_file: testFile });

    const result = await mod.execute({ action: 'complete', id: firstId, todo_file: testFile });
    assert.ok(result.includes('already completed'));
  });

  it('should delete a todo', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task to delete', todo_file: testFile });

    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'delete',
      id: firstId,
      todo_file: testFile,
    });

    assert.ok(result.includes('Todo deleted'));
    assert.ok(result.includes('Task to delete'));

    // Verify list is empty
    const listAfter = await mod.execute({ action: 'list', todo_file: testFile });
    assert.ok(listAfter.includes('No tasks'));
  });

  it('should reject delete without id', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await assert.rejects(() => mod.execute({ action: 'delete', todo_file: testFile }), /Parameter "id" is required/);
  });

  it('should reject delete with non-existent id', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await assert.rejects(() => mod.execute({ action: 'delete', id: 'nonexistent', todo_file: testFile }), /not found/);
  });

  it('should update todo text', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Old task', todo_file: testFile });
    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'update',
      id: firstId,
      text: 'New task',
      todo_file: testFile,
    });

    assert.ok(result.includes('Todo updated'));
    assert.ok(result.includes('New task'));
    assert.ok(result.includes('Changed: text'));
  });

  it('should update todo priority', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task', todo_file: testFile });
    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'update',
      id: firstId,
      priority: 'high',
      todo_file: testFile,
    });

    assert.ok(result.includes('Priority:'));
    assert.ok(result.includes('HIGH'));
    assert.ok(result.includes('Changed: priority'));
  });

  it('should update todo status (mark as complete)', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task', todo_file: testFile });
    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'update',
      id: firstId,
      completed: true,
      todo_file: testFile,
    });

    assert.ok(result.includes('Changed:'));
    assert.ok(result.includes('status'));
    assert.ok(result.includes('Completed'));
  });

  it('should not change priority when updating other fields (regression)', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Important task', priority: 'high', todo_file: testFile });

    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    // Update only the text — priority must remain HIGH
    const result = await mod.execute({
      action: 'update',
      id: firstId,
      text: 'Updated important task',
      todo_file: testFile,
    });

    // Should only have changed text, not priority
    assert.ok(result.includes('Changed: text'));
    assert.ok(!result.includes('Changed: text, priority'));
    assert.ok(result.includes('Priority: [high] HIGH'));
  });

  it('should sort by priority', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task Low', priority: 'low', todo_file: testFile });
    await mod.execute({ action: 'add', text: 'Task High', priority: 'high', todo_file: testFile });
    await mod.execute({ action: 'add', text: 'Task Medium', priority: 'medium', todo_file: testFile });

    const result = await mod.execute({
      action: 'list',
      sort_by: 'priority',
      todo_file: testFile,
    });

    // High should appear before Low
    const highIndex = result.indexOf('Task High');
    const lowIndex = result.indexOf('Task Low');
    assert.ok(highIndex < lowIndex);
  });

  it('should clear all todos', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task 1', todo_file: testFile });
    await mod.execute({ action: 'add', text: 'Task 2', todo_file: testFile });

    const result = await mod.execute({ action: 'clear', todo_file: testFile });
    assert.ok(result.includes('Cleared 2 todos'));

    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    assert.ok(listResult.includes('No tasks'));
  });

  it('should handle clear on empty list', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    const result = await mod.execute({ action: 'clear', todo_file: testFile });
    assert.ok(result.includes('already empty'));
  });

  it('should reject when MAX_TODOS limit is reached', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    // Write 1000 todos directly to avoid slow loop
    const todos = Array.from({ length: 1000 }, (_, i) => ({
      id: `id${i}`,
      text: `Task ${i}`,
      priority: 'medium',
      category: 'general',
      completed: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      due_date: null,
    }));
    await fs.writeFile(testFile, JSON.stringify(todos), 'utf8');

    await assert.rejects(
      () => mod.execute({ action: 'add', text: 'One more', todo_file: testFile }),
      /Maximum todo limit reached/,
    );
  });

  it('should sort by due_date', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Later task', due_date: '2030-12-31T00:00:00Z', todo_file: testFile });
    await mod.execute({ action: 'add', text: 'Earlier task', due_date: '2025-01-01T00:00:00Z', todo_file: testFile });
    await mod.execute({ action: 'add', text: 'No due date task', todo_file: testFile });

    const result = await mod.execute({ action: 'list', sort_by: 'due_date', todo_file: testFile });
    const earlierIdx = result.indexOf('Earlier task');
    const laterIdx = result.indexOf('Later task');
    assert.ok(earlierIdx < laterIdx, 'earlier due date should appear first');
  });

  it('should display due_date info when listing todos with due_date', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({
      action: 'add',
      text: 'Task with due date',
      due_date: '2030-06-15T00:00:00Z',
      todo_file: testFile,
    });

    const result = await mod.execute({ action: 'list', todo_file: testFile });
    assert.ok(result.includes('6/15/2030') || result.includes('2030'), 'should display due date');
  });

  it('should reject update without id', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await assert.rejects(
      () => mod.execute({ action: 'update', text: 'New text', todo_file: testFile }),
      /Parameter "id" is required/,
    );
  });

  it('should reject update with non-existent id', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await assert.rejects(
      () => mod.execute({ action: 'update', id: 'nonexistent', text: 'New text', todo_file: testFile }),
      /not found/,
    );
  });

  it('should update todo category', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task', todo_file: testFile });
    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const id = listResult.match(/ID: (\w+)/)[1];

    const result = await mod.execute({ action: 'update', id, category: 'testing', todo_file: testFile });
    assert.ok(result.includes('Changed: category'));
    assert.ok(result.includes('TESTING'));
  });

  it('should update todo due_date', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task', todo_file: testFile });
    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const id = listResult.match(/ID: (\w+)/)[1];

    const result = await mod.execute({ action: 'update', id, due_date: '2030-12-31T00:00:00Z', todo_file: testFile });
    assert.ok(result.includes('Changed: due date'));
  });

  it('should return no-changes message when update has no fields', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task', todo_file: testFile });
    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const id = listResult.match(/ID: (\w+)/)[1];

    const result = await mod.execute({ action: 'update', id, todo_file: testFile });
    assert.ok(result.includes('No changes applied'));
  });

  it('should display due_date info in update output', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await mod.execute({ action: 'add', text: 'Task', due_date: '2030-06-15T00:00:00Z', todo_file: testFile });
    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    const id = listResult.match(/ID: (\w+)/)[1];

    const result = await mod.execute({ action: 'update', id, text: 'Updated task', todo_file: testFile });
    assert.ok(result.includes('2030') || result.includes('6/15'), 'due date should appear in update output');
  });

  it('should throw for unknown action', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    await assert.rejects(() => mod.execute({ action: 'invalid_action', todo_file: testFile }), /Unknown action/);
  });

  it('uses ctx.agent._todoFile when no todo_file param is provided', async () => {
    const fsP = await import('node:fs/promises');
    const os_ = await import('node:os');
    const path_ = await import('node:path');
    const tmpDir = await fsP.mkdtemp(path_.join(os_.tmpdir(), 'todo-agent-test-'));
    const agentTodoFile = path_.join(tmpDir, 'todos-abc12.json');

    const mod = await import('../../../src/tools/general/todo.js');
    const ctx = {
      agent: {
        _todoFile: agentTodoFile,
        trustedPaths: new Set([tmpDir]),
      },
    };

    const result = await mod.execute({ action: 'add', text: 'Agent todo' }, ctx);
    assert.ok(result.includes('Agent todo'));

    const raw = await fsP.readFile(agentTodoFile, 'utf8');
    const todos = JSON.parse(raw);
    assert.strictEqual(todos.length, 1);
    assert.strictEqual(todos[0].text, 'Agent todo');

    await fsP.rm(tmpDir, { recursive: true });
  });

  it('todo_file param takes precedence over ctx.agent._todoFile', async () => {
    const fsP = await import('node:fs/promises');
    const os_ = await import('node:os');
    const path_ = await import('node:path');
    const tmpDir = await fsP.mkdtemp(path_.join(os_.tmpdir(), 'todo-agent-test-'));
    const agentTodoFile = path_.join(tmpDir, 'agent.json');
    const explicitFile = path_.join(tmpDir, 'explicit.json');

    const mod = await import('../../../src/tools/general/todo.js');
    const ctx = {
      agent: {
        _todoFile: agentTodoFile,
        trustedPaths: new Set([tmpDir]),
      },
    };

    await mod.execute({ action: 'add', text: 'Explicit', todo_file: explicitFile }, ctx);

    const raw = await fsP.readFile(explicitFile, 'utf8');
    assert.ok(JSON.parse(raw).length === 1);
    await assert.rejects(() => fsP.stat(agentTodoFile), { code: 'ENOENT' });

    await fsP.rm(tmpDir, { recursive: true });
  });
});
