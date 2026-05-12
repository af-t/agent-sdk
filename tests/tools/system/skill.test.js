import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

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

describe('Skill tool — execute()', () => {
  let mod;
  let registry;
  const testSkillDir = path.join(os.tmpdir(), 'test-skills-' + Date.now());
  const skillFilePath = path.join(testSkillDir, 'my-custom-skill', 'SKILL.md');

  before(async () => {
    // Reset and configure registry to find our test skill
    mod = await import('../../../src/tools/system/skill.js');
    registry = (await import('../../../src/registry/skill.js')).default;
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

    registry.configure({ extraSearchDirs: [testSkillDir] });
    await registry.refresh();
  });

  after(async () => {
    registry.reset();
    await fs.rm(testSkillDir, { recursive: true, force: true });
  });

  it('execute("list") returns formatted list of skills', async () => {
    const result = await mod.execute({ action: 'list' });
    assert.ok(result.startsWith('# Available Skills'));
    assert.ok(result.includes('MyTestSkill'));
  });

  it('execute("load") returns skill content for existing skill', async () => {
    const result = await mod.execute({ action: 'load', argument: 'MyTestSkill' });
    assert.ok(result.startsWith('# MyTestSkill'));
    assert.ok(result.includes('**description:**'));
    assert.ok(result.includes('A test skill for unit testing'));
    assert.ok(result.includes('This is the content of the test skill'));
  });

  it('execute("load") returns error message for non-existent skill', async () => {
    const result = await mod.execute({ action: 'load', argument: 'NonExistentSkill' });
    assert.ok(result.includes('NonExistentSkill'));
    assert.ok(result.includes('not found'));
  });

  it('execute("search") returns matching skills', async () => {
    const result = await mod.execute({ action: 'search', argument: 'test' });
    assert.ok(result.startsWith('# Skills matching'));
    assert.ok(result.includes('MyTestSkill'));
    assert.ok(result.includes('score:'));
  });

  it('execute("search") returns empty message for unmatched query', async () => {
    const result = await mod.execute({ action: 'search', argument: 'xyznonexistent12345' });
    assert.ok(result.includes('xyznonexistent12345'));
    assert.ok(result.includes('not found') || result.includes('No skills found matching'));
  });
});
