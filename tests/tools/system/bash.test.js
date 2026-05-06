import { describe, it, before } from 'node:test';
import assert from 'node:assert';

describe('Bash tool module', () => {
  let mod;

  before(async () => {
    mod = await import('../../../src/tools/system/bash.js');
  });

  it('should export name', () => {
    assert.strictEqual(mod.name, 'Bash');
  });

  it('should export description', () => {
    assert.ok(typeof mod.description === 'string');
    assert.ok(mod.description.length > 0);
  });

  it('should export input_schema', () => {
    assert.ok(mod.input_schema);
    assert.strictEqual(mod.input_schema.type, 'object');
    assert.ok(mod.input_schema.properties);
    assert.ok(mod.input_schema.properties.command);
    assert.ok(mod.input_schema.required.includes('command'));
  });

  it('should export execute as a function', () => {
    assert.strictEqual(typeof mod.execute, 'function');
  });
});
