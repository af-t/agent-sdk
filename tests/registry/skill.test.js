import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('SkillRegistry (default singleton)', () => {
  let skillModule;

  before(async () => {
    skillModule = await import('../../src/registry/skill.js');
  });

  it('exports a default object with expected methods', () => {
    const singleton = skillModule.default;
    assert.ok(singleton);
    assert.equal(typeof singleton.configure, 'function');
    assert.equal(typeof singleton.list, 'function');
    assert.equal(typeof singleton.get, 'function');
    assert.equal(typeof singleton.search, 'function');
    assert.equal(typeof singleton.refresh, 'function');
    assert.equal(typeof singleton.reset, 'function');
    assert.equal(typeof singleton._ensureDiscovered, 'function');
  });

  it('has skills Map and loaded flag', () => {
    const singleton = skillModule.default;
    assert.ok(singleton.skills instanceof Map);
    assert.equal(singleton.loaded, false);
  });

  it('reset clears the skills and sets loaded to false', () => {
    const singleton = skillModule.default;
    singleton.reset();
    assert.equal(singleton.loaded, false);
    assert.equal(singleton.skills.size, 0);
  });

  it('configure sets extraSearchDirs without throwing', () => {
    const singleton = skillModule.default;
    singleton.configure({ extraSearchDirs: ['/tmp/my-skills'] });
    assert.ok(true);
  });

  it('configure accepts scanAgentDirs: false', () => {
    const singleton = skillModule.default;
    singleton.configure({ scanAgentDirs: false });
    assert.ok(true);
  });

  it('configure accepts scanAgentDirs: true', () => {
    const singleton = skillModule.default;
    singleton.configure({ scanAgentDirs: true });
    assert.ok(true);
  });

  it('get() returns null for unknown skill', () => {
    const singleton = skillModule.default;
    singleton.reset();
    assert.equal(singleton.get('nonexistent-skill'), null);
  });

  it('search() returns empty array when no skills loaded', () => {
    const singleton = skillModule.default;
    singleton.reset();
    const results = singleton.search('anything');
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 0);
  });

  it('list() returns empty string when no skills', () => {
    const singleton = skillModule.default;
    singleton.reset();
    assert.equal(singleton.list(), '');
  });

  it('refresh calls discover and does not throw', async () => {
    const singleton = skillModule.default;
    singleton.reset();
    // refresh should not throw even with no skills dirs
    await singleton.refresh();
    assert.ok(true);
  });
});
