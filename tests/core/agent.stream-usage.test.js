import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

function makeSseResponse(lines) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream };
}

describe('Agent — streaming usage', () => {
  let Agent;
  let originalFetch;

  before(async () => {
    Agent = (await import('../../src/core/agent.js')).default;
    originalFetch = global.fetch;
  });

  after(() => {
    global.fetch = originalFetch;
  });

  it('requests stream_options.include_usage and accrues a streamed usage chunk', async () => {
    let sentBody = null;
    global.fetch = async (_url, opts) => {
      sentBody = JSON.parse(opts.body);
      return makeSseResponse([
        'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}',
        // final usage chunk in the OpenAI streaming shape (empty choices + top-level usage)
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        'data: [DONE]',
      ]);
    };

    const agent = new Agent({ apiKey: 'sk-test' });
    const out = await agent.run('go', () => {}); // notify -> streaming path

    assert.equal(sentBody.stream, true, 'streaming request must set stream:true');
    assert.deepEqual(sentBody.stream_options, { include_usage: true }, 'streaming request must opt into usage');
    assert.equal(out, 'hi');
    assert.equal(agent.usage.tokens, 15, 'streamed usage chunk must accrue into agent.usage.tokens');
  });
});
