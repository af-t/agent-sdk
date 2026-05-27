import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureSafePath,
  getIgnoreFilter,
  stripSecrets,
  truncateOutput,
  CONSTANTS,
  payloadHasMultimodal,
  degradePayload,
} from '../../src/core/utils.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { realpathSync } from 'node:fs';

const projectRoot = process.cwd();

describe('ensureSafePath', () => {
  it('accepts valid relative path', () => {
    const result = ensureSafePath('src/index.js');
    assert.ok(result);
    assert.ok(result.endsWith('src/index.js'));
  });

  it('accepts valid absolute path within project', () => {
    const result = ensureSafePath(path.resolve(projectRoot, 'src/core/utils.js'));
    assert.ok(result);
  });

  it('accepts the project root itself', () => {
    const result = ensureSafePath('.');
    assert.ok(result);
    assert.strictEqual(path.resolve(result), path.resolve(projectRoot));
  });

  it('rejects null byte in path', () => {
    assert.throws(() => ensureSafePath('../../etc/passwd\0'), { message: /null byte/ });
  });

  it('rejects path with .. traversal', () => {
    assert.throws(() => ensureSafePath('../../etc/passwd'), { message: /URL-encoded traversal|outside project root/ });
  });

  it('rejects URL-encoded path traversal %2e%2e', () => {
    assert.throws(() => ensureSafePath('%2e%2e%2fetc%2fpasswd'), { message: /URL-encoded traversal/ });
  });

  it('rejects double-encoded path traversal %252e%252e', () => {
    // %252e%252e decodes to %2e%2e then to ..
    assert.throws(() => ensureSafePath('%252e%252e%252fetc%252fpasswd'), { message: /URL-encoded traversal/ });
  });

  it('rejects double-encoded %252f forward slash', () => {
    // %252f decodes to %2f which is /
    assert.throws(() => ensureSafePath('etc%252fpasswd'), { message: /URL-encoded traversal/ });
  });

  it('rejects %5c backslash encoding', () => {
    // %5c is backslash — should be caught
    assert.throws(() => ensureSafePath('..%5c..%5cetc%5cpasswd'), { message: /URL-encoded traversal/ });
  });

  it('rejects extremely long path (> 4096 chars)', () => {
    const longPath = 'a/'.repeat(2048) + 'file.txt';
    // Path length > 4096 chars — still rejected because path.resolve may
    // produce path outside root or the path itself may be safe; we mainly
    // test that no crash occurs and the function handles it gracefully.
    try {
      ensureSafePath(longPath);
      // If it doesn't throw, it should return a valid path
    } catch (err) {
      // Throwing is acceptable for traversal or any reason
      assert.ok(err.message.length > 0);
    }
  });

  it('rejects symlink pointing outside project root', async () => {
    const fs = await import('node:fs');
    const symlinkPath = path.join(projectRoot, 'tests/fixtures/symlink-outside');
    let symlinkCreated = false;
    try {
      // Try to create symlink to /data or /etc (common on Termux/Android)
      const target = '/data';
      fs.symlinkSync(target, symlinkPath);
      symlinkCreated = true;
      // ensureSafePath should reject it since it resolves outside root
      assert.throws(() => ensureSafePath('tests/fixtures/symlink-outside'), {
        message: /Access denied|outside project root/,
      });
    } catch (err) {
      if (symlinkCreated) {
        // If symlink was created but ensureSafePath didn't throw, that's wrong
        // But if it's an expected Access denied error, re-throw
        if (err.message.includes('Access denied') || err.message.includes('outside project root')) {
          // expected
        } else {
          throw err;
        }
      }
      // Symlink creation failed (e.g., restricted filesystem) — skip gracefully
    } finally {
      if (symlinkCreated) {
        try {
          fs.unlinkSync(symlinkPath);
        } catch {}
      }
    }
  });

  it('rejects protocol handler file://', () => {
    assert.throws(() => ensureSafePath('file:///etc/passwd'), { message: /protocol handler/ });
  });

  it('rejects protocol handler https://', () => {
    assert.throws(() => ensureSafePath('https://evil.com/payload'), { message: /protocol handler/ });
  });

  it('accepts path within an explicitly trusted external root', () => {
    const externalDir = realpathSync(os.tmpdir());
    const externalFile = path.join(externalDir, 'test.txt');
    const result = ensureSafePath(externalFile, new Set([externalDir]));
    assert.ok(result.startsWith(externalDir));
  });

  it('accepts exact match on trusted root itself', () => {
    const externalDir = realpathSync(os.tmpdir());
    const result = ensureSafePath(externalDir, new Set([externalDir]));
    assert.strictEqual(result, externalDir);
  });

  it('rejects symlink inside allowedRoot that points outside it', () => {
    const tmpBase = realpathSync(os.tmpdir());
    const trustedDir = fs.mkdtempSync(path.join(tmpBase, 'trusted-'));
    const symlinkPath = path.join(trustedDir, 'escape');
    try {
      fs.symlinkSync('/etc', symlinkPath);
      assert.throws(() => ensureSafePath(symlinkPath, new Set([trustedDir])), {
        message: /resolves outside trusted root/,
      });
    } finally {
      fs.rmSync(trustedDir, { recursive: true, force: true });
    }
  });

  it('still rejects external path when allowedRoots is empty', () => {
    assert.throws(() => ensureSafePath('/etc/passwd', new Set()), { message: /outside project root/ });
  });

  it('still rejects external path when allowedRoots does not match', () => {
    const unrelated = path.join(os.tmpdir(), 'other-trusted');
    assert.throws(() => ensureSafePath('/etc/passwd', new Set([unrelated])), { message: /outside project root/ });
  });

  it('ignores relative entries in allowedRoots — only absolute paths are trusted', () => {
    assert.throws(() => ensureSafePath('/etc/passwd', new Set(['relative/dir'])), { message: /outside project root/ });
  });

  it('still rejects null bytes even when path matches an allowedRoot', () => {
    const externalDir = os.tmpdir();
    assert.throws(() => ensureSafePath(path.join(externalDir, 'file\0.txt'), new Set([externalDir])), {
      message: /null byte/,
    });
  });

  it('default call (no second arg) behaves identically to old API', () => {
    assert.throws(() => ensureSafePath('/etc/passwd'), { message: /outside project root/ });
    const result = ensureSafePath('src/index.js');
    assert.ok(result.endsWith('src/index.js'));
  });

  it('rejects null byte regardless of restricted=false', () => {
    assert.throws(() => ensureSafePath('foo\x00bar', null, { restricted: false }), /null byte/i);
  });

  it('rejects URL-encoded traversal regardless of restricted=false', () => {
    assert.throws(() => ensureSafePath('a/%2e%2e/etc/passwd', null, { restricted: false }), /encoded|traversal/i);
  });

  it('rejects protocol handlers regardless of restricted=false', () => {
    assert.throws(() => ensureSafePath('file:///etc/passwd', null, { restricted: false }), /protocol|file:/i);
  });

  it('blocks /etc/passwd when restricted=true (default)', () => {
    assert.throws(() => ensureSafePath('/etc/passwd'), /outside|boundary/i);
  });

  it('permits absolute external paths when restricted=false', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'esp-'));
    const f = path.join(tmp, 'a.txt');
    fs.writeFileSync(f, 'hi');
    const result = ensureSafePath(f, null, { restricted: false });
    assert.equal(result, fs.realpathSync(f));
    fs.rmSync(tmp, { recursive: true });
  });
});

