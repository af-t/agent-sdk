# Agent SDK

## Overview

`@af-t/agent-sdk` creates an OpenRouter-backed agent with file, shell, web,
memory, task, and background-job tools. The SDK also exposes registries,
recording helpers, MCP clients, and event-driven automation.

The package uses ES modules and requires Node.js 22 or later.

## Installation

```bash
npm install @af-t/agent-sdk
```

Set an OpenRouter API key in the environment or pass `apiKey` to
`createAgent`:

```bash
export OPENROUTER_API_KEY=sk-or-v1-your-key
```

## Quick start

```js
import { createAgent } from '@af-t/agent-sdk';

const agent = await createAgent({
  model: 'anthropic/claude-sonnet-4',
});

try {
  const answer = await agent.run('Explain what this repository does.');
  console.log(answer);
} finally {
  await agent.cleanup();
}
```

`run` accepts an optional event callback and an options object:

```js
const controller = new AbortController();

const answer = await agent.run(
  'Run the tests and summarize any failures.',
  (event) => {
    if (event.contentDelta) process.stdout.write(event.contentDelta);
  },
  { signal: controller.signal },
);
```

Provider-shaped request and response data keeps the provider's spelling.
For example, entries in `agent.messages` and provider tool calls use snake
case. SDK options, event envelopes, tool schemas, and metadata use camel case.

## Configuration

Explicit options take precedence over environment variables. Numeric
environment values are parsed as numbers. Boolean values accept `true`,
`false`, `1`, and `0`.

| Option                | Environment variable               | Purpose                                 |
| --------------------- | ---------------------------------- | --------------------------------------- |
| `apiKey`              | `OPENROUTER_API_KEY`               | OpenRouter API key                      |
| `baseUrl`             | `OPENROUTER_BASE_URL`              | API base URL                            |
| `model`               | `OPENROUTER_MODEL`                 | Chat model                              |
| `appName`             | `AGENT_SDK_APP_NAME`               | Storage namespace                       |
| `embeddingModel`      | `OPENROUTER_EMBEDDING_MODEL`       | Memory embedding model                  |
| `maxTurns`            | `OPENROUTER_MAX_TURNS`             | Request-turn limit; `0` means unlimited |
| `autoWake`            | `OPENROUTER_AUTO_WAKE`             | Resume after a background job exits     |
| `emptyTurnRecovery`   | `OPENROUTER_EMPTY_TURN_RECOVERY`   | Retry empty terminal turns              |
| `temperature`         | `OPENROUTER_TEMPERATURE`           | Sampling temperature                    |
| `topP`                | `OPENROUTER_TOP_P`                 | Top-p sampling                          |
| `minP`                | `OPENROUTER_MIN_P`                 | Minimum probability sampling            |
| `topK`                | `OPENROUTER_TOP_K`                 | Top-k sampling                          |
| `frequencyPenalty`    | `OPENROUTER_FREQUENCY_PENALTY`     | Frequency penalty                       |
| `presencePenalty`     | `OPENROUTER_PRESENCE_PENALTY`      | Presence penalty                        |
| `repetitionPenalty`   | `OPENROUTER_REPETITION_PENALTY`    | Repetition penalty                      |
| `seed`                | `OPENROUTER_SEED`                  | Sampling seed                           |
| `maxCompletionTokens` | `OPENROUTER_MAX_COMPLETION_TOKENS` | Completion token limit                  |

Reasoning settings can be passed together:

```js
const agent = await createAgent({
  reasoning: {
    effort: 'high',
    maxTokens: 2048,
    exclude: false,
    enabled: true,
  },
});
```

The matching environment variables are
`OPENROUTER_REASONING_EFFORT`, `OPENROUTER_REASONING_MAX_TOKENS`,
`OPENROUTER_REASONING_EXCLUDE`, and `OPENROUTER_REASONING_ENABLED`.

Provider routing belongs under `provider`:

```js
const agent = await createAgent({
  provider: {
    order: ['Anthropic', 'Google'],
    only: ['Anthropic'],
    avoid: ['Provider A'],
    sort: 'latency',
    allowFallbacks: true,
    requireParameters: false,
    dataCollection: 'deny',
  },
});
```

The corresponding variables are `OPENROUTER_ORDER`, `OPENROUTER_ONLY`,
`OPENROUTER_PROVIDER_IGNORE`, `OPENROUTER_PROVIDER_SORT`,
`OPENROUTER_PROVIDER_ALLOW_FALLBACKS`,
`OPENROUTER_PROVIDER_REQUIRE_PARAMETERS`, and
`OPENROUTER_PROVIDER_DATA_COLLECTION`.

