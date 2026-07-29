// On tools/list, this fixture first sends a server-to-client request that reuses
// the client's request ID. JSON-RPC permits this because IDs use per-sender namespaces.
// The fixture delivers the tools/list result only after the client answers that
// request with error -32601. This sequence exercises response/request routing.
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin, terminal: false });

function send(payload) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
}

let pendingToolsListId = null;

rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { capabilities: {}, serverInfo: { name: 'collision' } } });
  } else if (msg.method === 'tools/list') {
    pendingToolsListId = msg.id;
    // The server request deliberately collides with the client's request ID.
    send({ id: msg.id, method: 'roots/list', params: {} });
  } else if (msg.method === undefined && msg.id === pendingToolsListId && msg.error) {
    // The client rejected roots/list, so the server can deliver the tools/list result.
    send({
      id: pendingToolsListId,
      result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] },
    });
  }
});
