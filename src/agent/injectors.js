import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { resolveSafePath } from '../support/path-safety.js';

// Built-in injectors return text for a system-reminder block. An empty string
// omits that injector from the current turn.

export function defaultDateInjector() {
  const now = new Date();
  const iso = now.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return `Current date: ${date} ${time} UTC`;
}

export function contextFilesInjector(filePaths, trustedPathsFn) {
  return async function () {
    const trustedPaths = trustedPathsFn?.() ?? new Set();
    const parts = [];
    for (const filePath of filePaths) {
      let resolved;
      try {
        resolved = resolveSafePath(filePath, trustedPaths);
      } catch {
        // Invalid and untrusted context paths are optional, so skip them.
        continue;
      }
      let content;
      try {
        content = await readFile(resolved, 'utf8');
      } catch {
        // Missing optional context files contribute no reminder text.
        continue;
      }
      if (filePaths.length > 1) {
        const basename = path.basename(resolved);
        parts.push(`## ${basename}\n${content}`);
      } else {
        parts.push(content);
      }
    }
    return parts.join('\n\n');
  };
}

export function memoryIndexInjector(memoryDirFn, trustedPathsFn) {
  return async function () {
    const memoryDir = memoryDirFn();
    const trustedPaths = trustedPathsFn?.() ?? new Set();
    let resolved;
    try {
      resolved = resolveSafePath(path.join(memoryDir, 'MEMORY.md'), trustedPaths);
    } catch {
      return '';
    }
    try {
      const content = await readFile(resolved, 'utf8');
      if (!content.trim()) return '';
      return `## Memory index\n${content}`;
    } catch {
      return '';
    }
  };
}

export function memoryHintInjector(memoryDirFn, memoryTypesFn) {
  return function () {
    const memoryDir = memoryDirFn();
    const types = memoryTypesFn();
    const typeLines = Object.entries(types)
      .map(([k, v]) => `- ${k}: ${v}`)
      .join('\n');
    return [
      '## Memory system',
      `Memory files live at \`${memoryDir}/\`. Use writeFile, readFile, and editFile to manage them.`,
      '',
      '### Available types',
      typeLines,
      '',
      'Load the `using-memory` skill with loadSkill using action="load" and',
      'argument="using-memory" before the first memory write or update in this conversation,',
      'unless it is already loaded. The skill defines the file format, naming rules,',
      'and MEMORY.md index protocol.',
    ].join('\n');
  };
}

export function skillListInjector(skillRegistry) {
  return async ({ logger }) => {
    try {
      await skillRegistry._ensureDiscovered();
    } catch (err) {
      logger.warn({ component: 'agent', injector: 'skillList', error: err }, 'Skill discovery failed');
      return '';
    }
    const skills = skillRegistry.skills;
    if (!skills || skills.size === 0) return '';
    const lines = [];
    for (const [name, skill] of skills) {
      const desc = (skill.description || '').trim();
      const truncated = desc.length > 120 ? desc.slice(0, 117) + '...' : desc;
      lines.push(`- ${name}: ${truncated}`);
    }
    if (lines.length === 0) return '';
    return (
      `## Available skills\n${lines.join('\n')}\n\n` +
      'Load a relevant skill with loadSkill (action="load", argument=<skill name>) before acting, ' +
      'then follow its task instructions.'
    );
  };
}

export function pluginInstructionsInjector(skillRegistry) {
  return async ({ logger }) => {
    try {
      await skillRegistry._ensureDiscovered();
    } catch (err) {
      logger.warn({ component: 'agent', injector: 'pluginInstructions', error: err }, 'Skill discovery failed');
      return '';
    }
    const instructions = skillRegistry.getPluginInstructions();
    if (!instructions || instructions.length === 0) return '';
    const sections = instructions.map(({ plugin, content }) => `### ${plugin}\n${content}`);
    return `## Plugin instructions\n\n${sections.join('\n\n')}`;
  };
}
