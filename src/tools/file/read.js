import { spawn } from 'node:child_process';
import path from 'node:path';

export const name = 'Read';
export const description = 'Read the contents of a file with pagination and line numbers. Use pagination (start_line/end_line) for large files to avoid context overflow and ensure efficient reading.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File path' },
    start_line: { type: 'number', description: 'Line to start reading from' },
    end_line: { type: 'number', description: 'Line to end reading at' },
    max_lines: { type: 'number', description: 'Max lines to return (default 500)' }
  },
  required: ['path']
};

export const execute = async ({ path: filePath, start_line = 1, end_line = Infinity, max_lines = 500 }) => {
  return new Promise((resolve) => {
    const fullPath = path.resolve(filePath);
    const cat = spawn('cat', ['-n', fullPath]);
    let output = '';
    let error = '';

    cat.stdout.on('data', (data) => { output += data.toString(); });
    cat.stderr.on('data', (data) => { error += data.toString(); });

    cat.on('close', (code) => {
      if (code !== 0) {
        resolve(`ERROR: ${error.trim() || 'cat failed'}`);
        return;
      }

      // cat -n includes an extra newline at the end of the file if the file ends with a newline,
      // and split('\n') will create an extra empty element at the end.
      const lines = output.split('\n');
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }

      const start = Math.max(0, start_line - 1);
      const end = Math.min(lines.length, end_line || lines.length);
      const slice = lines.slice(start, end).slice(0, max_lines);

      // result already has line numbers from cat -n, but they have leading spaces.
      // e.g. "     1	content"
      // the original tool returned "1: content"
      // to stay somewhat consistent but use cat -n as requested, we'll keep the output as is from cat -n
      // but trim the leading spaces to be more user-friendly.

      let result = slice.join('\n');
      if (lines.length > end || (end - start) > max_lines) {
        result += '\n[... truncated]';
      }
      resolve(result);
    });
  });
};
