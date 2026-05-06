import logger from './logger.js';
import fs from 'node:fs/promises';
import { getDirname } from './dirname.js';
import path from 'node:path';
import os from 'node:os';

const __dirname = getDirname(import.meta);

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: content.trim() };

  const raw = match[1];
  const body = (match[2] || '').trim();
  const metadata = {};

  for (const line of raw.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    metadata[key] = value;
  }

  return { metadata, body };
}

class SkillRegistry {
  constructor(options = {}) {
    this.skills = new Map();
    this.loaded = false;
    this.extraSearchDirs = options.extraSearchDirs || [];
    this._forceRefresh = false;
  }

  async discover() {
    if (this.loaded && !this._forceRefresh) return;
    this.loaded = true;
    this._forceRefresh = false;
    this.skills.clear();

    const searchPaths = [
      { dir: path.join(__dirname, '..', 'skills'), scope: 'builtin' }
    ];

    // Default directories for common AI tool config folders (configurable)
    const defaultAgentDirs = ['claude', 'hermes', 'gemini', 'kilo', 'pi'];
    for (const x of defaultAgentDirs) {
      searchPaths.push({ dir: path.join(process.cwd(), `.${x}`, 'skills'), scope: 'project' });
      searchPaths.push({ dir: path.join(os.homedir(), `.${x}`, 'skills'), scope: 'user' });
    }

    // Extra user-configured search directories
    for (const extraDir of this.extraSearchDirs) {
      searchPaths.push({ dir: extraDir, scope: 'extra' });
    }

    for (const { dir, scope } of searchPaths) {
      await this._discover(dir, scope);
    }

    logger.debug(`SkillRegistry: discovered ${this.skills.size} skills`);
  }

  async _discover(dir, scope) {
    try {
      await fs.access(dir);
    } catch {
      /* directory doesn't exist — skip */
      return;
    }

    const entries = (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter(x => x.name === 'SKILL.md');
    for (const entry of entries) {
      const fullPath = path.join(entry.parentPath, entry.name);
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const { metadata, body } = parseFrontmatter(raw);
        const name = metadata.name;

        delete metadata.name;

        this.skills.set(name, {
          ...metadata,
          path: path.relative(process.cwd(), fullPath),
          parent: path.relative(process.cwd(), entry.parentPath),
          scope,
          content: body,
          raw
        });

        logger.debug(`SkillRegistry: loaded "${name}" (${scope})`);
      } catch (err) {
        logger.error(`SkillRegistry: failed to load from ${entry.parentPath}:`, err.message);
      }
    }
  }

  list() {
    let string = '';
    for (const [key, val] of this.skills) {
      string += `- **${key}**\n\n`;
      string += `  ${val.description}\n\n`;
    }
    return string;
  }

  get(name) {
    return this.skills.get(name) || null;
  }

  search(query) {
    const q = query.toLowerCase();
    const results = [];

    for (const [name, skill] of this.skills) {
      let score = 0;
      const nameLower = name.toLowerCase();
      const descLower = (skill.description || '').toLowerCase();
      const contentLower = (skill.content || '').toLowerCase();

      if (nameLower === q) {
        score += 100;
      } else if (nameLower.includes(q)) {
        score += 50;
      }

      const descWords = descLower.split(/\s+/);
      const qWords = q.split(/\s+/);
      for (const qw of qWords) {
        if (descLower.includes(qw)) score += 10;
      }
      for (const qw of qWords) {
        if (contentLower.includes(qw)) score += 5;
      }

      if (score > 0) {
        results.push({ name, ...skill, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results;
  }

  refresh() {
    this._forceRefresh = true;
    return this.discover();
  }

  reset() {
    this.skills.clear();
    this.loaded = false;
    this._forceRefresh = false;
  }
}

const registry = new SkillRegistry();
// Lazy initialization — first access triggers discovery
let _discoveryPromise = null;

export default {
  configure(options = {}) {
    if (options.extraSearchDirs) {
      registry.extraSearchDirs = options.extraSearchDirs;
    }
  },
  async _ensureDiscovered() {
    if (!_discoveryPromise) {
      _discoveryPromise = registry.discover();
    }
    await _discoveryPromise;
  },
  get skills() { return registry.skills; },
  get loaded() { return registry.loaded; },
  list() { return registry.list(); },
  get(name) { return registry.get(name); },
  search(query) { return registry.search(query); },
  refresh() { return registry.refresh(); },
  reset() { registry.reset(); },
};
