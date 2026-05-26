import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureSafePath } from '../../core/utils.js';
import { hashContent } from '../../core/file-state.js';

const MAX_WRITE_SIZE = 10 * 1024 * 1024; // 10MB limit to prevent disk exhaustion

export const name = 'Write';
export const description =
  'Create a new file, or overwrite an existing one by passing overwrite=true. Prefer Edit for partial changes. This tool will automatically create any missing parent directories. Side effect: writes/overwrites the target file. Do not issue parallel Write or Edit calls against the same path.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Destination path' },
    content: { type: 'string', description: 'Full content to write' },
    overwrite: {
      type: 'boolean',
      description: 'Set true to intentionally overwrite an existing file. Prefer Edit for partial changes.',
    },
  },
  required: ['path', 'content'],
};

export const execute = async ({ path: filePath, content, overwrite = false }, ctx = {}) => {
  const safePath = ensureSafePath(filePath, ctx.agent?.trustedPaths, { restricted: ctx.agent?.restricted !== false });

  const size = Buffer.byteLength(content, 'utf8');
  if (size > MAX_WRITE_SIZE) {
    throw new Error(`File too large (${size} bytes). Maximum allowed is ${MAX_WRITE_SIZE} bytes (10MB).`);
  }

  let exists;
  try {
    await fs.access(safePath);
    exists = true;
  } catch {
    exists = false;
  }
  if (exists && overwrite !== true) {
    throw new Error(
      `File ${filePath} already exists. Use Edit for partial changes, or pass overwrite=true for an intentional full rewrite.`,
    );
  }

  await fs.mkdir(path.dirname(safePath), { recursive: true });
  await fs.writeFile(safePath, content, 'utf8');

  const fileState = ctx.agent?.fileState;
  if (fileState) {
    const hash = hashContent(content);
    const totalLines = content.split('\n').length;
    fileState.set(safePath, {
      hash,
      lastReadTurn: ctx.agent?.currentTurn ?? 0,
      rangesRead: [[1, totalLines]],
      totalLines,
    });
  }

  return [
    `**File written**`,
    `  Absolute path  : ${safePath}`,
    `  Relative path  : ${path.relative(process.cwd(), safePath)}`,
    `  Bytes written  : ${Buffer.from(content).length}`,
  ].join('\n');
};
