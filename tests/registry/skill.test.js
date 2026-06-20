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
    assert.equal(typeof singleton.getPluginInstructions, 'function');
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

  it('getPluginInstructions returns an empty array before discovery', () => {
    const singleton = skillModule.default;
    singleton.reset();
    assert.deepEqual(singleton.getPluginInstructions(), []);
  });

  it('configure sets pluginsDir without throwing', () => {
    const singleton = skillModule.default;
    singleton.configure({ pluginsDir: path.join(os.tmpdir(), 'my-plugins') });
    assert.ok(true);
    singleton.configure({ pluginsDir: null });
  });

  it('configure with no pluginsDir key is a no-op', () => {
    const singleton = skillModule.default;
    singleton.configure({});
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
    await singleton.refresh();
    assert.ok(true);
  });
});

describe('SkillRegistry — plugin discovery', () => {
  let registry;
  let pluginsDir;

  before(async () => {
    const mod = await import('../../src/registry/skill.js');
    registry = mod.default;
    pluginsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plugins-test-'));

    // Plugin with both AGENTS.md and a skill
    await fs.mkdir(path.join(pluginsDir, 'alpha', 'skills', 'do-alpha'), { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, 'alpha', 'AGENTS.md'),
      'Use alpha skills when the task is about alpha things.',
      'utf8',
    );
    await fs.writeFile(
      path.join(pluginsDir, 'alpha', 'skills', 'do-alpha', 'SKILL.md'),
      ['---', 'name: AlphaSkill', 'description: A skill about alpha things', '---', '', 'Alpha body.'].join('\n'),
      'utf8',
    );

    // Plugin with skills only (no AGENTS.md)
    await fs.mkdir(path.join(pluginsDir, 'beta', 'skills', 'do-beta'), { recursive: true });
    await fs.writeFile(
      path.join(pluginsDir, 'beta', 'skills', 'do-beta', 'SKILL.md'),
      ['---', 'name: BetaSkill', 'description: A skill about beta things', '---', '', 'Beta body.'].join('\n'),
      'utf8',
    );

    // Plugin with AGENTS.md only (no skills folder)
    await fs.mkdir(path.join(pluginsDir, 'gamma'), { recursive: true });
    await fs.writeFile(path.join(pluginsDir, 'gamma', 'AGENTS.md'), 'Gamma guidance text.', 'utf8');

    registry.reset();
    registry.configure({ pluginsDir });
    await registry.refresh();
  });

  after(async () => {
    registry.configure({ pluginsDir: null });
    registry.reset();
    await fs.rm(pluginsDir, { recursive: true, force: true });
  });

  it('loads skills from plugin skills/ folders with scope "plugin"', () => {
    const alpha = registry.get('AlphaSkill');
    const beta = registry.get('BetaSkill');
    assert.ok(alpha, 'AlphaSkill should be discovered');
    assert.ok(beta, 'BetaSkill should be discovered');
    assert.equal(alpha.scope, 'plugin');
    assert.equal(beta.scope, 'plugin');
  });

  it('tags plugin skills with their plugin name', () => {
    assert.equal(registry.get('AlphaSkill').plugin, 'alpha');
    assert.equal(registry.get('BetaSkill').plugin, 'beta');
  });

  it('skill body is accessible via .content', () => {
    assert.ok(registry.get('AlphaSkill').content.includes('Alpha body'));
  });

  it('getPluginInstructions returns AGENTS.md entries for plugins that have them', () => {
    const instructions = registry.getPluginInstructions();
    const plugins = instructions.map((i) => i.plugin);
    assert.ok(plugins.includes('alpha'), 'alpha has AGENTS.md');
    assert.ok(plugins.includes('gamma'), 'gamma has AGENTS.md');
    assert.ok(!plugins.includes('beta'), 'beta has no AGENTS.md');
  });

  it('getPluginInstructions entries carry the AGENTS.md content', () => {
    const alpha = registry.getPluginInstructions().find((i) => i.plugin === 'alpha');
    assert.ok(alpha.content.includes('Use alpha skills when'));
  });

  it('getPluginInstructions is ordered by plugin name', () => {
    const order = registry.getPluginInstructions().map((i) => i.plugin);
    assert.deepEqual(order, [...order].sort());
  });
});

describe('SkillRegistry — missing plugins root', () => {
  let registry;

  before(async () => {
    registry = (await import('../../src/registry/skill.js')).default;
    registry.reset();
    registry.configure({ pluginsDir: path.join(os.tmpdir(), 'does-not-exist-' + Date.now()) });
    await registry.refresh();
  });

  after(() => {
    registry.configure({ pluginsDir: null });
    registry.reset();
  });

  it('does not throw and yields no plugin instructions', () => {
    assert.deepEqual(registry.getPluginInstructions(), []);
  });
});
