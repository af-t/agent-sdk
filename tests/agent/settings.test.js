import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProviderRouting } from '../../src/agent/settings.js';

const config = {
  provider: {
    order: ['environment-order'],
    only: ['environment-only'],
    avoid: ['environment-avoid'],
    sort: 'price',
    allowFallbacks: true,
    requireParameters: false,
    dataCollection: 'allow',
  },
};

test('provider routing keeps one canonical SDK shape', () => {
  assert.deepEqual(
    resolveProviderRouting(
      {
        provider: {
          order: ['option-order'],
          only: ['option-only'],
          avoid: ['option-avoid'],
          sort: 'latency',
          allowFallbacks: false,
          requireParameters: true,
          dataCollection: 'deny',
        },
      },
      config,
    ),
    {
      order: ['option-order'],
      only: ['option-only'],
      avoid: ['option-avoid'],
      sort: 'latency',
      allowFallbacks: false,
      requireParameters: true,
      dataCollection: 'deny',
    },
  );
});

test('provider routing does not accept removed constructor aliases', () => {
  assert.deepEqual(
    resolveProviderRouting(
      {
        order: ['legacy-order'],
        only: ['legacy-only'],
        provider: { ignore: ['legacy-ignore'] },
      },
      config,
    ),
    {
      order: ['environment-order'],
      only: ['environment-only'],
      avoid: ['environment-avoid'],
      sort: 'price',
      allowFallbacks: true,
      requireParameters: false,
      dataCollection: 'allow',
    },
  );
});

test('empty provider arrays clear environment routing', () => {
  const routing = resolveProviderRouting(
    {
      provider: {
        order: [],
        only: [],
        avoid: [],
      },
    },
    config,
  );

  assert.deepEqual(routing.order, []);
  assert.deepEqual(routing.only, []);
  assert.deepEqual(routing.avoid, []);
});
