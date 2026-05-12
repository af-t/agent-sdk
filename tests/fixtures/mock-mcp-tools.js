import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line.trim());
    if (msg.id === undefined) return; // notifications need no response

    if (msg.method === 'initialize') {
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'mock-tools-server', version: '1.0.0' },
          },
        }),
      );
    } else if (msg.method === 'tools/list') {
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            tools: [
              {
                name: 'echo',
                description: 'Echoes back the input text',
                inputSchema: {
                  type: 'object',
                  properties: { text: { type: 'string' } },
                  required: ['text'],
                },
              },
            ],
          },
        }),
      );
    } else if (msg.method === 'tools/call') {
      const text = msg.params?.arguments?.text ?? '';
      console.log(
        JSON.stringify({
          jsonrpc: '2.0',
          id: msg.id,
          result: { content: [{ type: 'text', text: `echo: ${text}` }] },
        }),
      );
    }
  } catch {}
});
