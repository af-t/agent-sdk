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
- **Built-in Tools** — File operations (Read, Write, Edit, Find, List), shell command execution (Bash), web search (Tavily), web fetch, and subagent delegation.
- **Safety & Validation** — Tool inputs are validated against their schema (type checks, required fields, enums). Path traversal protection. Dangerous shell command detection.
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
   |   ├── _send() ──> POST to OpenRouter /v1/chat/completions
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

```bash
npm install openrouter
```

Or clone directly from the repository:

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

| Variable                | Required | Description                                              |
|-------------------------|----------|----------------------------------------------------------|
| `OPENROUTER_API_KEY`    | Yes      | Your OpenRouter API key                                  |
| `OPENROUTER_MODEL`      | No       | Default model (e.g. `google/gemini-2.5-flash-preview`)   |
| `OPENROUTER_MAX_TOKENS` | No       | Maximum output tokens                                    |
| `OPENROUTER_ORDER`      | No       | Comma-separated provider priority order                  |
| `OPENROUTER_ONLY`       | No       | Restrict to specific providers only                      |
| `TAVILY_API_KEY`        | No       | API key for WebSearch tool (from [Tavily](https://tavily.com))|
| `DEBUG`                 | No       | Enable debug logging (`true`/`1`)                        |

## Basic Usage

```javascript
import createAgent from 'openrouter';

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
const result = await agent.run(
  'Create a README.md for this project.',
  (update) => {
    if (update.content) console.log('Content:', update.content);
    if (update.tool_calls) console.log('Tool calls:', update.tool_calls);
  }
);

// With abort signal
const controller = new AbortController();
setTimeout(() => controller.abort(), 5000); // 5 second timeout

try {
  const result = await agent.run('Process a heavy task...', null, {
    signal: controller.signal
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
import createAgent from 'openrouter';

const agent = await createAgent();

// Register a single tool
agent.use({
  name: 'GetWeather',
  description: 'Get the current weather for a city',
  input_schema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' }
    },
    required: ['city']
  },
  execute: async ({ city }) => {
    const res = await fetch(`https://api.weather.com/${city}`);
    const data = await res.json();
    return JSON.stringify(data);
  }
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
import Agent from 'openrouter/src/core/agent.js';
import { ToolRegistry } from 'openrouter/src/core/utils.js';

const tools = new ToolRegistry();
tools.register(myCustomTool);

const agent = new Agent({
  apiKey: 'sk-or-v1-...',
  model: 'openai/gpt-4o',
  tools,
  systemPrompt: 'Your custom prompt here'
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
  env: { MY_API_KEY: 'xxx' }
});
// Tools from the MCP server are automatically registered as my_server_<toolName>
```

## Available Tools

| Tool        | Category | Description                                        |
|-------------|----------|----------------------------------------------------|
| `Read`      | File     | Read file contents with pagination & line numbers  |
| `Write`     | File     | Write a new file (overwrite)                       |
| `Edit`      | File     | Edit a file with find-and-replace                  |
| `Find`      | File     | Search for files by name or content                |
| `List`      | File     | List directory contents (ls alternative)           |
| `Bash`      | System   | Execute shell commands (via node-pty)              |
| `Delegate`  | System   | Delegate tasks to a sub-agent                      |
| `Skill`     | System   | Manage and load skills                             |
| `WebSearch` | Web      | Web search via Tavily API                          |
| `WebFetch`  | Web      | Extract content from URLs                          |

## MCP Server

This SDK supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io) — a standard protocol for connecting LLMs with external tools.

**How it works:**
1. Call `agent.tools.connectMcpServer({ name, command, args, env })`
2. The SDK spawns the MCP server as a child process (stdio-based)
3. Tools from the MCP server are auto-registered with `<name>_<toolName>` prefix
4. The agent can immediately use those tools

**Minimal MCP server example:**

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

See `src/core/mcp.js` for the full implementation.

## Skill System

The SDK has a discovery system for skills based on `SKILL.md` files. Skills are searched in:

1. **Builtin** — `src/skills/` (inside the package)
2. **Project** — `.claude/skills/`, `.hermes/skills/`, `.gemini/skills/` (in the project directory)
3. **User** — `~/.claude/skills/`, `~/.hermes/skills/` (global user scope)
4. **Extra** — additional directories via `SkillRegistry.configure()`

Each SKILL.md contains YAML frontmatter (name, description, etc.) and a markdown body.

## Project Structure

```
openrouter/
├── src/
│   ├── index.js           # Entry point — createAgent() factory function
│   ├── config.js          # Configuration from environment variables
│   ├── core/
│   │   ├── agent.js       # Agent class — LLM interaction + tool loop
│   │   ├── utils.js       # ToolRegistry, withRetry, loadTools, helpers
│   │   ├── logger.js      # Colored console logger (debug/info/warn/error)
│   │   ├── errors.js      # Custom error classes (ApiError, ToolError, ConfigError)
│   │   ├── mcp.js         # MCP client (native stdio-based JSON-RPC)
│   │   └── skill.js       # SkillRegistry — discover & load SKILL.md
│   └── tools/
│       ├── file/          # Read, Write, Edit, Find, List
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

| Option    | Type     | Description                          |
|-----------|----------|--------------------------------------|
| `apiKey`  | string   | OpenRouter API key (overrides .env)  |
| `model`   | string   | Model identifier                     |
| `order`   | string[] | Provider routing order               |
| `only`    | string[] | Restrict to specific providers       |

### `agent.run(prompt, notify?, options?)`

| Parameter | Type            | Description                                     |
|-----------|-----------------|-------------------------------------------------|
| `prompt`  | string or array | Prompt text or array of content parts           |
| `notify`  | function        | Callback `({ content, reasoning, tool_calls })` |
| `options` | object          | `{ signal: AbortSignal }`                       |

### Agent Properties

| Property       | Type         | Description                          |
|----------------|--------------|--------------------------------------|
| `messages`     | array        | Conversation history                 |
| `tools`        | ToolRegistry | Registry of registered tools         |
| `usage`        | object       | `{ cost: number, tokens: number }`   |
| `systemPrompt` | string       | System prompt (can be overridden)    |

### ToolRegistry

| Method                  | Description                                      |
|-------------------------|--------------------------------------------------|
| `register(tool)`        | Register a new tool into the registry            |
| `execute(name, input)`  | Execute a tool with input validation             |
| `listTools()`           | List all registered tools                        |
| `getDefinitions()`      | Get tool definitions formatted for OpenRouter    |
| `connectMcpServer()`    | Connect an external MCP server                   |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for detailed guidelines on:
- Getting started with development
- Code style (ES modules, async/await, JSDoc)
- Submitting changes (feature branch, pull request)
- Reporting issues

## License

This project is licensed under the **MIT License** — see [LICENSE](LICENSE) for the full text.

Copyright (c) 2026 Angga Firman.
