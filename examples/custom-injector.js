// Custom per-turn injector example.

import os from 'node:os';
import createAgent from '../src/index.js';

const agent = await createAgent();

agent.registerInjector({
  name: 'host-metrics',
  scope: 'per-turn',
  fn: () => {
    const load = os.loadavg()[0].toFixed(2);
    const uptimeMin = Math.round(os.uptime() / 60);
    return `Host metrics: load1=${load}, uptime=${uptimeMin}m, hostname=${os.hostname()}`;
  },
});

const reply = await agent.run(
  'What is the current load average and uptime according to the system reminder? Quote the exact line.',
);

console.log('--- Agent reply ---');
console.log(reply);
console.log('--- Usage ---');
console.log(agent.usage);
