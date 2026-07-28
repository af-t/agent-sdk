import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { createTestTempDir } from './temp.js';

const childFixture = path.resolve('tests/fixtures/temp-dir-child.fixture.js');

function runChild(root, failure, probeTeardownOrder = false) {
  const resultPath = path.join(root, failure ? 'failure-result.txt' : 'success-result.txt');
  const orderPath = path.join(root, 'teardown-order.txt');
  const env = {
    ...process.env,
    TMPDIR: root,
    TEST_TEMP_RESULT_PATH: resultPath,
    TEST_TEMP_SHOULD_FAIL: failure ? '1' : '0',
    TEST_TEMP_PROBE_TEARDOWN_ORDER: probeTeardownOrder ? '1' : '0',
    TEST_TEMP_ORDER_PATH: orderPath,
  };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', childFixture], {
    encoding: 'utf8',
    env,
  });
  return { orderPath, result, resultPath };
}

test('createTestTempDir creates a unique directory below os.tmpdir', (t) => {
  const dir = createTestTempDir(t, 'test-temp-dir-');

  assert.equal(path.dirname(dir), os.tmpdir());
  assert.ok(path.basename(dir).startsWith('test-temp-dir-'));
  assert.ok(fs.statSync(dir).isDirectory());
});

test('createTestTempDir rejects prefixes that escape the temp root', (t) => {
  for (const prefix of ['../escaped-', 'nested/child-', path.join(os.tmpdir(), 'absolute-')]) {
    assert.throws(() => createTestTempDir(t, prefix), /safe temporary directory prefix/);
  }
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

test('resource teardown runs before temporary directory cleanup', (t) => {
  const root = createTestTempDir(t, 'test-temp-parent-');
  const { orderPath, result } = runChild(root, false, true);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(orderPath, 'utf8'), 'resource-open');
});
