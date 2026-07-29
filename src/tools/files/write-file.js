import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveSafePath } from '../../support/path-safety.js';
import { hashContent } from './file-state.js';

const MAX_WRITE_SIZE = 10 * 1024 * 1024;

const description =
  'Create a file or replace it when overwrite is true. Prefer editFile for partial changes. Do not submit more than one writeFile or editFile call for the same path in one turn.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'Destination path.' },
    content: { type: 'string', description: 'Complete file content.' },
    overwrite: {
      type: 'boolean',
      description: 'Allow a full replacement of an existing file.',
    },
  },
  required: ['path', 'content'],
};

const execute = async ({ path: filePath, content, overwrite = false }, ctx = {}) => {
  const safePath = resolveSafePath(filePath, ctx.agent?.trustedPaths, { restricted: ctx.agent?.restricted !== false });

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
      `File ${filePath} already exists. Use editFile for partial changes, or set overwrite to true for a full replacement.`,
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

  return `Wrote ${filePath} (${size} bytes).`;
};

export const writeFile = { name: 'writeFile', description, inputSchema, execute };
