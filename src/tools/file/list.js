import fs from 'node:fs/promises';
import path from 'node:path';
import { getIgnoreFilter, formatSize } from '../../core/utils.js';

export const name = 'List';
export const description = 'List files and directories at a specified path, respecting .gitignore rules. Use this to explore the project structure and discover available files and folders.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Directory to list' },
    recursive: { type: 'boolean', description: 'List subdirectories' },
    depth: { type: 'number', description: 'Recursion depth (default 1)' }
  }
};

export const execute = async ({ path: dirPath = '.', recursive = false, depth = 1 }) => {
  try {
    const absPath = path.resolve(dirPath);
    const filter = await getIgnoreFilter();
    const results = [];

    const walk = async (currentDir, currentDepth) => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path.relative(process.cwd(), fullPath);

        const filterPath = relativePath + (entry.isDirectory() ? '/' : '');
        if (filter.ignores(filterPath)) continue;

        let type = '[FILE]';
        let name = entry.name;
        let suffix = '';

        if (entry.isDirectory()) {
          type = '[DIR]';
          name += '/';
        } else if (entry.isSymbolicLink()) {
          type = '[LINK]';
          name += '@';
        }

        if (entry.isFile()) {
          try {
            const stats = await fs.stat(fullPath);
            suffix = ` (${formatSize(stats.size)})`;
          } catch {}
        }

        results.push(`${type} ${relativePath}${suffix}`);

        if (recursive && entry.isDirectory() && currentDepth < depth) {
          await walk(fullPath, currentDepth + 1);
        }
      }
    };

    await walk(absPath, 0);
    return results.join('\n') || '(Empty directory)';
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
};
