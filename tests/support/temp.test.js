import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createTestTempDir } from './temp.js';

const childFixture = path.resolve('tests/fixtures/temp-dir-child.fixture.js');

function runChild(root, failure) {
  const resultPath = path.join(root, failure ? 'failure-result.txt' : 'success-result.txt');
  const env = {
    ...process.env,
    TMPDIR: root,
    TEST_TEMP_RESULT_PATH: resultPath,
    TEST_TEMP_SHOULD_FAIL: failure ? '1' : '0',
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', childFixture], {
    encoding: 'utf8',
    env,
  });
  return { result, resultPath };
}

test('createTestTempDir creates a unique directory below os.tmpdir', (t) => {
  const dir = createTestTempDir(t, 'test-temp-dir-');

  assert.equal(path.dirname(dir), os.tmpdir());
  assert.ok(path.basename(dir).startsWith('test-temp-dir-'));
  assert.ok(fs.statSync(dir).isDirectory());
});

test('createTestTempDir removes child resources after passing tests', (t) => {
  const root = createTestTempDir(t, 'test-temp-parent-');
  const { result, resultPath } = runChild(root, false);

  assert.equal(result.status, 0, result.stderr);
  const childDir = fs.readFileSync(resultPath, 'utf8');
  assert.equal(fs.existsSync(childDir), false);
});

test('createTestTempDir removes child resources after failing tests', (t) => {
  const root = createTestTempDir(t, 'test-temp-parent-');
  const { result, resultPath } = runChild(root, true);

  assert.equal(result.status, 1, result.stderr);
  const childDir = fs.readFileSync(resultPath, 'utf8');
  assert.equal(fs.existsSync(childDir), false);
});
