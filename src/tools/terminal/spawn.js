import terminalManager from '../../core/terminal.js';
import crypto from 'node:crypto';

export const name = 'TerminalSpawn';
export const description = 'Start a new persistent shell session. Use this for tasks that require interactive shell access or persistent state across multiple turns.';
export const input_schema = {
  type: 'object',
  properties: {
    shell: { type: 'string', description: 'The shell to spawn (default: bash or sh)' },
    cwd: { type: 'string', description: 'Initial working directory' },
    cols: { type: 'number', description: 'Terminal columns (default: 80)' },
    rows: { type: 'number', description: 'Terminal rows (default: 24)' }
  }
};

export const execute = async ({ shell, cwd, cols, rows }) => {
  try {
    const id = `term_${crypto.randomBytes(2).toString('hex')}`;
    terminalManager.spawn(id, { shell, cwd, cols, rows });
    return `Session started with ID: ${id}`;
  } catch (error) {
    return `Failed to spawn session: ${error.message}`;
  }
};
