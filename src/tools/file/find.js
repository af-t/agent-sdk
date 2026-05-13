import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONSTANTS, ensureSafePath } from '../../core/utils.js';

export const name = 'Find';
export const parallelSafe = true;
export const description =
  'Search for files by name or content within a directory.  Prioritize using this tool over using commands like `find -iname` or `grep -R` for portability reasons.';
export const input_schema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Directory to search in' },
    pattern: { type: 'string', description: 'Regex or text pattern' },
    mode: { type: 'string', enum: ['name', 'content'], description: 'Search mode' },
  },
  required: ['pattern', 'mode'],
};

// Spawn command, capture stdout. find/rg non-zero exits are ok.
function spawnCommand(args, signal) {
  return new Promise((resolve, reject) => {
    const output = [];
    const errOutput = [];
    const child = spawn(args[0], args.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let aborted = false;

    const onAbort = () => {
      aborted = true;
      try {
        child.kill('SIGTERM');
      } catch {}
    };

    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errOutput.push(chunk));
    child.on('error', (err) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('exit', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (aborted) {
        reject(new Error('Find aborted'));
        return;
      }
      const out = Buffer.concat(output).toString();
      const err = Buffer.concat(errOutput).toString();

      const isPartialSuccess = (args[0] === 'find' && out.length > 0) || (args[0] === 'rg' && code === 1);

      if (code === 0 || isPartialSuccess) {
        resolve(out);
      } else {
        reject(new Error(err || out || `exit code ${code}`));
      }
    });
  });
}

// Check if command exists in PATH
function commandAvailable(cmd) {
  return new Promise((resolve) => {
    const child = spawn('which', [cmd], { stdio: 'ignore' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

// Native fallback: recursive Node.js walk

async function nativeSearch({ absPath, pattern, mode, cwd, signal }) {
  const regex = new RegExp(pattern, 'i');
  const matches = [];
  const searchRootPrefix = absPath.endsWith(path.sep) ? absPath : absPath + path.sep;
  const subdirPrefix = path.relative(cwd, absPath);
  const isSubdir = subdirPrefix && subdirPrefix !== '.';

  function toRelative(absFilePath) {
    let rel = absFilePath.startsWith(searchRootPrefix) ? absFilePath.slice(searchRootPrefix.length) : absFilePath;
    if (isSubdir) rel = subdirPrefix + path.sep + rel;
    return rel;
  }

  const walk = async (currentDir) => {
    if (signal?.aborted) throw new Error('Find aborted');
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal?.aborted) throw new Error('Find aborted');
      const fullPath = path.join(currentDir, entry.name);

      if (mode === 'name') {
        if (entry.isFile() && regex.test(entry.name)) {
          matches.push(toRelative(fullPath));
        }
      } else if (mode === 'content' && entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > CONSTANTS.MAX_FILE_SIZE_SEARCH) continue;

          // Check first 512 bytes for null bytes before reading entire file
          const header = await fs.readFile(fullPath);
          const nullByteCount = header.slice(0, 512).filter((b) => b === 0).length;
          if (nullByteCount > 0) continue;

          const content = header.toString('utf8');
          // Fallback: reject files with high ratio of non-printable characters
          const nonPrintable = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g) || []).length;
          if (nonPrintable / content.length > 0.3) continue;

          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (regex.test(line)) {
              const rel = toRelative(fullPath);
              matches.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
            }
          });
        } catch {
          // read/stat failed — skip file
        }
      }

      if (entry.isDirectory()) await walk(fullPath);
    }
  };

  await walk(absPath);
  return matches.length ? matches.join('\n') : 'No matches found.';
}

// Shell-accelerated search

function shellFindByRegex(absPath, pattern, cwd, signal) {
  const searchRootPrefix = absPath.endsWith(path.sep) ? absPath : absPath + path.sep;
  const subdirPrefix = path.relative(cwd, absPath);
  const isSubdir = subdirPrefix && subdirPrefix !== '.';
  const regex = new RegExp(pattern, 'i');

  function toRelative(absFilePath) {
    let rel = absFilePath.startsWith(searchRootPrefix) ? absFilePath.slice(searchRootPrefix.length) : absFilePath;
    if (isSubdir) rel = subdirPrefix + path.sep + rel;
    return rel;
  }

  return spawnCommand(['find', absPath, '-type', 'f'], signal).then((output) => {
    const files = output
      .split('\n')
      .filter(Boolean)
      .filter((absFilePath) => regex.test(path.basename(absFilePath)))
      .map(toRelative);

    return files.length ? files.join('\n') : 'No matches found.';
  });
}

function shellRgSearch(absPath, pattern, cwd, signal) {
  const searchRootPrefix = absPath.endsWith(path.sep) ? absPath : absPath + path.sep;
  const subdirPrefix = path.relative(cwd, absPath);
  const isSubdir = subdirPrefix && subdirPrefix !== '.';

  function toRelative(absFilePath) {
    let rel = absFilePath.startsWith(searchRootPrefix) ? absFilePath.slice(searchRootPrefix.length) : absFilePath;
    if (isSubdir) rel = subdirPrefix + path.sep + rel;
    return rel;
  }

  return spawnCommand(
    [
      'rg',
      '-n',
      '--no-heading',
      '-i',
      '--max-filesize',
      String(CONSTANTS.MAX_FILE_SIZE_SEARCH),
      '--max-columns',
      '100',
      pattern,
      absPath,
    ],
    signal,
  ).then((output) => {
    if (!output.trim()) return 'No matches found.';

    const lines = output.trim().split('\n');
    return lines
      .map((line) => {
        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) return line;
        const absFilePath = line.slice(0, colonIdx);
        const rest = line.slice(colonIdx);
        return toRelative(absFilePath) + rest;
      })
      .join('\n');
  });
}

// Main execute

export const execute = async ({ path: dirPath = '.', pattern, mode }, ctx = {}) => {
  const signal = ctx.signal;

  if (signal?.aborted) {
    throw new Error('Find aborted before start');
  }

  const absPath = ensureSafePath(dirPath);
  const cwd = process.cwd();

  try {
    new RegExp(pattern, 'i');
  } catch {
    throw new Error(`Invalid regex pattern: ${pattern}`);
  }

  if (mode === 'name') {
    const hasFind = await commandAvailable('find');
    if (hasFind) {
      return await shellFindByRegex(absPath, pattern, cwd, signal);
    }
  } else if (mode === 'content') {
    const hasRg = await commandAvailable('rg');
    if (hasRg) {
      return await shellRgSearch(absPath, pattern, cwd, signal);
    }
  }

  return await nativeSearch({ absPath, pattern, mode, cwd, signal });
};
