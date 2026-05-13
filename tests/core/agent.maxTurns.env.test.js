import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// This file tests the OPENROUTER_MAX_TURNS env var override.
// It sets the env before importing Agent so config captures the value.

describe('Agent MAX_TURNS env override', () => {
  let Agent;

  before(async () => {
    process.env.OPENROUTER_MAX_TURNS = '0';
    const mod = await import('../../src/core/agent.js');
    Agent = mod.default;
  });

  it('reads OPENROUTER_MAX_TURNS=0 from env and sets maxTurns to 0', () => {
    const agent = new Agent({ apiKey: 'sk-test-env-zero' });
    assert.strictEqual(agent.maxTurns, 0);
  });
});
