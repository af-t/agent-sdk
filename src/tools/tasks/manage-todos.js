import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafePath } from '../../support/path-safety.js';

// The cap prevents unbounded todo-file growth.
const MAX_ITEMS = 1000;

const readTodos = async (filePath, trustedPaths = new Set()) => {
  try {
    const safePath = resolveSafePath(filePath, trustedPaths);
    const data = await fs.readFile(safePath, 'utf8');
    const todos = JSON.parse(data);
    if (!Array.isArray(todos)) {
      throw new Error('Todo file must contain a JSON array.');
    }
    if (
      todos.some(
        (todo) =>
          todo &&
          typeof todo === 'object' &&
          ['created_at', 'updated_at', 'due_date'].some((field) => Object.hasOwn(todo, field)),
      )
    ) {
      throw new Error(
        'This todo file uses removed fields. Rename created_at to createdAt, updated_at to updatedAt, and due_date to dueDate before using manageTodos.',
      );
    }
    return todos;
  } catch (error) {
    // A missing file represents an empty todo list.
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

const description = 'Add, list, complete, update, delete, or clear items in a JSON todo file.';

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'list', 'complete', 'delete', 'update', 'clear'],
      description: 'Operation to perform.',
    },
    text: {
      type: 'string',
      description: 'Todo text. Required for add.',
    },
    priority: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description: 'Priority. The default is medium.',
    },
    dueDate: {
      type: 'string',
      description: 'Due date in ISO 8601 format.',
    },
    category: {
      type: 'string',
      description: 'Optional category.',
    },
    id: {
      type: 'string',
      description: 'Todo ID. Required for complete, delete, and update.',
    },
    completed: {
      type: 'boolean',
      description: 'Completion value for update.',
    },
    filter: {
      type: 'string',
      enum: ['all', 'pending', 'completed'],
      description: 'Filter used by list.',
    },
    sortBy: {
      type: 'string',
      enum: ['createdAt', 'priority', 'dueDate'],
      description: 'Sort field used by list.',
    },
    todoFile: {
      type: 'string',
      description: 'Todo file path. The default comes from the agent storage configuration.',
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

        if (todos.length >= MAX_ITEMS) {
          throw new Error(`Maximum todo limit reached (${MAX_ITEMS}). Delete some todos first.`);
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
            // createdAt sorts the newest item first.
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
