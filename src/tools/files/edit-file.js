import fs from 'node:fs/promises';
import { resolveSafePath } from '../../support/path-safety.js';
import { hashContent, isRangeCovered } from './file-state.js';

function fmtSnippet(text) {
  const s = text.replace(/\n/g, '↵');
  return s.length > 60 ? s.substring(0, 60) + '…' : s;
}

// Original-file line span an edit acts on, or null if content-anchored.
function lineSpanOf(edit) {
  if (edit.action === 'insert') {
    if (edit.anchorText !== undefined || edit.startLine === undefined) return null;
    return [edit.startLine, edit.startLine];
  }
  if (edit.oldText || edit.startLine === undefined || edit.endLine === undefined) return null;
  return [edit.startLine, edit.endLine];
}

function validateEdit(edit, i) {
  const label = `edit[${i}]`;
  if (!['replace', 'insert', 'delete'].includes(edit.action)) {
    throw new Error(`${label}: unknown action '${edit.action}'. Use replace, insert, or delete.`);
  }
  if (edit.action === 'replace') {
    if (edit.newText === undefined) throw new Error(`${label}: replace requires 'newText'`);
    if (!edit.oldText && (edit.startLine === undefined || edit.endLine === undefined)) {
      throw new Error(`${label}: replace requires 'oldText' or 'startLine'+'endLine'`);
    }
    if (edit.startLine !== undefined && edit.endLine !== undefined && edit.startLine > edit.endLine) {
      throw new Error(`${label}: startLine (${edit.startLine}) must not exceed endLine (${edit.endLine})`);
    }
  }
  if (edit.action === 'insert') {
    if (edit.newText === undefined) throw new Error(`${label}: insert requires 'newText'`);
    if (!['before', 'after'].includes(edit.position)) {
      throw new Error(`${label}: insert requires 'position' ("before" or "after")`);
    }
    if (!edit.anchorText && edit.startLine === undefined) {
      throw new Error(`${label}: insert requires 'anchorText' or 'startLine'`);
    }
  }
  if (edit.action === 'delete') {
    if (!edit.oldText && (edit.startLine === undefined || edit.endLine === undefined)) {
      throw new Error(`${label}: delete requires 'oldText' or 'startLine'+'endLine'`);
    }
    if (edit.startLine !== undefined && edit.endLine !== undefined && edit.startLine > edit.endLine) {
      throw new Error(`${label}: startLine (${edit.startLine}) must not exceed endLine (${edit.endLine})`);
    }
  }
}

function verifyOldText(content, oldText, label) {
  const occurrences = content.split(oldText).length - 1;
  if (occurrences === 0) {
    const snippet = fmtSnippet(oldText);
    throw new Error(
      `${label}: 'oldText' not found in file.\n  Searched for: "${snippet}"\n  Tip: check for trailing whitespace or indentation differences.`,
    );
  }
  if (occurrences > 1) {
    const snippet = fmtSnippet(oldText);
    throw new Error(`${label}: 'oldText' found multiple times. Provide more context. Searched for: "${snippet}"`);
  }
}

// originMap pairs each current zero-based line with its original one-based line.
// A null entry marks a line created or rewritten during this call. Keeping the
// map aligned with content lets line-based edits use original-file coordinates.
function spliceOriginMap(map, start, deleteCount, insertCount) {
  map.splice(start, deleteCount, ...new Array(insertCount).fill(null));
}

function resolveOriginalLine(map, origLine, origLineCount, label) {
  if (origLine < 1 || origLine > origLineCount) {
    throw new Error(`${label}: line ${origLine} is out of range (file has ${origLineCount} lines)`);
  }
  const idx = map.indexOf(origLine);
  if (idx === -1) {
    throw new Error(
      `${label}: line ${origLine} was changed by an earlier edit in this call. ` +
        `Use oldText or split this into separate editFile calls.`,
    );
  }
  return idx;
}

function applyEdit(content, edit, i, map, origLineCount) {
  const label = `edit[${i}]`;

  if (edit.action === 'replace' || edit.action === 'delete') {
    const replacement = edit.action === 'replace' ? edit.newText : '';
    if (edit.oldText) {
      verifyOldText(content, edit.oldText, label);
      const matchStart = content.indexOf(edit.oldText);
      const matchEnd = matchStart + edit.oldText.length;
      const firstLine = content.slice(0, matchStart).split('\n').length - 1;
      // The match's last character determines its final line. Using matchEnd
      // would make a trailing newline appear to touch the next line.
      const lastLine = content.slice(0, Math.max(matchStart, matchEnd - 1)).split('\n').length - 1;
      const origSpanLines = lastLine - firstLine + 1;
      // The newline-count difference gives the exact line delta regardless of
      // boundary alignment. Applying it to the corrected span keeps originMap
      // the same length as the edited content.
      const delta = replacement.split('\n').length - edit.oldText.split('\n').length;
      spliceOriginMap(map, firstLine, origSpanLines, origSpanLines + delta);
      return content.replace(edit.oldText, () => replacement);
    }
    const startIdx = resolveOriginalLine(map, edit.startLine, origLineCount, label);
    const endIdx = resolveOriginalLine(map, edit.endLine, origLineCount, label);
    const lines = content.split('\n');
    const removed = endIdx - startIdx + 1;
    if (edit.action === 'replace') {
      lines.splice(startIdx, removed, edit.newText);
      spliceOriginMap(map, startIdx, removed, edit.newText.split('\n').length);
    } else {
      lines.splice(startIdx, removed);
      spliceOriginMap(map, startIdx, removed, 0);
    }
    return lines.join('\n');
  }

  if (edit.action === 'insert') {
    const lines = content.split('\n');
    let insertIndex;
    if (edit.anchorText !== undefined) {
      const idx = lines.findIndex((l) => l.includes(edit.anchorText));
      if (idx === -1) throw new Error(`${label}: 'anchorText' not found`);
      insertIndex = edit.position === 'after' ? idx + 1 : idx;
    } else {
      const idx = resolveOriginalLine(map, edit.startLine, origLineCount, label);
      insertIndex = edit.position === 'after' ? idx + 1 : idx;
    }
    lines.splice(insertIndex, 0, edit.newText);
    spliceOriginMap(map, insertIndex, 0, edit.newText.split('\n').length);
    return lines.join('\n');
  }
}

