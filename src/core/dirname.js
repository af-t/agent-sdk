import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function getDirname(importMeta) {
  return importMeta.dirname || path.dirname(fileURLToPath(importMeta.url));
}
