import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { createTraceFormatter } from './trace-writer.js';

export class Recording {
  constructor({ id, level, model, events, snapshots }) {
    this.id = id;
    this.level = level;
    this.model = model;
    this.events = events;
    this.snapshots = snapshots;
  }

  static async load(filePath) {
    const raw = await readFile(filePath, 'utf8');
    const events = [];
    const snapshots = [];
    let id;
    let level;
    let model;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        logger.warn(`Recording.load: skipping malformed line`);
        continue;
      }
      if (rec.type === 'session_start') {
        id = rec.id;
        level = rec.level;
        model = rec.model;
      } else if (rec.type === 'turn_snapshot') {
        snapshots.push(rec);
      } else if (rec.type !== 'session_end') {
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
    // steer records carry no trace text
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
