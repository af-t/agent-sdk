import { createInterface } from 'node:readline';

// MOCK-TIMEOUT-SERVER: started (will not respond to initialize)
console.error('[MCP Server]: MOCK-TIMEOUT-SERVER: started (will not respond to initialize)');

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// We ignore all input and never send anything to stdout.
rl.on('line', (_line) => {
  // Never respond
});
