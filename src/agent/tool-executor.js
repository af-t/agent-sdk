// A model tried to send rich content again after the provider already rejected
// it once this run; the run has since been marked text-only.
const MULTIMODAL_UNSUPPORTED_NOTICE =
  '[Multimodal content not displayed. This model does not support it. Do not attempt to describe or guess the content.]';

function parseToolArguments(toolCall) {
  // Zero-parameter tools stream an empty arguments string; treat
  // empty/whitespace/missing as an empty object instead of failing.
  const rawArgs = toolCall.function.arguments;
  return rawArgs && rawArgs.trim() ? JSON.parse(rawArgs.trim()) : {};
}

// Turns a tool's raw return value into the text that belongs in the tool
// message and the multimodal parts (if any) that belong in a follow-up user
// message. `multimodalUnsupported` marks a run where the provider has already
// rejected rich content once, so any further attachments are replaced with a
// text notice instead of being queued again.
function extractOutput(result, multimodalUnsupported) {
  const richParts = [];
  let output;

  if (Array.isArray(result)) {
    const textParts = [];
    for (const part of result) {
      if (part && typeof part === 'object') {
        if (part.type === 'text') {
          textParts.push(part.text);
        } else if (part.type !== undefined) {
          if (!multimodalUnsupported) richParts.push(part);
        } else {
          textParts.push(JSON.stringify(part));
        }
      } else {
        textParts.push(String(part));
      }
    }
    if (richParts.length > 0) {
      output = textParts.join('\n') || '[File loaded successfully as multimodal content]';
    } else if (multimodalUnsupported && result.some((p) => p && typeof p === 'object' && p.type && p.type !== 'text')) {
      output = (textParts.join('\n') || '') + '\n' + MULTIMODAL_UNSUPPORTED_NOTICE;
    } else {
      output = result.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join('\n');
    }
  } else if (result && typeof result === 'object' && result.type) {
    if (result.type === 'text') {
      output = result.text;
    } else if (multimodalUnsupported) {
      output = MULTIMODAL_UNSUPPORTED_NOTICE;
    } else {
      richParts.push(result);
      output = '[File loaded successfully as multimodal content]';
    }
  } else {
    output = typeof result === 'string' ? result : JSON.stringify(result);
  }

  return { output, richParts };
}

// Turns one model tool call into a complete tool-result message and the
// multimodal parts it produced, if any. It never throws for a tool-level
// failure. Malformed calls, invalid arguments, and tool rejections all land in
// the returned message's `content`, so the run loop always
// has a message to push. Rich-content queuing (the follow-up user message,
// pending-call bookkeeping) stays with the caller, since that touches
// conversation history and this class does not.
export class ToolExecutor {
  constructor({ registry, logger }) {
    this.registry = registry;
    this.logger = logger.child({ component: 'toolExecutor' });
  }

  async execute(toolCall, context = {}) {
    const { agent, logger, maxToolOutput, signal, multimodalUnsupported, broadcast } = context;
    // A provider response is never fully trusted to have
    // the shape it is supposed to, and the id is worth keeping even when the
    // rest of the call is too malformed to run, so the tool-result message
    // still pairs with the assistant's tool_calls entry.
    const tool_call_id = toolCall?.id;

    let name;
    let input;
    try {
      name = toolCall.function.name;
      input = parseToolArguments(toolCall);
    } catch (parseErr) {
      this.logger.warn({ tool: name, error: parseErr }, 'Failed to parse tool arguments');
      // The call never reached the registry or announced a start, so it has no
      // matching end event.
      return {
        role: 'tool',
        content: `Error: Invalid arguments: ${parseErr.message}`,
        tool_call_id,
        durationMs: undefined,
        richParts: [],
      };
    }

    await broadcast?.({ toolStart: { toolCallId: tool_call_id, name, input } });

    this.logger.debug({ tool: name }, 'Executing tool');
    const started = Date.now();
    let output;
    let richParts = [];
    let toolError;
    try {
      const result = await this.registry.execute(name, input, { agent, logger, maxToolOutput, signal, tool_call_id });
      ({ output, richParts } = extractOutput(result, multimodalUnsupported));
    } catch (err) {
      toolError = err;
    }
    const durationMs = Date.now() - started;

    const endEvent = { toolCallId: tool_call_id, name, durationMs };
    if (toolError) endEvent.error = toolError.message;
    else endEvent.output = output;
    await broadcast?.({ toolEnd: endEvent });

    if (toolError) {
      this.logger.warn({ tool: name, error: toolError }, 'Tool call failed');
      return {
        role: 'tool',
        content: `Error: ${toolError.message ?? toolError}`,
        tool_call_id,
        durationMs,
        richParts: [],
      };
    }

    return { role: 'tool', content: output, tool_call_id, durationMs, richParts };
  }
}
