import fs from 'node:fs/promises';
import path from 'node:path';
import { ensureSafePath } from '../../core/utils.js';
import { hashContent, isRangeCovered, mergeRanges } from '../../core/file-state.js';
import { detectFileType, imageDimensions, hexPreview, humanSize, magicByteType } from '../../core/file-type.js';
import { flattenNotebook } from '../../core/notebook.js';

const MAX_READ_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10MB

export const name = 'Read';
export const description =
  'Read the contents of a file with pagination and line numbers. Handles text, notebooks (.ipynb), images (PNG/JPEG/GIF/WebP), PDFs, and binary files. Use pagination (start_line/end_line) for large files to avoid context overflow and ensure efficient reading.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'File path' },
    start_line: { type: 'number', description: 'Line to start reading from' },
    end_line: { type: 'number', description: 'Line to end reading at' },
    max_lines: { type: 'number', description: 'Max lines to return (default 1500)' },
  },
  required: ['path'],
};

// read and paginate a text file
async function readText(safePath, filePath, { start_line = 1, end_line = Infinity, max_lines = 1500 }, ctx = {}) {
  const stat = await fs.stat(safePath);
  if (stat.size > MAX_READ_SIZE) {
    throw new Error(`File too large (${stat.size} bytes). Maximum readable size is ${MAX_READ_SIZE} bytes (10MB).`);
  }

  const content = await fs.readFile(safePath, 'utf8');
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }

  const totalLines = lines.length;
  const start = Math.max(0, start_line - 1);
  const end = Math.min(totalLines, end_line || totalLines);
  const slice = lines.slice(start, end).slice(0, max_lines);

  const requestedStart = start + 1;
  const effectiveEnd = start + slice.length;

  const fileState = ctx.agent?.fileState;
  const turn = ctx.agent?.currentTurn ?? 0;

  if (fileState) {
    const hash = hashContent(content);
    const prev = fileState.get(safePath);
    if (prev && prev.hash === hash && isRangeCovered(prev.rangesRead, requestedStart, effectiveEnd)) {
      return `[CACHED] ${filePath} unchanged since turn ${prev.lastReadTurn}. Lines ${requestedStart}-${effectiveEnd} already in context. (Total: ${totalLines} lines)`;
    }
    const baseRanges = prev && prev.hash === hash ? prev.rangesRead : [];
    const newRanges = mergeRanges([...baseRanges, [requestedStart, effectiveEnd]]);
    fileState.set(safePath, { hash, lastReadTurn: turn, rangesRead: newRanges, totalLines });
  }

  let result = slice
    .map((line, i) => {
      const lineNum = start + i + 1;
      return `${String(lineNum).padStart(6, ' ')}\t${line}`;
    })
    .join('\n');

  if (totalLines > end || end - start > max_lines) {
    result += '\n[... truncated]';
  }
  return result;
}

export const execute = async ({ path: filePath, start_line = 1, end_line = Infinity, max_lines = 1500 }, ctx = {}) => {
  const safePath = ensureSafePath(filePath, ctx.agent?.trustedPaths);

  const stat = await fs.stat(safePath);

  // read sample bytes for detection
  const sampleSize = Math.min(stat.size, 4096);
  const ext = path.extname(safePath).toLowerCase();
  let sample = Buffer.alloc(0);

  if (sampleSize > 0) {
    const handle = await fs.open(safePath, 'r');
    try {
      const buf = Buffer.alloc(sampleSize);
      await handle.read(buf, 0, sampleSize, 0);
      sample = buf;
    } finally {
      await handle.close();
    }
  }

  const { category, mime } = detectFileType(sample, ext);

  if (category === 'text') {
    return readText(safePath, filePath, { start_line, end_line, max_lines }, ctx);
  }

  if (category === 'notebook') {
    if (stat.size > MAX_READ_SIZE) {
      throw new Error(`File too large (${stat.size} bytes). Maximum readable size is ${MAX_READ_SIZE} bytes (10MB).`);
    }
    const raw = await fs.readFile(safePath, 'utf8');
    return flattenNotebook(raw);
  }

  if (category === 'image') {
    const baseName = path.basename(safePath);
    if (stat.size > MAX_IMAGE_BYTES) {
      return `[image] ${baseName} — ${mime}, ${humanSize(stat.size)} (too large to inline; over ${humanSize(MAX_IMAGE_BYTES)})`;
    }
    const buf = await fs.readFile(safePath);
    const dim = imageDimensions(buf, mime);
    const dataUri = 'data:' + mime + ';base64,' + buf.toString('base64');
    return [
      {
        type: 'text',
        text: `[image] ${baseName} — ${dim ? dim.width + 'x' + dim.height + ' ' : ''}${mime}, ${humanSize(stat.size)}`,
      },
      { type: 'image_url', image_url: { url: dataUri } },
    ];
  }

  if (category === 'pdf') {
    const baseName = path.basename(safePath);
    if (stat.size > MAX_PDF_BYTES) {
      return `[pdf] ${baseName} — ${humanSize(stat.size)} (too large to inline; over ${humanSize(MAX_PDF_BYTES)})`;
    }
    const buf = await fs.readFile(safePath);
    const dataUri = 'data:application/pdf;base64,' + buf.toString('base64');
    return [
      { type: 'text', text: `[pdf] ${baseName} — ${humanSize(stat.size)}` },
      { type: 'file', file: { filename: baseName, file_data: dataUri } },
    ];
  }

  // binary fallback
  const baseName = path.basename(safePath);
  const previewLen = Math.min(sample.length, 64);
  return `[binary] ${baseName} — ${magicByteType(sample)}, ${humanSize(stat.size)}\nhex (first ${previewLen} bytes): ${hexPreview(sample, 64)}`;
};
