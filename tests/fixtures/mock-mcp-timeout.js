import { createInterface } from 'node:readline';

// This fixture starts successfully and never responds to initialize.
console.error('[MCP Server]: MOCK-TIMEOUT-SERVER: started (will not respond to initialize)');

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

// We ignore all input and never send anything to stdout.
rl.on('line', (_line) => {
  // The fixture intentionally leaves every request unanswered.
});
