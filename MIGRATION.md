# Migration guide

This guide covers the JavaScript, tool, event, and configuration names removed
by the natural-English API redesign. Breaking changes are intentional. The
redesign ships no compatibility aliases for any removed name.

## Agent and tool contracts

Custom tools now expose exactly `{ name, description, inputSchema, execute }`.
Register them through `agent.registerTools`.

| Old name             | New name              |
| -------------------- | --------------------- |
| `agent.use`          | `agent.registerTools` |
| `input_schema`       | `inputSchema`         |
| `start_line`         | `startLine`           |
| `end_line`           | `endLine`             |
| `max_lines`          | `maxLines`            |
| `use_raw` / `useRaw` | `rawContent`          |
| `output_limit`       | `outputLimit`         |

For example:

```js
agent.registerTools({
  name: 'readSummary',
  description: 'Read a short summary.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      startLine: { type: 'number' },
      endLine: { type: 'number' },
    },
  },
  execute: async ({ startLine, endLine }) => `${startLine}:${endLine}`,
});
```

## Built-in tool names

| Old name       | New name         |
| -------------- | ---------------- |
| `Read`         | `readFile`       |
| `Write`        | `writeFile`      |
| `Edit`         | `editFile`       |
| `Find`         | `findFiles`      |
| `List`         | `listFiles`      |
| `Bash`         | `runShell`       |
| `Delegate`     | `delegateTask`   |
| `Jobs`         | `manageJobs`     |
| `Skill`        | `loadSkill`      |
| `Todo`         | `manageTodos`    |
| `RecallMemory` | `recallMemory`   |
| `WebFetch`     | `fetchUrl`       |
| `WebSearch`    | `searchWeb`      |
| `Wakeup`       | `scheduleWakeup` |

Update tool allowlists, saved prompts, tests, and any provider fixtures that
refer to these SDK-authored names.

## Configuration object

Environment variable names remain uppercase snake case. The object returned by
the environment loader uses camel case and nests reasoning and provider
settings.

| Old property                  | New property                 |
| ----------------------------- | ---------------------------- |
| `API_KEY`                     | `apiKey`                     |
| `BASE_URL`                    | `baseUrl`                    |
| `ORDER`                       | `provider.order`             |
| `ONLY`                        | `provider.only`              |
| `MODEL`                       | `model`                      |
| `APP_NAME`                    | `appName`                    |
| `EMBEDDING_MODEL`             | `embeddingModel`             |
| `MAX_TURNS`                   | `maxTurns`                   |
| `AUTO_WAKE`                   | `autoWake`                   |
| `EMPTY_TURN_RECOVERY`         | `emptyTurnRecovery`          |
| `EMPTY_TURN_RETRIES`          | `emptyTurnRetries`           |
| `TAVILY_API_KEY`              | `tavilyApiKey`               |
| `MAX_RETRIES`                 | `maxRetries`                 |
| `DEBUG`                       | `debug`                      |
| `TEMPERATURE`                 | `temperature`                |
| `TOP_P`                       | `topP`                       |
| `MIN_P`                       | `minP`                       |
| `TOP_K`                       | `topK`                       |
| `FREQUENCY_PENALTY`           | `frequencyPenalty`           |
| `PRESENCE_PENALTY`            | `presencePenalty`            |
| `REPETITION_PENALTY`          | `repetitionPenalty`          |
| `SEED`                        | `seed`                       |
| `MAX_COMPLETION_TOKENS`       | `maxCompletionTokens`        |
| `REASONING_EFFORT`            | `reasoning.effort`           |
| `REASONING_MAX_TOKENS`        | `reasoning.maxTokens`        |
| `REASONING_EXCLUDE`           | `reasoning.exclude`          |
| `REASONING_ENABLED`           | `reasoning.enabled`          |
| `PROVIDER_ALLOW_FALLBACKS`    | `provider.allowFallbacks`    |
| `PROVIDER_REQUIRE_PARAMETERS` | `provider.requireParameters` |
| `PROVIDER_DATA_COLLECTION`    | `provider.dataCollection`    |
| `PROVIDER_IGNORE`             | `provider.avoid`             |
| `PROVIDER_AVOID`              | `provider.avoid`             |
| `PROVIDER_SORT`               | `provider.sort`              |

Numeric environment values are parsed as numbers. Invalid numeric values now
raise `ConfigError`. The configuration object and its nested objects are
frozen.

## Event names

SDK-authored event envelopes use camel case. Provider tool-call objects inside
`toolCalls` still use the provider's snake-case wire format.

| Old event field   | New event field  |
| ----------------- | ---------------- |
| `content_delta`   | `contentDelta`   |
| `reasoning_delta` | `reasoningDelta` |
| `tool_calls`      | `toolCalls`      |
| `tool_start`      | `toolStart`      |
| `tool_end`        | `toolEnd`        |
| `steer_applied`   | `steerApplied`   |
| `stop_recovery`   | `stopRecovery`   |
| `turn_end`        | `turnEnd`        |

Event metadata follows the same rule. For example, `tool_call_id`,
`duration_ms`, and `finish_reason` became `toolCallId`, `durationMs`, and
`finishReason` when they are part of an SDK event.

## Recordings

The persisted event vocabulary changed with the event envelope. Sessions
recorded by earlier builds no longer replay in this version. Start a fresh
recording after upgrading.

Provider-shaped request payloads, response bodies, `agent.messages` entries,
and provider tool-call objects keep their wire spelling. This exception does
not apply to SDK-authored recording metadata.

## Module layout

Memory modules live under `src/memory`, recording modules under
`src/recording`, and automation modules under `src/automation`. Consumers
should import supported exports from `@af-t/agent-sdk` instead of reaching into
these directories.

`createAgent({ logger })` accepts a Pino-style logger directly. The SDK wraps
the logger for redaction but does not close, flush, or reconfigure it.
