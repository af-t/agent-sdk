# TODO — OpenRouter Agent SDK Remediation Plan

> **Based on:** [ISSUES.md](./ISSUES.md) — 73 verified issues across 8 categories.
>
> **Target:** v2.0.0 — production-ready SDK.
>
> Tasks are ordered by priority. Each references the source file, line numbers, and a concrete fix.

### Legend

| Marker | Meaning |
|--------|---------|
| `[x]` | Done — implemented and verified |
| `[ ]` | Pending — not yet started |
| `[-]` | Skipped / Low priority — intentional decision, see item notes |

---

## 📋 Phase 0 — Critical Bug Hotfixes (DO FIRST)

These are confirmed functional bugs that silently produce wrong results. Fix them before anything else.

### [x] P0.1 — Fix `diff()` exit code handling — `src/tools/file/edit.js:7-17`

**Bug:** `diff` returns code 1 when files *differ* (the desired case), but the code treats *any* non-zero as error. The entire diff feature has never worked.

```diff
// BEFORE — edit.js lines 14-17
-   child.stderr.on('data', chunk => stderr.push(chunk));
-   child.on('error', (err) => reject(Buffer.concat(stderr).toString()));
-   child.on('exit', (code) => {
-     if (code) { reject(Buffer.concat(stderr).toString()); return; }
-     resolve(Buffer.concat(stdout).toString());
-   });

// AFTER — edit.js
+   child.stderr.on('data', chunk => stderr.push(chunk));
+   child.on('error', (err) => reject(err));
+   child.on('exit', (code) => {
+     // diff exit codes: 0=identical, 1=different, 2=trouble
+     if (code > 1) {
+       reject(new Error(`diff failed with code ${code}: ${Buffer.concat(stderr).toString()}`));
+       return;
+     }
+     resolve(Buffer.concat(stdout).toString());
+   });
```

**Also fixes:** BUG-2 (stderr event `'error'` → `'data'`), REL-2 for Edit tool.

---

### [x] P0.2 — Fix `usage.tokens` accumulation — `src/core/agent.js:135`

**Bug:** `=` overwrites instead of accumulating. Cost uses `+=`, tokens must too.

```diff
-   this.usage.tokens = (response.usage?.total_tokens || 0);
+   this.usage.tokens += (response.usage?.total_tokens || 0);
```

---

### [x] P0.3 — Fix `Skill` tool missing `await` — `src/tools/system/skill.js:30,48`

**Bug:** `execute()` returns a Promise, but `lists` is used as a string → output shows `[object Promise]`.

```diff
// Line 30
-   const lists = execute({ action: 'list' });
+   const lists = await execute({ action: 'list' });

// Line 48
-   const lists = execute({ action: 'list' });
+   const lists = await execute({ action: 'list' });
```

---

### [x] P0.4 — Fix MCP timeout using wrong variable — `src/core/mcp.js:63-73`

**Bug:** `setTimeout(..., timeout)` uses the raw parameter (which may be `undefined` = instant timeout). `effectiveTimeout` is computed but ignored.

```diff
  async request(method, params, timeout) {
    const effectiveTimeout = timeout || this.defaultTimeout;
    ...
    const timer = setTimeout(() => {
      this.pendingRequests.delete(id);
-     reject(new Error(`Request ${method} timed out after ${timeout}ms`));
-   }, timeout);
+     reject(new Error(`Request ${method} timed out after ${effectiveTimeout}ms`));
+   }, effectiveTimeout);
```

---

### [x] P0.5 — Wrap `JSON.parse()` tool arguments in try-catch — `src/core/agent.js:187`

**Bug:** Malformed JSON from the LLM crashes the entire agent run.

```diff
-   const input = JSON.parse(tc.function.arguments);
+   let input;
+   try {
+     input = JSON.parse(tc.function.arguments);
+   } catch (parseErr) {
+     logger.warn(`Agent: failed to parse tool arguments for "${tc.function.name}": ${parseErr.message}`);
+     this.messages.push({
+       role: 'tool',
+       content: `Error: invalid JSON arguments — ${parseErr.message}`,
+       tool_call_id: tc.id
+     });
+     continue;
+   }
```

---

## 📋 Phase 1 — Security Hardening

### [x] P1.1 — Add `ensureSafePath()` to `Read` tool — `src/tools/file/read.js`

```diff
  import { spawn } from 'node:child_process';
  import path from 'node:path';
+ import { ensureSafePath } from '../../core/utils.js';

  export const execute = async ({ path: filePath, ... }) => {
    return new Promise((resolve) => {
-     const fullPath = path.resolve(filePath);
+     const fullPath = ensureSafePath(filePath);
      const cat = spawn('cat', ['-n', fullPath]);
```

Also: replace `spawn('cat', ...)` with `fs.readFile` for portability (see P4.1).

---

### [x] P1.2 — Call `ensureSafePath()` in `Write` tool — `src/tools/file/write.js:16-20`

**Current:** `ensureSafePath` is imported but dead code.

```diff
  export const execute = async ({ path: filePath, content }) => {
    try {
-     const fullPath = path.resolve(filePath);
+     const fullPath = ensureSafePath(filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
```

---

### [x] P1.3 — Hardening `ensureSafePath()` against TOCTOU & encoding bypass — `src/core/utils.js:59-68`

```diff
  export function ensureSafePath(filePath) {
+   // Reject null bytes and URL-encoded traversal
+   if (filePath.includes('\0') || /%2e%2e|%2f|%5c/i.test(filePath)) {
+     throw new Error(`Access denied: Path contains suspicious characters`);
+   }
    const root = path.resolve(process.cwd());
    const resolvedPath = path.resolve(filePath);
    const relative = path.relative(root, resolvedPath);

-   if (relative.startsWith('..') || path.isAbsolute(relative)) {
+   if (relative.startsWith('..') || path.isAbsolute(relative) || !relative) {
      throw new Error(`Access denied: Path '${filePath}' is outside project root`);
    }
+   // Resolve symlinks to prevent TOCTOU
+   try {
+     return fs.realpathSync(resolvedPath);
+   } catch {
+     // Path doesn't exist yet (valid for Write); use resolvedPath
+     // But still check that the directory prefix is safe
+     const dir = path.dirname(resolvedPath);
+     const safeDir = fs.realpathSync(dir);
+     const safeRelative = path.relative(root, safeDir);
+     if (safeRelative.startsWith('..') || path.isAbsolute(safeRelative)) {
+       throw new Error(`Access denied: Path '${filePath}' resolves outside project root`);
+     }
+     return resolvedPath;
+   }
  }
```

