import terminalManager from '../../core/terminal.js';

export const name = 'TerminalDestroy';
export const description = 'Terminate an active shell session. Use this to clean up resources once a terminal-based task is finished or the session is no longer needed.';
export const input_schema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The session ID' }
  },
  required: ['id']
};

export const execute = async ({ id }) => {
  try {
    terminalManager.destroy(id);
    return `SUCCESS: Session ${id} destroyed`;
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
};