Use `storagePaths` to put memory, temporary state, or plugins in explicit
locations:

```js
const agent = await createAgent({
  storagePaths: {
    memoryDir: '/var/lib/my-agent/memory',
    tmpDir: '/var/lib/my-agent/tmp',
    pluginsDir: '/var/lib/my-agent/plugins',
  },
});
```

Agents restrict file access and sanitize child-process environments by
default. Setting `restricted: false` disables those checks and emits a warning.

## Custom logging

`createAgent({ logger })` accepts a Pino-style logger directly:

```js
import pino from 'pino';
import { createAgent } from '@af-t/agent-sdk';

const agent = await createAgent({
  apiKey: process.env.OPENROUTER_API_KEY,
  model: 'anthropic/claude-sonnet-4',
  logger: pino({ level: 'info' }),
});
```

A logger must provide `debug`, `info`, `warn`, and `error` methods. A `child`
method is optional. The SDK redacts known secrets before forwarding records.
It never closes, flushes, reconfigures, or otherwise takes ownership of a
consumer-supplied logger.

Without a custom logger, the SDK writes structured JSON records to the
console. Set `DEBUG=true` to include debug records.

## Tools

An agent created without a custom registry receives these tools:

| Tool             | Purpose                                                      |
| ---------------- | ------------------------------------------------------------ |
| `readFile`       | Read text and supported media, with line pagination for text |
| `writeFile`      | Create a file or replace it when explicitly allowed          |
| `editFile`       | Apply ordered replace, insert, or delete operations          |
| `findFiles`      | Search file names or contents                                |
| `listFiles`      | List a directory while respecting ignore rules               |
| `runShell`       | Run foreground or background shell commands                  |
| `delegateTask`   | Run a task in a subagent                                     |
| `manageJobs`     | List or stop background jobs                                 |
| `scheduleWakeup` | Schedule a nonblocking wake-up timer                         |
| `manageTodos`    | Store and update a JSON todo list                            |
| `loadSkill`      | List, search, or load instruction sets                       |
| `recallMemory`   | Rank stored memory files for a query                         |
| `fetchUrl`       | Fetch an HTTP or HTTPS URL with SSRF checks                  |
| `searchWeb`      | Search through Tavily or DuckDuckGo                          |

Every tool has exactly `{ name, description, inputSchema, execute }`.
Register one tool or an array with `agent.registerTools`:

```js
const wordCount = {
  name: 'wordCount',
  description: 'Count whitespace-separated words in text.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: { type: 'string', description: 'Text to count.' },
    },
  },
  execute: async ({ text }) => String(text.trim().split(/\s+/).filter(Boolean).length),
};

agent.registerTools(wordCount);
```

`registerTools` returns the agent. Tool output is truncated according to the
call's `outputLimit`, the execution context, or the agent's
`maxToolOutputChars`, in that order.

## MCP

Connect a command-based MCP server through the agent's registry:

```js
await agent.tools.connectMcpServer({
  name: 'local',
  command: 'node',
  args: ['./mcp-server.js'],
  env: { SERVICE_URL: 'https://service.example' },
});

const tools = agent.tools.listTools();
```

Remote tools are registered as `<server>.<tool>`. The SDK validates commands,
sanitizes the child environment, supports abort signals for tool calls, and
closes MCP clients during `agent.cleanup()`. A supplied registry can be
constructed directly with `ToolRegistry`.

## Memory

Memory files live in `.<appName>/memory` unless
`storagePaths.memoryDir` overrides the location. `MEMORY.md` is the index
injected on the first turn. Other Markdown files hold the full entries.

The agent does not write memories automatically. It uses `readFile`,
`writeFile`, and `editFile` for storage, while `recallMemory` ranks existing
entries. With an API key, recall uses embeddings and caches them in
`.embeddings.json`; if embedding fails for a reason other than cancellation,
recall falls back to lexical ranking.

See `examples/with-memory.js` and the bundled `using-memory` skill for the file
format and index rules.

## Automation

`createDaemon` turns source events into agent actions. Sources implement
`start(emit)` and `stop()`.

```js
import { createAgent, createDaemon, createTimerSource } from '@af-t/agent-sdk';

const agent = await createAgent();
const timer = createTimerSource({
  intervalMs: 60_000,
  event: { type: 'check' },
  immediate: true,
});

const daemon = createDaemon({
  agent,
  sources: [timer],
  handler: (event) => {
    if (event.type === 'check') {
      return { type: 'run', prompt: 'Check the current task queue.' };
    }
    return { type: 'ignore' };
  },
});

daemon.start();
```

