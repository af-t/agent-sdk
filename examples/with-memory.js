// Persistent-memory protocol example.

import createAgent from '../src/index.js';

const agent = await createAgent();

console.log('--- Run 1: store a preference ---');
const first = await agent.run(
  'Remember that I prefer pnpm over npm for this project. ' +
    'Save it as a user-type memory and update MEMORY.md accordingly.',
);
console.log(first);
console.log();

agent.reset();

console.log('--- Run 2: recall the preference ---');
const second = await agent.run('Check my saved memories. Which package manager do I prefer for this project, and why?');
console.log(second);
console.log();

console.log('--- Total usage ---');
console.log(agent.usage);
