// MCP mock: after initialize, sends malformed messages with method: null and
// method: '' and no id (must be silently dropped, not emitted as
// notifications), followed by a well-formed notification (must still be
// emitted normally).
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
