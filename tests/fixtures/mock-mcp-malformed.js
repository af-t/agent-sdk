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
      // This response is malformed JSON rather than a complete object.
      console.log('{ "jsonrpc": "2.0", "id": ' + msg.id + ', "result": { "incomplete": true ');
      // The response has no closing brace.
    }
  } catch {
    // Ignore non-JSON input, including an echoed copy of the malformed response.
  }
});
