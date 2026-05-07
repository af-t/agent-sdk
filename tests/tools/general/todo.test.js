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

    assert.ok(result.includes('✅ Todo added'));
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

    assert.ok(result.includes('✅ Todo completed'));
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

    assert.ok(result.includes('🗑️ Todo deleted'));
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

    assert.ok(result.includes('🔄 Todo updated'));
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
    assert.ok(result.includes('✅ Completed'));
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
    assert.ok(result.includes('Priority: 🔴 HIGH'));
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
    assert.ok(result.includes('All 2 todos have been cleared'));

    const listResult = await mod.execute({ action: 'list', todo_file: testFile });
    assert.ok(listResult.includes('No tasks'));
  });

  it('should handle clear on empty list', async () => {
    await cleanup();
    const mod = await import('../../../src/tools/general/todo.js');
    const result = await mod.execute({ action: 'clear', todo_file: testFile });
    assert.ok(result.includes('already empty'));
  });
});
