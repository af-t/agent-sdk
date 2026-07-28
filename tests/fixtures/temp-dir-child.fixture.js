import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { createTestTempDir } from '../support/temp.js';

test('child owns its temporary directory', (t) => {
  const resource = { dir: undefined };
  if (process.env.TEST_TEMP_PROBE_TEARDOWN_ORDER === '1') {
    t.after(() => {
      fs.writeFileSync(
        process.env.TEST_TEMP_ORDER_PATH,
        fs.existsSync(resource.dir) ? 'resource-open' : 'temporary-directory-removed',
      );
    });
  }
  resource.dir = createTestTempDir(t, 'test-temp-child-');
  const { dir } = resource;
  fs.writeFileSync(process.env.TEST_TEMP_RESULT_PATH, dir);
  assert.ok(fs.existsSync(dir));
  if (process.env.TEST_TEMP_SHOULD_FAIL === '1') assert.fail('intentional child failure');
});
