import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mergeReasoningDelta, finalizeReasoningDetails, sanitizeAssistantReasoning } from '../../src/core/reasoning.js';

describe('reasoning — streaming accumulation', () => {
  it('concatenates consecutive text chunks sharing an index', () => {
    let acc = [];
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.text', text: 'Think', index: 0 }]);
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.text', text: 'ing', signature: 'sig', index: 0 }]);
    assert.deepStrictEqual(finalizeReasoningDetails(acc), [
      { type: 'reasoning.text', text: 'Thinking', signature: 'sig', index: 0 },
    ]);
  });

  it('keeps separate blocks for different indices and sorts ascending', () => {
    let acc = [];
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.text', text: 'B', index: 1 }]);
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.text', text: 'A', index: 0 }]);
    assert.deepStrictEqual(finalizeReasoningDetails(acc), [
      { type: 'reasoning.text', text: 'A', index: 0 },
      { type: 'reasoning.text', text: 'B', index: 1 },
    ]);
  });

  it('concatenates summary and encrypted data fields', () => {
    let acc = [];
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.summary', summary: 'high ', index: 0 }]);
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.summary', summary: 'level', index: 0 }]);
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.encrypted', data: 'AA', index: 1 }]);
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.encrypted', data: 'BB', index: 1 }]);
    assert.deepStrictEqual(finalizeReasoningDetails(acc), [
      { type: 'reasoning.summary', summary: 'high level', index: 0 },
      { type: 'reasoning.encrypted', data: 'AABB', index: 1 },
    ]);
  });

  it('merges index-less chunks into the last entry of the same type', () => {
    let acc = [];
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.text', text: 'Half ' }]);
    acc = mergeReasoningDelta(acc, [{ type: 'reasoning.text', text: 'whole' }]);
    assert.deepStrictEqual(finalizeReasoningDetails(acc), [{ type: 'reasoning.text', text: 'Half whole' }]);
  });

  it('returns acc unchanged when deltaDetails is not an array', () => {
    const acc = [{ type: 'reasoning.text', text: 'A', index: 0 }];
    assert.deepStrictEqual(mergeReasoningDelta(acc, null), acc);
  });

  it('does not mutate the input accumulator', () => {
    const acc = [{ type: 'reasoning.text', text: 'A', index: 0 }];
    const next = mergeReasoningDelta(acc, [{ type: 'reasoning.text', text: 'B', index: 0 }]);
    assert.strictEqual(acc[0].text, 'A');
    assert.notStrictEqual(next, acc);
  });

  it('returns undefined when the accumulator is empty', () => {
    assert.strictEqual(finalizeReasoningDetails([]), undefined);
    assert.strictEqual(finalizeReasoningDetails(undefined), undefined);
  });
});

describe('reasoning — payload sanitizer', () => {
  const details = [{ type: 'reasoning.text', text: 'why', signature: 'sig', index: 0 }];

  it('drops the reasoning string when details exist on openrouter', () => {
    const msg = { role: 'assistant', reasoning: 'why', reasoning_details: details, content: 'hi' };
    const out = sanitizeAssistantReasoning(msg, 'openrouter');
    assert.strictEqual(out.reasoning, undefined);
    assert.deepStrictEqual(out.reasoning_details, details);
    assert.strictEqual(msg.reasoning, 'why'); // input not mutated
  });

  it('leaves a string-only assistant message unchanged on openrouter', () => {
    const msg = { role: 'assistant', reasoning: 'why', content: 'hi' };
    const out = sanitizeAssistantReasoning(msg, 'openrouter');
    assert.strictEqual(out, msg);
  });

  it('leaves a string-only assistant message with empty details unchanged on openrouter', () => {
    const msg = { role: 'assistant', reasoning: 'why', reasoning_details: [], content: 'hi' };
    assert.strictEqual(sanitizeAssistantReasoning(msg, 'openrouter'), msg);
  });

  it('strips reasoning_details on the openai dialect', () => {
    const msg = { role: 'assistant', reasoning: 'why', reasoning_details: details, content: 'hi' };
    const out = sanitizeAssistantReasoning(msg, 'openai');
    assert.strictEqual(out.reasoning_details, undefined);
    assert.deepStrictEqual(msg.reasoning_details, details); // input not mutated
  });

  it('returns non-assistant messages untouched', () => {
    const msg = { role: 'user', content: 'hi' };
    assert.strictEqual(sanitizeAssistantReasoning(msg, 'openrouter'), msg);
  });
});
