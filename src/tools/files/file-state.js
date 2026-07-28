import crypto from 'node:crypto';

export function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function isRangeCovered(ranges, start, end) {
  for (const [s, e] of ranges) {
    if (s <= start && e >= end) return true;
  }
  return false;
}

export function mergeRanges(ranges) {
  if (ranges.length === 0) return [];
  const sorted = ranges.map(([s, e]) => [s, e]).sort((a, b) => a[0] - b[0]);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    const [s, e] = sorted[i];
    if (s <= last[1] + 1) {
      last[1] = Math.max(last[1], e);
    } else {
      out.push([s, e]);
    }
  }
  return out;
}
