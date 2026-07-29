// After initialize, this fixture sends malformed messages with null or empty
// methods and no ID. The client drops them, then emits the valid notification
// that follows.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
}

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { capabilities: {}, serverInfo: { name: 'null-method-server' } } });
    send({ method: null });
    send({ method: '' });
    send({ method: 'test/ping', params: {} });
  }
});
