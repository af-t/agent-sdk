import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureSafePath } from '../../core/utils.js';

export const name = 'Write';
export const description = 'Create a new file or completely overwrite an existing one with full content. This tool will automatically create any missing parent directories.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Destination path' },
    content: { type: 'string', description: 'Full content to write' }
  },
  required: ['path', 'content']
};

export const execute = async ({ path: filePath, content }) => {
  try {
    const fullPath = path.resolve(filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf8');

    return [
      `**File written**`,
      `  Full path      : ${fullPath}`,
      `  Relative       : ${path.relative(process.cwd(), fullPath)}`,
      `  Bytes written  : ${Buffer.from(content).length}`
    ].join('\n');
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
};
