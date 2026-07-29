import { readFile } from 'node:fs/promises';
import { resolveLogger } from '../support/logger.js';
import { createTraceFormatter } from './trace-writer.js';

export class Recording {
  constructor({ id, level, model, events, snapshots }) {
    this.id = id;
    this.level = level;
    this.model = model;
    this.events = events;
    this.snapshots = snapshots;
  }

  static async load(filePath, { logger } = {}) {
    const componentLogger = resolveLogger(logger).child({ component: 'recording' });
    const raw = await readFile(filePath, 'utf8');
    const events = [];
    const snapshots = [];
    let id;
    let level;
    let model;
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        componentLogger.warn({ filePath, line: i + 1 }, 'Skipping malformed line while loading a recording');
        continue;
      }
      if (rec.type === 'sessionStart') {
        id = rec.id;
        level = rec.level;
        model = rec.model;
      } else if (rec.type === 'turnSnapshot') {
        snapshots.push(rec);
      } else if (rec.type !== 'sessionEnd') {
        events.push(rec);
      }
    }
    return new Recording({ id, level, model, events, snapshots });
  }

  snapshotAt(turn) {
    const s = this.snapshots.find((x) => x.turn === turn);
    return s ? { messages: s.messages, usage: s.usage } : null;
  }

  responseAt(turn) {
    const r = this.events.find((e) => e.type === 'response' && e.turn === turn);
    return r ? r.raw : null;
  }

  requestAt(turn) {
    const r = this.events.find((e) => e.type === 'request' && e.turn === turn);
    return r ? r.payload : null;
  }

  toolResult(toolCallId) {
    const r = this.events.find((e) => e.type === 'toolEnd' && e.toolCallId === toolCallId);
    if (!r) return null;
    return r.error !== undefined ? { error: r.error } : { output: r.output };
  }

  renderTrace(opts = {}) {
    const fmt = createTraceFormatter(opts);
    let out = '';
    // Steer records carry no trace text.
    for (const rec of this.events) {
      if (rec.type === 'assistant') {
        out += fmt.step({ content: rec.content, reasoning: rec.reasoning });
      } else if (rec.type === 'toolCalls') {
        out += fmt.step({ toolCalls: rec.calls.map((c) => ({ function: { name: c.name } })) });
      } else if (rec.type === 'toolStart') {
        out += fmt.step({ toolStart: { toolCallId: rec.toolCallId, name: rec.name, input: rec.input } });
      } else if (rec.type === 'toolEnd') {
        out += fmt.step({
          toolEnd: {
            toolCallId: rec.toolCallId,
            name: rec.name,
            durationMs: rec.durationMs,
            output: rec.output,
            error: rec.error,
          },
        });
      }
    }
    out += fmt.flush();
    return out;
  }
}
