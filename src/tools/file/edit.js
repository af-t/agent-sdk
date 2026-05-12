import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ensureSafePath } from '../../core/utils.js';

async function diff(file1, file2) {
  const output = [];
  const errOutput = [];
  return new Promise((resolve, reject) => {
    const child = spawn('diff', [file1, file2], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errOutput.push(chunk));
    child.on('error', (err) => reject(err));
    child.on('exit', (code) => {
      if (code > 1) {
        const err = Buffer.concat(errOutput).toString();
        const out = Buffer.concat(output).toString();
        reject(new Error(`diff failed with code ${code}: ${err || out}`));
        return;
      }
      resolve(Buffer.concat(output).toString());
    });
  });
}

function validateEdit(edit, i) {
  const label = `edit[${i}]`;
  if (!['replace', 'insert', 'delete'].includes(edit.action)) {
    throw new Error(`${label}: unknown action '${edit.action}'. Use replace, insert, or delete.`);
  }
  if (edit.action === 'replace') {
    if (edit.new_text === undefined) throw new Error(`${label}: replace requires 'new_text'`);
    if (!edit.old_text && (edit.start_line === undefined || edit.end_line === undefined)) {
      throw new Error(`${label}: replace requires 'old_text' or 'start_line'+'end_line'`);
    }
    if (edit.start_line !== undefined && edit.end_line !== undefined && edit.start_line > edit.end_line) {
      throw new Error(`${label}: start_line (${edit.start_line}) must not exceed end_line (${edit.end_line})`);
    }
  }
  if (edit.action === 'insert') {
    if (edit.text === undefined) throw new Error(`${label}: insert requires 'text'`);
    if (!['before', 'after'].includes(edit.position)) {
      throw new Error(`${label}: insert requires 'position' ("before" or "after")`);
    }
    if (!edit.anchor_text && edit.line === undefined) {
      throw new Error(`${label}: insert requires 'anchor_text' or 'line'`);
    }
  }
  if (edit.action === 'delete') {
    if (!edit.old_text && (edit.start_line === undefined || edit.end_line === undefined)) {
      throw new Error(`${label}: delete requires 'old_text' or 'start_line'+'end_line'`);
    }
    if (edit.start_line !== undefined && edit.end_line !== undefined && edit.start_line > edit.end_line) {
      throw new Error(`${label}: start_line (${edit.start_line}) must not exceed end_line (${edit.end_line})`);
    }
  }
}

function applyEdit(content, edit, i) {
  const label = `edit[${i}]`;

  if (edit.action === 'replace') {
    if (edit.old_text) {
      const occurrences = content.split(edit.old_text).length - 1;
      if (occurrences === 0) throw new Error(`${label}: 'old_text' not found`);
      if (occurrences > 1) throw new Error(`${label}: 'old_text' found multiple times. Provide more context.`);
      return content.replace(edit.old_text, () => edit.new_text);
    }
    const lines = content.split('\n');
    const start = Math.max(0, edit.start_line - 1);
    const end = Math.min(lines.length, edit.end_line);
    lines.splice(start, end - start, edit.new_text);
    return lines.join('\n');
  }

  if (edit.action === 'insert') {
    const lines = content.split('\n');
    let insertIndex;
    if (edit.anchor_text !== undefined) {
      const idx = lines.findIndex((l) => l.includes(edit.anchor_text));
      if (idx === -1) throw new Error(`${label}: 'anchor_text' not found`);
      insertIndex = edit.position === 'after' ? idx + 1 : idx;
    } else {
      const M = lines.length;
      if (edit.line < 1 || edit.line > M) {
        throw new Error(`${label}: line ${edit.line} is out of range (file has ${M} lines)`);
      }
      insertIndex = edit.position === 'after' ? edit.line : edit.line - 1;
    }
    lines.splice(insertIndex, 0, edit.text);
    return lines.join('\n');
  }

  if (edit.action === 'delete') {
    if (edit.old_text) {
      const occurrences = content.split(edit.old_text).length - 1;
      if (occurrences === 0) throw new Error(`${label}: 'old_text' not found`);
      if (occurrences > 1) throw new Error(`${label}: 'old_text' found multiple times. Provide more context.`);
      return content.replace(edit.old_text, () => '');
    }
    const lines = content.split('\n');
    const start = Math.max(0, edit.start_line - 1);
    const end = Math.min(lines.length, edit.end_line);
    lines.splice(start, end - start);
    return lines.join('\n');
  }
}

export const name = 'Edit';
export const description =
  'Surgically update a file with one or more sequential actions (replace, insert, delete). All actions target the same file and are applied top-to-bottom. The file is only written if every action succeeds.';

export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File to update' },
    edits: {
      type: 'array',
      description: 'Edit actions applied sequentially. File is unchanged if any action fails.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Action type' },
          old_text: { type: 'string', description: '(replace/delete) Exact text to find — must appear exactly once' },
          new_text: { type: 'string', description: '(replace) Replacement text' },
          start_line: { type: 'number', description: '(replace/delete) Start line, 1-based' },
          end_line: { type: 'number', description: '(replace/delete) End line, 1-based inclusive' },
          text: { type: 'string', description: '(insert) Text to insert' },
          position: { type: 'string', description: '(insert) "before" or "after" the anchor' },
          anchor_text: { type: 'string', description: '(insert) First line containing this string is the anchor' },
          line: { type: 'number', description: '(insert) 1-based line number anchor' },
        },
        required: ['action'],
      },
    },
  },
  required: ['path', 'edits'],
};

export const execute = async ({ path: filePath, edits }) => {
  if (!edits || edits.length === 0) throw new Error('edits must not be empty');

  const safePath = ensureSafePath(filePath);
  let content = (await fs.readFile(safePath, 'utf8'))
    .split('\n')
    .map((x) => x.replace(/ +$/, ''))
    .join('\n');

  for (let i = 0; i < edits.length; i++) {
    validateEdit(edits[i], i);
    content = applyEdit(content, edits[i], i);
  }

  const temp = path.join(os.tmpdir(), `.oasdk-${Array.from(crypto.randomBytes(5), (x) => x.toString(36)).join('')}`);
  await fs.writeFile(temp, content, 'utf8');
  const difference = await diff(safePath, temp);
  await fs.rm(temp, { force: true });
  await fs.writeFile(safePath, content, 'utf8');

  return difference
    ? `File ${filePath} updated successfully\n\ndiff:\n${difference}`
    : `File ${filePath} updated, but no diff found`;
};
