import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafePath } from '../../support/path-safety.js';

// Hard cap to prevent unbounded growth
const MAX_TODOS = 1000;

const readTodos = async (filePath, trustedPaths = new Set()) => {
  try {
    const safePath = resolveSafePath(filePath, trustedPaths);
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
  const safePath = resolveSafePath(filePath, trustedPaths);
  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, JSON.stringify(todos, null, 2), 'utf8');
};

const generateId = () => {
  return Math.random().toString(36).substring(2, 7);
};

const formatTodoDetails = (todo) => {
  const status = todo.completed ? '[done]' : '[pending]';
  const priorityLabel = { high: '[high]', medium: '[medium]', low: '[low]' }[todo.priority];

  let dueInfo = '';
  if (todo.dueDate) {
    const due = new Date(todo.dueDate);
    const isOverdue = !todo.completed && due < new Date();
    dueInfo = ` | ${isOverdue ? '[overdue]' : 'due:'} ${due.toLocaleDateString('en-US')}`;
  }
  return { status, priorityLabel, dueInfo };
};

const description =
  'Manage a todo list to track tasks and activities. Supports add, list, complete, delete, update, and clear actions with filtering, sorting, priority, category, and due date support. Data is persisted to a JSON file.';

const inputSchema = {
  type: 'object',
  additionalProperties: false,
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
    dueDate: {
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
    sortBy: {
      type: 'string',
      enum: ['createdAt', 'priority', 'dueDate'],
      description: 'Sort order for "list" action: createdAt, priority, or dueDate',
    },
    todoFile: {
      type: 'string',
      description:
        'Custom todo file path (optional, default: the agent-configured path under storagePaths.tmpDir or the appName storage namespace).',
    },
  },
  required: ['action'],
};

const execute = async (
  { action, text, priority, dueDate, category, id, completed, filter = 'all', sortBy = 'createdAt', todoFile },
  ctx = {},
) => {
  const trustedPaths = ctx.agent?.trustedPaths;
  const todoPath = todoFile || ctx.agent?._todoFile;
  if (!todoPath) {
    throw new Error(
      'manageTodos requires a configured storage path. Provide a "todoFile" or run within an agent (storagePaths.tmpDir or the appName-derived default).',
    );
  }

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
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          dueDate: dueDate || null,
        };

        todos.push(newTodo);
        await writeTodos(todoPath, todos, trustedPaths);

        const due = newTodo.dueDate ? new Date(newTodo.dueDate) : null;
        const dueInfo = due ? ` (Due: ${due.toLocaleDateString('en-US')})` : '';

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

        filteredTodos.sort((a, b) => {
          if (sortBy === 'priority') {
            const priorityOrder = { high: 3, medium: 2, low: 1 };
            return priorityOrder[b.priority] - priorityOrder[a.priority];
          } else if (sortBy === 'dueDate') {
            if (!a.dueDate && !b.dueDate) return 0;
            if (!a.dueDate) return 1;
            if (!b.dueDate) return -1;
            return new Date(a.dueDate) - new Date(b.dueDate);
          } else {
            // createdAt (default): newest first
            return new Date(b.createdAt) - new Date(a.createdAt);
          }
        });

        if (filteredTodos.length === 0) {
          return `No tasks${filterLabel}.`;
        }

        let output = `Task List${filterLabel} - Total: ${filteredTodos.length}\n`;
        output += `${'-'.repeat(60)}\n`;

        filteredTodos.forEach((todo, index) => {
          const { status, priorityLabel, dueInfo } = formatTodoDetails(todo);

          output += `${index + 1}. ${status} ${priorityLabel} ${todo.text}\n`;
          output += `   ID: ${todo.id} | ${todo.category.toUpperCase()} | Created: ${new Date(todo.createdAt).toLocaleDateString('en-US')}${dueInfo}\n`;
        });

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
        todo.updatedAt = new Date().toISOString();
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

        if (dueDate !== undefined) {
          todo.dueDate = dueDate;
          updates.push('due date');
        }

        if (completed !== undefined) {
          todo.completed = completed;
          updates.push('status');
        }

        todo.updatedAt = new Date().toISOString();
        await writeTodos(todoPath, todos, trustedPaths);

        if (updates.length === 0) {
          return `No changes applied to todo "${todo.text}".`;
        }

        const { status: statusLabel, priorityLabel, dueInfo } = formatTodoDetails(todo);

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

export const manageTodos = { name: 'manageTodos', description, inputSchema, execute };
