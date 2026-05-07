import { createInterface } from 'node:readline';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

rl.on('line', (line) => {
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      // Respond with malformed JSON instead of a valid object
      console.log('{ "jsonrpc": "2.0", "id": ' + msg.id + ', "result": { "incomplete": true '); 
      // Note: No closing brace, missing serverInfo, etc.
    }
  } catch {
    // If we receive something not JSON (like the malformed JSON we just sent if it was echoed back), 
    // just ignore it.
  }
});