> Requires adding `import fs from 'node:fs'` at top of utils.js (already using `node:fs/promises` — use sync variant here or restructure).

---

### [x] P1.4 — Replace predictable temp file names — `src/tools/file/edit.js:38`

```diff
+ import crypto from 'node:crypto';
  ...
- const temp = path.join(os.tmpdir(), `temp${Date.now() + Math.floor(Math.random() * 1000)}`);
+ const temp = path.join(os.tmpdir(), `.openrouter-edit-${crypto.randomUUID()}`);
```

---

### [x] P1.5 — Sanitize environment passed to Bash tool — `src/tools/system/bash.js:24`

```diff
+ // Whitelist of safe environment variables to pass
+ const SAFE_ENV_KEYS = ['HOME', 'USER', 'PATH', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
+   'PWD', 'OLDPWD', 'NODE_PATH', 'TMPDIR'];

  export const execute = async ({ command, cwd = process.cwd(), env = process.env, ... }) => {
+   // Build a sanitized env — exclude API keys and secrets
+   const safeEnv = {};
+   for (const key of SAFE_ENV_KEYS) {
+     if (key in env) safeEnv[key] = env[key];
+   }
+   // Allow explicit user overrides via the env parameter
+   Object.assign(safeEnv, env !== process.env ? env : {});
```

> **Alternative:** Keep `process.env` as default but add a `config.js` option `BASH_STRIP_SECRETS=true` that redacts `*_API_KEY`, `*_TOKEN`, `*_SECRET`, `OPENROUTER_*`, `TAVILY_*` patterns.

---

### [x] P1.6 — Sanitize environment passed to MCP client — `src/core/mcp.js:21-23`

```diff
+ import { stripSecrets } from './utils.js';  // new utility
  ...
  this.process = spawn(this.config.command, this.config.args || [], {
-   env: { ...process.env, ...(this.config.env || {}) },
+   env: { ...stripSecrets(process.env), ...(this.config.env || {}) },
    stdio: ['pipe', 'pipe', 'pipe']
  });
```

---

### [x] P1.7 — Revamp Bash dangerous command detection — `src/tools/system/bash.js:4-9`

Replace 4 naive regexes with a structured whitelist/blacklist approach:

```diff
- const DANGEROUS_PATTERNS = [
-   /\brm\s+-rf\s+\//,
-   /\bdd\s+if=/,
-   /\bmkfs\./,
-   /\b>:.*\/dev\//,
- ];
+ // Blocklist: commands/patterns that should never run
+ const BLOCKED_COMMANDS = [
+   'rm -rf /', 'rm -rf /*', 'rm -rf ~', 'rm -rf .*',
+   'dd if=', 'mkfs', 'mkswap',
+   ':(){ :|:& };:',  // fork bomb
+   'chmod 777 /', 'chmod -R 777 /',
+   '> /dev/sda', '> /dev/hda',
+   'shutdown', 'reboot', 'poweroff', 'halt', 'init 0', 'init 6',
+   'wget -O - | sh', 'curl | sh', 'curl | bash',
+ ];
+
+ function isBlocked(command) {
+   const normalized = command.replace(/\s+/g, ' ').toLowerCase();
+   for (const blocked of BLOCKED_COMMANDS) {
+     if (normalized.includes(blocked)) return blocked;
+   }
+   // Detect eval/exec/source on suspicious targets
+   if (/\b(eval|exec|source)\s+.*(\/etc\/|\.ssh|\.env)/.test(normalized)) {
+     return 'eval/exec/source on sensitive path';
+   }
+   return null;
+ }
```

---

### [x] P1.8 — Encapsulate API key — `src/core/agent.js:28`

Store as a private field to prevent serialization leakage:

```diff
+   #apiKey;
    ...
    constructor(options) {
-     this.apiKey = apiKey;
+     this.#apiKey = apiKey || config.API_KEY;
    }
    ...
    _request(payload) {
-     'Authorization': `Bearer ${this.apiKey}`,
+     'Authorization': `Bearer ${this.#apiKey}`,
```

Update `delegate.js:19` to use a getter or internal method instead of `agent.apiKey`.

---

### [x] P1.9 — Redact secrets from logger — `src/core/logger.js`

```diff
+ const SECRET_PATTERNS = [
+   /sk-(?:or|ant)-[a-zA-Z0-9_-]+/g,
+   /Bearer\s+[a-zA-Z0-9_-]+/g,
+   /tvly-[a-zA-Z0-9_-]+/g,
+ ];
+
+ function redact(msg) {
+   let s = typeof msg === 'string' ? msg : JSON.stringify(msg);
+   for (const re of SECRET_PATTERNS) {
+     s = s.replace(re, '***REDACTED***');
+   }
+   return s;
+ }

  export const logger = {
    error: (msg, ...args) => {
-     console.error(`${prefix(colors.red)} ${msg}`, ...args);
+     console.error(`${prefix(colors.red)} ${redact(msg)}`, ...args.map(redact));
    },
    // ... same for warn, debug, info
  };
```

---

## 📋 Phase 2 — Reliability & Error Handling

### [x] P2.1 — Fill empty catch blocks with logging — 5 locations

| File | Line | Current | Fix |
|------|------|---------|-----|
| `utils.js` | 218 | `catch {}` | `catch (err) { logger.debug('isDirectory stat failed:', err.message); }` |
| `list.js` | 50 | `catch {}` | `catch { suffix = ''; }` _(size is optional, just skip silently is ok—add comment)_ |
| `agent.js` | 40 | `catch {}` | `catch { logger.debug('No RULE.md found, using default instruction.'); }` _(already has logger.debug above? Double-check: line 41 has it. OK but the catch is empty.)_ → Remove empty catch, the logger.debug on 41 is inside try. Move to catch. |
| `skill.js` | 71 | `catch {}` | `catch { /* directory doesn't exist — skip */ }` _(add comment)_ |
| `mcp.js` | 207 | `catch (err) {}` | `catch (err) { logger.warn('MCP client close failed:', err.message); }` |

**For `agent.js:38-42`:**
```diff
    try {
      base = fs.readFileSync(path.join(__dirname, '..', '..', 'RULE.md'), 'utf8');
-   } catch {
-     logger.debug('No RULE.md found, using default instruction.');
-   }
+   } catch (err) {
+     logger.debug('No RULE.md found, using default instruction.');
+   }
```
> Actually the `catch` already spans lines 40-42—the block has the debug log. Verified not empty. Still, make it `catch (err)` for clarity.

---

### [x] P2.2 — Standardize tool error handling — All tools under `src/tools/`

**Problem:** Tools return `"ERROR: ..."` strings. Agent treats them as successful results.

**Solution:** Keep returning error text (LLM needs to see it) but **prefix with a machine-parseable marker** so the agent loop can detect failures programmatically:

```diff
// In every tool catch block, change:
- return `ERROR: ${error.message}`;
+ return `__TOOL_ERROR__: ${error.message}`;
```

Then in `agent.js:190-196`:
```diff
    const result = await this.tools.execute(name, input, { agent: this });
