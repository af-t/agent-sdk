import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

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
    singleton.configure({ extraSearchDirs: [path.join(os.tmpdir(), 'my-skills')] });
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

describe('SkillRegistry — discovery with real SKILL.md files', () => {
  let registry;
  let tmpdir;

  before(async () => {
    const mod = await import('../../src/registry/skill.js');
    registry = mod.default;
    tmpdir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-reg-test-'));

    await fs.mkdir(path.join(tmpdir, 'alpha-skill'), { recursive: true });
    await fs.writeFile(
      path.join(tmpdir, 'alpha-skill', 'SKILL.md'),
      [
        '---',
        'name: AlphaSkill',
        'description: A skill about alpha things',
        '---',
        '',
        'Alpha skill body content here.',
      ].join('\n'),
      'utf8',
    );

    await fs.mkdir(path.join(tmpdir, 'beta-skill'), { recursive: true });
    await fs.writeFile(
      path.join(tmpdir, 'beta-skill', 'SKILL.md'),
      [
        '---',
        'name: BetaSkill',
        'description: A skill about beta things',
        '---',
        '',
        'Beta skill body content here.',
      ].join('\n'),
      'utf8',
    );

    registry.reset();
    registry.configure({ extraSearchDirs: [tmpdir], scanAgentDirs: false });
    await registry.refresh();
  });

  after(async () => {
    registry.configure({ extraSearchDirs: [], scanAgentDirs: true });
    registry.reset();
    await fs.rm(tmpdir, { recursive: true, force: true });
  });

  it('list() returns string including both skill names', () => {
    const result = registry.list();
    assert.strictEqual(typeof result, 'string');
    assert.ok(result.includes('AlphaSkill'));
    assert.ok(result.includes('BetaSkill'));
  });

  it('get("AlphaSkill") returns a non-null object', () => {
    const skill = registry.get('AlphaSkill');
    assert.ok(skill !== null);
    assert.strictEqual(typeof skill, 'object');
  });

  it('AlphaSkill description is correctly parsed from frontmatter', () => {
    const skill = registry.get('AlphaSkill');
    assert.ok(skill.description.toLowerCase().includes('alpha'));
  });

  it('get("NonExistentXYZ") returns null', () => {
    assert.strictEqual(registry.get('NonExistentXYZ'), null);
  });

  it('search("alpha") returns array with AlphaSkill', () => {
    const results = registry.search('alpha');
    assert.ok(Array.isArray(results));
    assert.ok(results.some((r) => r.name === 'AlphaSkill'));
  });

  it('search("zyxnonexistent999") returns empty array', () => {
    const results = registry.search('zyxnonexistent999');
    assert.ok(Array.isArray(results));
    assert.strictEqual(results.length, 0);
  });

  it('BetaSkill description is correctly parsed from frontmatter', () => {
    const skill = registry.get('BetaSkill');
    assert.ok(skill !== null);
    assert.ok(skill.description.toLowerCase().includes('beta'));
  });

  it('skill body is accessible via .content property', () => {
    const alpha = registry.get('AlphaSkill');
    assert.strictEqual(typeof alpha.content, 'string');
    assert.ok(alpha.content.includes('Alpha skill body content here'));

    const beta = registry.get('BetaSkill');
    assert.strictEqual(typeof beta.content, 'string');
    assert.ok(beta.content.includes('Beta skill body content here'));
  });
});
