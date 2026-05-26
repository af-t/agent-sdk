import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureSafePath } from '../../core/utils.js';

// Hard cap to prevent unbounded growth
const MAX_TODOS = 1000;

const readTodos = async (filePath, trustedPaths = new Set()) => {
  try {
    const safePath = ensureSafePath(filePath, trustedPaths);
    const data = await fs.readFile(safePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    // Return empty array if file doesn't exist yet
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
};

const writeTodos = async (filePath, todos, trustedPaths = new Set()) => {
  const safePath = ensureSafePath(filePath, trustedPaths);
  await fs.writeFile(safePath, JSON.stringify(todos, null, 2), 'utf8');
};

const generateId = () => {
  return Math.random().toString(36).substring(2, 7);
};

export const name = 'Todo';

export const description =
  'Manage a todo list to track tasks and activities. Supports add, list, complete, delete, update, and clear actions with filtering, sorting, priority, category, and due date support. Data is persisted to a JSON file.';

export const input_schema = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'list', 'complete', 'delete', 'update', 'clear'],
      description: 'Action to perform: add, list, complete, delete, update, or clear',
    },
    text: {
      type: 'string',
      description: 'Task text (required for "add" action)',
    },
    priority: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Task priority: low, medium, or high (default: medium)',
    },
    due_date: {
      type: 'string',
      description: 'Due date in ISO 8601 format (e.g. 2025-12-31T23:59:59Z)',
    },
    category: {
      type: 'string',
      description: 'Task category (e.g. "development", "meeting", "documentation")',
    },
    id: {
      type: 'string',
      description: 'Todo item ID (required for "complete", "delete", "update" actions)',
    },
    completed: {
      type: 'boolean',
      description: 'Completion status (used with "update" action)',
    },
    filter: {
      type: 'string',
      enum: ['all', 'pending', 'completed'],
      description: 'Filter for "list" action: all, pending, or completed',
    },
    sort_by: {
      type: 'string',
      enum: ['created_at', 'priority', 'due_date'],
      description: 'Sort order for "list" action: created_at, priority, or due_date',
    },
    todo_file: {
      type: 'string',
      description: 'Custom todo file path (optional, default: agent-configured path or .todos.json in project root)',
    },
  },
  required: ['action'],
};

