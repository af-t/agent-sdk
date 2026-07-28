import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { SkillRegistry } from '../../../src/registries/skill-registry.js';

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

  it('should export inputSchema', () => {
    assert.ok(mod.inputSchema);
    assert.strictEqual(mod.inputSchema.type, 'object');
    assert.ok(mod.inputSchema.properties);
    assert.ok(mod.inputSchema.properties.action);
    assert.strictEqual(mod.inputSchema.properties.action.type, 'string');
    assert.deepStrictEqual(mod.inputSchema.properties.action.enum, ['list', 'load', 'search']);
    assert.ok(mod.inputSchema.properties.argument);
    assert.ok(mod.inputSchema.required.includes('action'));
    assert.ok(!mod.inputSchema.required.includes('argument'));
  });

  it('creates an execute function for an injected registry', () => {
    assert.strictEqual(typeof mod.createSkillTool(new SkillRegistry()).execute, 'function');
  });
});

describe('Skill tool: execute()', () => {
  let mod;
  let registry;
  let tool;
  const pluginsDir = path.join(os.tmpdir(), 'test-plugins-' + Date.now());
  const skillFilePath = path.join(pluginsDir, 'test-plugin', 'skills', 'my-custom-skill', 'SKILL.md');

  before(async () => {
    // Reset and configure registry to find our test skill
    mod = await import('../../../src/tools/system/skill.js');
    registry = new SkillRegistry();
    registry.reset();

    // Create a temporary SKILL.md file
    await fs.mkdir(path.dirname(skillFilePath), { recursive: true });
    await fs.writeFile(
      skillFilePath,
      [
        '---',
        'name: MyTestSkill',
        'description: A test skill for unit testing',
        'author: TestBot',
        '---',
        '',
        'This is the content of the test skill.',
        '',
        '## Usage',
        '',
        'Use this skill for testing purposes.',
      ].join('\n'),
      'utf8',
    );

    registry.configure({ pluginsDir });
    await registry.refresh();
    tool = mod.createSkillTool(registry);
  });

  after(async () => {
    registry.configure({ pluginsDir: null });
    registry.reset();
    await fs.rm(pluginsDir, { recursive: true, force: true });
  });

  it('execute("list") returns formatted list of skills', async () => {
    const result = await tool.execute({ action: 'list' });
    assert.ok(result.startsWith('# Available Skills'));
    assert.ok(result.includes('MyTestSkill'));
  });

  it('execute("load") returns skill content for existing skill', async () => {
    const result = await tool.execute({ action: 'load', argument: 'MyTestSkill' });
    assert.ok(result.startsWith('# MyTestSkill'));
    assert.ok(result.includes('**description:**'));
    assert.ok(result.includes('A test skill for unit testing'));
    assert.ok(result.includes('This is the content of the test skill'));
  });

  it('execute("load") returns error message for non-existent skill', async () => {
    const result = await tool.execute({ action: 'load', argument: 'NonExistentSkill' });
    assert.ok(result.includes('NonExistentSkill'));
    assert.ok(result.includes('not found'));
  });

  it('execute("search") returns matching skills', async () => {
    const result = await tool.execute({ action: 'search', argument: 'test' });
    assert.ok(result.startsWith('# Skills matching'));
    assert.ok(result.includes('MyTestSkill'));
    assert.ok(result.includes('score:'));
  });

  it('execute("search") returns empty message for unmatched query', async () => {
    const result = await tool.execute({ action: 'search', argument: 'xyznonexistent12345' });
    assert.ok(result.includes('xyznonexistent12345'));
    assert.ok(result.includes('not found') || result.includes('No skills found matching'));
  });

  it('execute throws validation error when load or search is called without argument', async () => {
    await assert.rejects(() => tool.execute({ action: 'load' }), /Parameter "argument" is required/);
    await assert.rejects(() => tool.execute({ action: 'load', argument: '   ' }), /Parameter "argument" is required/);
    await assert.rejects(() => tool.execute({ action: 'search' }), /Parameter "argument" is required/);
  });
});
