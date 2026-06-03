import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger.js';

const LEVELS = { events: 0, snapshots: 1, full: 2 }; // full reserved for phase 2

function now() {
  return new Date().toISOString();
}

function sessionId() {
  const ts = now().replace(/[:.]/g, '-');
  const rand = crypto.randomBytes(3).toString('hex').slice(0, 5);
  return `${ts}-${rand}`;
}

export function createSessionRecorder({ dir, level = 'snapshots', model } = {}) {
  const lvl = LEVELS[level] ?? LEVELS.snapshots;
  fs.mkdirSync(dir, { recursive: true });
  const id = sessionId();
  const filePath = path.join(dir, `session-${id}.jsonl`);
  const stream = fs.createWriteStream(filePath, { flags: 'a' });

  let alive = true;
  let lastReasoning = '';
  let lastContent = '';
  let curTurn = 0;

  // catch async stream errors
  stream.on('error', (err) => {
    alive = false;
    logger.warn(`SessionRecorder stream error, disabling recording: ${err.message}`);
  });

  function write(obj) {
    if (!alive) return;
    try {
      stream.write(JSON.stringify(obj) + '\n');
    } catch (err) {
      logger.warn(`SessionRecorder write failed, disabling recording: ${err.message}`);
      alive = false;
    }
  }

  function flushAssistant(turn) {
    if (!lastReasoning.trim() && !lastContent.trim()) return;
    write({ t: now(), type: 'assistant', turn, content: lastContent, reasoning: lastReasoning });
    lastReasoning = '';
    lastContent = '';
  }

  write({ t: now(), type: 'session_start', id, level, model });

  function record(event, turn) {
    if (!alive || !event || typeof event !== 'object') return;
    if (typeof turn === 'number') curTurn = turn;
    if (typeof event.reasoning === 'string') lastReasoning = event.reasoning;
    if (typeof event.content === 'string') lastContent = event.content;

    if (event.tool_calls) {
      flushAssistant(curTurn);
      const calls = event.tool_calls.map((tc) => ({ id: tc.id, name: tc.function?.name || tc.name || '?' }));
      write({ t: now(), type: 'tool_calls', turn: curTurn, calls });
    }
    if (event.tool_start) {
      const { tool_call_id, name, input } = event.tool_start;
      write({ t: now(), type: 'tool_start', turn: curTurn, tool_call_id, name, input });
    }
    if (event.tool_end) {
      const { tool_call_id, name, duration_ms, output, error } = event.tool_end;
      const rec = { t: now(), type: 'tool_end', turn: curTurn, tool_call_id, name, duration_ms };
      if (error !== undefined) rec.error = error;
      else rec.output = output;
      write(rec);
    }
    if (event.steer_applied) {
      write({ t: now(), type: 'steer', turn: curTurn, count: event.steer_applied.count });
    }
  }

  function snapshot(turn, messages, usage) {
    if (!alive || lvl < LEVELS.snapshots) return;
    if (typeof turn === 'number') curTurn = turn;
    flushAssistant(turn);
    write({ t: now(), type: 'turn_snapshot', turn, messages: structuredClone(messages), usage: { ...usage } });
  }

  function close() {
    flushAssistant(curTurn);
    write({ t: now(), type: 'session_end', reason: 'closed' });
    alive = false;
    return new Promise((resolve) => stream.end(resolve));
  }

  return { path: filePath, record, snapshot, close };
}
