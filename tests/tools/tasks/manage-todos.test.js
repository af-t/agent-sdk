import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { createTestTempDir } from '../../support/temp.js';

describe('manageTodos tool', () => {
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

  it('exports only the canonical manageTodos object', async () => {
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    assert.strictEqual(mod.name, 'manageTodos');
    assert.ok(mod.description);
    assert.ok(mod.inputSchema);
    assert.strictEqual(typeof mod.execute, 'function');
  });

  it('adds a new todo', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    const result = await mod.execute({
      action: 'add',
      text: 'Learn Unit Testing',
      priority: 'high',
      category: 'development',
      todoFile: testFile,
    });

    assert.ok(result.includes('Todo added'));
    assert.ok(result.includes('Learn Unit Testing'));
    assert.ok(result.includes('Priority: HIGH'));
    assert.ok(result.includes('Category: development'));
  });

  it('rejects add without text', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(
      () =>
        mod.execute({
          action: 'add',
          todoFile: testFile,
        }),
      /Parameter "text" is required/,
    );
  });

  it('lists todos', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({
      action: 'add',
      text: 'Task 1',
      todoFile: testFile,
    });
    await mod.execute({
      action: 'add',
      text: 'Task 2',
      priority: 'high',
      todoFile: testFile,
    });

    const result = await mod.execute({
      action: 'list',
      todoFile: testFile,
    });

    assert.ok(result.includes('Task List'));
    assert.ok(result.includes('Task 1'));
    assert.ok(result.includes('Task 2'));
    assert.ok(result.includes('Total: 2'));
  });

  it('reports an empty list when there are no todos', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    const result = await mod.execute({
      action: 'list',
      todoFile: testFile,
    });

    assert.ok(result.includes('No tasks'));
  });

  it('filters pending todos', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Pending Task', todoFile: testFile });
    await mod.execute({ action: 'add', text: 'Completed Task', todoFile: testFile });

    // The most recently created task appears first in the default sort.
    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const ids = [...listResult.matchAll(/ID: (\w+)/g)].map((m) => m[1]);
    const completedId = ids[0];

    await mod.execute({ action: 'complete', id: completedId, todoFile: testFile });

    // The pending filter excludes the completed task.
    const pendingResult = await mod.execute({
      action: 'list',
      filter: 'pending',
      todoFile: testFile,
    });

    assert.ok(pendingResult.includes('pending'));
    assert.ok(pendingResult.includes('Pending Task'));
    assert.ok(!pendingResult.includes('Completed Task'));
  });

  it('filters completed todos', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task to complete', todoFile: testFile });

    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    await mod.execute({ action: 'complete', id: firstId, todoFile: testFile });

    const completedResult = await mod.execute({
      action: 'list',
      filter: 'completed',
      todoFile: testFile,
    });

    assert.ok(completedResult.includes('completed'));
    assert.ok(completedResult.includes('Task to complete'));
  });

  it('completes a todo', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task to be completed', todoFile: testFile });

    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'complete',
      id: firstId,
      todoFile: testFile,
    });

    assert.ok(result.includes('Todo completed'));
    assert.ok(result.includes('Task to be completed'));

    // The list reflects the completed state.
    const listAfter = await mod.execute({ action: 'list', filter: 'completed', todoFile: testFile });
    assert.ok(listAfter.includes('Task to be completed'));
  });

  it('rejects complete without an id', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(() => mod.execute({ action: 'complete', todoFile: testFile }), /Parameter "id" is required/);
  });

  it('rejects complete with a non-existent id', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(() => mod.execute({ action: 'complete', id: 'nonexistent', todoFile: testFile }), /not found/);
  });

  it('reports an already completed todo instead of completing it twice', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task', todoFile: testFile });
    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    await mod.execute({ action: 'complete', id: firstId, todoFile: testFile });

    const result = await mod.execute({ action: 'complete', id: firstId, todoFile: testFile });
    assert.ok(result.includes('already completed'));
  });

  it('deletes a todo', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task to delete', todoFile: testFile });

    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'delete',
      id: firstId,
      todoFile: testFile,
    });

    assert.ok(result.includes('Todo deleted'));
    assert.ok(result.includes('Task to delete'));

    // Clearing removes every todo.
    const listAfter = await mod.execute({ action: 'list', todoFile: testFile });
    assert.ok(listAfter.includes('No tasks'));
  });

  it('rejects delete without an id', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(() => mod.execute({ action: 'delete', todoFile: testFile }), /Parameter "id" is required/);
  });

  it('rejects delete with a non-existent id', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(() => mod.execute({ action: 'delete', id: 'nonexistent', todoFile: testFile }), /not found/);
  });

  it('updates todo text', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Old task', todoFile: testFile });
    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'update',
      id: firstId,
      text: 'New task',
      todoFile: testFile,
    });

    assert.ok(result.includes('Todo updated'));
    assert.ok(result.includes('New task'));
    assert.ok(result.includes('Changed: text'));
  });

  it('updates todo priority', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task', todoFile: testFile });
    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'update',
      id: firstId,
      priority: 'high',
      todoFile: testFile,
    });

    assert.ok(result.includes('Priority:'));
    assert.ok(result.includes('HIGH'));
    assert.ok(result.includes('Changed: priority'));
  });

  it('updates todo status to completed', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task', todoFile: testFile });
    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    const result = await mod.execute({
      action: 'update',
      id: firstId,
      completed: true,
      todoFile: testFile,
    });

    assert.ok(result.includes('Changed:'));
    assert.ok(result.includes('status'));
    assert.ok(result.includes('Completed'));
  });

  it('keeps priority unchanged when updating other fields', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Important task', priority: 'high', todoFile: testFile });

    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const idMatch = listResult.match(/ID: (\w+)/);
    const firstId = idMatch[1];

    // Updating the text preserves the high priority.
    const result = await mod.execute({
      action: 'update',
      id: firstId,
      text: 'Updated important task',
      todoFile: testFile,
    });

    assert.ok(result.includes('Changed: text'));
    assert.ok(!result.includes('Changed: text, priority'));
    assert.ok(result.includes('Priority: [high] HIGH'));
  });

  it('sorts by priority', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task Low', priority: 'low', todoFile: testFile });
    await mod.execute({ action: 'add', text: 'Task High', priority: 'high', todoFile: testFile });
    await mod.execute({ action: 'add', text: 'Task Medium', priority: 'medium', todoFile: testFile });

    const result = await mod.execute({
      action: 'list',
      sortBy: 'priority',
      todoFile: testFile,
    });

    // Descending priority places High before Low.
    const highIndex = result.indexOf('Task High');
    const lowIndex = result.indexOf('Task Low');
    assert.ok(highIndex < lowIndex);
  });

  it('clears all todos', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task 1', todoFile: testFile });
    await mod.execute({ action: 'add', text: 'Task 2', todoFile: testFile });

    const result = await mod.execute({ action: 'clear', todoFile: testFile });
    assert.ok(result.includes('Cleared 2 todos'));

    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    assert.ok(listResult.includes('No tasks'));
  });

  it('reports an already empty list on clear', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    const result = await mod.execute({ action: 'clear', todoFile: testFile });
    assert.ok(result.includes('already empty'));
  });

  it('rejects add once the todo limit is reached', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    // Direct fixture setup avoids one thousand tool calls.
    const todos = Array.from({ length: 1000 }, (_, i) => ({
      id: `id${i}`,
      text: `Task ${i}`,
      priority: 'medium',
      category: 'general',
      completed: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      dueDate: null,
    }));
    await fs.writeFile(testFile, JSON.stringify(todos), 'utf8');

    await assert.rejects(
      () => mod.execute({ action: 'add', text: 'One more', todoFile: testFile }),
      /Maximum todo limit reached/,
    );
  });

  it('sorts by dueDate', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Later task', dueDate: '2030-12-31T00:00:00Z', todoFile: testFile });
    await mod.execute({ action: 'add', text: 'Earlier task', dueDate: '2025-01-01T00:00:00Z', todoFile: testFile });
    await mod.execute({ action: 'add', text: 'No due date task', todoFile: testFile });

    const result = await mod.execute({ action: 'list', sortBy: 'dueDate', todoFile: testFile });
    const earlierIdx = result.indexOf('Earlier task');
    const laterIdx = result.indexOf('Later task');
    assert.ok(earlierIdx < laterIdx, 'earlier due date should appear first');
  });

  it('shows dueDate details when listing todos', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({
      action: 'add',
      text: 'Task with due date',
      dueDate: '2030-06-15T00:00:00Z',
      todoFile: testFile,
    });

    const result = await mod.execute({ action: 'list', todoFile: testFile });
    assert.ok(result.includes('6/15/2030') || result.includes('2030'), 'should display due date');
  });

  it('rejects update without an id', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(
      () => mod.execute({ action: 'update', text: 'New text', todoFile: testFile }),
      /Parameter "id" is required/,
    );
  });

  it('rejects update with a non-existent id', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(
      () => mod.execute({ action: 'update', id: 'nonexistent', text: 'New text', todoFile: testFile }),
      /not found/,
    );
  });

  it('updates todo category', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task', todoFile: testFile });
    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const id = listResult.match(/ID: (\w+)/)[1];

    const result = await mod.execute({ action: 'update', id, category: 'testing', todoFile: testFile });
    assert.ok(result.includes('Changed: category'));
    assert.ok(result.includes('TESTING'));
  });

  it('updates todo dueDate', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task', todoFile: testFile });
    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const id = listResult.match(/ID: (\w+)/)[1];

    const result = await mod.execute({ action: 'update', id, dueDate: '2030-12-31T00:00:00Z', todoFile: testFile });
    assert.ok(result.includes('Changed: due date'));
  });

  it('reports no changes when update carries no fields', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task', todoFile: testFile });
    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const id = listResult.match(/ID: (\w+)/)[1];

    const result = await mod.execute({ action: 'update', id, todoFile: testFile });
    assert.ok(result.includes('No changes applied'));
  });

  it('shows dueDate details in the update output', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await mod.execute({ action: 'add', text: 'Task', dueDate: '2030-06-15T00:00:00Z', todoFile: testFile });
    const listResult = await mod.execute({ action: 'list', todoFile: testFile });
    const id = listResult.match(/ID: (\w+)/)[1];

    const result = await mod.execute({ action: 'update', id, text: 'Updated task', todoFile: testFile });
    assert.ok(result.includes('2030') || result.includes('6/15'), 'due date should appear in update output');
  });

  it('rejects an unknown action', async () => {
    await cleanup();
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(() => mod.execute({ action: 'invalid_action', todoFile: testFile }), /Unknown action/);
  });

  it('uses ctx.agent._todoFile when no todoFile param is provided', async (t) => {
    const fsP = await import('node:fs/promises');
    const path_ = await import('node:path');
    const tmpDir = createTestTempDir(t, 'todo-agent-test-');
    const agentTodoFile = path_.join(tmpDir, 'todos-abc12.json');

    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
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
  });

  it('throws a clear error when neither todoFile nor ctx.agent._todoFile is provided', async () => {
    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(() => mod.execute({ action: 'list' }, {}), /configured storage path|todoFile/i);
  });

  it('auto-creates the parent directory of _todoFile when writing', async (t) => {
    const fsP = await import('node:fs/promises');
    const path_ = await import('node:path');
    const base = createTestTempDir(t, 'todo-mkdir-');
    const nestedFile = path_.join(base, '.agent-sdk', 'todos.json');

    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    const ctx = { agent: { _todoFile: nestedFile, trustedPaths: new Set([base]) } };

    const result = await mod.execute({ action: 'add', text: 'Nested todo' }, ctx);
    assert.ok(result.includes('Nested todo'));

    const raw = await fsP.readFile(nestedFile, 'utf8');
    assert.strictEqual(JSON.parse(raw).length, 1);
  });

  it('todoFile param takes precedence over ctx.agent._todoFile', async (t) => {
    const fsP = await import('node:fs/promises');
    const path_ = await import('node:path');
    const tmpDir = createTestTempDir(t, 'todo-agent-test-');
    const agentTodoFile = path_.join(tmpDir, 'agent.json');
    const explicitFile = path_.join(tmpDir, 'explicit.json');

    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    const ctx = {
      agent: {
        _todoFile: agentTodoFile,
        trustedPaths: new Set([tmpDir]),
      },
    };

    await mod.execute({ action: 'add', text: 'Explicit', todoFile: explicitFile }, ctx);

    const raw = await fsP.readFile(explicitFile, 'utf8');
    assert.ok(JSON.parse(raw).length === 1);
    await assert.rejects(() => fsP.stat(agentTodoFile), { code: 'ENOENT' });
  });

  it('gives migration guidance for legacy todo field names', async () => {
    const legacyFile = path.join(tmpDir, 'legacy-todos.json');
    await fs.writeFile(
      legacyFile,
      JSON.stringify([
        {
          id: 'legacy',
          text: 'Migrate me',
          completed: false,
          priority: 'medium',
          category: 'general',
          created_at: '2026-01-01T00:00:00.000Z',
          updated_at: '2026-01-01T00:00:00.000Z',
          due_date: null,
        },
      ]),
      'utf8',
    );

    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(() => mod.execute({ action: 'list', todoFile: legacyFile }), {
      message: /created_at.*createdAt.*updated_at.*updatedAt.*due_date.*dueDate/,
    });
  });

  it('rejects a todo file whose JSON root is not an array', async () => {
    const invalidFile = path.join(tmpDir, 'invalid-todos.json');
    await fs.writeFile(invalidFile, JSON.stringify({ todos: [] }), 'utf8');

    const mod = (await import('../../../src/tools/tasks/manage-todos.js')).manageTodos;
    await assert.rejects(() => mod.execute({ action: 'list', todoFile: invalidFile }), {
      message: /Todo file must contain a JSON array/,
    });
  });
});
