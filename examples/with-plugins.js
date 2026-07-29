// Run this example with OPENROUTER_API_KEY=... node examples/with-plugins.js.
// The weather plugin provides AGENTS.md and a forecast skill. The calculator
// plugin provides a percentage skill. Plugins may provide either form or both.

import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import createAgent from '../src/index.js';

export async function main() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const pluginsDir = path.join(__dirname, 'plugins');

  const agent = await createAgent({ storagePaths: { pluginsDir } });

  await agent.skillRegistry.discover();

  try {
    console.log('Skills discovered from plugins:');
    for (const [name, skill] of agent.skillRegistry.skills) {
      if (skill.scope !== 'plugin') continue;
      console.log(`- ${name} (plugin: ${skill.plugin}): ${skill.description}`);
    }

    console.log('\nPlugin instructions:');
    for (const { plugin, content } of agent.skillRegistry.getPluginInstructions()) {
      console.log(`### ${plugin}\n${content}`);
    }

    console.log('Agent reply:');
    const reply = await agent.run('I am in Jakarta. Should I bring an umbrella this afternoon?');
    console.log(reply);

    console.log('\nUsage:');
    console.log(agent.usage);
  } finally {
    await agent.cleanup();
  }
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return pathToFileURL(realpathSync(path.resolve(process.argv[1]))).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  await main();
}
