import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { SkillRegistry } from '../../src/registries/skill-registry.js';

describe('SkillRegistry', () => {
  let registry;

  before(() => {
    registry = new SkillRegistry();
  });

  it('exposes instance methods', () => {
    assert.equal(typeof registry.configure, 'function');
    assert.equal(typeof registry.list, 'function');
    assert.equal(typeof registry.get, 'function');
    assert.equal(typeof registry.search, 'function');
    assert.equal(typeof registry.refresh, 'function');
    assert.equal(typeof registry.reset, 'function');
    assert.equal(typeof registry._ensureDiscovered, 'function');
    assert.equal(typeof registry.getPluginInstructions, 'function');
  });

  it('has skills Map and loaded flag', () => {
    assert.ok(registry.skills instanceof Map);
    assert.equal(registry.loaded, false);
  });

  it('reset clears the skills and sets loaded to false', () => {
    registry.reset();
    assert.equal(registry.loaded, false);
    assert.equal(registry.skills.size, 0);
  });

  it('getPluginInstructions returns an empty array before discovery', () => {
    registry.reset();
    assert.deepEqual(registry.getPluginInstructions(), []);
  });

  it('configure sets pluginsDir without throwing', () => {
    registry.configure({ pluginsDir: path.join(os.tmpdir(), 'my-plugins') });
    assert.ok(true);
    registry.configure({ pluginsDir: null });
  });

  it('configure with no pluginsDir key is a no-op', () => {
    registry.configure({});
    assert.ok(true);
  });

  it('get() returns null for unknown skill', () => {
    registry.reset();
    assert.equal(registry.get('nonexistent-skill'), null);
  });

  it('search() returns empty array when no skills loaded', () => {
    registry.reset();
    const results = registry.search('anything');
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 0);
  });

  it('list() returns empty string when no skills', () => {
    registry.reset();
    assert.equal(registry.list(), '');
  });

  it('reset() lets the next _ensureDiscovered re-discover', async () => {
    registry.configure({ pluginsDir: null });
    registry.reset();
    await registry._ensureDiscovered();
    const countAfterFirst = registry.skills.size;
    assert.ok(countAfterFirst > 0, 'builtin skills should be discovered');
    registry.reset();
    assert.equal(registry.skills.size, 0);
    await registry._ensureDiscovered();
    assert.equal(registry.skills.size, countAfterFirst);
    registry.reset();
  });

  it('refresh calls discover and does not throw', async () => {
    registry.reset();
    await registry.refresh();
    assert.ok(true);
  });
});

describe('SkillRegistry: plugin discovery', () => {
  let registry;
  let pluginsDir;

  before(async () => {
    registry = new SkillRegistry();
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

describe('SkillRegistry: missing plugins root', () => {
  let registry;

  before(async () => {
    registry = new SkillRegistry();
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
