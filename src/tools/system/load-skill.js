const description = 'List, search, or load instruction sets for a task.';

const inputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['list', 'load', 'search'],
      description: 'Operation to perform.',
    },
    argument: {
      type: 'string',
      description: 'Skill name for load, search query for search, or omitted for list.',
    },
  },
  required: ['action'],
};

const execute = async ({ action, argument }, { agent } = {}) => {
  const registry = agent?.skillRegistry;
  if (!registry) throw new Error('loadSkill requires ctx.agent.skillRegistry.');
  await registry._ensureDiscovered();

  if ((action === 'load' || action === 'search') && (!argument || !argument.trim())) {
    throw new Error(`Parameter "argument" is required and cannot be empty for action "${action}".`);
  }

  switch (action) {
    case 'list': {
      const lists = registry.list();
      if (!lists) {
        return 'No skills found.';
      }

      return `# Available Skills (${registry.skills.size})\n\n` + lists;
    }
    case 'load': {
      const skill = registry.get(argument);
      if (!skill) {
        const lists = await execute({ action: 'list' }, { agent });
        return `Skill "${argument}" not found!\n\n${lists}`;
      }

      let output = `# ${argument}\n\n`;
      for (const key of Object.keys(skill)) {
        if (skill[key] && key !== 'content' && key !== 'raw') {
          output += `**${key}:** ${skill[key]}\n`;
        }
      }
      output += '\n---\n\n';
      output += skill.content;

      return output;
    }
    case 'search': {
      const results = registry.search(argument);
      if (!results || results.length === 0) {
        const lists = await execute({ action: 'list' }, { agent });
        return `No skills found matching "${argument}".\n\n${lists}`;
      }

      let output = `# Skills matching "${argument}" (${results.length})\n\n`;
      for (const skill of results) {
        output += `- **${skill.name}** (${skill.scope}, score: ${skill.score})\n`;
        if (skill.description) {
          output += `  ${skill.description}\n`;
        }
        output += '\n';
      }

      return output;
    }
  }
};

export const loadSkill = { name: 'loadSkill', description, inputSchema, execute };
