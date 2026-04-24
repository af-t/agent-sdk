import fs from 'node:fs/promises';
import path from 'node:path';
import { getIgnoreFilter } from '../../core/utils.js';

export const name = 'Find';
export const description = 'Search for files by name or content within a directory, respecting .gitignore rules. Use this to locate specific files or code snippets when the exact path is unknown.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Directory to search in' },
    pattern: { type: 'string', description: 'Regex or text pattern' },
    mode: { type: 'string', enum: ['name', 'content'], description: 'Search mode' }
  },
  required: ['pattern', 'mode']
};

export const execute = async ({ path: dirPath = '.', pattern, mode }) => {
  try {
    const absPath = path.resolve(dirPath);
    const filter = await getIgnoreFilter();
    const regex = new RegExp(pattern, 'i');
    const matches = [];

    const search = async (currentDir) => {
      const entries = await fs.readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relativePath = path.relative(process.cwd(), fullPath);

        const filterPath = relativePath + (entry.isDirectory() ? '/' : '');
        if (filter.ignores(filterPath)) continue;

        if (mode === 'name') {
          if (regex.test(entry.name)) matches.push(relativePath);
        } else if (mode === 'content' && entry.isFile()) {
          const stats = await fs.stat(fullPath);
          if (stats.size > 1024 * 500) continue;

          const content = await fs.readFile(fullPath, 'utf8');
          if (content.includes('\u0000')) continue;

          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (regex.test(line)) {
              matches.push(`${relativePath}:${i + 1}: ${line.trim().slice(0, 100)}`);
            }
          });
        }

        if (entry.isDirectory()) await search(fullPath);
      }
    };

    await search(absPath);
    return matches.join('\n') || 'No matches found.';
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
};
