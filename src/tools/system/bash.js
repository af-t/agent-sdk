import pty from 'node-pty';

// Dangerous commands that should warn or be blocked
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//,
  /\bdd\s+if=/,
  /\bmkfs\./,
  /\b>:.*\/dev\//,
];

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
  // Warn about dangerous commands
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return `BLOCKED: Command matches dangerous pattern '${pattern}'. For safety, this command is not allowed.`;
    }
  }

  return new Promise((resolve) => {
    // node-pty spawn creates a pseudo-terminal
    const ptyProcess = pty.spawn('bash', ['-c', command], {
      name: 'xterm-256color',
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
        resolve(output || `Process exited with code ${exitCode}${signal ? ' and signal ' + signal : ''}`);
      } else {
        resolve(output);
      }
    });
  });
};
