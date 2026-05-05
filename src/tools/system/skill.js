import registry from '../../core/skill.js';

export const name = 'Skill';
export const description = 'Reusable instruction sets for specialized tasks like code review, debugging, testing, architecture planning, strategy, and more.';

export const input_schema = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['list', 'load', 'search'], description: 'There are 3 options to manage your skills.' },
    argument: { type: 'string', description: 'Argument for list, load, or search. for list no need to fill in, for load enter name, for search enter query.' }
  },
  required: ['action', 'argument']
};

export const execute = async ({ action, argument }) => {
  await registry._ensureDiscovered();

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
        const lists = execute({ action: 'list' });
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
      if (!results) {
        const lists = execute({ action: 'list' });
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
