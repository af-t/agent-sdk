import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('with-plugins example uses the Agent-owned SkillRegistry API', async () => {
  const source = await fs.readFile(path.resolve('examples/with-plugins.js'), 'utf8');
  assert.doesNotMatch(source, /import\s+skillRegistry\s+from/);
  assert.match(source, /agent\.skillRegistry\._ensureDiscovered\(\)/);
});
