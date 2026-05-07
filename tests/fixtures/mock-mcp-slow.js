import { createInterface } from 'node:readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      // Wait 3 seconds before responding
      setTimeout(() => {
        console.log(
          JSON.stringify({
            jsonrpc: '2.0',
            id: msg.id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              serverInfo: { name: 'mock-slow-server', version: '1.0.0' },
            },
          }),
        );
      }, 3000);
    }
  } catch {}
});
