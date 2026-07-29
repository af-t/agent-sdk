import os from 'node:os';
import createAgent from '../src/index.js';

const agent = await createAgent();

const unregister = agent.registerInjector({
  name: 'host-metrics',
  scope: 'per-turn',
  run: () => {
    const load = os.loadavg()[0].toFixed(2);
    const uptimeMin = Math.round(os.uptime() / 60);
    return `Host metrics: load1=${load}, uptime=${uptimeMin}m, hostname=${os.hostname()}`;
  },
});

try {
  const reply = await agent.run(
    'What is the current load average and uptime according to the system reminder? Quote the exact line.',
  );
  console.log('Agent reply:');
  console.log(reply);
  console.log('Usage:');
  console.log(agent.usage);
} finally {
  unregister();
  await agent.cleanup();
}
