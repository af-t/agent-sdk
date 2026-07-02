// MCP mock: on tools/list, first sends a server-to-client REQUEST that reuses
// the client's request id (legal per JSON-RPC — ids are per-sender namespaces),
// and only delivers the real tools/list result after the client answers that
// request with an error (-32601). Exercises the response/request routing fix.
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
    // server->client request deliberately colliding with the client's id
    send({ id: msg.id, method: 'roots/list', params: {} });
  } else if (msg.method === undefined && msg.id === pendingToolsListId && msg.error) {
    // client rejected our roots/list request — now deliver the real result
    send({
      id: pendingToolsListId,
      result: { tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: {} } }] },
    });
  }
});
