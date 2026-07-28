import { createInterface } from 'node:readline';

const lines = createInterface({ input: process.stdin, terminal: false });
process.stderr.write('Bearer mcp-diagnostic-secret\n');

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: { capabilities: { tools: {} }, serverInfo: { name: 'hanging-call' } },
      }) + '\n',
    );
  } else if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }) + '\n');
  }
});
