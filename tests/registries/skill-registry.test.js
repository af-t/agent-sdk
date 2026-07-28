import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillRegistry } from '../../src/registries/skill-registry.js';

test('creates a logger-aware skill registry with explicit roots', () => {
  const childBindings = [];
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child(bindings) {
      childBindings.push(bindings);
      return this;
    },
  };
  const registry = new SkillRegistry({ logger, roots: [] });

  assert.ok(registry.skills instanceof Map);
  assert.deepEqual(childBindings, [{ component: 'skillRegistry' }]);
});
