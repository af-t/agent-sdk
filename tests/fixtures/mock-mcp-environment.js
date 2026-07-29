import { createInterface } from 'node:readline';

const unsafeKeys = ['BASH_ENV', 'LD_PRELOAD', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH'];
const lines = createInterface({ input: process.stdin, terminal: false });

lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          capabilities: { tools: {} },
          serverInfo: {
            name: 'environment-probe',
            unsafeKeys: unsafeKeys.filter((key) => Object.hasOwn(process.env, key)),
          },
        },
      }) + '\n',
    );
  } else if (message.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }) + '\n');
  }
});
