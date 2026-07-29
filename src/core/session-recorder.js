import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger.js';

const LEVELS = { events: 0, snapshots: 1, full: 2 };

function now() {
  return new Date().toISOString();
}

function sessionId() {
  const ts = now().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex').slice(0, 5);
  return `${ts}-${rand}`;
}

export function createSessionRecorder({ dir, level = 'snapshots', model, redact } = {}) {
  const lvl = LEVELS[level] ?? LEVELS.snapshots;
  fs.mkdirSync(dir, { recursive: true });
  const id = sessionId();
  const filePath = path.join(dir, `session-${id}.jsonl`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });

  let alive = true;
  let curTurn = 0;

  stream.on('error', (err) => {
    alive = false;
    logger.warn(`SessionRecorder stream error, disabling recording: ${err.message}`);
  });

  function write(obj) {
    if (!alive) return;
    let rec = obj;
    if (typeof redact === 'function') {
      try {
        rec = redact(obj);
      } catch (err) {
        logger.warn(`SessionRecorder redact threw, dropping record: ${err.message}`);
        return;
      }
      if (!rec) return; // redact dropped the record
    }
    try {
      stream.write(JSON.stringify(rec) + '\n');
    } catch (err) {
      logger.warn(`SessionRecorder write failed, disabling recording: ${err.message}`);
      alive = false;
    }
  }

  write({ t: now(), type: 'session_start', id, level, model });

  // assistant + toolCalls recorded from the run loop
  // so capture is identical in stream and non-stream modes
  function recordAssistant(turn, message) {
    if (!alive || !message) return;
    if (typeof turn === 'number') curTurn = turn;
    const content = typeof message.content === 'string' ? message.content : '';
    const reasoning = typeof message.reasoning === 'string' ? message.reasoning : '';
    if (content.trim() || reasoning.trim()) {
      write({ t: now(), type: 'assistant', turn: curTurn, content, reasoning });
    }
    if (message.tool_calls && message.tool_calls.length) {
      const calls = message.tool_calls.map((tc) => ({ id: tc.id, name: tc.function?.name || tc.name || '?' }));
      write({ t: now(), type: 'toolCalls', turn: curTurn, calls });
    }
  }

  // tool + steer events arrive via broadcast in both modes
  function record(event, turn) {
    if (!alive || !event || typeof event !== 'object') return;
    if (typeof turn === 'number') curTurn = turn;
    if (event.toolStart) {
      const { toolCallId, name, input } = event.toolStart;
      write({ t: now(), type: 'toolStart', turn: curTurn, toolCallId, name, input });
    }
    if (event.toolEnd) {
      const { toolCallId, name, durationMs, output, error } = event.toolEnd;
      const rec = { t: now(), type: 'toolEnd', turn: curTurn, toolCallId, name, durationMs };
      if (error !== undefined) rec.error = error;
      else rec.output = output;
      write(rec);
    }
    if (event.steerApplied) {
      write({ t: now(), type: 'steer', turn: curTurn, count: event.steerApplied.count });
    }
  }

  function request(turn, payload) {
    if (!alive || lvl < LEVELS.full) return;
    if (typeof turn === 'number') curTurn = turn;
    write({ t: now(), type: 'request', turn: curTurn, payload: structuredClone(payload) });
  }

  function response(turn, raw) {
    if (!alive || lvl < LEVELS.full) return;
    if (typeof turn === 'number') curTurn = turn;
    write({ t: now(), type: 'response', turn: curTurn, raw: structuredClone(raw) });
  }

  function snapshot(turn, messages, usage) {
    if (!alive || lvl < LEVELS.snapshots) return;
    if (typeof turn === 'number') curTurn = turn;
    write({ t: now(), type: 'turn_snapshot', turn, messages: structuredClone(messages), usage: { ...usage } });
  }

  function close() {
    write({ t: now(), type: 'session_end', reason: 'closed' });
    alive = false;
    return new Promise((resolve) => stream.end(resolve));
  }

  return { path: filePath, record, recordAssistant, request, response, snapshot, close };
}