The package also exports `createHttpSource`, `createFileWatchSource`, and
`createCopilot`. Stop a daemon with `await daemon.stop({ abort: true })` when
the host shuts down.

## Recording

Enable recording when creating an agent:

```js
const agent = await createAgent({
  record: {
    dir: './sessions',
    level: 'full',
    redact: (record) => record,
  },
});
```

Levels are `events`, `snapshots`, and `full`. You can also call
`agent.startRecording(options)` and `await agent.stopRecording()`.

Load a JSON Lines recording through the public `Recording` export:

```js
import { Recording } from '@af-t/agent-sdk';

const recording = await Recording.load('./sessions/session-example.jsonl');
console.log(recording.renderTrace());
```

`recording.snapshotAt(turn)`, `requestAt(turn)`, `responseAt(turn)`, and
`toolResult(toolCallId)` query captured data. `agent.forkAt(recording, turn)`
creates an agent from a stored snapshot.

## API reference

The package exports:

| Export                  | Role                                    |
| ----------------------- | --------------------------------------- |
| `createAgent`           | Create and configure an agent           |
| `ToolRegistry`          | Register, execute, and connect tools    |
| `SkillRegistry`         | Discover bundled and plugin skills      |
| `Recording`             | Load and inspect recorded sessions      |
| `recallMemories`        | Rank memory files without an agent      |
| `McpClientWrapper`      | Adapt an MCP process to registry tools  |
| `McpNativeClient`       | Send MCP JSON-RPC requests to a process |
| `createDaemon`          | Dispatch source events to agent actions |
| `createTimerSource`     | Emit timer events                       |
| `createHttpSource`      | Emit authenticated HTTP events          |
| `createFileWatchSource` | Emit debounced file events              |
| `createCopilot`         | Supervise an agent from another agent   |

Common agent methods:

| Method                           | Result                                                |
| -------------------------------- | ----------------------------------------------------- |
| `run(prompt, notify?, options?)` | Run or steer the conversation                         |
| `registerTools(tools)`           | Register one tool or an array                         |
| `steer(prompt)`                  | Queue a prompt for an active run                      |
| `subscribe(callback)`            | Subscribe to persistent events and receive a disposer |
| `registerInjector(injector)`     | Register an injector and receive a disposer           |
| `unregisterInjector(name)`       | Remove matching injectors                             |
| `onBeforeRequest(callback)`      | Register a request hook and receive a disposer        |
| `onStop(callback)`               | Register a terminal-turn hook and receive a disposer  |
| `onBackgroundExit(callback)`     | Register a background-exit listener                   |
| `startRecording(options)`        | Start recording and return the output path            |
| `stopRecording()`                | Stop recording and return the output path             |
| `forkAt(recording, turn)`        | Create an agent from a snapshot                       |
| `reset()`                        | Clear conversation and per-run state                  |
| `cleanup()`                      | Stop owned jobs, recorders, tools, and subagents      |

Streaming and subscription callbacks receive camel-case SDK events:

| Event field      | Meaning                                   |
| ---------------- | ----------------------------------------- |
| `contentDelta`   | New assistant text                        |
| `content`        | Assistant text accumulated so far         |
| `reasoningDelta` | New reasoning text                        |
| `reasoning`      | Reasoning text accumulated so far         |
| `toolCalls`      | Complete provider tool-call objects       |
| `toolStart`      | Tool name, call ID, and input             |
| `toolEnd`        | Tool result or error and duration         |
| `steerApplied`   | Number of queued steering prompts applied |
| `stopRecovery`   | Empty-turn recovery attempt               |
| `turnEnd`        | Terminal or tool-producing turn boundary  |

Objects inside `toolCalls` retain the provider's wire spelling.
`turnEnd` is sent to subscribers, not the one-run `notify` callback.

## Project structure

| Path                | Contents                                              |
| ------------------- | ----------------------------------------------------- |
| `src/agent/`        | Agent state, lifecycle, requests, jobs, and run loop  |
| `src/automation/`   | Daemon, copilot, HTTP, and file-watch sources         |
| `src/config/`       | Environment configuration                             |
| `src/integrations/` | MCP clients                                           |
| `src/memory/`       | Memory parsing and ranking                            |
| `src/recording/`    | Session recording and trace rendering                 |
| `src/registries/`   | Tool and skill registries                             |
| `src/skills/`       | Bundled skills and helper resources                   |
| `src/support/`      | Errors, logging, security, payload, and retry helpers |
| `src/tools/`        | Built-in tool implementations                         |
| `examples/`         | Runnable usage examples and sample plugins            |
| `tests/`            | Node test suites                                      |
