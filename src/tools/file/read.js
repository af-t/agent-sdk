import fs from 'node:fs/promises';
import { ensureSafePath } from '../../core/utils.js';

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
  try {
    const safePath = ensureSafePath(filePath, ctx.agent?.trustedPaths);

    // Check file size before reading to prevent memory exhaustion
    const stat = await fs.stat(safePath);
    if (stat.size > MAX_READ_SIZE) {
      throw new Error(`File too large (${stat.size} bytes). Maximum readable size is ${MAX_READ_SIZE} bytes (10MB).`);
    }

    // Read entire file content — use fs.readFile instead of spawn('cat') for portability & security
    const content = await fs.readFile(safePath, 'utf8');
    const lines = content.split('\n');
    // Remove trailing empty line from split
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }

    const start = Math.max(0, start_line - 1);
    const end = Math.min(lines.length, end_line || lines.length);
    const slice = lines.slice(start, end).slice(0, max_lines);

    // Format with line numbers like cat -n would
    let result = slice
      .map((line, i) => {
        const lineNum = start + i + 1;
        return `${String(lineNum).padStart(6, ' ')}\t${line}`;
      })
      .join('\n');

    if (lines.length > end || end - start > max_lines) {
      result += '\n[... truncated]';
    }
    return result;
  } catch (error) {
    throw error;
  }
};
