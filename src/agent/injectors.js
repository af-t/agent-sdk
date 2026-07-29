import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { resolveSafePath } from '../support/path-safety.js';

// The injectors an agent registers for itself unless its options turn them off.
// Each one returns the text the lifecycle folds into a system-reminder block:
// an empty string means there is nothing to say this turn.

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
        // Path traversal or outside root: skip silently.
        continue;
      }
      let content;
      try {
        content = await readFile(resolved, 'utf8');
      } catch {
        // File missing: skip silently.
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
      .map(([k, v]) => `- **${k}**: ${v}`)
      .join('\n');
    return [
      '## Memory system',
      `Memory files live at \`${memoryDir}/\`. Use writeFile, readFile, and editFile to manage them.`,
      '',
      '### Available types',
      typeLines,
      '',
      'You **MUST** load the `using-memory` skill (via the loadSkill tool with action="load",',
      'argument="using-memory") BEFORE the first memory write or update in this conversation,',
      'unless you have already loaded it. The skill defines file format, naming conventions,',
      'and the MEMORY.md index protocol, and you are required to follow it exactly.',
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
      'When a skill is relevant to your current task, you **MUST** load it via the loadSkill tool ' +
      '(action="load", argument=<skill name>) and follow its instructions and conventions exactly. ' +
      'Do not invent alternative approaches or formats when a skill provides authoritative guidance ' +
      'for the task at hand. Skill bodies are the source of truth for their respective domains.'
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
