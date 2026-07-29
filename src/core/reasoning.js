export function mergeReasoningDelta(acc, deltaDetails) {
  const out = Array.isArray(acc) ? acc.slice() : [];
  if (!Array.isArray(deltaDetails)) return out;
  for (const block of deltaDetails) {
    if (!block || typeof block !== 'object') continue;
    const slot = findSlot(out, block);
    if (slot === -1) {
      out.push(cloneBlock(block));
    } else {
      out[slot] = mergeBlock(out[slot], block);
    }
  }
  return out;
}

export function finalizeReasoningDetails(acc) {
  if (!Array.isArray(acc) || acc.length === 0) return undefined;
  return acc.slice().sort((a, b) => indexOf(a) - indexOf(b));
}

// Stable sorting keeps insertion order when a block has no index.
function indexOf(block) {
  return typeof block.index === 'number' ? block.index : 0;
}

function findSlot(out, block) {
  if (typeof block.index === 'number') {
    return out.findIndex((b) => b.index === block.index);
  }
  const last = out.length - 1;
  if (last >= 0 && out[last].type === block.type) return last;
  return -1;
}

// Only provider fields the SDK understands are copied.
function cloneBlock(block) {
  const b = {};
  for (const key of ['type', 'index', 'id', 'format', 'text', 'summary', 'data', 'signature']) {
    if (block[key] !== undefined) b[key] = block[key];
  }
  return b;
}

// Content is concatenated while later metadata replaces earlier values.
function mergeBlock(existing, block) {
  const b = { ...existing };
  if (block.text !== undefined) b.text = (b.text || '') + block.text;
  if (block.summary !== undefined) b.summary = (b.summary || '') + block.summary;
  if (block.data !== undefined) b.data = (b.data || '') + block.data;
  for (const key of ['type', 'index', 'id', 'format', 'signature']) {
    if (block[key] !== undefined) b[key] = block[key];
  }
  return b;
}

export function sanitizeAssistantReasoning(msg) {
  if (!msg || msg.role !== 'assistant') return msg;

  // A populated reasoning_details value supersedes the plain reasoning field.
  const hasDetails =
    msg.reasoning_details !== undefined &&
    msg.reasoning_details !== null &&
    (!Array.isArray(msg.reasoning_details) || msg.reasoning_details.length > 0);

  if (hasDetails) {
    if (msg.reasoning !== undefined) {
      const out = { ...msg };
      delete out.reasoning;
      return out;
    }
    return msg;
  }

  return msg;
}
