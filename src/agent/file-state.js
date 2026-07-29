// What the file tools know about the files this session has touched, keyed by
// resolved absolute path. `readFile` and `writeFile` record an entry; `editFile`
// refuses a file that has no entry, or one whose content changed since the entry
// was recorded, so an edit can never land on content the model has not seen.
//
// An entry is { hash, lastReadTurn, rangesRead, exactRangesRead, totalLines }.
// `rangesRead` are the merged line ranges an edit may touch, `exactRangesRead`
// the ranges as they were asked for, which is what a repeated read matches
// against before it answers from context instead of resending the lines.
export class FileState {
  #entries = new Map();

  get size() {
    return this.#entries.size;
  }

  get(filePath) {
    return this.#entries.get(filePath);
  }

  set(filePath, entry) {
    this.#entries.set(filePath, entry);
    return this;
  }

  has(filePath) {
    return this.#entries.has(filePath);
  }

  clear() {
    this.#entries.clear();
  }
}
