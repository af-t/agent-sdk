import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../../src/support/errors.js';
import {
  degradePayload,
  formatBytes,
  hasMultimodalContent,
  LIMITS,
  sanitizeAppName,
  truncateOutput,
} from '../../src/support/payload.js';

describe('truncateOutput', () => {
  it('preserves strings at or below the limit and non-string values', () => {
    assert.equal(truncateOutput('hello', 10), 'hello');
    assert.equal(truncateOutput('hello', 5), 'hello');
    assert.equal(truncateOutput(null, 5), null);
    assert.deepEqual(truncateOutput({ value: 1 }, 5), { value: 1 });
  });

  it('adds an omission notice when it truncates text', () => {
    assert.match(truncateOutput('hello world', 5), /^hello\n\[\.\.\. truncated: 6 characters omitted\]$/);
    assert.ok(truncateOutput('x'.repeat(LIMITS.maxToolOutput + 1000)).length < LIMITS.maxToolOutput + 1000);
  });
});

describe('hasMultimodalContent', () => {
  it('returns false for invalid payloads and text-only content', () => {
    assert.equal(hasMultimodalContent(null), false);
    assert.equal(hasMultimodalContent({ messages: null }), false);
    assert.equal(hasMultimodalContent({ messages: [{ role: 'tool', content: 'plain string' }] }), false);
    assert.equal(
      hasMultimodalContent({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
      false,
    );
  });

  it('detects non-text user and tool content', () => {
    assert.equal(
      hasMultimodalContent({ messages: [{ role: 'tool', content: [{ type: 'image_url', image_url: {} }] }] }),
      true,
    );
    assert.equal(hasMultimodalContent({ messages: [{ role: 'tool', content: [{ type: 'file', file: {} }] }] }), true);
    assert.equal(
      hasMultimodalContent({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: {} }] }] }),
      true,
    );
  });
});

describe('degradePayload', () => {
  it('does nothing for invalid or text-only payloads', () => {
    const message = { role: 'tool', content: [{ type: 'text', text: 'only text' }] };
    const payload = { messages: [message] };
    assert.doesNotThrow(() => degradePayload(null));
    assert.doesNotThrow(() => degradePayload({ messages: null }));
    degradePayload(payload);
    assert.strictEqual(payload.messages[0], message);
  });

  it('leaves string-content messages unchanged', () => {
    const payload = { messages: [{ role: 'tool', content: 'already text' }] };
    degradePayload(payload);
    assert.equal(payload.messages[0].content, 'already text');
  });

  it('replaces non-text content with joined text without mutating the original message', () => {
    const content = [
      { type: 'text', text: 'line one' },
      { type: 'text', text: 'line two' },
      { type: 'image_url', image_url: {} },
    ];
    const message = { role: 'tool', tool_call_id: 'call', content };
    const payload = { messages: [message] };
    degradePayload(payload);
    assert.equal(payload.messages[0].content, 'line one\nline two');
    assert.strictEqual(message.content, content);
    assert.notStrictEqual(payload.messages[0], message);
  });

  it('uses a notice when a rich message has no text', () => {
    const payload = { messages: [{ role: 'tool', content: [{ type: 'image_url', image_url: {} }] }] };
    degradePayload(payload);
    assert.equal(payload.messages[0].content, '[non-text content omitted]');
  });
});

describe('sanitizeAppName', () => {
  it('trims valid single-segment names', () => {
    assert.equal(sanitizeAppName('  my_app.v2  '), 'my_app.v2');
  });

  it('rejects non-strings, empty values, path separators, dot segments, and null bytes', () => {
    for (const value of [42, null, '', '   ', 'foo/bar', 'foo\\bar', '.', '..', 'a\0b']) {
      assert.throws(() => sanitizeAppName(value), ConfigError);
    }
  });
});

describe('formatBytes', () => {
  it('formats byte counts for display', () => {
    assert.equal(formatBytes(0), '0B');
    assert.equal(formatBytes(1024), '1KB');
    assert.equal(formatBytes(1536), '1.5KB');
  });
});
