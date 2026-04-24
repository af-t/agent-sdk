import terminalManager from '../../core/terminal.js';

export const name = 'TerminalWait';
export const description = 'Register a background observer to watch for a specific pattern or idle timeout in a terminal session. Use this to synchronize with asynchronous processes.';
export const input_schema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The session ID' },
    pattern: { type: 'string', description: 'Regex pattern to watch for' },
    idleTimeout: { type: 'number', description: 'Seconds of silence before notifying (default 300)' }
  },
  required: ['id']
};

export const execute = async ({ id, pattern, idleTimeout }) => {
  try {
    terminalManager.addObserver(id, { pattern, idleTimeout: idleTimeout || 300 });
    return "SUCCESS: Observer registered. I will notify you when the event occurs.";
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
};
