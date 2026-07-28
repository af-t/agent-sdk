import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError } from '../../src/support/errors.js';
import { createDefaultLogger, redactLogValue, resolveLogger } from '../../src/support/logger.js';

function createRecordingLogger(bindings = {}, records = []) {
  const logger = {
    records,
    child(extra) {
      return createRecordingLogger({ ...bindings, ...extra }, records);
    },
  };

  for (const level of ['debug', 'info', 'warn', 'error']) {
    logger[level] = function (context, message) {
      records.push({ level, context: { ...bindings, ...context }, message, receiver: this });
    };
  }

  return logger;
}

describe('structured logger', () => {
  it('passes structured entries to a Pino-style logger', () => {
    const target = createRecordingLogger();
    const logger = resolveLogger(target);

    logger.info({ component: 'agent', model: 'test/model' }, 'Agent started');

    assert.deepEqual(target.records[0].context, {
      component: 'agent',
      model: 'test/model',
    });
    assert.equal(target.records[0].message, 'Agent started');
    assert.equal(target.records[0].receiver, target);
  });

  it('redacts nested secrets before calling a custom logger', () => {
    const target = createRecordingLogger();
    const logger = resolveLogger(target);

    logger.error(
      {
        authorization: 'Bearer hidden-token',
        nested: { apiKey: 'sk-or-hidden' },
      },
      'Request failed for sk-or-hidden',
    );

    const serialized = JSON.stringify({
      context: target.records[0].context,
      message: target.records[0].message,
    });
    assert.doesNotMatch(serialized, /hidden-token|sk-or-hidden/);
    assert.match(serialized, /REDACTED/);
  });

  it('does not require child support', () => {
    const target = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((level) => [level, () => {}]));

    assert.doesNotThrow(() => resolveLogger(target).info({}, 'ready'));
  });

  it('merges child bindings when the target has no child method', () => {
    const records = [];
    const target = Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map((level) => [
        level,
        (context, message) => records.push({ level, context, message }),
      ]),
    );

    resolveLogger(target).child({ component: 'agent' }).warn({ attempt: 2 }, 'Retrying');

    assert.deepEqual(records[0], {
      level: 'warn',
      context: { component: 'agent', attempt: 2 },
      message: 'Retrying',
    });
  });

  it('throws ConfigError when a required log level is missing', () => {
    const target = { info() {}, warn() {}, error() {} };

    assert.throws(() => resolveLogger(target), ConfigError);
  });

  it('redacts circular objects and Error messages without mutating the input', () => {
    const error = new Error('Request failed for sk-ant-secret');
    const value = { nested: { token: 'hidden-token' }, error };
    value.self = value;

    const result = redactLogValue(value);

    assert.deepEqual(result.nested, { token: '[REDACTED]' });
    assert.equal(result.self, '[Circular]');
    assert.doesNotMatch(result.error.message, /sk-ant-secret/);
    assert.equal(value.nested.token, 'hidden-token');
  });

  it('uses the structured signature for the default console logger', () => {
    const writes = [];
    const consoleTarget = {
      log: (entry) => writes.push({ stream: 'stdout', entry }),
      error: (entry) => writes.push({ stream: 'stderr', entry }),
    };
    const logger = createDefaultLogger({ consoleTarget });

    logger.info({ component: 'agent' }, 'Agent started');
    logger.warn({ attempt: 2 }, 'Retrying');

    assert.deepEqual(JSON.parse(writes[0].entry), { component: 'agent', message: 'Agent started' });
    assert.equal(writes[0].stream, 'stdout');
    assert.deepEqual(JSON.parse(writes[1].entry), { attempt: 2, message: 'Retrying' });
    assert.equal(writes[1].stream, 'stderr');
  });

  it('emits debug records only when debug is enabled', () => {
    const quietWrites = [];
    const verboseWrites = [];
    const quiet = createDefaultLogger({ consoleTarget: { log: (entry) => quietWrites.push(entry), error() {} } });
    const verbose = createDefaultLogger({
      debug: true,
      consoleTarget: { log: (entry) => verboseWrites.push(entry), error() {} },
    });

    quiet.debug({ component: 'agent' }, 'Hidden');
    verbose.debug({ component: 'agent' }, 'Shown');

    assert.deepEqual(quietWrites, []);
    assert.deepEqual(JSON.parse(verboseWrites[0]), { component: 'agent', message: 'Shown' });
  });

  it('does not call logger lifecycle methods', () => {
    const target = createRecordingLogger();
    for (const method of ['flush', 'end', 'close']) {
      target[method] = () => {
        throw new Error(`${method} should not be called`);
      };
    }

    const logger = resolveLogger(target);
    logger.info({}, 'ready');
    logger.child({ component: 'agent' }).error({}, 'failed');

    assert.equal(target.records.length, 2);
  });
});