const description =
  'Apply ordered replace, insert, or delete actions to a file. The file is written only when every action succeeds. Prefer oldText because it stays anchored to content. Line numbers are adjusted after earlier insertions and deletions, but cannot address a line rewritten earlier in the same call. Put line-based actions in top-to-bottom order. Do not submit more than one writeFile or editFile call for the same path in one turn.';

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'File to update.' },
    edits: {
      type: 'array',
      description: 'Actions apply sequentially. The file stays unchanged if any action fails.',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['replace', 'insert', 'delete'], description: 'Operation to apply.' },
          oldText: { type: 'string', description: 'Text to replace or delete.' },
          newText: { type: 'string', description: 'Replacement or inserted text.' },
          startLine: { type: 'number', description: 'First original line to change or use as an insert anchor.' },
          endLine: { type: 'number', description: 'Last original line to change.' },
          position: { type: 'string', enum: ['before', 'after'], description: 'Insert position.' },
          anchorText: { type: 'string', description: 'Text in the line to use as an insert anchor.' },
        },
        required: ['action'],
      },
    },
  },
  required: ['path', 'edits'],
};

const execute = async ({ path: filePath, edits }, ctx = {}) => {
  if (!edits || edits.length === 0) throw new Error('edits must not be empty');

  const safePath = resolveSafePath(filePath, ctx.agent?.trustedPaths, { restricted: ctx.agent?.restricted !== false });
  const rawContent = await fs.readFile(safePath, 'utf8');
  const currentHash = hashContent(rawContent);

  const fileState = ctx.agent?.fileState;
  let priorRanges = null;
  if (fileState) {
    const prev = fileState.get(safePath);
    if (!prev) {
      throw new Error(`File ${filePath} has not been read in this session. Call readFile first so it enters context.`);
    }
    if (prev.hash !== currentHash) {
      throw new Error(`File ${filePath} was modified since last read. Call readFile again before editing.`);
    }
    priorRanges = prev.rangesRead;
  }

  const usesCrlf = rawContent.includes('\r\n');
  let content = usesCrlf ? rawContent.replace(/\r\n/g, '\n') : rawContent;

  const origLineCount = content.split('\n').length;
  const originMap = Array.from({ length: origLineCount }, (_, idx) => idx + 1);
  let lastOriginalEndLine = -Infinity;

  for (let i = 0; i < edits.length; i++) {
    validateEdit(edits[i], i);

    const edit = edits[i];

    if (priorRanges) {
      const span = lineSpanOf(edit);
      if (span && !isRangeCovered(priorRanges, span[0], span[1])) {
        const anchored = edit.action === 'insert' ? 'anchorText' : 'oldText';
        throw new Error(
          `edit[${i}]: lines ${span[0]}-${span[1]} have not been read. Use readFile first, or use ${anchored}.`,
        );
      }
    }

    const origStart = edit.startLine;
    if (origStart !== undefined) {
      if (origStart <= lastOriginalEndLine) {
        throw new Error(`edit[${i}]: line-based edits must be ordered top-to-bottom in the original file`);
      }
      lastOriginalEndLine = edit.endLine ?? origStart;
    }

    content = applyEdit(content, edit, i, originMap, origLineCount);
  }

  const output = usesCrlf ? content.replace(/\n/g, '\r\n') : content;
  await fs.writeFile(safePath, output, 'utf8');

  if (fileState) {
    const newHash = hashContent(output);
    const totalLines = content.split('\n').length;
    const prev = fileState.get(safePath);
    const prevRanges = prev ? prev.rangesRead : [];
    fileState.set(safePath, {
      hash: newHash,
      lastReadTurn: ctx.agent?.currentTurn ?? 0,
      rangesRead: prevRanges,
      totalLines,
    });
  }

  return `Updated ${filePath} (${Buffer.byteLength(output, 'utf8')} bytes).`;
};

export const editFile = { name: 'editFile', description, inputSchema, execute };
