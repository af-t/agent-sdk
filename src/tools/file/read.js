import fs from 'node:fs/promises';
import { ensureSafePath } from '../../core/utils.js';
import { hashContent, isRangeCovered, mergeRanges } from '../../core/file-state.js';

const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB

export const name = 'Read';
export const parallelSafe = true;
export const description =
  'Read the contents of a file with pagination and line numbers. Use pagination (start_line/end_line) for large files to avoid context overflow and ensure efficient reading.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File path' },
    start_line: { type: 'number', description: 'Line to start reading from' },
    end_line: { type: 'number', description: 'Line to end reading at' },
    max_lines: { type: 'number', description: 'Max lines to return (default 1500)' },
  },
  required: ['path'],
};

export const execute = async ({ path: filePath, start_line = 1, end_line = Infinity, max_lines = 1500 }, ctx = {}) => {
  const safePath = ensureSafePath(filePath, ctx.agent?.trustedPaths);

  const stat = await fs.stat(safePath);
  if (stat.size > MAX_READ_SIZE) {
    throw new Error(`File too large (${stat.size} bytes). Maximum readable size is ${MAX_READ_SIZE} bytes (10MB).`);
  }

  const content = await fs.readFile(safePath, 'utf8');
  const lines = content.split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  const totalLines = lines.length;
  const start = Math.max(0, start_line - 1);
  const end = Math.min(totalLines, end_line || totalLines);
  const slice = lines.slice(start, end).slice(0, max_lines);

  const requestedStart = start + 1;
  const effectiveEnd = start + slice.length;

  const fileState = ctx.agent?.fileState;
  const turn = ctx.agent?.currentTurn ?? 0;

  if (fileState) {
    const hash = hashContent(content);
    const prev = fileState.get(safePath);
    if (prev && prev.hash === hash && isRangeCovered(prev.rangesRead, requestedStart, effectiveEnd)) {
      return `[CACHED] ${filePath} unchanged since turn ${prev.lastReadTurn}. Lines ${requestedStart}-${effectiveEnd} already in context. (Total: ${totalLines} lines)`;
    }
    const baseRanges = prev && prev.hash === hash ? prev.rangesRead : [];
    const newRanges = mergeRanges([...baseRanges, [requestedStart, effectiveEnd]]);
    fileState.set(safePath, { hash, lastReadTurn: turn, rangesRead: newRanges, totalLines });
  }

  let result = slice
    .map((line, i) => {
      const lineNum = start + i + 1;
      return `${String(lineNum).padStart(6, ' ')}\t${line}`;
    })
    .join('\n');

  if (totalLines > end || end - start > max_lines) {
    result += '\n[... truncated]';
  }
  return result;
};
