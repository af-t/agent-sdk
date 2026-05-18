# OpenRouter Agent SDK

Minimal SDK for building AI agents connected to the [OpenRouter API](https://openrouter.ai). Built with Node.js (ES modules), featuring an automatic tool execution loop, MCP support, and a skill discovery system.

## Table of Contents

- [Key Features](#key-features)
- [Execution Flow](#execution-flow)
- [Installation](#installation)
- [Configuration](#configuration)
- [Basic Usage](#basic-usage)
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

## Installation

Clone directly from the repository:

```bash
git clone git@github.com:af-t/openrouter.git
cd openrouter
npm install
```

## Configuration

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

| Variable                | Required | Description                                                    |
| ----------------------- | -------- | -------------------------------------------------------------- |
| `OPENROUTER_API_KEY`    | Yes      | Your OpenRouter API key                                        |
| `OPENROUTER_MODEL`      | No       | Default model (e.g. `inclusionai/ling-2.6-1t:free`)            |
| `OPENROUTER_MAX_TOKENS` | No       | Maximum output tokens                                          |
| `OPENROUTER_MAX_TURNS`  | No       | Maximum number of request cycles per `run()` (default: 25)     |
| `OPENROUTER_ORDER`      | No       | Comma-separated provider priority order                        |
| `OPENROUTER_ONLY`       | No       | Restrict to specific providers only                            |
| `TAVILY_API_KEY`        | No       | API key for WebSearch tool (from [Tavily](https://tavily.com)) |
| `DEBUG`                 | No       | Enable debug logging (`true`/`1`)                              |

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

// Reset conversation
agent.messages = [];
```

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

| Tool        | Category | Description                                                       |
| ----------- | -------- | ----------------------------------------------------------------- |
| `Read`      | File     | Read file contents with pagination & line numbers                 |
| `Write`     | File     | Write a new file (overwrite)                                      |
| `Edit`      | File     | Edit a file with find-and-replace                                 |
| `Find`      | File     | Search for files by name or content                               |
| `List`      | File     | List directory contents (ls alternative)                          |
| `Todo`      | General  | Manage a todo list (add, list, complete, delete) with persistence |
| `Bash`      | System   | Execute shell commands (pty with fallback to child_process)       |
| `Delegate`  | System   | Delegate tasks to a sub-agent                                     |
| `Skill`     | System   | Manage and load skills                                            |
| `WebSearch` | Web      | Web search via Tavily API                                         |
| `WebFetch`  | Web      | Extract content from URLs                                         |

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
    tmpDir: '~/.config/myapp/tmp',                 // where temp files (todos) go
  },
});
```

- `memoryDir` — directory for persistent memory files (`MEMORY.md` + individual memory files). Default: `.openrouter/memory` in the project root.
- `tmpDir` — directory for temporary files. When set, the todo file is created as `todos-XXXXX.json` inside this directory with a random 5-character suffix per agent instance. Default: `.todos.json` in the project root.

Paths support `~` expansion. Both accept paths inside or outside the project root.

### Cleanup

Call `agent.cleanup()` to delete all files in `tmpDir` (non-recursive; the directory itself is preserved). This is consumer-managed — the SDK does not register any process exit handlers.

Recommended pattern:

```js
const agent = await createAgent({ storagePaths: { tmpDir: '~/.config/myapp/tmp' } });

process.on('SIGINT', async () => { await agent.cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await agent.cleanup(); process.exit(0); });

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

The directory is **not auto-created**. The agent (or you) creates files on demand. Override the location via the `memoryDir` constructor option.

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
│   ├── registry/
│   │   ├── tool.js        # ToolRegistry — register, execute, hooks, MCP
│   │   └── skill.js       # SkillRegistry — discover & load SKILL.md
│   └── tools/
│       ├── file/          # Read, Write, Edit, Find, List
│       ├── general/       # Todo
│       ├── system/        # Bash, Delegate, Skill
│       └── web/           # Search (Tavily), Fetch
├── CONTRIBUTING.md        # Contribution guidelines
├── LICENSE                # MIT License
├── package.json
└── .env.example           # Configuration template
```

## API Reference

### `createAgent(options)`

Factory function to create an Agent instance.

| Option               | Type     | Description                                                                           |
| -------------------- | -------- | ------------------------------------------------------------------------------------- |
| `apiKey`             | string   | OpenRouter API key (overrides `.env`).                                                |
| `model`              | string   | Model identifier.                                                                     |
| `order`              | string[] | Provider routing order.                                                               |
| `only`               | string[] | Restrict to specific providers.                                                       |
| `systemPrompt`       | string   | System prompt override. Falls back to `RULE.md`, then a built-in default.             |
| `maxTurns`           | number   | Max request cycles per `run()`. Default `25`; `0` means unlimited.                    |
| `maxTokens`          | number   | Maximum output tokens per request.                                                    |
| `effort`             | string   | Reasoning effort: `'low'`, `'medium'`, `'high'`. Default `'high'`.                    |
| `maxToolOutputChars` | number   | Cap (in chars) for tool output before truncation. Default `50_000`.                   |
| `contextFiles`       | string[] | Files to inject on the first turn. Default `['AGENT.md']`. Missing files are skipped. |
| `memoryDir`          | string   | Memory directory (relative to cwd). Default `.openrouter/memory`.                     |
| `memoryTypes`        | object   | Custom memory type descriptions; merged over the four built-in types.                 |
| `injectors`          | object   | Disable built-in injectors by name, e.g. `{ date: false, skillList: false }`.         |

### `agent.run(prompt, notify?, options?)`

| Parameter | Type            | Description                                     |
| --------- | --------------- | ----------------------------------------------- |
| `prompt`  | string or array | Prompt text or array of content parts           |
| `notify`  | function        | Callback `({ content, reasoning, tool_calls })` |
| `options` | object          | `{ signal: AbortSignal }`                       |

### Agent Properties

| Property       | Type         | Description                        |
| -------------- | ------------ | ---------------------------------- |
| `messages`     | array        | Conversation history               |
| `maxTurns`     | number       | Max LLM request cycles             |
| `isSubagent`   | boolean      | Whether the agent is a sub-agent   |
| `tools`        | ToolRegistry | Registry of registered tools       |
| `usage`        | object       | `{ cost: number, tokens: number }` |
| `systemPrompt` | string       | System prompt (can be overridden)  |

### Agent Methods

| Method                                  | Description                                                             |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `use(tool \| tool[])`                   | Register one or more tools after construction.                          |
| `reset()`                               | Clear messages and reset accumulated usage.                             |
| `registerInjector({ name, scope, fn })` | Register a context injector. `scope` is `'first-turn'` or `'per-turn'`. |
| `unregisterInjector(name)`              | Remove a previously registered injector by name.                        |
| `onBeforeRequest(fn)`                   | Hook the outgoing payload. Returns a disposer.                          |

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
- Code style (ES modules, async/await, JSDoc)
- Submitting changes (feature branch, pull request)
- Reporting issues

## License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for the full text.

Copyright (c) 2026 Angga Firman.