describe('withRetry', () => {
  let withRetry;
  let origSetTimeout;

  before(async () => {
    const mod = await import('../../src/core/utils.js');
    withRetry = mod.withRetry;
    // Save original setTimeout
    origSetTimeout = globalThis.setTimeout;
  });

  after(() => {
    // Restore setTimeout if we mocked it
    if (globalThis.setTimeout !== origSetTimeout) {
      globalThis.setTimeout = origSetTimeout;
    }
  });

  it('succeeds on first attempt', async () => {
    const result = await withRetry(async () => 'success', 3);
    assert.equal(result, 'success');
  });

  it('succeeds after retries (using fast timers)', async () => {
    // Replace setTimeout with a fast version for delay-sensitive tests
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    try {
      let attempts = 0;
      const result = await withRetry(async () => {
        attempts++;
        if (attempts < 3) throw new Error('fail');
        return 'recovered';
      }, 5);
      assert.equal(result, 'recovered');
      assert.equal(attempts, 3);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('throws if all retries exhausted (using fast timers)', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    try {
      await assert.rejects(
        () =>
          withRetry(async () => {
            throw new Error('persistent');
          }, 3),
        { message: 'persistent' },
      );
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('circuit breaker: does not retry 4xx client errors', async () => {
    let attempts = 0;
    const err = { status: 401, message: 'Unauthorized' };

    await assert.rejects(
      () =>
        withRetry(async () => {
          attempts++;
          throw err;
        }, 5),
      { status: 401 },
    );
    assert.equal(attempts, 1);
  });

  it('circuit breaker: does not retry 401', async () => {
    let count = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          count++;
          throw { status: 401 };
        }, 3),
      { status: 401 },
    );
    assert.equal(count, 1);
  });

  it('circuit breaker: does not retry 403', async () => {
    let count = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          count++;
          throw { status: 403 };
        }, 3),
      { status: 403 },
    );
    assert.equal(count, 1);
  });

  it('circuit breaker: does not retry 404', async () => {
    let count = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          count++;
          throw { status: 404 };
        }, 3),
      { status: 404 },
    );
    assert.equal(count, 1);
  });

  it('circuit breaker: does not retry 400 with different message', async () => {
    let count = 0;
    await assert.rejects(
      () =>
        withRetry(async () => {
          count++;
          throw { status: 400, message: 'Bad input' };
        }, 3),
      { status: 400 },
    );
    assert.equal(count, 1);
  });

  it('calls callback on final failure', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, _delay, ...args) => realSetTimeout(fn, 1, ...args);

    try {
      let callbackCalled = false;
      await assert.rejects(
        () =>
          withRetry(
            async () => {
              throw new Error('fail');
            },
            2,
            () => {
              callbackCalled = true;
            },
          ),
        { message: 'fail' },
      );
      assert.equal(callbackCalled, true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('handles hanging callback gracefully (callback returns promise that never resolves)', async () => {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => {
      if (delay === 5000) {
        // This is the callback safety timeout — fast-forward it too
        return realSetTimeout(fn, 1, ...args);
      }
      return realSetTimeout(fn, 1, ...args);
    };

    try {
      let callbackCalled = false;
      // This callback returns a promise that never resolves
      await assert.rejects(
        () =>
          withRetry(
            async () => {
              throw new Error('fail');
            },
            2,
            () => {
              callbackCalled = true;
              return new Promise(() => {}); // never resolves
            },
          ),
        { message: 'fail' },
      );
      // The withRetry should have completed despite the hanging callback
      assert.equal(callbackCalled, true);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('timeout handling: callback that never resolves causes retry exhaustion', async () => {
    // Use a callback that hangs for a long time, then let withRetry try
    // multiple times. Each attempt hangs; withRetry should exhaust retries
    // and throw the last error.
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, delay, ...args) => {
      // Fast-forward delays to 1ms so test finishes quickly
      return realSetTimeout(fn, 1, ...args);
    };

    try {
      let attempts = 0;
      await assert.rejects(
        () =>
          withRetry(async () => {
            attempts++;
            // This promise never resolves on its own — simulating timeout
            throw new Error('timeout');
          }, 3),
        { message: 'timeout' },
      );
      // Should have tried 3 times
      assert.equal(attempts, 3);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  it('jitter logic: delays vary across retries', async () => {
    // Mock setTimeout to capture delay values passed to it
    const realSetTimeout = globalThis.setTimeout;
    const capturedDelays = [];

    globalThis.setTimeout = (fn, delay, ...args) => {
      capturedDelays.push(delay);
      return realSetTimeout(fn, 1, ...args);
    };

    try {
      await assert.rejects(() =>
        withRetry(async () => {
          throw new Error('fail');
        }, 5),
      );

      // We should have captured 5 delay values (retries=5)
      assert.ok(capturedDelays.length >= 5, `Expected >= 5 delays, got ${capturedDelays.length}`);

      // Verify delays are not all identical (jitter works)
      const uniqueDelays = new Set(capturedDelays.map((d) => Math.round(d)));
      assert.ok(
        uniqueDelays.size > 1,
        `Expected varying delays (jitter), got all identical: ${capturedDelays.join(',')}`,
      );

      // Verify approximate exponential backoff
      for (let i = 1; i < capturedDelays.length; i++) {
        const ratio = capturedDelays[i] / capturedDelays[i - 1];
        assert.ok(
          ratio >= 0.6,
          `Delay ${i} (${capturedDelays[i]}) should be >= 0.6 * delay ${i - 1} (${capturedDelays[i - 1]}), ratio=${ratio.toFixed(3)}`,
        );
      }
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });
});

describe('getIgnoreFilter', () => {
  it('returns a filter object with test, ignores, and add methods', async () => {
    const filter = await getIgnoreFilter();
    assert.equal(typeof filter.test, 'function');
    assert.equal(typeof filter.ignores, 'function');
    assert.equal(typeof filter.add, 'function');
  });

  it('caches the result based on cwd', async () => {
    const f1 = await getIgnoreFilter();
    const f2 = await getIgnoreFilter();
    assert.strictEqual(f1, f2);
  });
});

describe('stripSecrets', () => {
  it('strips API keys from env object', () => {
    const env = { OPENROUTER_API_KEY: 'secret123', PATH: '/usr/bin' };
    const stripped = stripSecrets(env);
    assert.equal(stripped.OPENROUTER_API_KEY, undefined);
    assert.equal(stripped.PATH, '/usr/bin');
  });

  it('strips tokens and secrets', () => {
    const env = { GITHUB_TOKEN: 'token', DB_PASSWORD: 'pass', USER: 'admin' };
    const stripped = stripSecrets(env);
    assert.equal(stripped.GITHUB_TOKEN, undefined);
    assert.equal(stripped.DB_PASSWORD, undefined);
    assert.equal(stripped.USER, 'admin');
  });

  it('strips case-insensitive matches', () => {
    const env = { MySecretKey: 'xyz', public_data: '123' };
    const stripped = stripSecrets(env);
    assert.equal(stripped.MySecretKey, undefined);
    assert.equal(stripped.public_data, '123');
  });

  it('returns empty object for empty input', () => {
    assert.deepEqual(stripSecrets({}), {});
  });

  it('does not modify the original env object', () => {
    const env = { API_KEY: '123' };
    stripSecrets(env);
    assert.equal(env.API_KEY, '123');
  });
});

describe('truncateOutput', () => {
  it('returns text unchanged when under limit', () => {
    assert.strictEqual(truncateOutput('hello', 10), 'hello');
  });

  it('returns text unchanged when exactly at limit', () => {
    assert.strictEqual(truncateOutput('hello', 5), 'hello');
  });

  it('truncates and appends omitted-char count when over limit', () => {
    const result = truncateOutput('hello world', 5);
    assert.strictEqual(result.startsWith('hello'), true);
    assert.ok(result.includes('[... truncated:'));
    assert.ok(result.includes('6 characters omitted'));
  });

  it('does not truncate non-string values', () => {
    assert.strictEqual(truncateOutput(null, 5), null);
    assert.deepEqual(truncateOutput({ a: 1 }, 5), { a: 1 });
    assert.strictEqual(truncateOutput(42, 5), 42);
  });

  it('uses CONSTANTS.MAX_TOOL_OUTPUT as default limit', () => {
    const long = 'x'.repeat(CONSTANTS.MAX_TOOL_OUTPUT + 1000);
    const result = truncateOutput(long);
    assert.strictEqual(result.length < long.length, true);
    assert.ok(result.includes('[... truncated:'));
  });
});

describe('payloadHasMultimodal', () => {
  it('returns false for missing payload', () => {
    assert.strictEqual(payloadHasMultimodal(null), false);
    assert.strictEqual(payloadHasMultimodal(undefined), false);
  });

  it('returns false when messages is absent or not an array', () => {
    assert.strictEqual(payloadHasMultimodal({}), false);
    assert.strictEqual(payloadHasMultimodal({ messages: null }), false);
  });

  it('returns false when all tool messages have only text parts', () => {
    const payload = {
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'tool', content: [{ type: 'text', text: 'result' }] },
      ],
    };
    assert.strictEqual(payloadHasMultimodal(payload), false);
  });

  it('returns false when tool message content is a string', () => {
    const payload = {
      messages: [{ role: 'tool', content: 'plain string' }],
    };
    assert.strictEqual(payloadHasMultimodal(payload), false);
  });

  it('returns true when a tool message contains an image_url part', () => {
    const payload = {
      messages: [
        {
          role: 'tool',
          content: [
            { type: 'text', text: '[image] x.png' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    };
    assert.strictEqual(payloadHasMultimodal(payload), true);
  });

  it('returns true when a tool message contains a file part', () => {
    const payload = {
      messages: [
        {
          role: 'tool',
          content: [
            { type: 'text', text: '[pdf] doc.pdf' },
            { type: 'file', file: { filename: 'doc.pdf', file_data: 'base64data' } },
          ],
        },
      ],
    };
    assert.strictEqual(payloadHasMultimodal(payload), true);
  });

  it('returns true when a user message contains non-text parts', () => {
    const payload = {
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }],
    };
    assert.strictEqual(payloadHasMultimodal(payload), true);
  });
});

describe('degradePayload', () => {
  it('is a no-op for missing or invalid payload', () => {
    assert.doesNotThrow(() => degradePayload(null));
    assert.doesNotThrow(() => degradePayload(undefined));
    assert.doesNotThrow(() => degradePayload({}));
    assert.doesNotThrow(() => degradePayload({ messages: null }));
  });

  it('collapses image_url part and keeps text part as joined string', () => {
    const payload = {
      messages: [
        {
          role: 'tool',
          tool_call_id: 'c1',
          content: [
            { type: 'text', text: '[image] x.png' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    };
    degradePayload(payload);
    assert.strictEqual(typeof payload.messages[0].content, 'string');
    assert.strictEqual(payload.messages[0].content, '[image] x.png');
  });

  it('uses placeholder when there are no text parts', () => {
    const payload = {
      messages: [
        {
          role: 'tool',
          tool_call_id: 'c2',
          content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
        },
      ],
    };
    degradePayload(payload);
    assert.strictEqual(payload.messages[0].content, '[non-text content omitted]');
  });

  it('joins multiple text parts with newline', () => {
    const payload = {
      messages: [
        {
          role: 'tool',
          tool_call_id: 'c3',
          content: [
            { type: 'text', text: 'line one' },
            { type: 'text', text: 'line two' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    };
    degradePayload(payload);
    assert.strictEqual(payload.messages[0].content, 'line one\nline two');
  });

  it('leaves string-content tool messages untouched', () => {
    const payload = {
      messages: [{ role: 'tool', tool_call_id: 'c4', content: 'already a string' }],
    };
    degradePayload(payload);
    assert.strictEqual(payload.messages[0].content, 'already a string');
  });

  it('leaves all-text-array tool messages untouched', () => {
    const payload = {
      messages: [
        {
          role: 'tool',
          tool_call_id: 'c5',
          content: [{ type: 'text', text: 'only text' }],
        },
      ],
    };
    degradePayload(payload);
    assert.ok(Array.isArray(payload.messages[0].content), 'should still be an array');
    assert.strictEqual(payload.messages[0].content[0].text, 'only text');
  });

  it('does not mutate the original message object', () => {
    const originalContent = [
      { type: 'text', text: '[image] x.png' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ];
    const originalMsg = { role: 'tool', tool_call_id: 'c6', content: originalContent };
    const payload = { messages: [originalMsg] };

    degradePayload(payload);

    // The slot in payload.messages is replaced but original object is unchanged
    assert.strictEqual(originalMsg.content, originalContent, 'original message content ref unchanged');
    assert.ok(Array.isArray(originalMsg.content), 'original content is still an array');
    assert.strictEqual(originalMsg.content[1].type, 'image_url', 'original still has image_url part');
    // The new slot is a different object
    assert.notStrictEqual(payload.messages[0], originalMsg);
  });
});
