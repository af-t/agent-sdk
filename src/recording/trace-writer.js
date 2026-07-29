import fs from 'node:fs';
import { truncateOutput } from '../support/payload.js';

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
    if (event.toolCalls) {
      out += flushTurn();
      const names = event.toolCalls.map((tc) => tc.function?.name || tc.name || '?').join(', ');
      out += `[tool calls] ${names}\n`;
    }
    if (event.toolStart) {
      const { toolCallId, name, input } = event.toolStart;
      const inp = truncateOutput(safeStringify(input), toolOutputCap);
      out += `  -> ${name}#${toolCallId} start: ${inp}\n`;
    }
    if (event.toolEnd) {
      const { toolCallId, name, durationMs, output, error } = event.toolEnd;
      const body = error ? `ERROR ${error}` : truncateOutput(safeStringify(output), toolOutputCap);
      out += `  -> ${name}#${toolCallId} end (${durationMs}ms): ${body}\n`;
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
