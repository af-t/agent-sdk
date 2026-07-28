import fs from 'node:fs/promises';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

let ignoreFilterCache = null;
let ignoreFilterCacheKey = null;
let ignoreFilterMtime = 0;

export async function loadIgnoreFilter() {
  const currentDirectory = process.cwd();
  const gitignorePath = path.join(currentDirectory, '.gitignore');
  let mtime = 0;
  try {
    mtime = (await fs.stat(gitignorePath)).mtimeMs;
  } catch {}

  if (ignoreFilterCache && ignoreFilterCacheKey === currentDirectory && ignoreFilterMtime === mtime) {
    return ignoreFilterCache;
  }
  ignoreFilterMtime = mtime;

  const filter = ignore();
  try {
    filter.add(await fs.readFile(gitignorePath, 'utf8'));
  } catch {}

  ignoreFilterCache = {
    test(filePath) {
      const relativePath = path.relative(currentDirectory, path.resolve(filePath));
      if (relativePath.startsWith(`..${path.sep}`) || relativePath === '..') return false;
      return filter.test(relativePath);
    },
    ignores(filePath) {
      const relativePath = path.relative(currentDirectory, path.resolve(filePath));
      if (relativePath.startsWith(`..${path.sep}`) || relativePath === '..') return false;
      return filter.ignores(relativePath);
    },
    add(content) {
      return filter.add(content);
    },
  };
  ignoreFilterCacheKey = currentDirectory;
  return ignoreFilterCache;
}

export function clearIgnoreFilterCache() {
  ignoreFilterCache = null;
  ignoreFilterCacheKey = null;
  ignoreFilterMtime = 0;
}

function decodePath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isContained(canonicalTarget, canonicalRoot) {
  let target = canonicalTarget.normalize('NFC');
  let root = canonicalRoot.normalize('NFC');
  if (process.platform === 'win32') {
    target = target.toLowerCase();
    root = root.toLowerCase();
  }
  const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return target === root || target.startsWith(rootPrefix);
}

export function resolveSafePath(filePath, allowedRoots = new Set(), options = {}) {
  const restricted = options.restricted !== false;
  if (filePath.includes('\0')) throw new Error('Access denied: Path contains null byte');

  let decodedPath = filePath;
  for (let index = 0; decodedPath.includes('%') && index < 3; index += 1) {
    decodedPath = decodePath(decodedPath);
  }
  if (
    /%2e%2e|%2f|%5c/i.test(filePath) ||
    (filePath.includes('%') && (decodedPath.includes('/') || decodedPath.includes('\\')))
  ) {
    throw new Error('Access denied: Path contains URL-encoded traversal characters');
  }
  if (restricted && decodedPath.includes('..')) {
    throw new Error('Access denied: Path contains directory traversal ("..")');
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath.trim())) {
    throw new Error('Access denied: Path uses a protocol handler');
  }

  const resolvedTarget = path.resolve(filePath);
  let ancestorPath = resolvedTarget;
  let canonicalAncestor = null;
  let missingSuffix = '';
  while (true) {
    try {
      canonicalAncestor = realpathSync(ancestorPath);
      break;
    } catch {
      const parentPath = path.dirname(ancestorPath);
      if (parentPath === ancestorPath) break;
      missingSuffix = path.join(path.basename(ancestorPath), missingSuffix);
      ancestorPath = parentPath;
    }
  }
  if (!canonicalAncestor) throw new Error('Access denied: Could not resolve path ancestor');
  if (!restricted) return path.join(canonicalAncestor, missingSuffix);

  const trustedRoots = allowedRoots || new Set();
  const projectRoot = realpathSync(process.cwd());
  const components = missingSuffix.split(path.sep).filter(Boolean);
  if (components.length > 0) {
    const nextPath = path.join(canonicalAncestor, components[0]);
    try {
      if (lstatSync(nextPath).isSymbolicLink()) {
        let canonicalTarget;
        try {
          canonicalTarget = realpathSync(nextPath);
        } catch {
          canonicalTarget = path.resolve(canonicalAncestor, readlinkSync(nextPath));
        }
        const targetIsTrusted = [...trustedRoots].some((trustedRoot) => {
          if (typeof trustedRoot !== 'string' || !path.isAbsolute(trustedRoot)) return false;
          try {
            return isContained(canonicalTarget, realpathSync(trustedRoot));
          } catch {
            return false;
          }
        });
        if (!isContained(canonicalTarget, projectRoot) && !targetIsTrusted) {
          const nextPathIsTrusted = [...trustedRoots].some((trustedRoot) => {
            if (typeof trustedRoot !== 'string' || !path.isAbsolute(trustedRoot)) return false;
            try {
              return isContained(nextPath, realpathSync(trustedRoot));
            } catch {
              return false;
            }
          });
          if (nextPathIsTrusted) throw new Error(`Access denied: Path '${filePath}' resolves outside trusted root`);
          throw new Error(`Access denied: Path '${filePath}' is outside project root`);
        }
      }
    } catch (error) {
      if (error.message?.startsWith('Access denied:')) throw error;
    }
  }

  const targetIsInProject = isContained(resolvedTarget, projectRoot);
  let isSafe = isContained(canonicalAncestor, projectRoot);
  let targetIsInTrustedRoot = false;
  if (!isSafe) {
    for (const trustedRoot of trustedRoots) {
      if (typeof trustedRoot !== 'string' || !path.isAbsolute(trustedRoot)) continue;
      try {
        const canonicalTrustedRoot = realpathSync(trustedRoot);
        if (isContained(resolvedTarget, canonicalTrustedRoot)) targetIsInTrustedRoot = true;
        if (isContained(canonicalAncestor, canonicalTrustedRoot)) {
          isSafe = true;
          break;
        }
      } catch {}
    }
  }
  if (!isSafe) {
    if (targetIsInTrustedRoot && !targetIsInProject) {
      throw new Error(`Access denied: Path '${filePath}' resolves outside trusted root`);
    }
    throw new Error(`Access denied: Path '${filePath}' is outside project root`);
  }
  return path.join(canonicalAncestor, missingSuffix);
}
