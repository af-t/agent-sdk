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

  renderTrace(opts = {}) {
    const fmt = createTraceFormatter(opts);
    let out = '';
    // steer records carry no trace text
    for (const rec of this.events) {
      if (rec.type === 'assistant') {
        out += fmt.step({ content: rec.content, reasoning: rec.reasoning });
      } else if (rec.type === 'tool_calls') {
        out += fmt.step({ tool_calls: rec.calls.map((c) => ({ function: { name: c.name } })) });
      } else if (rec.type === 'tool_start') {
        out += fmt.step({ tool_start: { tool_call_id: rec.tool_call_id, name: rec.name, input: rec.input } });
      } else if (rec.type === 'tool_end') {
        out += fmt.step({
          tool_end: {
            tool_call_id: rec.tool_call_id,
            name: rec.name,
            duration_ms: rec.duration_ms,
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
