import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureSafePath } from '../../core/utils.js';

const MAX_WRITE_SIZE = 10 * 1024 * 1024; // 10MB limit to prevent disk exhaustion

export const name = 'Write';
export const description =
  'Create a new file or completely overwrite an existing one with full content. This tool will automatically create any missing parent directories.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Destination path' },
    content: { type: 'string', description: 'Full content to write' },
  },
  required: ['path', 'content'],
};

export const execute = async ({ path: filePath, content }) => {
  try {
    const safePath = ensureSafePath(filePath);

    // Reject oversized writes to prevent disk exhaustion
    const size = Buffer.byteLength(content, 'utf8');
    if (size > MAX_WRITE_SIZE) {
      throw new Error(`File too large (${size} bytes). Maximum allowed is ${MAX_WRITE_SIZE} bytes (10MB).`);
    }

    await fs.mkdir(path.dirname(safePath), { recursive: true });
    await fs.writeFile(safePath, content, 'utf8');

    return [
      `**File written**`,
      `  Absolute path  : ${safePath}`,
      `  Relative path  : ${path.relative(process.cwd(), safePath)}`,
      `  Bytes written  : ${Buffer.from(content).length}`,
    ].join('\n');
  } catch (error) {
    throw error;
  }
};
