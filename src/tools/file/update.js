import fs from 'node:fs/promises';
import path from 'node:path';

export const name = 'Edit';
export const description = 'Surgically update a file by replacing a specific text block or line range. Provide exact context to ensure the replacement is targeted, safe, and avoids unintended matches.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File to update' },
    new_text: { type: 'string', description: 'The replacement text' },
    old_text: { type: 'string', description: 'Exact text to find and replace (Priority 1)' },
    start_line: { type: 'number', description: 'Start line for range replacement (Priority 2)' },
    end_line: { type: 'number', description: 'End line for range replacement (Priority 2)' }
  },
  required: ['path', 'new_text']
};

export const execute = async ({ path: filePath, new_text, old_text, start_line, end_line }) => {
  try {
    const fullPath = path.resolve(filePath);
    const content = await fs.readFile(fullPath, 'utf8');

    if (old_text) {
      const occurrences = content.split(old_text).length - 1;
      if (occurrences === 0) throw new Error("'old_text' not found in file.");
      if (occurrences > 1) throw new Error("'old_text' found multiple times. Please provide more context.");

      const newContent = content.replace(old_text, new_text);
      await fs.writeFile(fullPath, newContent, 'utf8');
    } else if (start_line !== undefined && end_line !== undefined) {
      const lines = content.split('\n');
      const start = Math.max(0, start_line - 1);
      const end = Math.min(lines.length, end_line);

      lines.splice(start, end - start, new_text);
      await fs.writeFile(fullPath, lines.join('\n'), 'utf8');
    } else {
      throw new Error("Either 'old_text' or both 'start_line' and 'end_line' must be provided.");
    }
    return `File ${filePath} updated successfully`;
  } catch (error) {
    return `ERROR: ${error.message}`;
  }
};
