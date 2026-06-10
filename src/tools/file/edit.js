import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { ensureSafePath } from '../../core/utils.js';
import { hashContent } from '../../core/file-state.js';

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

function fmtSnippet(text) {
  const s = text.replace(/\n/g, '↵');
  return s.length > 60 ? s.substring(0, 60) + '…' : s;
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

function applyEdit(content, edit, i, lineOffset) {
  const label = `edit[${i}]`;

  if (edit.action === 'replace') {
    if (edit.old_text) {
      const occurrences = content.split(edit.old_text).length - 1;
      if (occurrences === 0) {
        const snippet = fmtSnippet(edit.old_text);
        throw new Error(
          `${label}: 'old_text' not found in file.\n  Searched for: "${snippet}"\n  Tip: check for trailing whitespace or indentation differences.`,
        );
      }
      if (occurrences > 1) {
        const snippet = fmtSnippet(edit.old_text);
        throw new Error(`${label}: 'old_text' found multiple times. Provide more context. Searched for: "${snippet}"`);
      }
      const delta = edit.new_text.split('\n').length - edit.old_text.split('\n').length;
      return { content: content.replace(edit.old_text, () => edit.new_text), delta };
    }
    const lines = content.split('\n');
    const start = Math.max(0, edit.start_line + lineOffset - 1);
    const end = Math.min(lines.length, edit.end_line + lineOffset);
    lines.splice(start, end - start, edit.new_text);
    const delta = edit.new_text.split('\n').length - (edit.end_line - edit.start_line + 1);
    return { content: lines.join('\n'), delta };
  }

  if (edit.action === 'insert') {
    const lines = content.split('\n');
    let insertIndex;
    if (edit.anchor_text !== undefined) {
      const idx = lines.findIndex((l) => l.includes(edit.anchor_text));
      if (idx === -1) throw new Error(`${label}: 'anchor_text' not found`);
      insertIndex = edit.position === 'after' ? idx + 1 : idx;
    } else {
      const adjustedLine = edit.line + lineOffset;
      const M = lines.length;
      if (adjustedLine < 1 || adjustedLine > M) {
        throw new Error(`${label}: line ${edit.line} is out of range (file has ${M} lines)`);
      }
      insertIndex = edit.position === 'after' ? adjustedLine : adjustedLine - 1;
    }
    lines.splice(insertIndex, 0, edit.text);
    return { content: lines.join('\n'), delta: edit.text.split('\n').length };
  }

  if (edit.action === 'delete') {
    if (edit.old_text) {
      const occurrences = content.split(edit.old_text).length - 1;
      if (occurrences === 0) {
        const snippet = fmtSnippet(edit.old_text);
        throw new Error(
          `${label}: 'old_text' not found in file.\n  Searched for: "${snippet}"\n  Tip: check for trailing whitespace or indentation differences.`,
        );
      }
      if (occurrences > 1) {
        const snippet = fmtSnippet(edit.old_text);
        throw new Error(`${label}: 'old_text' found multiple times. Provide more context. Searched for: "${snippet}"`);
      }
      const delta = -(edit.old_text.split('\n').length - 1);
      return { content: content.replace(edit.old_text, () => ''), delta };
    }
    const lines = content.split('\n');
    const start = Math.max(0, edit.start_line + lineOffset - 1);
    const end = Math.min(lines.length, edit.end_line + lineOffset);
    lines.splice(start, end - start);
    return { content: lines.join('\n'), delta: -(edit.end_line - edit.start_line + 1) };
  }
}

export const name = 'Edit';
export const description =
  'Surgically update a file with one or more sequential actions (replace, insert, delete). ' +
  'Actions are applied top-to-bottom; the file is only written if every action succeeds. ' +
  'Prefer old_text over line numbers — old_text is content-anchored and immune to shifting. ' +
  'When using line-based edits in a multi-edit call, line numbers are automatically adjusted ' +
  'for insertions and deletions made by earlier actions in the same call. ' +
  'Line-based edits must be specified in top-to-bottom order (ascending start_line). Side effect: mutates the target file. Do not issue parallel Edit/Write calls against the same path.';

export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File to update' },
    edits: {
      type: 'array',
      description:
        'Edit actions applied sequentially top-to-bottom. Prefer old_text for robustness — it is content-anchored and unaffected by prior edits in the same call. File is unchanged if any action fails.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Action type' },
          old_text: {
            type: 'string',
            description:
              '(replace/delete) Exact text to find — must appear exactly once. Preferred over line numbers: content-anchored and unaffected by line shifting from other edits.',
          },
          new_text: { type: 'string', description: '(replace) Replacement text' },
          start_line: {
            type: 'number',
            description:
              '(replace/delete) Start line, 1-based, in the original file. Automatically adjusted for lines added/removed by earlier actions in this call.',
          },
          end_line: {
            type: 'number',
            description:
              '(replace/delete) End line, 1-based inclusive, in the original file. Automatically adjusted for earlier actions in this call.',
          },
          text: { type: 'string', description: '(insert) Text to insert' },
          position: { type: 'string', description: '(insert) "before" or "after" the anchor' },
          anchor_text: { type: 'string', description: '(insert) First line containing this string is the anchor' },
          line: {
            type: 'number',
            description:
              '(insert) 1-based line number anchor in the original file. Automatically adjusted for earlier actions in this call.',
          },
        },
        required: ['action'],
      },
    },
  },
  required: ['path', 'edits'],
};

