import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createBuiltinTools } from '../../src/tools/index.js';

const CANONICAL_NAMES = [
  'readFile',
  'writeFile',
  'editFile',
  'findFiles',
  'listFiles',
  'manageTodos',
  'recallMemory',
  'fetchUrl',
  'searchWeb',
  'runShell',
  'delegateTask',
  'manageJobs',
  'loadSkill',
  'scheduleWakeup',
];

const CAMEL_CASE = /^[a-z][A-Za-z0-9]*$/;

function collectSchemaNames(schema, location, found = []) {
  if (!schema || typeof schema !== 'object') return found;

  for (const [field, subSchema] of Object.entries(schema.properties ?? {})) {
    found.push({ kind: 'field', value: field, location: `${location}.${field}` });
    collectSchemaNames(subSchema, `${location}.${field}`, found);
  }
  if (schema.items) {
    collectSchemaNames(schema.items, `${location}[]`, found);
  }
  for (const value of schema.enum ?? []) {
    if (typeof value === 'string') {
      found.push({ kind: 'enum value', value, location: `${location} enum` });
    }
  }
  return found;
}

describe('built-in tool contracts', () => {
  const tools = createBuiltinTools();

  it('registers the canonical tool names in order', () => {
    assert.deepEqual(
      tools.map((tool) => tool.name),
      CANONICAL_NAMES,
    );
  });

  it('exposes nothing beyond name, description, inputSchema, and execute', () => {
    assert.deepEqual(
      tools.map((tool) => Object.keys(tool).sort()),
      CANONICAL_NAMES.map(() => ['description', 'execute', 'inputSchema', 'name']),
    );
  });

  it('names every input-schema field and enum value in camelCase', () => {
    const offenders = tools.flatMap((tool) =>
      collectSchemaNames(tool.inputSchema, tool.name).filter((entry) => !CAMEL_CASE.test(entry.value)),
    );

    assert.deepEqual(
      offenders.map((entry) => `${entry.location}: ${entry.kind} "${entry.value}"`),
      [],
    );
  });
});
