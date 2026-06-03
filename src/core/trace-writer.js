import fs from 'node:fs';
import { truncateOutput } from './utils.js';

const TRACE_TOOL_OUTPUT_CAP = 2000;

function safeStringify(v) {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function createTraceFormatter({ toolOutputCap = TRACE_TOOL_OUTPUT_CAP } = {}) {
  let turn = 0;
  let lastReasoning = '';
  let lastContent = '';

  function flushTurn() {
    turn += 1;
    let block = `=== turn ${turn} ===\n`;
    if (lastReasoning.trim()) block += `[reasoning]\n${lastReasoning}\n`;
    if (lastContent.trim()) block += `[assistant]\n${lastContent}\n`;
    lastReasoning = '';
    lastContent = '';
    return block;
  }

  function step(event) {
    if (!event || typeof event !== 'object') return '';
    if (typeof event.reasoning === 'string') lastReasoning = event.reasoning;
    if (typeof event.content === 'string') lastContent = event.content;

    let out = '';
    if (event.tool_calls) {
      out += flushTurn();
      const names = event.tool_calls.map((tc) => tc.function?.name || tc.name || '?').join(', ');
      out += `[tool_calls] ${names}\n`;
    }
    if (event.tool_start) {
      const { tool_call_id, name, input } = event.tool_start;
      const inp = truncateOutput(safeStringify(input), toolOutputCap);
      out += `  -> ${name}#${tool_call_id} start: ${inp}\n`;
    }
    if (event.tool_end) {
      const { tool_call_id, name, duration_ms, output, error } = event.tool_end;
      const body = error ? `ERROR ${error}` : truncateOutput(safeStringify(output), toolOutputCap);
      out += `  -> ${name}#${tool_call_id} end (${duration_ms}ms): ${body}\n`;
    }
    return out;
  }

  function flush() {
    if (lastReasoning.trim() || lastContent.trim()) return flushTurn();
    return '';
  }

  return { step, flush };
}

export function createTraceWriter(logPath, opts = {}) {
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  const fmt = createTraceFormatter(opts);

  function notify(event) {
    const chunk = fmt.step(event);
    if (chunk) stream.write(chunk);
  }

  function close() {
    const tail = fmt.flush();
    if (tail) stream.write(tail);
    return new Promise((resolve) => stream.end(resolve));
  }

  return { notify, close };
}
