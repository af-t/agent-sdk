import logger from '../core/logger.js';
import fs from 'node:fs/promises';
import { getDirname } from '../core/utils.js';
import path from 'node:path';

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
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    metadata[key] = value;
  }

  return { metadata, body };
}

export class SkillRegistry {
  #forceRefresh = false;

  constructor(options = {}) {
    this.skills = new Map();
    this.pluginInstructions = [];
    this.loaded = false;
    this.pluginsDir = options.pluginsDir || null;
  }

  async discover() {
    if (this.loaded && !this.#forceRefresh) return;
    this.loaded = true;
    this.#forceRefresh = false;
    this.skills.clear();
    this.pluginInstructions = [];

    // Builtin skills are the only internal source
    await this.#discover(path.join(__dirname, '..', 'skills'), 'builtin');

    // Plugins are the only external source
    if (this.pluginsDir) {
      await this.#discoverPlugins(this.pluginsDir);
    }

    logger.debug(
      `SkillRegistry: discovered ${this.skills.size} skills, ${this.pluginInstructions.length} plugin instructions`,
    );
  }

  async #discoverPlugins(root) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      // plugins root missing — skip
      return;
    }

    const pluginNames = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    for (const name of pluginNames) {
      const pluginDir = path.join(root, name);
      await this.#discover(path.join(pluginDir, 'skills'), 'plugin', name);
      await this.#readPluginInstructions(pluginDir, name);
    }
  }

  async #readPluginInstructions(pluginDir, name) {
    try {
      const content = await fs.readFile(path.join(pluginDir, 'AGENTS.md'), 'utf8');
      if (content.trim()) {
        this.pluginInstructions.push({ plugin: name, content: content.trim() });
      }
    } catch {
      // no AGENTS.md — skip
    }
  }

  async #discover(dir, scope, plugin) {
    try {
      await fs.access(dir);
    } catch {
      // directory doesn't exist — skip
      return;
    }

    const entries = (await fs.readdir(dir, { recursive: true, withFileTypes: true })).filter(
      (x) => x.name === 'SKILL.md',
    );
    for (const entry of entries) {
      const fullPath = path.join(entry.parentPath, entry.name);
      try {
        const raw = await fs.readFile(fullPath, 'utf8');
        const { metadata, body } = parseFrontmatter(raw);
        const name = metadata.name;

        delete metadata.name;

        this.skills.set(name, {
          ...metadata,
          ...(plugin ? { plugin } : {}),
          path: path.relative(process.cwd(), fullPath),
          parent: path.relative(process.cwd(), entry.parentPath),
          scope,
          content: body,
          raw,
        });

        logger.debug(`SkillRegistry: loaded "${name}" (${scope})`);
      } catch (err) {
        logger.error(`SkillRegistry: failed to load from ${entry.parentPath}:`, err.message);
      }
    }
  }

  getPluginInstructions() {
    return [...this.pluginInstructions];
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
    this.#forceRefresh = true;
    return this.discover();
  }

  reset() {
    this.skills.clear();
    this.pluginInstructions = [];
    this.loaded = false;
    this.#forceRefresh = false;
  }
}

// Singleton instance
const registry = new SkillRegistry();
let _discoveryPromise = null;

export default {
  configure(options = {}) {
    if (options.pluginsDir !== undefined && (options.pluginsDir || null) !== registry.pluginsDir) {
      registry.pluginsDir = options.pluginsDir || null;
      registry.reset();
      // invalidate cached discovery so the next _ensureDiscovered re-scans
      _discoveryPromise = null;
    }
  },
  async _ensureDiscovered() {
    if (!_discoveryPromise) {
      _discoveryPromise = registry.discover();
    }
    await _discoveryPromise;
  },
  getPluginInstructions() {
    return registry.getPluginInstructions();
  },
  get skills() {
    return registry.skills;
  },
  get loaded() {
    return registry.loaded;
  },
  list() {
    return registry.list();
  },
  get(name) {
    return registry.get(name);
  },
  search(query) {
    return registry.search(query);
  },
  refresh() {
    return registry.refresh();
  },
  reset() {
    registry.reset();
    _discoveryPromise = null;
  },
};
