// Plugin loading example: skills + AGENTS.md from a plugins directory.
//
// Run with:  OPENROUTER_API_KEY=... node examples/with-plugins.js
//
// Layout under examples/plugins/:
//   weather/     AGENTS.md + skills/forecast/SKILL.md   (instructions + skill)
//   calculator/  skills/percentage/SKILL.md             (skill only, no AGENTS.md)
//
// A plugin's skills/ folder and its AGENTS.md are independent and optional.
// The default plugins dir is `.<appName>/plugins`; storagePaths.pluginsDir
// overrides it (here, the example folder).

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import createAgent from '../src/index.js';
import skillRegistry from '../src/registry/skill.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginsDir = path.join(__dirname, 'plugins');

// The constructor calls skillRegistry.configure({ pluginsDir }) for us.
const agent = await createAgent({ storagePaths: { pluginsDir } });

// Force discovery so we can inspect what the plugins contributed (no API call).
await skillRegistry._ensureDiscovered();

console.log('--- Skills discovered from plugins ---');
for (const [name, skill] of skillRegistry.skills) {
  if (skill.scope !== 'plugin') continue;
  console.log(`- ${name} (plugin: ${skill.plugin}) — ${skill.description}`);
}

console.log('\n--- Plugin instructions (injected as a first-turn system-reminder) ---');
for (const { plugin, content } of skillRegistry.getPluginInstructions()) {
  console.log(`### ${plugin}\n${content}`);
}

// The weather AGENTS.md should steer the model to load the forecast skill.
console.log('--- Agent reply ---');
const reply = await agent.run('I am in Jakarta. Should I bring an umbrella this afternoon?');
console.log(reply);

console.log('\n--- Usage ---');
console.log(agent.usage);