export const execute = async ({ path: filePath, edits }, ctx = {}) => {
  if (!edits || edits.length === 0) throw new Error('edits must not be empty');

  const safePath = ensureSafePath(filePath, ctx.agent?.trustedPaths, { restricted: ctx.agent?.restricted !== false });
  const rawContent = await fs.readFile(safePath, 'utf8');
  const currentHash = hashContent(rawContent);

  const fileState = ctx.agent?.fileState;
  if (fileState) {
    const prev = fileState.get(safePath);
    if (!prev) {
      throw new Error(`File ${filePath} has not been read in this session. Call Read first so it enters context.`);
    }
    if (prev.hash !== currentHash) {
      throw new Error(
        `File ${filePath} was modified since last read (hash mismatch). Call Read again to refresh context before editing.`,
      );
    }
  }

  // Normalize CRLF to LF for matching only; original endings restored on write
  const usesCrlf = rawContent.includes('\r\n');
  let content = usesCrlf ? rawContent.replace(/\r\n/g, '\n') : rawContent;

  let lineOffset = 0;
  let lastOriginalEndLine = -Infinity;

  for (let i = 0; i < edits.length; i++) {
    validateEdit(edits[i], i);

    const edit = edits[i];
    const origStart = edit.start_line ?? edit.line;
    if (origStart !== undefined) {
      if (origStart <= lastOriginalEndLine) {
        throw new Error(`edit[${i}]: line-based edits must be ordered top-to-bottom in the original file`);
      }
      lastOriginalEndLine = edit.end_line ?? origStart;
    }

    const { content: newContent, delta } = applyEdit(content, edit, i, lineOffset);
    content = newContent;
    lineOffset += delta;
  }

  const output = usesCrlf ? content.replace(/\n/g, '\r\n') : content;
  const temp = path.join(os.tmpdir(), `.oasdk-${Array.from(crypto.randomBytes(5), (x) => x.toString(36)).join('')}`);
  await fs.writeFile(temp, output, 'utf8');
  const difference = await diff(safePath, temp);
  await fs.rm(temp, { force: true });
  await fs.writeFile(safePath, output, 'utf8');

  if (fileState) {
    const newHash = hashContent(output);
    const totalLines = content.split('\n').length;
    fileState.set(safePath, {
      hash: newHash,
      lastReadTurn: ctx.agent?.currentTurn ?? 0,
      rangesRead: [[1, totalLines]],
      totalLines,
    });
  }

  return difference
    ? `File ${filePath} updated successfully\n\ndiff:\n${difference}`
    : `File ${filePath} updated, but no diff found`;
};