+   const isError = typeof result === 'string' && result.startsWith('__TOOL_ERROR__');
    this.messages.push({
      role: 'tool',
-     content: (typeof result === 'string') ? result : JSON.stringify(result),
+     content: (typeof result === 'string') ? result : JSON.stringify(result),
+     ...(isError ? { is_error: true } : {}),
      tool_call_id: tc.id
    });
```

> **Actually BETTER:** Just have tools **throw** on errors, and catch in the agent loop. That's the proper pattern. See P2.2b.

### [x] P2.2b — (Preferred) Have tools throw errors, catch in agent loop

```diff
// agent.js:189-196
    logger.debug('Agent: Executing tool:', name);
+   try {
      const result = await this.tools.execute(name, input, { agent: this });
+   } catch (toolErr) {
+     logger.warn(`Tool ${name} failed: ${toolErr.message}`);
+     this.messages.push({
+       role: 'tool',
+       content: `Error: ${toolErr.message}`,
+       tool_call_id: tc.id
+     });
+     continue;
+   }
```

Then fix each tool to `throw new Error(...)` instead of `return 'ERROR: ...'`. This affects: `write.js`, `edit.js`, `find.js`, `list.js`, `bash.js`, `fetch.js`, `search.js`, `delegate.js`.

---

### [x] P2.3 — Add timeout to `_request()` — `src/core/agent.js:59-67`

```diff
+ const REQUEST_TIMEOUT = 120_000; // 2 minutes

  async _request(payload) {
+   const controller = new AbortController();
+   const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
+   try {
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
-       body: JSON.stringify({ ...payload, stream: false })
+       body: JSON.stringify({ ...payload, stream: false }),
+       signal: controller.signal
      });
