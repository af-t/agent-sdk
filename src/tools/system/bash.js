import pty from 'node-pty';

export const name = 'Bash';
export const description = 'Execute a shell command. Use this for system operations that do not have a specialized tool, such as running tests, performing builds, or using complex CLI utilities.';
export const input_schema = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'Shell command to execute' },
    cwd: { type: 'string', description: 'Working directory' },
    env: { type: 'object', description: 'Environment variables' },
    timeout: { type: 'number', description: 'Timeout in ms (default 300000)' }
  },
  required: ['command']
};

export const execute = async ({ command, cwd = process.cwd(), env = process.env, timeout = 300000 }) => {
  return new Promise((resolve) => {
    // node-pty spawn creates a pseudo-terminal
    const ptyProcess = pty.spawn('bash', ['-c', command], {
      name: 'xterm-color',
      cols: 80,
      rows: 30,
      cwd,
      env
    });

    let output = '';
    const timer = setTimeout(() => {
      ptyProcess.kill();
      resolve(`Execution timed out after ${timeout}ms\n\nPartial Output:\n${output}`);
    }, timeout);

    ptyProcess.onData((data) => {
      output += data;
    });

    ptyProcess.onExit(({ exitCode, signal }) => {
      clearTimeout(timer);
      if (exitCode !== 0) {
        // node-pty combines stdout and stderr
        // return the accumulated output if the process exited with error
        resolve(output || `Process exited with code ${exitCode}${signal ? ' and signal ' + signal : ''}`);
      } else {
        resolve(output);
      }
    });
  });
};
