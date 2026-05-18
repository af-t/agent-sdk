import fs from 'node:fs/promises';
import path from 'node:path';
import { getIgnoreFilter, formatSize, ensureSafePath } from '../../core/utils.js';

export const name = 'List';
export const parallelSafe = true;
export const description =
  'List files and directories at a specified path, respecting .gitignore rules. Use this to explore the project structure and discover available files and folders.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Directory to list' },
    depth: { type: 'number', description: 'Recursion depth (default 1)' },
  },
  required: ['path'],
};

export const execute = async ({ path: dirPath = '.', depth = 1 }, ctx = {}) => {
  try {
    const absPath = ensureSafePath(dirPath, ctx.agent?.trustedPaths);
    const filter = await getIgnoreFilter();
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
            suffix = ` (${formatSize(stats.size)})`;
          } catch {
            suffix = ''; // stat failed — skip size display silently
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
  } catch (error) {
    throw error;
  }
};
