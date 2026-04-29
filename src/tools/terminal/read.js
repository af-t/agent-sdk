import terminalManager from '../../core/terminal.js';

export const name = 'TerminalRead';
export const description = 'Retrieve the current accumulated output from a terminal session. Use this to check the result of long-running commands or to inspect the current state of the terminal.';
export const input_schema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The session ID' },
    clear: { type: 'boolean', description: 'If true, clears the buffer after reading' }
  },
  required: ['id']
};

export const execute = async ({ id, clear = false }) => {
  try {
    const output = terminalManager.read(id, clear);
    return output.text || "(No new output, maybe you forgot to write \\n after executing command)";
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
};