+   } finally {
+     clearTimeout(timer);
+   }
```

---

### [x] P2.4 — Add max loop iteration guard — `src/core/agent.js:180`

```diff
+ const DEFAULT_MAX_TOOL_LOOPS = 25;
+ let loopCount = 0;

  constructor(options) {
    ...
+   // Max tool loop iterations before forcing a break.
+   // Set to 0 for unlimited (used by subagents via Delegate).
+   this.maxToolLoops = options.maxToolLoops ?? DEFAULT_MAX_TOOL_LOOPS;
  }

  async run(prompt, notify, options) {
    ...
    let loopCount = 0;

    while (true) {
+     if (this.maxToolLoops > 0 && ++loopCount > this.maxToolLoops) {
+       logger.warn(`Agent: max tool loop iterations reached (${this.maxToolLoops}), forcing break.`);
+       break;
+     }
      ...
```

> **NOTE — Delegate conflict:** `MAX_TOOL_LOOPS` as a static constant breaks the Delegate tool. Since Delegate creates a subagent from the same `Agent` class, the subagent also inherits the same loop limit. Complex delegated tasks that need >25 tool iterations will hit the limit mid-work, and since the loop break returns `this.messages[this.messages.length - 1].content` (which is typically a raw tool result, not an LLM summary), the parent agent receives garbled output.
>
> **Fix:** `maxToolLoops` is now an instance-level option (default 25). Subagents created via Delegate receive `maxToolLoops: 1000` to avoid premature termination. Set to `0` for unlimited iterations.
>
> Affected files: `agent.js:41,193`, `delegate.js:38`.

---

### [x] P2.5 — Improve empty `choices` handling — `src/core/agent.js:171-172`

```diff
    const message = response.choices?.[0]?.message;
-   if (!message) break;
+   if (!message) {
+     logger.warn('Agent: LLM returned no message in response. Breaking loop.');
+     break;
+   }
```

---

### [x] P2.6 — Log MCP parse failures — `src/core/mcp.js:168-173`

```diff
  _parseMessage(line) {
    try {
      return JSON.parse(line.trim());
    } catch (e) {
+     logger.debug('MCP: failed to parse message line:', line.slice(0, 200));
      return null;
    }
  }
```

---

### [x] P2.7 — Add circuit breaker to `withRetry()` — `src/core/utils.js:78-97`

```diff
  export async function withRetry(func, count = config.MAX_RETRIES, callback) {
    let delay = CONSTANTS.RETRY_BASE_DELAY;
    let lastError;
+   const NON_RETRYABLE = [401, 403, 400, 404];
+   const MAX_DELAY = 60_000; // 1 minute cap

    for (let i = 0; i < count; i++) {
      try {
        const res = await func();
        return res;
      } catch (err) {
+       // Do not retry client errors (4xx except 429)
+       if (err?.status && NON_RETRYABLE.includes(err.status)) {
+         throw err;
+       }
        const jitter = delay * (0.8 + Math.random() * 0.4);
+       await new Promise(resolve => setTimeout(resolve, Math.min(jitter, MAX_DELAY)));
-       await new Promise(resolve => setTimeout(resolve, jitter));
        lastError = err;
-       delay *= CONSTANTS.RETRY_BACKOFF_FACTOR;
+       delay = Math.min(delay * CONSTANTS.RETRY_BACKOFF_FACTOR, MAX_DELAY);
      }
    }
    ...
```

---

### [x] P2.8 — Await notify callback — `src/core/agent.js:175`

```diff
-   notify({ content, reasoning, tool_calls });
+   try {
+     await notify({ content, reasoning, tool_calls });
+   } catch (err) {
+     logger.debug('Notify callback error:', err.message);
+   }
```

---

### [-] P2.9 — Make `RULE.md` loading async — `src/core/agent.js:36-56`

> **Low priority.** The sync `fs.readFileSync` for RULE.md runs once at agent construction (~1ms for a small file). Converting to lazy async init adds complexity (tracking ready state, awaiting in hot path) for negligible startup improvement. Revisit if RULE.md grows to 100KB+.

```diff
-   this.systemPrompt = systemPrompt || (() => {
-     let base = 'You are an interactive agent...';
-     try {
-       base = fs.readFileSync(path.join(__dirname, '..', '..', 'RULE.md'), 'utf8');
-     } catch { ... }
-     ...
-     return base + envInfo.join('\n');
-   })();
+   this._customSystemPrompt = systemPrompt || null;
+   this._systemPromptReady = false;
```

Move the sync `fs.readFileSync` + envInfo building to a lazy async init in `_send()`:
```js
  async _ensureSystemPrompt() {
    if (this._systemPromptReady) return;
    if (this._customSystemPrompt) {
      this.systemPrompt = this._customSystemPrompt;
    } else {
      try {
        const base = await fs.readFile(path.join(__dirname, '..', '..', 'RULE.md'), 'utf8');
        this.systemPrompt = base + envInfo.join('\n');
      } catch {
        this.systemPrompt = 'You are an interactive agent...' + envInfo.join('\n');
      }
    }
    this._systemPromptReady = true;
  }
```

> Requires changing `fs` import from `node:fs` to `node:fs/promises`.

---

## 📋 Phase 3 — Architecture Refactor

### [x] P3.1 — Rename package to avoid OpenRouter brand conflict — `package.json:2`

```diff
- "name": "openrouter",
+ "name": "@af-t/openrouter-agent-sdk",
```

> Also update README imports accordingly.

---

### [-] P3.2 — Add provider abstraction layer — New file `src/core/providers/`

Create an interface that `Agent` uses instead of hardcoded OpenRouter URLs:

```
src/core/providers/
├── openrouter.js     # Current implementation moved here
├── openai.js         # New: direct OpenAI API
└── anthropic.js      # New: direct Anthropic API
```

Each provider exports:
```js
export const name = 'openrouter';
export const chatEndpoint = 'https://openrouter.ai/api/v1/chat/completions';
export function buildHeaders(apiKey) { ... }
export function buildPayload(agent) { ... }
export function parseResponse(raw) { ... }
```

Agent constructor accepts `provider` (defaults to `'openrouter'`), `_request()` delegates to the provider module.

---

### [-] P3.3 — Split Agent class — `src/core/`

```
src/core/
├── agent.js           # Agent class — orchestrator only (~60 lines)
├── message-manager.js # Message history, cache_control logic
├── prompt-builder.js  # System prompt construction
├── api-client.js      # HTTP request to LLM (using provider)
├── tool-loop.js       # Tool execution loop logic
├── usage-tracker.js   # Cost & token tracking
```

Agent becomes a thin coordinator:
```js
class Agent {
  constructor(opts) {
    this.messages = new MessageManager();
    this.prompt = new PromptBuilder(opts);
    this.api = new ApiClient(opts.provider, opts.apiKey);
    this.loop = new ToolLoop(opts.tools);
    this.usage = new UsageTracker();
  }
  async run(prompt, notify, opts) {
    this.messages.addUser(prompt);
    return this.loop.execute({
      messages: this.messages,
      prompt: this.prompt,
      api: this.api,
      usage: this.usage,
      notify,
      signal: opts?.signal
    });
  }
}
```

---

### [x] P3.4 — Extract `import.meta.dirname` fallback to shared utility — `src/core/dirname.js`

```js
// src/core/dirname.js
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export function getDirname(importMeta) {
  return importMeta.dirname || path.dirname(fileURLToPath(importMeta.url));
}
```

Replace duplicated pattern in `agent.js`, `index.js`, `skill.js`.

---

### [x] P3.5 — Add `unregister()` and `clear()` to ToolRegistry — `src/core/utils.js:99-133`

```diff
  register({ name, description, input_schema, execute }) {
    if (typeof execute !== 'function') throw Error('Tool must have an execute function');
    this._tools.set(name, { description, input_schema, execute });
  }

+ unregister(name) {
+   return this._tools.delete(name);
+ }
+
+ clear() {
+   this._tools.clear();
+   this._mcpClients = [];
+ }
```

---

### [x] P3.6 — Add `refresh()` / `reset()` to SkillRegistry — `src/core/skill.js`

```diff
  async discover() {
-   if (this.loaded) return;
-   this.loaded = true;
+   if (this.loaded && !this._forceRefresh) return;
+   this.loaded = true;
+   this._forceRefresh = false;
    this.skills.clear();
    ...
  }

+ refresh() {
+   this._forceRefresh = true;
+   return this.discover();
+ }
+
+ reset() {
+   this.skills.clear();
+   this.loaded = false;
+   this._forceRefresh = false;
+ }
```

Expose through the exported singleton wrapper.

---

### [x] P3.7 — Limit Delegate recursion depth — `src/tools/system/delegate.js:17-24`

**Approach:** Depth check only (the tool filtering approach was removed — see note below).

```diff
  export const execute = async ({ description, prompt, persona, context_files }, { agent }) => {
+   const depth = (agent._delegateDepth || 0) + 1;
+   const MAX_DELEGATE_DEPTH = 3;
+   if (depth > MAX_DELEGATE_DEPTH) {
+     throw new Error(`Delegate depth limit reached (${MAX_DELEGATE_DEPTH}). Cannot nest deeper.`);
+   }
+
    const subagent = new Agent({
+     tools: agent.tools,  // inherit all tools — subagents CAN use Delegate (within depth limit)
      ...
    });
+   subagent._delegateDepth = depth;
```

> **Why NOT filter out the Delegate tool:** A depth limit already prevents unbounded recursion.
> If Delegate is removed from subagent tools, depth becomes meaningless — subagents can never
> delegate regardless of remaining depth. This wastes the 3-level capacity and defeats use cases
> that genuinely need nested delegation (e.g., parent delegates research, child delegates sub-topic
> research, grandchild delegates file operations).
>
> Filtering was implemented alongside the depth check (over-engineering), then removed. One guard
> (depth limit) is sufficient and more flexible.
>
> Affected files: `delegate.js:19-29`.

---

### [-] P3.8 — Enable parallel tool execution — `src/core/agent.js:180`

```diff
  if (!tool_calls || tool_calls.length === 0) break;
- for (const tc of tool_calls) {
-   ...
- }
+ const results = await Promise.allSettled(
+   tool_calls.map(async (tc) => {
+     if (signal?.aborted) throw new Error('Agent run aborted');
+     const input = JSON.parse(tc.function.arguments);
+     const result = await this.tools.execute(tc.function.name, input, { agent: this });
+     return { tc, result };
+   })
+ );
+ for (const r of results) {
+   if (r.status === 'rejected') {
+     this.messages.push({
+       role: 'tool',
+       content: `Error: ${r.reason.message}`,
+       tool_call_id: r.reason.tc?.id || 'unknown'
+     });
+   } else {
+     this.messages.push({
+       role: 'tool',
+       content: (typeof r.value.result === 'string') ? r.value.result : JSON.stringify(r.value.result),
+       tool_call_id: r.value.tc.id
+     });
+   }
+ }
```

> ⚠️ Only do this for read-only tools. Write/Edit/Bash must remain sequential. Add `tool.sideEffect = 'read' | 'write'` metadata to each tool definition.

---

### [-] P3.9 — Make streaming configurable — `src/core/agent.js:66`

```diff
+   const stream = payload.stream ?? false;
-   body: JSON.stringify({ ...payload, stream: false })
+   body: JSON.stringify({ ...payload, stream })
```

Add `stream` option to `createAgent()` and `agent.run()`.

---

### [x] P3.10 — Deep freeze config & use getters — `src/config.js`

```diff
+ function deepFreeze(obj) {
+   Object.freeze(obj);
+   for (const key of Object.keys(obj)) {
+     if (typeof obj[key] === 'object' && obj[key] !== null && !Object.isFrozen(obj[key])) {
+       deepFreeze(obj[key]);
+     }
+   }
+   return obj;
+ }

- export default Object.freeze({...});
+ export default deepFreeze({...});
```

---

### [x] P3.11 — Add middleware/hook system to ToolRegistry — `src/core/utils.js`

```diff
  class ToolRegistry {
    _tools = new Map();
    _mcpClients = [];
+   _hooks = { beforeExecute: [], afterExecute: [] };

+   onBeforeExecute(fn) { this._hooks.beforeExecute.push(fn); return () => { const i = this._hooks.beforeExecute.indexOf(fn); if (i !== -1) this._hooks.beforeExecute.splice(i, 1); }; }
+   onAfterExecute(fn) { this._hooks.afterExecute.push(fn); return () => { const i = this._hooks.afterExecute.indexOf(fn); if (i !== -1) this._hooks.afterExecute.splice(i, 1); }; }

    async execute(name, input, context) {
      const tool = this._tools.get(name);
      if (!tool) throw new Error(`Tool ${name} not found`);
-     // ... validation ...
+
+     for (const hook of this._hooks.beforeExecute) {
+       await hook({ name, input, context });
+     }
-     return await tool.execute(input, context);
+     const result = await tool.execute(input, context);
+     for (const hook of this._hooks.afterExecute) {
+       await hook({ name, input, context, result });
+     }
+     return result;
    }
```

> Hooks are **observers only** — they receive data snapshots and can throw to abort/signal, but cannot modify `input` or `result`. The registration methods return a disposer function for cleanup.
>
> `clear()` also resets hooks: `this._hooks = { beforeExecute: [], afterExecute: [] }`.
>
> Affected files: `utils.js:185-244,260-303,322`.

---

### [x] P3.12 — Fix naming inconsistencies

| Location | Current | Fix |
|----------|---------|-----|
| `config.js` | `ORDERS` | `ORDER` (singular, consistent with `ONLY`) |
| `agent.js:33-34` | `this.effort` / `this.max_tokens` | `this.effort` / `this.maxTokens` (both camelCase) |
| `utils.js:11,14` | `RETRY_BASE_DELAY` / `FETCH_TIMEOUT` | `RETRY_BASE_DELAY_MS` / `FETCH_TIMEOUT_MS` (both suffix `_MS`) |

---

## 📋 Phase 4 — Tool Improvements

### [x] P4.1 — `Read` tool: replace `spawn('cat')` with `fs.readFile` — `src/tools/file/read.js`

> **Done.** Already implemented — `read.js` uses `fs.readFile` + line-number formatting in pure JS. No `spawn('cat')` dependency. Portability benefit without any performance regression for typical file sizes.

```diff
- import { spawn } from 'node:child_process';
+ import fs from 'node:fs/promises';
  import path from 'node:path';
  import { ensureSafePath } from '../../core/utils.js';

  export const execute = async ({ path: filePath, start_line = 1, end_line = Infinity, max_lines = 500 }) => {
-   return new Promise((resolve) => {
-     const fullPath = path.resolve(filePath);
-     const cat = spawn('cat', ['-n', fullPath]);
-     ...

+   try {
+     const fullPath = ensureSafePath(filePath);
+     const content = await fs.readFile(fullPath, 'utf8');
+     const lines = content.split('\n');
+     if (lines[lines.length - 1] === '') lines.pop();
+
+     const start = Math.max(0, start_line - 1);
+     const end = Math.min(lines.length, end_line || lines.length);
+     const slice = lines.slice(start, end).slice(0, max_lines);
+
+     const result = slice.map((line, i) => `${start + i + 1}: ${line}`).join('\n');
+
+     if (lines.length > end || slice.length > max_lines) {
+       return result + '\n[... truncated]';
+     }
+     return result;
+   } catch (error) {
+     return `ERROR: ${error.message}`;
+   }
  };
```

---

### [-] P4.2 — `Edit` tool: simplify workflow (in-memory diff) — `src/tools/file/edit.js`

> **Skipped.** `spawn('diff')` is fast, well-tested, and available on all Unix systems. An in-memory line-by-line diff would be a regression in quality (misses context, no unified diff format) and adds maintenance burden for no real gain. The current approach works correctly after P0.1 fixed the exit code bug.

Replace the temp-file + `spawn('diff')` flow with an in-memory diff:

```diff
- import { spawn } from 'node:child_process';

- async function diff(file1, file2) { ... }  // remove entire diff() function
+ function computeDiff(oldLines, newLines) {
+   // Simple line-based diff
+   const diffLines = [];
+   const maxLen = Math.max(oldLines.length, newLines.length);
+   for (let i = 0; i < maxLen; i++) {
+     const oldLine = oldLines[i];
+     const newLine = newLines[i];
+     if (oldLine !== newLine) {
+       if (oldLine !== undefined) diffLines.push(`- ${oldLine}`);
+       if (newLine !== undefined) diffLines.push(`+ ${newLine}`);
+     }
+   }
+   return diffLines.join('\n');
+ }

  export const execute = async ({ path: filePath, new_text, old_text, start_line, end_line }) => {
    try {
-     const fullPath = path.resolve(filePath);
+     const fullPath = ensureSafePath(filePath);
      const content = await fs.readFile(fullPath, 'utf8');
+     const oldLines = content.split('\n');
+
      if (old_text) { ... /* same replace logic but in-memory */ }
      else if (start_line !== undefined && end_line !== undefined) { ... }
      else throw new Error(...);

-     const temp = path.join(...);
-     await fs.writeFile(temp, newContent, 'utf8');
-     const difference = await diff(fullPath, temp);
-     const newContent = await fs.readFile(temp);
-     await fs.rm(temp);
+     const newLines = newContent.split('\n');
+     const diffOutput = computeDiff(oldLines, newLines);

      await fs.writeFile(fullPath, newContent);

-     if (difference) {
-       return `File ${filePath} updated successfully\n\ndiff:\n${difference}`;
+     if (diffOutput) {
+       return `File ${filePath} updated successfully\n\ndiff:\n${diffOutput}`;
      } else {
        return `File ${filePath} updated, but no diff found`;
      }
    } catch (error) {
-     return `ERROR: ${error.message}`;
+     throw error;  // let agent loop handle
    }
  };
```

> Remove `import os from 'node:os'` and `import { spawn } from 'node:child_process'` — no longer needed.

---

### [x] P4.3 — `Find` tool: refactor to shell find(1) + ripgrep (replaced manual recursive walk)

```diff
- // BEFORE: recursive Node.js directory walk with fs.readdir + fs.readFile
- // 70 lines of manual traversal, binary detection, .gitignore filtering
+ // AFTER: shell find(1) for filename search, ripgrep for content search
+ // ~50 lines, 10-100x faster, native .gitignore via rg, auto binary skip
```

> **Done differently:** Instead of adding a depth limit to the recursive walk, the entire tool was refactored to shell out to `find(1)` for `mode='name'` and `rg` for `mode='content'`. Both are orders of magnitude faster, handle deep trees natively, and ripgrep respects `.gitignore` by default.

---

### [x] P4.4 — `Find` tool: better binary detection — `src/tools/file/find.js:39-40`

```diff
  const content = await fs.readFile(fullPath, 'utf8');
- if (content.includes('\u0000')) continue;
+ // Skip binary files: null bytes or high ratio of non-printable chars
+ const nullByteCount = (content.match(/\x00/g) || []).length;
+ const nonPrintable = (content.match(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g) || []).length;
+ if (nullByteCount > 0 || nonPrintable / content.length > 0.3) continue;
```

> **Better approach:** Check first 512 bytes with `fs.readFile(fullPath, { length: 512 })` for null bytes before reading entire file.

---

### [x] P4.5 — `WebFetch`: add more elements to strip + preserve structure — `src/tools/web/fetch.js:38,46`

```diff
- $('script, style, nav, footer, header, noscript').remove();
+ $('script, style, nav, footer, header, noscript, aside, iframe, form, svg, canvas, [aria-hidden="true"], [hidden], .hidden').remove();
```

```diff
- cleanText = cleanText.replace(/\s\s+/g, ' ').trim();
+ // Preserve paragraph structure: collapse multiple spaces but keep newlines
+ cleanText = cleanText.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
```

---

### [x] P4.6 — `WebFetch`: detect content type properly — `src/tools/web/fetch.js:26-33`

```diff
-   const contentType = res.headers.get('content-type');
+   const contentType = res.headers.get('content-type') || 'unknown';

-   if (contentType && contentType.includes('application/json')) {
+   if (contentType.includes('application/json')) {
+   // Also: text/plain, text/csv, text/markdown return raw text
+   // Unknown types return raw text
+   // Only text/html reaches cheerio
```

> **Additional validations added beyond the original TODO:**
>
> 1. **Binary content rejection** — `isBinaryContent()` checks for non-printable characters > 70% ratio. Rejects with a clear error message including the content-type. This prevents binary files from reaching cheerio (which would produce garbled output) or being returned as meaningless raw bytes.
> 2. **Content-type annotation** — `withContentType()` prefixes all output with `Content-Type: <type>` so the LLM knows what format it's reading (JSON, CSV, markdown, etc.).
> 3. **Size limit check** — Rejects responses over 10MB via `content-length` header before reading the body.
> 4. **Single `res.text()` call** — Refactored from multiple `res.text()` calls (one per branch) to a single read at the top, reducing redundant I/O.
>
> Affected files: `fetch.js:1,5,18-33,83,87-101,103-106,113-116,125,128`.

---

### [x] P4.7 — `WebSearch`: omit empty arrays from Tavily payload — `src/tools/web/search.js:35-36`

```diff
  const body = {
    api_key: apiKey,
    query,
    search_depth: depth,
    max_results: Math.min(maxResults, 20),
    include_answer: includeAnswer,
-   include_domains: includeDomains || [],
-   exclude_domains: excludeDomains || []
  };
+ if (includeDomains?.length) body.include_domains = includeDomains;
+ if (excludeDomains?.length) body.exclude_domains = excludeDomains;
```

---

### [x] P4.8 — `WebSearch`: use config instead of direct `process.env` — `src/tools/web/search.js:20`

```diff
- const apiKey = process.env.TAVILY_API_KEY || config.TAVILY_API_KEY;
+ const apiKey = config.TAVILY_API_KEY;
```

> `config.js` already reads `TAVILY_API_KEY` from `process.env`. The direct `process.env` access is redundant.

---

### [-] P4.9 — MCP tool naming: use unique ID instead of server name — `src/core/utils.js:181`

> **Skipped.** The current naming `\`${name}_${remoteTool.name}\`` (e.g., `fs_read_file`) is superior for this SDK's use case:
>
> - **Deterministic** — tool names are stable across sessions. This matters for persisted message history reuse and debugging.
> - **Token-efficient** — UUID adds ~8 tokens per tool per request, multiplied by tools × loop iterations.
> - **Server name is already unique** — `connectMcpServer()` takes a `name` parameter. Users control naming; duplicate names are a configuration error, not a runtime safety issue.
>
> If collision protection is ever needed, a counter-based approach (`${name}_${id++}_...`) or simple duplicate registration error is more appropriate than a random UUID.

---

## 📋 Phase 5 — Code Quality & Tooling

### [x] P5.1 — Write unit tests

```
tests/                          # root-level, separate from src/
├── core/
│   ├── utils.test.js           # 38 tests — ToolRegistry, ensureSafePath, withRetry, getIgnoreFilter
│   ├── agent.test.js           # 13 tests — constructor, use(), usage tracking
│   ├── mcp.test.js             # 6 tests — McpNativeClient, McpClientWrapper
│   └── skill.test.js           # 8 tests — SkillRegistry, parseFrontmatter, discover
├── tools/
│   ├── file/
│   │   ├── read.test.js        # 5 tests
│   │   ├── write.test.js       # 5 tests
│   │   ├── edit.test.js        # 5 tests
│   │   ├── find.test.js        # 5 tests
│   │   └── list.test.js        # 5 tests
│   ├── system/
│   │   ├── bash.test.js        # 4 tests
│   │   ├── delegate.test.js    # 4 tests
│   │   └── skill.test.js       # 4 tests
│   └── web/
│       ├── fetch.test.js       # 16 tests (incl. SSRF validation)
│       └── search.test.js      # 4 tests
```

> **122 tests total, all passing.** Uses Node.js native `node:test` + `node:assert` via dynamic ESM imports. No external test dependencies.
>
> Run with: `node --test 'tests/**/*.test.js'` or `npm test`.
>
> Key testing patterns:
> - Core modules use dynamic `import()` inside `before` hooks
> - File tools respect `ensureSafePath` (all ops within project root)
> - WebFetch tests validate SSRF rejection (localhost, private IPs, non-http protocols)
> - Tool exports tested for name/description/input_schema/execute shape

### [-] P5.2 — Set up CI/CD — `.github/workflows/ci.yml`

```yaml
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node-version: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node-version }}
      - run: npm ci
      - run: npm test
      - run: npm run lint
```

### [x] P5.3 — Add ESLint + Prettier — `package.json` + config files

```json
"devDependencies": {
  "eslint": "^9.0.0",
  "prettier": "^3.0.0",
  "eslint-config-prettier": "^9.0.0"
},
"scripts": {
  "test": "node --test",
  "lint": "eslint src/",
  "format": "prettier --write src/",
  "prepare": "npm run lint && npm test"
}
```

Config files created: `.eslintrc.json`, `.prettierrc`.

---

### [-] P5.4 — Add TypeScript definitions — `src/index.d.ts`

```typescript
declare module '@af-t/openrouter-agent-sdk' {
  interface AgentOptions {
    apiKey?: string;
    model?: string;
    order?: string[];
    only?: string[];
    maxTokens?: number;
    systemPrompt?: string;
  }
  interface ToolDefinition {
    name: string;
    description: string;
    input_schema: object;
    execute: (input: any, context?: any) => Promise<any>;
  }
  interface Agent {
    messages: any[];
    tools: ToolRegistry;
    usage: { cost: number; tokens: number };
    systemPrompt: string;
    use(tools: ToolDefinition | ToolDefinition[]): void;
    run(prompt: string | any[], notify?: (update: any) => void, options?: { signal?: AbortSignal }): Promise<string>;
  }
  function createAgent(options?: AgentOptions): Promise<Agent>;
  export default createAgent;
}
```

> Or add `// @ts-check` + JSDoc annotations for lighter-weight type safety.

---

### [x] P5.5 — Replace `console.log` in delegate — `src/tools/system/delegate.js:31`

```diff
+ import logger from '../../core/logger.js';
  ...
- console.log('Spawning subagent for:', description);
+ logger.debug('Spawning subagent for:', description);
```

---

### [-] P5.6 — Make `MAX_TOKENS_SUBAGENT` configurable — `src/core/utils.js:15`

> **Skipped.** Subagents now inherit `maxTokens` from the parent agent with a fallback to `CONSTANTS.MAX_TOKENS_SUBAGENT` (32000):
> ```js
> maxTokens: agent.maxTokens || CONSTANTS.MAX_TOKENS_SUBAGENT,
> ```
> If the parent has `maxTokens` set (via `OPENROUTER_MAX_TOKENS` env var or constructor option), subagents inherit it — no separate env var needed. If the parent doesn't have it set, 32000 is a reasonable default that beats most provider defaults (which range from 4096-8192).
>
> Adding a dedicated env var for subagent tokens would be redundant given this inheritance pattern.

---

### [-] P5.7 — Use `res.json()` in `_request()` — `src/core/agent.js:69-77`

> **Skipped.** The current `res.text()` + `JSON.parse()` pattern is objectively better:
>
> - `res.json()` internally does `res.text()` + `JSON.parse()` — same CPU, same I/O in the success path
> - In the **error path** (parse failure), `res.json()` has already consumed the body stream, requiring an **extra** `res.text()` call to retrieve the raw body for error messages
> - Current code reads the body once via `res.text()`, and `JSON.parse()` is a zero-copy in-memory operation on the already-available string
> - Error messages in the current code can include the raw response body without any additional I/O
>
> The TODO diff would make the error path strictly worse with no upside.

---

### [x] P5.8 — Add `gitignore` file-watch cache invalidation — `src/core/utils.js:22-52`

```diff
+ import fs from 'node:fs';
  ...
+ let _ignoreFilterMtime = 0;
+
  export async function getIgnoreFilter() {
    const cwd = process.cwd();
-   if (_ignoreFilterCache && _ignoreFilterCacheKey === cwd) {
+   const gitignorePath = path.join(cwd, '.gitignore');
+   let mtime = 0;
+   try { mtime = fs.statSync(gitignorePath).mtimeMs; } catch {}
+
+   if (_ignoreFilterCache && _ignoreFilterCacheKey === cwd && _ignoreFilterMtime === mtime) {
      return _ignoreFilterCache;
    }
+   _ignoreFilterMtime = mtime;
    ...
```

---

### [x] P5.9 — Fix `ToolRegistry.register()` error message — `src/core/utils.js:131`

```diff
- if (typeof execute !== 'function') throw Error('tools cannot be executed');
+ if (typeof execute !== 'function') throw Error('Tool must have an execute function');
```

---

## 📋 Phase 6 — Dependency Cleanup

### [x] P6.1 — Clean `node_modules` and define `devDependencies`

```bash
rm -rf node_modules package-lock.json
npm install
```

> `node-pty` moved to `optionalDependencies` — native compilation fails on platforms without node-gyp (e.g., Android/Termux). This is handled by P6.3 (fallback to `child_process.exec`).
>
> Removed unused imports: `fs` (index.js), `path`+`CONSTANTS` (read.js), `ToolRegistry` (delegate.js).
>
> ESLint upgraded to flat config (`eslint.config.js`) — v10 no longer supports `.eslintrc.json`.
>
> `prepare` lifecycle script removed from `package.json` — it ran `lint && test` on every `npm install`, which caused friction during dependency installs when test failures were unrelated to the install itself.

### [-] P6.2 — Evaluate replacing `cheerio` with native `DOMParser`

> **Skipped.** `globalThis.DOMParser` is `undefined` in Node.js 25.8.2 — there is no native DOM parser in Node.js core. Replacing cheerio would require `linkedom` (a third-party dependency), not fewer dependencies.
>
> Cheerio is already working, tested, and well-integrated with `fetch.js`. The potential size savings (~1MB) don't justify the risk of rewriting the HTML scraping logic for a CLI SDK. If tree-shaking becomes a priority later, `linkedom` is the recommended replacement: same selector API, ~1/10 the install size, standard `DOMParser` interface.

### [x] P6.3 — Evaluate falling back to `child_process.exec` when `node-pty` unavailable

```diff
- import pty from 'node-pty';
+ // Lazy dynamic import with fallback
+ let _ptyModule = null;
+ async function getPty() {
+   if (_ptyModule === null) {
+     try {
+       _ptyModule = await import('node-pty');
+     } catch {
+       _ptyModule = false;
+     }
+   }
+   return _ptyModule;
+ }
```

> Static `import pty from 'node-pty'` crashes the entire process at module load time if the native binary isn't available (common on Android/Termux, minimal Docker, Windows without build tools).
>
> **Fix:** Lazy dynamic import `await import('node-pty')` wrapped in try-catch. If it fails, falls back to `child_process.exec` with the same timeout/maxBuffer semantics.
>
> `node-pty` was moved to `optionalDependencies` in P6.1 so `npm install` doesn't fail.
>
> For Termux: native module can be compiled with `GYP_DEFINES='android_ndk_path=""' npm i`.
>
> Affected files: `bash.js` (full rewrite), `package.json` (optionalDependencies).

---

## 📋 Phase 7 — Documentation

### [-] P7.1 — Create `RULE.md`

```bash
echo 'You are an interactive agent that helps users with software engineering tasks.' > RULE.md
```

> I need advanced version

---

### [-] P7.2 — Create `CHANGELOG.md`

Start with v2.0.0 entries documenting all fixes from this TODO.

> I don't think this is necessary for now.

---

### [-] P7.3 — Create `AUTHORS` + fix copyright year

```
# AUTHORS
Angga Firman <...>
```

```diff
- Copyright (c) 2026 Angga Firman.
+ Copyright (c) 2025 Angga Firman.
```

Applies to `README.md` line 383 and `LICENSE`.

> Not important

---

### [-] P7.4 — Write real MCP server example in README

Replace the stub at lines 282-291 with a working, minimal example (e.g., a weather tool MCP server).

---

### [-] P7.5 — Add issue templates

```
.github/
├── ISSUE_TEMPLATE/
│   ├── bug_report.md
│   └── feature_request.md
└── PULL_REQUEST_TEMPLATE.md
```

---

### [-] P7.6 — Add semver policy + editorconfig

Add to `README.md`:
```md
## Versioning

This project follows [Semantic Versioning](https://semver.org/). Breaking changes will be communicated via CHANGELOG.md.
```

Create `.editorconfig`:
```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true
```

---

### [x] P7.7 — Update README to match reality

| README claims | Action |
|---------------|--------|
| "Path traversal protection" | Add note: "on Write, Edit, and List tools" (once Read is fixed in P1.1) |
| "Streaming" | Either remove or note "coming in v2.1" |
| "Ephemeral Caching" | Keep (it's minimal but present) |
| MCP example | Replace with working code (P7.4) |

---

## 📋 Phase 8 — Polish

### [ ] P8.1 — Add `SkillRegistry.configure()` to change search dirs without env

Already partially supported via `extraSearchDirs`. Add option to disable default agent dir scanning:
```js
SkillRegistry.configure({ scanAgentDirs: false, extraSearchDirs: ['./my-skills'] });
```

---

### [ ] P8.2 — Add `tool_call_id` validation — `src/core/agent.js:194`

```diff
  this.messages.push({
    role: 'tool',
    content: ...,
-   tool_call_id: tc.id
+   tool_call_id: tc.id || `call_${crypto.randomUUID()}`
  });
```

---

### [ ] P8.3 — Add `agent.reset()` to clear message history + usage

```js
reset() {
  this.messages = [];
  this.usage = { cost: 0, tokens: 0 };
}
```

---

### [ ] P8.4 — Make `reasoning_effort` configurable — `src/core/agent.js:33`

```diff
- this.effort = 'high';
+ this.effort = options.reasoningEffort || 'high';
```

---

> **Recommended approach:** Complete P0-P2 first (critical/high severity) to get to a minimally safe v1.1.0, then iterate P3-P8 toward v2.0.0.
