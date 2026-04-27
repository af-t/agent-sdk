import terminalManager from '../../core/terminal.js';

export const name = 'TerminalWrite';
export const description = 'Send input strings or commands to an active terminal session. Use this to interact with shell processes or CLI tools running in the terminal.';
export const input_schema = {
  type: 'object',
  properties: {
    id: { type: 'string', description: 'The session ID' },
    input: { type: 'string', description: 'The text/command to write' }
  },
  required: ['id', 'input']
};

export const execute = async ({ id, input }) => {
  try {
    input = input.endsWith('\n') ? input : input + '\n';

    if (input.includes('echo') && input.includes('>')) {
      throw Error('using echo to write files is prohibited');
    }

    if (input.includes('cat') && input.includes('>') && input.includes('<<')) {
      throw Error('using cat to write files is prohibited');
    }

    terminalManager.write(id, input);
    return `Input sent to session ${id}`;
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
};
