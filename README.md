# OpenRouter Agent SDK

Minimal SDK for building AI agents connected to the [OpenRouter API](https://openrouter.ai). Built with Node.js (ES modules), featuring an automatic tool execution loop, MCP support, and a skill discovery system.

## Table of Contents

- [Key Features](#key-features)
- [Execution Flow](#execution-flow)
- [Installation](#installation)
- [Configuration](#configuration)
- [Basic Usage](#basic-usage)
- [Background Jobs](#background-jobs)
- [Integration into Your Project](#integration-into-your-project)
- [Available Tools](#available-tools)
- [MCP Server](#mcp-server)
- [Skill System](#skill-system)
- [Context Injection Layer](#context-injection-layer)
- [Persistent Memory](#persistent-memory)
- [Project Structure](#project-structure)
- [API Reference](#api-reference)
- [Contributing](#contributing)
- [License](#license)

---

## Key Features

- **OpenRouter Integration** — Access 300+ LLM models through a single API with provider routing (order/only).
- **Automatic Tool Execution Loop** — The agent automatically calls tools, receives results, and continues the conversation until a final answer is produced.
- **MCP (Model Context Protocol) Support** — Connect your agent to external tools via stdio-based MCP servers.
- **Skill Discovery System** — Discover and load skills from SKILL.md files across builtin, project, and user directories.
- **Built-in Tools** — File operations (Read, Write, Edit, Find, List), shell command execution (Bash with optional **node-pty** support), web search (Tavily), web fetch (using **cheerio**), and subagent delegation.
- **Safety & Validation** — Tool inputs are validated against their schema (type checks, required fields, enums). Path traversal protection and **.gitignore** compliance on Read, Write, Edit, List, and Find tools. Dangerous shell command detection.
- **Retry with Exponential Backoff** — Auto-retry with jitter to handle rate limits and transient errors.
- **Abort Signal Support** — Cancel agent execution at any point.
- **Ephemeral Caching** — Automatic `cache_control` on system prompt and the last user message.

## Execution Flow

```
1. createAgent()
   |
   ├── loadTools() ──> scan src/tools/ ──> register into ToolRegistry
   |
   └── new Agent({ apiKey, model, tools, ... })

2. agent.run(prompt)
   |
   ├── push user message to message history
   |
   ├── LOOP:
   |   ├── #send() ──> POST to OpenRouter /v1/chat/completions
   |   |
   |   ├── [response contains tool_calls?]
   |   |   YES ──> for each tool_call:
   |   |   |       ├── ToolRegistry.execute(name, input)
   |   |   |       ├── input validation (required, type, enum)
   |   |   |       └── push result as tool message
   |   |   |
   |   |   NO  ──> break (final answer received)
   |   |
   |   └── (repeat with tool results as new context)
   |
   └── return content of the last message
```

Simplified diagram:

```
[Prompt] --> Agent.send() --> OpenRouter API
                                |
                          [Tool Calls?]
                           /        \
                         YES        NO
                          |          |
                    Execute Tool    [DONE]
                    via Registry     return
                          |         content
                    Push Result
                    to Messages
                          |
                    <-- loop back
```

While a loop is running, additional `run()` or `steer()` calls do not start a second loop — their prompts are queued and merged into the conversation after the current turn's tool results. See [Steering a Running Agent](#steering-a-running-agent).

## Installation

Clone directly from the repository:

```bash
git clone git@github.com:af-t/openrouter.git
cd openrouter
npm install
```

> **Node.js ≥22 required** — the SDK uses `process.loadEnvFile()` (native in Node 22+). Earlier versions will fail to load `.env`.

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable                                                                                                                                                                        | Required | Description                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| `OPENROUTER_API_KEY`                                                                                                                                                            | Yes      | Your OpenRouter API key                                        |
| `OPENROUTER_MODEL`                                                                                                                                                              | No       | Default model (e.g. `inclusionai/ling-2.6-1t:free`)            |
| `OPENROUTER_MAX_TURNS`                                                                                                                                                          | No       | Maximum number of request cycles per `run()` (default: 25)     |
| `OPENROUTER_ORDER`                                                                                                                                                              | No       | Comma-separated provider priority order                        |
| `OPENROUTER_ONLY`                                                                                                                                                               | No       | Restrict to specific providers only                            |
| `TAVILY_API_KEY`                                                                                                                                                                | No       | API key for WebSearch tool (from [Tavily](https://tavily.com)) |
| `DEBUG`                                                                                                                                                                         | No       | Enable debug logging (`true`/`1`)                              |
| `OPENROUTER_TEMPERATURE`, `OPENROUTER_TOP_P`, `OPENROUTER_MIN_P`, `OPENROUTER_TOP_K`                                                                                            | No       | Sampling controls                                              |
| `OPENROUTER_FREQUENCY_PENALTY`, `OPENROUTER_PRESENCE_PENALTY`, `OPENROUTER_REPETITION_PENALTY`                                                                                  | No       | Repetition controls                                            |
| `OPENROUTER_SEED`, `OPENROUTER_MAX_COMPLETION_TOKENS`                                                                                                                           | No       | Deterministic seed; output token cap (`max_completion_tokens`) |
| `OPENROUTER_REASONING_EFFORT`, `OPENROUTER_REASONING_MAX_TOKENS`, `OPENROUTER_REASONING_EXCLUDE`, `OPENROUTER_REASONING_ENABLED`                                                | No       | Reasoning controls                                             |
| `OPENROUTER_PROVIDER_AVOID`, `OPENROUTER_PROVIDER_SORT`, `OPENROUTER_PROVIDER_ALLOW_FALLBACKS`, `OPENROUTER_PROVIDER_REQUIRE_PARAMETERS`, `OPENROUTER_PROVIDER_DATA_COLLECTION` | No       | Provider routing                                               |

## Basic Usage

```javascript
import createAgent from './src/index.js';

// Create agent with default config (from .env)
const agent = await createAgent();

// Or with option overrides
const agent = await createAgent({
  apiKey: 'sk-or-v1-...',
  model: 'anthropic/claude-sonnet-4',
});

// Simple prompt
const result = await agent.run('What is OpenRouter?');
console.log(result);

// With notification callback (step-by-step updates)
const result = await agent.run('Create a README.md for this project.', (update) => {
  if (update.content) console.log('Content:', update.content);
  if (update.reasoning) console.log('Reasoning:', update.reasoning);
  if (update.tool_calls) console.log('Tool calls:', update.tool_calls);
});

// With abort signal
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000); // 5 second timeout

try {
  const result = await agent.run('Process a heavy task...', null, {
    signal: controller.signal,
  });
} catch (err) {
  if (err.message === 'Agent run aborted') {
    console.log('Cancelled by user');
  }
}

// Check usage
console.log(`Cost: $${agent.usage.cost}`);
console.log(`Total tokens: ${agent.usage.tokens}`);
```

### Multi-turn Conversation

The agent preserves message history automatically. Call `run()` repeatedly for multi-turn conversations:

```javascript
await agent.run('Hello, who are you?');
await agent.run('Can you elaborate on that?'); // has context from previous turn

// Reset conversation and accumulated usage counters
agent.reset();
```

### Steering a Running Agent

`run()` is re-entrancy-safe. Calling it again while a loop is in progress — or calling `steer()` — enqueues the prompt instead of starting a second loop. Queued prompts are appended to the conversation after the current turn's tool results, so you can redirect a long-running agent without waiting for it to return:

```javascript
const runPromise = agent.run('Refactor the whole codebase...');

// Later, from elsewhere in your app — no need to await runPromise first:
agent.steer('Actually, focus on src/core/ only.');

if (agent.isRunning) {
  // a run loop is currently active
}

const result = await runPromise; // resolves after the steered work finishes too
```

`steer()` returns `true` when the prompt is queued, or `false` when the agent is idle (there is no loop to steer) or the prompt is empty. When a streaming `notify` callback is set, a `{ steer_applied: { count } }` event fires each time queued prompts are drained into the conversation.

### Reactive daemon

`createDaemon` keeps an Agent alive as a long-running process and drives it from
external events. Each event runs through a programmatic handler you write; the
handler returns an action that the daemon actuates against the Agent.

```js
import createAgent, { createDaemon, createTimerSource } from '@af-t/openrouter-agent-sdk';

const agent = await createAgent();

const daemon = createDaemon({
  agent,
  handler: (event, ctx) => {
    if (event.type === 'tick') return { type: 'run', prompt: 'Do the periodic check.' };
    return { type: 'ignore' };
  },
  sources: [createTimerSource({ intervalMs: 60_000, event: { type: 'tick' }, immediate: true })],
});

const stopSignal = daemon.start();
daemon.emit({ type: 'manual', data: 'kick' }); // programmatic source, always available
// ... later:
await daemon.stop(); // pass { abort: true } to also cancel an in-flight run
await agent.cleanup(); // the daemon does not own the Agent's lifecycle
```

Actions a handler may return: `{ type: 'ignore' }`, `{ type: 'run', prompt, notify? }`,
`{ type: 'steer', prompt }`, `{ type: 'prompt', text }` (auto-routes to steer while the
agent is running, otherwise run), and `{ type: 'abort' }`. The handler may also act on
`ctx` directly (`ctx.agent`, `ctx.isRunning`, `ctx.emit`, `ctx.daemon`, `ctx.signal`) and
return `null`. A source is any `{ start(emit), stop() }`; `createTimerSource` is built in.

#### File-watch source

`createFileWatchSource(options)` is a zero-dependency daemon source that emits filesystem-change events. It implements the same `{ start(emit), stop() }` interface as `createTimerSource`.

```js
import createAgent, { createDaemon, createFileWatchSource } from '@af-t/openrouter-agent-sdk';

const daemon = createDaemon({
  agent: await createAgent(),
  handler: (event) => ({
    type: 'prompt',
    text: `Changed: ${event.path ?? event.paths.join(', ')}. Re-run the tests.`,
  }),
  sources: [
    createFileWatchSource({
      paths: ['src', 'tests'],
      recursive: true,
      ignore: ['node_modules', '.git', '.log'],
      coalesce: true,
    }),
  ],
});

daemon.start();
```

Options: `paths` (string or array, required), `recursive` (default `false`), `usePolling` + `pollIntervalMs` (use `fs.watchFile` for WSL2 `/mnt/c`, network FS, Docker mounts; default `false` / `1000`), `debounceMs` (default `50`; collapses an editor's save burst per path, and is the batch window when `coalesce` is set), `coalesce` (default `false`; `true` emits one batched `{ type, paths, changes }` event per window), `ignore` (substring list), `filter` (`(path, eventType) => boolean`), and `type` (default `'file-change'`).

Per-file events are `{ type, path, eventType }`; coalesced events are `{ type, paths, changes }`. `eventType` is `'rename'` (create/delete/rename) or `'change'` (content).

Note: in `usePolling` mode, directories are expanded to the files present at `start()`; files created afterward are not auto-detected (a `fs.watchFile` limitation). Use the default `fs.watch` backend, or list explicit file paths, when that matters.

#### HTTP/webhook source

`createHttpSource(options)` is a zero-dependency daemon source that turns inbound HTTP requests into events. It owns a `node:http` server and implements the same `{ start(emit), stop() }` interface as `createTimerSource` and `createFileWatchSource` (plus `address()` for the bound port).

```js
import createAgent, { createDaemon, createHttpSource } from '@af-t/openrouter-agent-sdk';

const daemon = createDaemon({
  agent: await createAgent(),
  sources: [
    createHttpSource({
      port: 8787,
      authToken: process.env.CTRL_TOKEN,
      hmacSecret: process.env.WEBHOOK_SECRET,
      routes: [
        { path: '/control', type: 'http-control', auth: 'token' },
        { path: '/webhook', type: 'http-webhook', auth: 'hmac' },
      ],
    }),
  ],
  handler: async (event, ctx) => {
    if (event.type === 'http-control') {
      const out = await ctx.agent.run(event.body.prompt, null, { signal: ctx.signal });
      event.respond(out); // replies with the agent's result
      return null; // already handled
    }
    event.respond({ status: 202, body: { queued: true } });
    return { type: 'run', prompt: `Webhook: ${JSON.stringify(event.body)}` };
  },
});

daemon.start();
```

Options: `port` (required; `0` = ephemeral, read back via `source.address()`), `host` (default `127.0.0.1`), `routes` (array of `{ path, type, auth?, method? }`; `auth` is `none`/`token`/`hmac`, `method` defaults to `POST`), `authToken` (enables `auth:'token'`), `hmacSecret` (enables `auth:'hmac'`), `signatureHeader` (default `x-signature-256`), `signaturePrefix` (default `sha256=`), `healthPath` (default `/health`, `GET` -> `200`, no auth, no event; `null` disables), `responseTimeoutMs` (default `30000`), `bodyLimitBytes` (default `1_000_000`).

Each matched request emits `{ type, method, path, query, headers, body, rawBody, ip, requestId, respond }`. Call `event.respond(value)` to reply: a string -> `200 text/plain`; an object -> a `{ status, headers, body }` spec (wrap a JSON payload as `respond({ body: {...} })`). Because the daemon awaits the handler, awaiting `ctx.agent.run(...)` before calling `respond` returns the agent's result to the HTTP caller; returning a bare `run` action is fire-and-forget and will `504` unless you also call `respond`. Auth (token + HMAC) uses constant-time comparison; bind stays on `127.0.0.1` by default — terminate TLS upstream before exposing it.

## Background Jobs

Bash commands and Delegate subagents can run detached from the current turn. The agent returns immediately with a job ID and log path, and delivers a `<system-reminder>` to the run loop when the job finishes.

```javascript
// Detach a shell command
const jobInfo = await agent.run('Run the test suite in the background.');
// The Bash tool was called with background:true — agent got a job ID and log path back.

// Delegate a subagent in fire-and-forget mode
// (Delegate tool called with background:true inside the agent's tool loop)
```

The `Remind` tool complements background jobs — it pauses the run loop until a duration elapses or a specific time is reached, optionally short-circuiting when any watched background job exits:

```
Remind({ wait_ms: 30000 })              // wait 30 s
Remind({ until: '2026-01-01T00:00:00Z' }) // wait until a timestamp
Remind({ wait_ms: 60000, watch: ['bg-a1b2c'] }) // wake early if job finishes
```

Register a listener for background-job completion from outside the run loop:

```javascript
const disposer = agent.onBackgroundExit(({ id, exitCode, log }) => {
  console.log(`Job ${id} finished (exit ${exitCode}). Log: ${log}`);
});
// disposer() to unsubscribe
```

Active background jobs are tracked in `agent.backgroundJobs` (`Map<id, BgJob>`). All running jobs receive `SIGTERM` (then `SIGKILL` after 2 s) during `agent.cleanup()`.

## Integration into Your Project

### 1. Register Custom Tools

You can add your own tools at any point:

```javascript
import createAgent from './src/index.js';

const agent = await createAgent();

// Register a single tool
agent.use({
  name: 'GetWeather',
  description: 'Get the current weather for a city',
  input_schema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
    },
    required: ['city'],
  },
  execute: async ({ city }) => {
    const res = await fetch(`https://api.weather.com/${city}`);
    const data = await res.json();
    return JSON.stringify(data);
  },
});

// Register multiple tools at once
agent.use([toolA, toolB, toolC]);
```

### 2. Override System Prompt

The agent uses `RULE.md` if it exists in the project root, or falls back to a default prompt. You can override it:

```javascript
const agent = await createAgent();

// Direct override
agent.systemPrompt = 'You are a helpful assistant that always answers in rhymes.';
```

Or create a `RULE.md` file in your project root:

```markdown
You are an expert AI engineer helping with Node.js debugging.
Be concise and provide runnable code examples.
```

### 3. Use the Bare Agent Class

```javascript
import Agent from './src/core/agent.js';
import { ToolRegistry } from './src/registry/tool.js';

const tools = new ToolRegistry();
tools.register(myCustomTool);

const agent = new Agent({
  apiKey: 'sk-or-v1-...',
  model: 'openai/gpt-4o',
  tools,
  systemPrompt: 'Your custom prompt here',
});

await agent.run('Execute task...');
```

### 4. Connect an MCP Server

```javascript
// Before running the agent, connect an MCP server
await agent.tools.connectMcpServer({
  name: 'my-server',
  command: 'node',
  args: ['path/to/mcp-server.js'],
  env: { MY_API_KEY: 'xxx' },
});
// Tools from the MCP server are automatically registered as my_server_<toolName>
```

## Available Tools

| Tool        | Category | Description                                                                           |
| ----------- | -------- | ------------------------------------------------------------------------------------- |
| `Read`      | File     | Read text, notebooks, images, PDFs & binary files                                     |
| `Write`     | File     | Write a new file (overwrite)                                                          |
| `Edit`      | File     | Edit a file with find-and-replace                                                     |
| `Find`      | File     | Search for files by name or content                                                   |
| `List`      | File     | List directory contents (ls alternative)                                              |
| `Todo`      | General  | Manage a todo list (add, list, complete, delete, update, clear) with persistence      |
| `Bash`      | System   | Execute shell commands (pty with fallback to child_process); supports background mode |
| `Delegate`  | System   | Delegate tasks to a sub-agent; supports background mode                               |
| `Remind`    | System   | Pause execution until a duration elapses or an absolute time is reached               |
| `Skill`     | System   | Manage and load skills                                                                |
| `WebSearch` | Web      | Web search via Tavily API                                                             |
| `WebFetch`  | Web      | Extract content from URLs                                                             |

### Reading non-text files

`Read` classifies a file by its magic bytes (and the `.ipynb` extension) and adapts its output:

- **Text** — paginated, line-numbered output (unchanged behavior).
- **Notebooks (`.ipynb`)** — the JSON is flattened into a readable transcript of cells, with code cell outputs (stdout, results, error tracebacks) inlined.
- **Images (PNG/JPEG/GIF/WebP)** — returned as an `image_url` content part (a base64 data URI) so vision-capable models actually see the image, preceded by a text part with the file name, dimensions, and size.
- **PDFs** — returned as a `file` content part; models with native document support (such as Claude) read them directly, and OpenRouter can OCR for the rest.
- **Other binary files** — a metadata summary (detected type, size) plus a hex preview of the first bytes.

Images above 5 MB and PDFs above 10 MB skip the inline content part and return a metadata summary instead, to keep the context window manageable.

**Automatic degradation.** Not every provider accepts non-text content parts inside a `tool`-role message. If a request is rejected with an HTTP 400 because of multimodal tool content, the agent strips the non-text parts (keeping the descriptive text part), retries once, and degrades all subsequent requests for the rest of the session.

## MCP Server

This SDK supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) — a standard protocol for connecting LLMs with external tools.

**How it works:**

1. Call `agent.tools.connectMcpServer({ name, command, args, env })`
2. The SDK spawns the MCP server as a child process (stdio-based)
3. Tools from the MCP server are auto-registered with `<name>_<toolName>` prefix
4. The agent can immediately use those tools

**Minimal MCP server example (simplified illustration):**

```javascript
// mcp-weather.js
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  // handle JSON-RPC messages (initialize, tools/list, tools/call, etc.)
  // Send response to stdout
});
```

> For a working MCP server implementation, see `src/core/mcp.js`. A full production-ready example (e.g., weather tool) is planned for a future release.

See `src/core/mcp.js` for the full implementation.

## Skill System

The SDK has a discovery system for skills based on `SKILL.md` files. Skills are searched in:

1. **Builtin** — `src/skills/` (inside the package)
2. **Project** — `.claude/skills/`, `.hermes/skills/`, `.gemini/skills/` (in the project directory)
3. **User** — `~/.claude/skills/`, `~/.hermes/skills/` (global user scope)
4. **Extra** — additional directories via `SkillRegistry.configure()`

Each SKILL.md contains YAML frontmatter (name, description, etc.) and a markdown body.

## Context Injection Layer

Beyond the system prompt and message history, the agent exposes a **third tier** of context: short fragments injected into the last user message right before each request. This lets you ship dynamic, situational information (current date, loaded files, memory index, custom hints) without polluting the system prompt or rewriting message history.

The injection layer is organised as three tiers:

1. **System prompt** — stable instructions resolved once at construction (`systemPrompt` option or `RULE.md`).
2. **First-turn injectors** — run once on the first `run()` after `reset()` or construction. Used for one-shot context like loaded files, skill catalogues, memory index.
3. **Per-turn injectors** — run on every request. Used for live signals like the current timestamp.

The combined output of both scopes is joined with `\n\n`, wrapped in a single `<system-reminder>...</system-reminder>` block, and inserted as a new text part immediately before the trailing content part of the last user message. The trailing part keeps its `cache_control: ephemeral` marker, so reminders do not break prompt caching.

### Builtin Injectors

| Name           | Scope      | What it injects                                                                         |
| -------------- | ---------- | --------------------------------------------------------------------------------------- |
| `date`         | per-turn   | `Current date: YYYY-MM-DD HH:MM UTC`                                                    |
| `contextFiles` | first-turn | Concatenated contents of files listed in `contextFiles` option (defaults to `AGENT.md`) |
| `memoryIndex`  | first-turn | Contents of `<memoryDir>/MEMORY.md`, if present                                         |
| `memoryHint`   | first-turn | Brief description of the memory directory and the available memory types                |
| `skillList`    | first-turn | Name + truncated description of every discovered skill                                  |

Disable any builtin individually via the `injectors` option:

```javascript
const agent = await createAgent({
  injectors: { date: false, skillList: false },
});
```

### Registering Custom Injectors

```javascript
import os from 'node:os';

const agent = await createAgent();

agent.registerInjector({
  name: 'host',
  scope: 'per-turn',
  fn: () => `Hostname: ${os.hostname()}, load: ${os.loadavg()[0].toFixed(2)}`,
});

// Remove later if you no longer want it
agent.unregisterInjector('host');
```

An injector function receives `{ messages, usage, turn }` and returns a `string` (sync or via `Promise`). Return `''` to skip the injector for that turn — the wrapper omits empty fragments entirely.

### Mutating the Outgoing Request

For lower-level access, register a `before-request` hook to inspect or mutate the final payload after injectors have been applied:

```javascript
agent.onBeforeRequest((payload) => {
  payload.metadata = { traceId: crypto.randomUUID() };
});
```

The hook returns a disposer. Hooks run in registration order and may be async.

## Persistent Memory

The SDK ships a file-based memory protocol that lets the agent persist knowledge across sessions. There are **no dedicated memory tools** — the LLM reads, writes, and edits memory files using the standard `Read`, `Write`, and `Edit` tools, guided by the `using-memory` skill and the first-turn memory injectors.

### Configurable Storage Paths

Use `storagePaths` to place memory and temporary files outside the project root (e.g. in a user-level config directory):

```js
const agent = await createAgent({
  storagePaths: {
    memoryDir: '~/.config/myapp/workspace/memory', // where memory files live
    tmpDir: '~/.config/myapp/tmp', // where temp files (todos) go
  },
});
```

- `memoryDir` — directory for persistent memory files (`MEMORY.md` + individual memory files). Default: `.openrouter/memory` in the project root.
- `tmpDir` — directory for temporary files. When set, the todo file is created as `todos-XXXXX.json` inside this directory with a random 5-character suffix per agent instance. Default: `.openrouter/todos.json` in the project root.

Paths support `~` expansion. Both accept paths inside or outside the project root.

### Cleanup

Call `agent.cleanup()` to delete all files in `tmpDir` (non-recursive; the directory itself is preserved). This is consumer-managed — the SDK does not register any process exit handlers.

Recommended pattern:

```js
const agent = await createAgent({ storagePaths: { tmpDir: '~/.config/myapp/tmp' } });

process.on('SIGINT', async () => {
  await agent.cleanup();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await agent.cleanup();
  process.exit(0);
});

// Or after a one-shot run:
try {
  await agent.run(prompt);
} finally {
  await agent.cleanup();
}
```

### File Layout

```
<cwd>/.openrouter/memory/
├── MEMORY.md                       # Index — one line per memory
├── feedback-prefers-pnpm.md        # Individual memory file
├── project-deadline-q3.md
└── ...
```

The directory is **not auto-created**. The agent (or you) creates files on demand. Override the location via `storagePaths.memoryDir`.

### File Format

Each memory file is a markdown document with simple frontmatter:

```markdown
---
name: feedback-prefers-pnpm
description: User prefers pnpm over npm for this project.
metadata:
  type: feedback
---

# Prefers pnpm

The user explicitly asked to use pnpm for installs in this repo. Honour it for any onboarding or scripted setup instructions.
```

- `name` — kebab-case slug matching the filename (without `.md`).
- `description` — one-line summary; used by the LLM to scan for relevance.
- `metadata.type` — one of the registered memory types (see below).

`MEMORY.md` is a flat index listing each memory as `- [[slug]] — short description`. The agent updates it whenever it adds, renames, or deletes a memory.

### Memory Types

Four types ship by default and describe what each category is for:

| Type        | Purpose                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `user`      | Information about the user — role, goals, preferences.                             |
| `feedback`  | Guidance the user gave about how to approach work.                                 |
| `project`   | Ongoing work context, decisions, deadlines that aren't derivable from code or git. |
| `reference` | Pointers to external systems — dashboards, tracker projects, channels.             |

Extend or override via `memoryTypes`:

```javascript
const agent = await createAgent({
  memoryTypes: {
    incident: 'Post-mortem notes and action items from production incidents.',
  },
});
```

Custom keys are merged on top of the built-in defaults.

### Protocol

The `using-memory` builtin skill (see `src/skills/using-memory/SKILL.md`) covers the full protocol: when to save, when not to save, file naming, index conventions, and stale-memory handling. The LLM loads it on demand via the `Skill` tool when it decides memory is relevant.

## Project Structure

```
openrouter/
├── src/
│   ├── index.js           # Entry point — createAgent() factory function
│   ├── config.js          # Configuration from environment variables
│   ├── core/
│   │   ├── agent.js       # Agent class — LLM interaction + tool loop
│   │   ├── utils.js       # withRetry, loadTools, ensureSafePath, helpers
│   │   ├── logger.js      # Colored console logger (debug/info/warn/error)
│   │   ├── errors.js      # Custom error classes (ApiError, ToolError, ConfigError)
│   │   ├── mcp.js         # MCP client (native stdio-based JSON-RPC)
│   │   ├── file-type.js   # Magic-byte detection for the Read tool
│   │   ├── file-state.js  # File content cache (line-number stability)
│   │   └── notebook.js    # .ipynb flattener for the Read tool
│   ├── registry/
│   │   ├── tool.js        # ToolRegistry — register, execute, hooks, MCP
│   │   └── skill.js       # SkillRegistry — discover & load SKILL.md
│   └── tools/
│       ├── file/          # Read, Write, Edit, Find, List
│       ├── general/       # Todo
│       ├── system/        # Bash, Delegate, Remind, Skill
│       └── web/           # Search (Tavily), Fetch
├── CONTRIBUTING.md        # Contribution guidelines
├── LICENSE                # MIT License
├── package.json
└── .env.example           # Configuration template
```

## API Reference

### `createAgent(options)`

Factory function to create an Agent instance.

| Option                                                     | Type     | Description                                                                                                                        |
| ---------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`                                                   | string   | OpenRouter API key (overrides `.env`).                                                                                             |
| `model`                                                    | string   | Model identifier.                                                                                                                  |
| `order`                                                    | string[] | Provider routing order.                                                                                                            |
| `only`                                                     | string[] | Restrict to specific providers.                                                                                                    |
| `provider`                                                 | object   | Provider routing: `{ order, only, avoid, sort, allowFallbacks, requireParameters, dataCollection }`. Merged with env.              |
| `temperature`, `topP`, `minP`, `topK`                      | number   | Sampling controls. Option wins over env.                                                                                           |
| `frequencyPenalty`, `presencePenalty`, `repetitionPenalty` | number   | Repetition controls.                                                                                                               |
| `seed`                                                     | number   | Deterministic sampling seed.                                                                                                       |
| `maxCompletionTokens`                                      | number   | Output token cap; sent as `max_completion_tokens`.                                                                                 |
| `responseFormat`                                           | object   | Passed through as `response_format` (e.g. JSON mode).                                                                              |
| `stop`                                                     | string[] | Stop sequences.                                                                                                                    |
| `reasoning`                                                | object   | `{ effort, maxTokens, exclude, enabled }`. Maps to OpenRouter's `reasoning`.                                                       |
| `systemPrompt`                                             | string   | System prompt override. Falls back to `RULE.md`, then a built-in default.                                                          |
| `maxTurns`                                                 | number   | Max request cycles per `run()`. Default `25`; `0` means unlimited.                                                                 |
| `effort`                                                   | string   | Reasoning effort: `'low'`, `'medium'`, `'high'`. Default `'high'`.                                                                 |
| `maxToolOutputChars`                                       | number   | Cap (in chars) for tool output before truncation. Default `50_000`.                                                                |
| `restricted`                                               | boolean  | Security mode. Default `true`. Set `false` to lift path-boundary checks, env filtering, and shell command blocks (logs a warning). |
| `storagePaths`                                             | object   | `{ memoryDir?, tmpDir? }`. Paths support `~` expansion. External dirs are auto-added to `trustedPaths`.                            |
| `contextFiles`                                             | string[] | Files to inject on the first turn. Default `['AGENT.md']`. Missing files are skipped.                                              |
| `memoryTypes`                                              | object   | Custom memory type descriptions; merged over the four built-in types.                                                              |
| `injectors`                                                | object   | Disable built-in injectors by name, e.g. `{ date: false, skillList: false }`.                                                      |

### `agent.run(prompt, notify?, options?)`

| Parameter | Type            | Description                                     |
| --------- | --------------- | ----------------------------------------------- |
| `prompt`  | string or array | Prompt text or array of content parts           |
| `notify`  | function        | Callback `({ content, reasoning, tool_calls })` |
| `options` | object          | `{ signal: AbortSignal }`                       |

Calling `run()` while a loop is already active does not start a second loop: the prompt is enqueued for the running loop and the in-flight run's promise is returned, so `await` still resolves with the final result.

### `agent.steer(prompt)`

Queue a prompt for an already-running loop without waiting for it to finish — see [Steering a Running Agent](#steering-a-running-agent). Synchronous and non-blocking; returns `true` when the prompt is queued, or `false` when the agent is idle (no loop to steer) or the prompt is empty.

### Agent Properties

| Property         | Type         | Description                                                 |
| ---------------- | ------------ | ----------------------------------------------------------- |
| `messages`       | array        | Conversation history                                        |
| `maxTurns`       | number       | Max LLM request cycles                                      |
| `isSubagent`     | boolean      | Whether the agent is a sub-agent                            |
| `restricted`     | boolean      | Security mode flag (set at construction)                    |
| `tools`          | ToolRegistry | Registry of registered tools                                |
| `usage`          | object       | `{ cost: number, tokens: number }`                          |
| `systemPrompt`   | string       | System prompt (can be overridden)                           |
| `isRunning`      | boolean      | Whether a run loop is currently active                      |
| `backgroundJobs` | Map          | Active background jobs keyed by job ID (`bg-<5-hex>`)       |
| `subagents`      | Map          | Named subagent instances keyed by ID (scoped to this agent) |

### Agent Methods

| Method                                  | Description                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `use(tool \| tool[])`                   | Register one or more tools after construction.                                                               |
| `reset()`                               | Clear messages and reset accumulated usage.                                                                  |
| `registerInjector({ name, scope, fn })` | Register a context injector. `scope` is `'first-turn'` or `'per-turn'`.                                      |
| `unregisterInjector(name)`              | Remove a previously registered injector by name.                                                             |
| `onBeforeRequest(fn)`                   | Hook the outgoing payload. Returns a disposer.                                                               |
| `onBackgroundExit(fn)`                  | Register a listener for background-job completion (fired when idle). Returns a disposer.                     |
| `steer(prompt)`                         | Queue a prompt for the active run loop (non-blocking). Returns `true` if queued, `false` when idle or empty. |
| `cleanup()`                             | Kill running background jobs, delete tmpDir files, and shut down MCP child processes.                        |

### ToolRegistry

| Method                 | Description                                   |
| ---------------------- | --------------------------------------------- |
| `register(tool)`       | Register a new tool into the registry         |
| `execute(name, input)` | Execute a tool with input validation          |
| `listTools()`          | List all registered tools                     |
| `getDefinitions()`     | Get tool definitions formatted for OpenRouter |
| `connectMcpServer()`   | Connect an external MCP server                |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines on:

- Getting started with development
- Code style (ES modules, async/await, `//` comments — no JSDoc)
- Submitting changes (feature branch, pull request)
- Reporting issues

## License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for the full text.

Copyright (c) 2026 Angga Firman.