export const execute = async (
  { action, text, priority, due_date, category, id, completed, filter = 'all', sort_by = 'created_at', todo_file },
  ctx = {},
) => {
  const trustedPaths = ctx.agent?.trustedPaths;
  const todoPath = todo_file || ctx.agent?._todoFile || path.join(process.cwd(), '.todos.json');

  try {
    let todos = await readTodos(todoPath, trustedPaths);

    switch (action) {
      case 'add': {
        if (!text || text.trim().length === 0) {
          throw new Error('Parameter "text" is required to add a new todo.');
        }

        if (todos.length >= MAX_TODOS) {
          throw new Error(`Maximum todo limit reached (${MAX_TODOS}). Delete some todos first.`);
        }

        const newTodo = {
          id: generateId(),
          text: text.trim(),
          priority: priority || 'medium',
          category: category || 'general',
          completed: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          due_date: due_date || null,
        };

        todos.push(newTodo);
        await writeTodos(todoPath, todos, trustedPaths);

        const dueDate = newTodo.due_date ? new Date(newTodo.due_date) : null;
        const dueInfo = dueDate ? ` (Due: ${dueDate.toLocaleDateString('en-US')})` : '';

        return `Todo added:
   Text: ${newTodo.text}
   Priority: ${newTodo.priority.toUpperCase()}
   Category: ${newTodo.category}${dueInfo}
   ID: ${newTodo.id}`;
      }

      case 'list': {
        let filteredTodos = [...todos];
        const filterLabel = filter !== 'all' ? ` (${filter})` : '';

        if (filter === 'pending') {
          filteredTodos = todos.filter((t) => !t.completed);
        } else if (filter === 'completed') {
          filteredTodos = todos.filter((t) => t.completed);
        }

        // Sort
        filteredTodos.sort((a, b) => {
          if (sort_by === 'priority') {
            const priorityOrder = { high: 3, medium: 2, low: 1 };
            return priorityOrder[b.priority] - priorityOrder[a.priority];
          } else if (sort_by === 'due_date') {
            if (!a.due_date && !b.due_date) return 0;
            if (!a.due_date) return 1;
            if (!b.due_date) return -1;
            return new Date(a.due_date) - new Date(b.due_date);
          } else {
            // created_at (default) — newest first
            return new Date(b.created_at) - new Date(a.created_at);
          }
        });

        if (filteredTodos.length === 0) {
          return `No tasks${filterLabel}.`;
        }

        let output = `Task List${filterLabel} - Total: ${filteredTodos.length}\n`;
        output += `${'-'.repeat(60)}\n`;

        filteredTodos.forEach((todo, index) => {
          const status = todo.completed ? '[done]' : '[pending]';
          const priorityLabel = { high: '[high]', medium: '[medium]', low: '[low]' }[todo.priority];

          let dueInfo = '';
          if (todo.due_date) {
            const dueDate = new Date(todo.due_date);
            const isOverdue = !todo.completed && dueDate < new Date();
            dueInfo = ` | ${isOverdue ? '[overdue]' : 'due:'} ${dueDate.toLocaleDateString('en-US')}`;
          }

          output += `${index + 1}. ${status} ${priorityLabel} ${todo.text}\n`;
          output += `   ID: ${todo.id} | ${todo.category.toUpperCase()} | Created: ${new Date(todo.created_at).toLocaleDateString('en-US')}${dueInfo}\n`;
        });

        // Summary
        const total = todos.length;
        const completedCount = todos.filter((t) => t.completed).length;
        const pendingCount = total - completedCount;
        output += `\n${'-'.repeat(60)}\n`;
        output += `Summary: ${completedCount}/${total} completed | ${pendingCount} pending`;

        return output;
      }

      case 'complete': {
        if (!id) {
          throw new Error('Parameter "id" is required to complete a todo.');
        }

        const todo = todos.find((t) => t.id === id);
        if (!todo) {
          throw new Error(`Todo with ID "${id}" not found.`);
        }

        if (todo.completed) {
          return `Todo "${todo.text}" is already completed.`;
        }

        todo.completed = true;
        todo.updated_at = new Date().toISOString();
        await writeTodos(todoPath, todos, trustedPaths);

        return `Todo completed:\n   "${todo.text}"`;
      }

      case 'delete': {
        if (!id) {
          throw new Error('Parameter "id" is required to delete a todo.');
        }

        const index = todos.findIndex((t) => t.id === id);
        if (index === -1) {
          throw new Error(`Todo with ID "${id}" not found.`);
        }

        const deletedTodo = todos.splice(index, 1)[0];
        await writeTodos(todoPath, todos, trustedPaths);

        return `Todo deleted:\n   "${deletedTodo.text}"`;
      }

      case 'update': {
        if (!id) {
          throw new Error('Parameter "id" is required to update a todo.');
        }

        const todo = todos.find((t) => t.id === id);
        if (!todo) {
          throw new Error(`Todo with ID "${id}" not found.`);
        }

        const updates = [];

        if (text !== undefined) {
          todo.text = text.trim();
          updates.push('text');
        }

        if (priority !== undefined) {
          todo.priority = priority;
          updates.push('priority');
        }

        if (category !== undefined) {
          todo.category = category;
          updates.push('category');
        }

        if (due_date !== undefined) {
          todo.due_date = due_date;
          updates.push('due date');
        }

        if (completed !== undefined) {
          todo.completed = completed;
          updates.push('status');
        }

        todo.updated_at = new Date().toISOString();
        await writeTodos(todoPath, todos, trustedPaths);

        if (updates.length === 0) {
          return `No changes applied to todo "${todo.text}".`;
        }

        const statusLabel = todo.completed ? '[done]' : '[pending]';
        const priorityLabel = { high: '[high]', medium: '[medium]', low: '[low]' }[todo.priority];

        let dueInfo = '';
        if (todo.due_date) {
          const dueDate = new Date(todo.due_date);
          const isOverdue = !todo.completed && dueDate < new Date();
          dueInfo = ` | ${isOverdue ? '[overdue]' : 'due:'} ${dueDate.toLocaleDateString('en-US')}`;
        }

        return `Todo updated:
   "${todo.text}"
   Status: ${statusLabel} ${todo.completed ? 'Completed' : 'Pending'}
   Priority: ${priorityLabel} ${todo.priority.toUpperCase()}
   Category: ${todo.category.toUpperCase()}${dueInfo}
   Changed: ${updates.join(', ')}`;
      }

      case 'clear': {
        const count = todos.length;
        if (count === 0) {
          return 'Todo list is already empty.';
        }

        todos = [];
        await writeTodos(todoPath, todos, trustedPaths);

        return `Cleared ${count} todos.`;
      }

      default:
        throw new Error(`Unknown action "${action}". Use: add, list, complete, delete, update, or clear.`);
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Todo file is not accessible: ${todoPath}`, { cause: error });
    }
    throw error;
  }
};
