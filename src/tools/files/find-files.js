import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sanitizeChildEnvironment } from '../../support/environment.js';
import { resolveSafePath } from '../../support/path-safety.js';
import { LIMITS } from '../../support/payload.js';

const description = 'Search file names or file contents under a directory.';
const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', description: 'Directory to search.' },
    pattern: { type: 'string', description: 'Regular expression or text to find.' },
    mode: { type: 'string', enum: ['name', 'content'], description: 'Search names or contents.' },
  },
  required: ['pattern', 'mode'],
};

function spawnCommand(args, signal) {
  return new Promise((resolve, reject) => {
    const output = [];
    const errOutput = [];
    const child = spawn(args[0], args.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizeChildEnvironment(process.env),
    });
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
        reject(new Error('File search was aborted'));
        return;
      }
      const out = Buffer.concat(output).toString();
      const err = Buffer.concat(errOutput).toString();

      const isPartialSuccess =
        (args[0] === 'find' && out.length > 0) || (args[0] === 'rg' && (code === 1 || (code === 2 && out.length > 0)));

      if (code === 0 || isPartialSuccess) {
        resolve(out);
      } else {
        reject(new Error(err || out || `exit code ${code}`));
      }
    });
  });
}

function commandAvailable(cmd) {
  return new Promise((resolve) => {
    const child = spawn('which', [cmd], {
      stdio: 'ignore',
      env: sanitizeChildEnvironment(process.env),
    });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}

function makeToRelative(absPath, cwd) {
  const searchRootPrefix = absPath.endsWith(path.sep) ? absPath : absPath + path.sep;
  const subdirPrefix = path.relative(cwd, absPath);
  const isSubdir = subdirPrefix && subdirPrefix !== '.';

  return function toRelative(absFilePath) {
    let rel = absFilePath.startsWith(searchRootPrefix) ? absFilePath.slice(searchRootPrefix.length) : absFilePath;
    if (isSubdir) rel = subdirPrefix + path.sep + rel;
    return rel;
  };
}

async function nativeSearch({ absPath, pattern, mode, cwd, signal }) {
  const regex = new RegExp(pattern, 'i');
  const matches = [];
  const toRelative = makeToRelative(absPath, cwd);

  const walk = async (currentDir) => {
    if (signal?.aborted) throw new Error('File search was aborted');
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (signal?.aborted) throw new Error('File search was aborted');
      const fullPath = path.join(currentDir, entry.name);

      if (mode === 'name') {
        if (entry.isFile() && regex.test(entry.name)) {
          matches.push(toRelative(fullPath));
        }
      } else if (mode === 'content' && entry.isFile()) {
        try {
          const stat = await fs.stat(fullPath);
          if (stat.size > LIMITS.maxSearchFileSize) continue;

          const handle = await fs.open(fullPath, 'r');
          let isBinary = false;
          try {
            const buf = Buffer.alloc(Math.min(stat.size, 512));
            await handle.read(buf, 0, buf.length, 0);
            const nullByteCount = buf.filter((b) => b === 0).length;
            if (nullByteCount > 0) isBinary = true;
          } finally {
            await handle.close();
          }
          if (isBinary) continue;

          const content = await fs.readFile(fullPath, 'utf8');
          // eslint-disable-next-line no-control-regex -- intentionally matches control chars for binary detection
          const nonPrintable = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g) || []).length;
          if (nonPrintable / content.length > 0.3) continue;

          const lines = content.split('\n');
          lines.forEach((line, i) => {
            if (regex.test(line)) {
              const rel = toRelative(fullPath);
              matches.push(`${rel}:${i + 1}: ${line.trim().slice(0, 100)}`);
            }
          });
        } catch {}
      }

      if (entry.isDirectory()) await walk(fullPath);
    }
  };

  await walk(absPath);
  return matches.length ? matches.join('\n') : 'No matches found.';
}

function shellFindByRegex(absPath, pattern, cwd, signal) {
  const regex = new RegExp(pattern, 'i');
  const toRelative = makeToRelative(absPath, cwd);

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
  const toRelative = makeToRelative(absPath, cwd);

  return spawnCommand(
    [
      'rg',
      '-n',
      '--no-heading',
      '-i',
      '--max-filesize',
      String(LIMITS.maxSearchFileSize),
      '--max-columns',
      '100',
      '--',
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

const execute = async ({ path: dirPath = '.', pattern, mode }, ctx = {}) => {
  const signal = ctx.signal;

  if (signal?.aborted) {
    throw new Error('File search was aborted before it started');
  }

  const absPath = resolveSafePath(dirPath, ctx.agent?.trustedPaths, { restricted: ctx.agent?.restricted !== false });
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

export const findFiles = { name: 'findFiles', description, inputSchema, execute };
