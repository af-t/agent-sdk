import { describe, it, before } from 'node:test';
import assert from 'node:assert';

describe('WebSearch tool module', () => {
  let mod;

  before(async () => {
    mod = await import('../../../src/tools/web/search.js');
  });

  it('should export name', () => {
    assert.strictEqual(mod.name, 'WebSearch');
  });

  it('should export description', () => {
    assert.ok(typeof mod.description === 'string');
    assert.ok(mod.description.length > 0);
  });

  it('should export input_schema', () => {
    assert.ok(mod.input_schema);
    assert.strictEqual(mod.input_schema.type, 'object');
    assert.ok(mod.input_schema.properties);
    assert.ok(mod.input_schema.properties.query);
    assert.strictEqual(mod.input_schema.properties.query.type, 'string');
    assert.ok(mod.input_schema.required.includes('query'));
  });

  it('should export execute as a function', () => {
    assert.strictEqual(typeof mod.execute, 'function');
  });
});
