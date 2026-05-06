import { describe, it, before } from 'node:test';
import assert from 'node:assert';

describe('Skill tool module', () => {
  let mod;

  before(async () => {
    mod = await import('../../../src/tools/system/skill.js');
  });

  it('should export name', () => {
    assert.strictEqual(mod.name, 'Skill');
  });

  it('should export description', () => {
    assert.ok(typeof mod.description === 'string');
    assert.ok(mod.description.length > 0);
  });

  it('should export input_schema', () => {
    assert.ok(mod.input_schema);
    assert.strictEqual(mod.input_schema.type, 'object');
    assert.ok(mod.input_schema.properties);
    assert.ok(mod.input_schema.properties.action);
    assert.strictEqual(mod.input_schema.properties.action.type, 'string');
    assert.deepStrictEqual(mod.input_schema.properties.action.enum, ['list', 'load', 'search']);
    assert.ok(mod.input_schema.properties.argument);
    assert.ok(mod.input_schema.required.includes('action'));
    assert.ok(mod.input_schema.required.includes('argument'));
  });

  it('should export execute as a function', () => {
    assert.strictEqual(typeof mod.execute, 'function');
  });
});
