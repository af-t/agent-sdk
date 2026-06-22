// Accumulate one streaming delta into the reasoning_details list.
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

// Sort by index and drop empty result.
export function finalizeReasoningDetails(acc) {
  if (!Array.isArray(acc) || acc.length === 0) return undefined;
  return acc.slice().sort((a, b) => indexOf(a) - indexOf(b));
}

// index-less blocks sort as 0; stable sort preserves insertion order
function indexOf(block) {
  return typeof block.index === 'number' ? block.index : 0;
}

// Match by index, else the last entry of the same type.
function findSlot(out, block) {
  if (typeof block.index === 'number') {
    return out.findIndex((b) => b.index === block.index);
  }
  const last = out.length - 1;
  if (last >= 0 && out[last].type === block.type) return last;
  return -1;
}

// drops unknown fields (forward-compat assumption)
function cloneBlock(block) {
  const b = {};
  for (const key of ['type', 'index', 'id', 'format', 'text', 'summary', 'data', 'signature']) {
    if (block[key] !== undefined) b[key] = block[key];
  }
  return b;
}

// Concat content fields, overwrite stable metadata when present.
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

// payload-ready copy, dialect-aware
export function sanitizeAssistantReasoning(msg) {
  if (!msg || msg.role !== 'assistant') return msg;

  // If reasoning_details is present, we keep it regardless of the dialect.
  // We only delete reasoning if reasoning_details is a non-empty array/object to avoid redundancy.
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
