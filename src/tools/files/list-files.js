import fs from 'node:fs/promises';
import path from 'node:path';
import { loadIgnoreFilter, resolveSafePath } from '../../support/path-safety.js';
import { formatBytes } from '../../support/payload.js';

const description = 'List files and directories under a path while respecting .gitignore rules.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'Directory to list.' },
    depth: { type: 'number', description: 'Directory depth to include. The default is 1.' },
  },
  required: ['path'],
};

const execute = async ({ path: dirPath = '.', depth = 1 }, ctx = {}) => {
  const absPath = resolveSafePath(dirPath, ctx.agent?.trustedPaths, { restricted: ctx.agent?.restricted !== false });
  const filter = await loadIgnoreFilter();
  const results = [];

  const walk = async (currentDir, currentDepth) => {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relativePath = path.relative(process.cwd(), fullPath);

      const filterPath = relativePath + (entry.isDirectory() ? '/' : '');
      if (filter.ignores(filterPath)) continue;
      if (relativePath.match(/\.git\//)) continue;

      let type = '';
      let suffix = '';

      if (entry.isDirectory()) {
        type = '/';
      } else if (entry.isSymbolicLink()) {
        type = '@';
      } else if (entry.isFIFO()) {
        type = '|';
      } else if (entry.isSocket()) {
        type = '=';
      }

      if (entry.isFile()) {
        try {
          const stats = await fs.stat(fullPath);
          suffix = ` (${formatBytes(stats.size)})`;
        } catch {
          suffix = '';
        }
      }

      results.push(`${relativePath}${type}${suffix}`);

      if (entry.isDirectory() && currentDepth < depth) {
        await walk(fullPath, currentDepth + 1);
      }
    }
  };

  await walk(absPath, 0);
  return results.join('\n') || '(Empty directory)';
};

export const listFiles = { name: 'listFiles', description, inputSchema, execute };
