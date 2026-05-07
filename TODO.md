# 🗺️ Technical Debt & Improvements Roadmap

<div align="center">

![Status](https://img.shields.io/badge/Status-All%20Clear-brightgreen?style=for-the-badge)
![Tests](https://img.shields.io/badge/Tests-203%20✓-success?style=for-the-badge)
![Date](https://img.shields.io/badge/Updated-2025--05--07-blue?style=for-the-badge)
![Coverage](https://img.shields.io/badge/Pass%20Rate-100%25-brightgreen?style=for-the-badge)

> ✅ **All primary security hardening and testing suite bugs have been addressed.**
>
> `203 pass · 0 fail · 0 skip`

</div>

---

## 📋 Table of Contents

- [✅ Fixed: MCP Mock Server Tests](#-fixed-mcp-mock-server-tests-always-skipped)
- [🔒 Hardened: ensureSafePath](#-hardened-ensuresafepath-robustness)
- [⚡ Improved: Agent Tool Loop Limits](#-improved-agent-tool-loop-limits)
- [📊 Coverage Report](#-coverage-report)
- [🖥️ TUI Implementation Roadmap](#️-tui-implementation-roadmap-inkreact)
- [🔧 Maintenance](#-maintenance)

---

## ✅ Fixed: MCP Mock Server Tests Always Skipped

| Detail | Info |
|--------|------|
| **File** | `tests/core/mcp.test.js` |
| **Status** | ![Fixed](https://img.shields.io/badge/-FIXED-success) |

### 🔍 Fix Details

The test runner was skipping tests because the condition was evaluated at registration time. This was fixed by:

1. 📌 Moving the `skip` logic into the test body using `t.skip()`.
2. 🛠️ Fixing the mock server to send malformed JSON immediately during handshake to trigger expected timeout behavior.

---

## 🔒 Hardened: `ensureSafePath` Robustness

| Detail | Info |
|--------|------|
| **File** | `src/core/utils.js` |
| **Status** | ![Complete](https://img.shields.io/badge/-COMPLETE-blue) |

### 🛡️ Improvements

| Improvement | Description |
|-------------|-------------|
| 🔄 **Recursive Decoding** | Handled double-encoded traversals (e.g., `%252e%252e`) |
| 🔗 **Symlink Validation** | Added strict validation for symlink targets (including broken links) |
| 📂 **Root Access** | Fixed the bug that blocked access to the project root (`.`) |

---

## ⚡ Improved: Agent Tool Loop Limits

| Detail | Info |
|--------|------|
| **File** | `src/core/agent.js` |
| **Status** | ![Complete](https://img.shields.io/badge/-COMPLETE-blue) |

### 🎯 UX Enhancements

| Feature | Description |
|---------|-------------|
| 🎀 **Soft Limit** | Injects a system warning on the last turn to encourage a final summary |
| 🚧 **Structured Hard Break** | Returns `[LIMIT_REACHED]` tag instead of raw garbage when forced to stop |

---

## 📊 Coverage Report

<div align="center">

| Suite | Tests | ✅ Pass | ❌ Fail | ⏭️ Skip | Progress |
|-------|:-----:|:-------:|:-------:|:--------:|:--------:|
| **Agent** | 19 | 19 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **ToolRegistry** | 20 | 20 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **Bash tool** | 26 | 26 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **WebFetch tool** | 26 | 26 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **WebSearch tool** | 4 | 4 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **File tools** (edit/find/list/read/write) | 26 | 26 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **ensureSafePath** | 14 | 14 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **withRetry** | 12 | 12 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **SkillRegistry** | 15 | 15 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **MCP Client & Mock** | 12 | 12 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **Others** (Delegate, utils, env) | 21 | 21 | 0 | 0 | ![100%](https://progress-bar.dev/100/?title=done&width=100) |
| **Total** | **195** | **195** | **0** | **0** | ![100%](https://progress-bar.dev/100/?title=ALL+PASS&width=150&color=brightgreen) |

</div>

> ℹ️ *Note: Total count adjusted based on current test execution output*

---

## 🖥️ TUI Implementation Roadmap (Ink/React)

> Plan for upgrading the CLI SDK into a professional-grade TUI application.

### 📦 Phase 1: Core Logic Infrastructure

- [ ] **🔀 Streaming Support** — Refactor `Agent._request` and `Agent.run` to support streaming tokens (`stream: true`)
- [ ] **📡 Event Emitters** — Add an `EventEmitter` to the `Agent` class to emit:
  - `token` — When a new chunk of text arrives
  - `reasoning` — When thinking content arrives
  - `tool-start` — When a tool execution begins
  - `tool-end` — When tool results are ready
- [ ] **🏗️ Build Pipeline** — Setup `esbuild` or `swc` to transpile JSX/React code for Termux compatibility

### 🧠 Phase 2: State Management (The "Brain" for TUI)

- [ ] **🏪 Agent Store** — Create a hook or store to track:
  - Current message history
  - Real-time token/cost accumulation
  - Current active tool status
- [ ] **📦 Output Buffering** — Implement a buffer to handle rapid streaming without UI stutter

### 🎨 Phase 3: UI Components (Styling Focus)

#### 🏗️ Layout
- [ ] **📐 Sidebar/Header** — For Model Info & Cost
- [ ] **💬 Main Chat Area** — With auto-scroll
- [ ] **📊 Dynamic Bottom Bar** — For tool status

#### 🖱️ Interactivity
- [ ] **✏️ Multiline Input Field** — With history support
- [ ] **⏹️ Cancel Button** — Using `AbortController` integration

#### 🎭 Theming
- [ ] **📝 Markdown Rendering** — Using `ink-markdown`
- [ ] **🎨 Syntax Highlighting** — For code blocks
- [ ] **🔴 Redaction Visualizer** — Showing `***REDACTED***` in real-time

---

## 🔧 Maintenance (Ongoing)

- [x] ✅ Consistently use `t.skip()` for runtime-dependent skips
- [x] 🧹 Clean up unused variables and imports (ESLint compliance)
- [x] 🐧 Whitelist Termux specific environment variables (`LD_PRELOAD`, `PREFIX`)

---

<div align="center">

---

*📌 **Legend:*** ![Done](https://img.shields.io/badge/-✓_Done-brightgreen) • ![In Progress](https://img.shields.io/badge/-⬚_Pending-lightgrey) • ![Complete](https://img.shields.io/badge/-Complete-blue)

</div>
