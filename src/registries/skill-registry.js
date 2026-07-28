import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveLogger } from '../support/logger.js';

const __dirname = import.meta.dirname || path.dirname(fileURLToPath(import.meta.url));

function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: content.trim() };
  const metadata = {};
  for (const line of match[1].split('\n')) {
    const colonIndex = line.indexOf(':');
    if (colonIndex === -1) continue;
    const key = line.slice(0, colonIndex).trim();
    let value = line.slice(colonIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
      value = value.slice(1, -1);
    metadata[key] = value;
  }
  return { metadata, body: (match[2] || '').trim() };
}

export class SkillRegistry {
  #forceRefresh = false;

  constructor({ logger, roots } = {}) {
    this.logger = resolveLogger(logger).child({ component: 'skillRegistry' });
    this.skills = new Map();
    this.pluginInstructions = [];
    this.loaded = false;
    this.roots = roots ?? [{ path: path.join(__dirname, '..', 'skills'), scope: 'builtin' }];
    this.pluginsDir = null;
  }

  async discover() {
    if (this.loaded && !this.#forceRefresh) return;
    this.loaded = true;
    this.#forceRefresh = false;
    this.skills.clear();
    this.pluginInstructions = [];
    for (const root of this.roots) await this.#discover(root.path, root.scope, root.plugin);
    if (this.pluginsDir) await this.#discoverPlugins(this.pluginsDir);
    this.logger.debug(
      { skillCount: this.skills.size, pluginInstructionCount: this.pluginInstructions.length },
      'Discovered skills',
    );
  }

  async #discoverPlugins(root) {
    let entries;
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const pluginDir = path.join(root, entry.name);
      await this.#discover(path.join(pluginDir, 'skills'), 'plugin', entry.name);
      await this.#readPluginInstructions(pluginDir, entry.name);
    }
  }

  async #readPluginInstructions(pluginDir, plugin) {
    try {
      const content = await fs.readFile(path.join(pluginDir, 'AGENTS.md'), 'utf8');
      if (content.trim()) this.pluginInstructions.push({ plugin, content: content.trim() });
    } catch {}
  }

  async #discover(directory, scope, plugin) {
    try {
      await fs.access(directory);
    } catch {
      return;
    }
    const entries = (await fs.readdir(directory, { recursive: true, withFileTypes: true })).filter(
      (entry) => entry.name === 'SKILL.md',
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
        this.logger.debug({ name, scope }, 'Loaded skill');
      } catch (error) {
        this.logger.error({ directory: entry.parentPath, error }, 'Failed to load skill');
      }
    }
  }

  getPluginInstructions() {
    return [...this.pluginInstructions];
  }
  get(name) {
    return this.skills.get(name) || null;
  }
  list() {
    let output = '';
    for (const [name, skill] of this.skills) output += `- **${name}**\n\n  ${skill.description}\n\n`;
    return output;
  }
  search(query) {
    const normalizedQuery = query.toLowerCase();
    const words = normalizedQuery.split(/\s+/);
    const results = [];
    for (const [name, skill] of this.skills) {
      const nameLower = name.toLowerCase();
      const descriptionLower = (skill.description || '').toLowerCase();
      const contentLower = (skill.content || '').toLowerCase();
      let score = nameLower === normalizedQuery ? 100 : nameLower.includes(normalizedQuery) ? 50 : 0;
      for (const word of words) if (descriptionLower.includes(word)) score += 10;
      for (const word of words) if (contentLower.includes(word)) score += 5;
      if (score > 0) results.push({ name, ...skill, score });
    }
    return results.sort((left, right) => right.score - left.score);
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
  configure({ pluginsDir } = {}) {
    if (pluginsDir !== undefined && (pluginsDir || null) !== this.pluginsDir) {
      this.pluginsDir = pluginsDir || null;
      this.reset();
    }
  }
  async _ensureDiscovered() {
    await this.discover();
  }
}
