# 🖥️ TUI Implementation Plan — OpenRouter Agent SDK

> **Vision:** Transform the current CLI SDK into a professional-grade Terminal User Interface (TUI) application using **Ink** + **React**, delivering a rich interactive experience for AI agent interactions.

---

## 📐 Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                        TERMINAL USER                          │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                      INK/RENDERER                             │
│  (Virtual DOM → Terminal output via Yoga layout engine)      │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                    COMPONENT TREE                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐   │
│  │   Sidebar    │  │  Chat Area   │  │   Status Bar     │   │
│  │  · Model     │  │ · Messages   │  │  · Tool Status   │   │
│  │  · Cost      │  │ · Streaming  │  │  · Connection    │   │
│  │  · Tokens    │  │ · Markdown   │  │  · Abort Button  │   │
│  └──────────────┘  └──────────────┘  └──────────────────┘   │
│  ┌──────────────────────────────────────────────────────┐    │
│  │                   Input Area                         │    │
│  │  · Multiline Input · History · Send/Cancel           │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                    STATE LAYER (Zustand)                      │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐  │
│  │ Agent Store │ │ Session Store│ │    UI Store          │  │
│  │ · messages  │ │ · history    │ │ · theme              │  │
│  │ · streaming │ │ · configs    │ │ · layout             │  │
│  │ · tokens    │ │ · sessions   │ │ · focus              │  │
│  └─────────────┘ └──────────────┘ └──────────────────────┘  │
└──────────────────────────┬───────────────────────────────────┘
                           │
┌──────────────────────────▼───────────────────────────────────┐
│                    AGENT ENGINE (Existing)                    │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────────┐   │
│  │ Agent._req │  │ Agent.run    │  │  ToolRegistry      │   │
│  │ (streaming)│  │ (event emit) │  │  (existing)        │   │
│  └────────────┘  └──────────────┘  └────────────────────┘   │
└──────────────────────────────────────────────────────────────┘
```

---

## 🧱 Component Tree

```
<App>
  ├── <FullScreen>                    // Full terminal capture
  │   ├── <Box flexDirection="row">
  │   │   ├── <Sidebar width={30}>    // Left panel
  │   │   │   ├── <ModelInfo />       // Model name & provider
  │   │   │   ├── <CostTracker />     // Real-time cost/tokens
  │   │   │   ├── <SessionList />     // Session history
  │   │   │   └── <Settings />        // Quick settings
  │   │   │
  │   │   ├── <Box flexDirection="column" flexGrow={1}>
  │   │   │   ├── <ChatArea />        // Main content
  │   │   │   │   ├── <MessageList>
  │   │   │   │   │   ├── <UserMessage />    // User input display
  │   │   │   │   │   ├── <AssistantMessage> // AI response
  │   │   │   │   │   │   ├── <MarkdownRenderer />
  │   │   │   │   │   │   ├── <CodeBlock />  // With syntax highlight
  │   │   │   │   │   │   └── <ReasoningBlock /> // Collapsible thinking
  │   │   │   │   │   ├── <ToolCallMessage />  // Tool execution
  │   │   │   │   │   │   ├── <ToolSpinner />   // Animated spinner
  │   │   │   │   │   │   └── <ToolResult />    // Collapsible result
  │   │   │   │   │   └── <SystemMessage />
  │   │   │   │   └── <AutoScroll />   // Scroll anchor
  │   │   │   │
  │   │   │   └── <InputArea>         // Bottom input
  │   │   │       ├── <TextInput />   // Multiline input
  │   │   │       ├── <SendButton />  // Send / Ctrl+Enter
  │   │   │       └── <CancelButton /> // AbortController
  │   │   │
  │   │   └── <StatusBar height={1}>  // Bottom status line
  │   │       ├── <ToolStatus />      // "Running: bash..."
  │   │       ├── <ConnectionStatus /> // "● Connected"
  │   │       └── <Keybindings />     // "Ctrl+N New | Ctrl+Q Quit"
  │   └── ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
```

---

## 🔄 Data Flow

```
                    ┌────────────────────────────────────────┐
                    │          USER INTERACTION              │
                    │  (keyboard input, scroll, resize)      │
                    └────────────────┬───────────────────────┘
                                     │
                    ┌────────────────▼───────────────────────┐
                    │         INPUT HANDLER                  │
                    │  · TextInput onChange                  │
                    │  · useInput() for global keys          │
                    │  · Enter → submit, Ctrl+C → cancel     │
                    └────────────────┬───────────────────────┘
                                     │
                    ┌────────────────▼───────────────────────┐
                    │         STATE DISPATCH                 │
                    │  · zustand store actions               │
                    │  · agentStore.run(prompt)              │
                    └────────────────┬───────────────────────┘
                                     │
                    ┌────────────────▼───────────────────────┐
                    │      EVENT EMITTER (Agent class)       │
                    │                                        │
                    │   ┌──────────┐    ┌───────────────┐   │
                    │   │  token   │───▶│  tokenBuffer  │   │
                    │   ├──────────┤    │  accumulate   │   │
                    │   │reasoning │───▶│  store.set    │   │
                    │   ├──────────┤    └───────────────┘   │
                    │   │tool-start│───▶│  store.setTool │   │
                    │   ├──────────┤    └───────────────┘   │
                    │   │ tool-end │───▶│  store.addMsg  │   │
                    │   ├──────────┤    └───────────────┘   │
                    │   │  done    │───▶│  store.finalize│   │
                    │   └──────────┘                        │
                    └────────────────┬───────────────────────┘
                                     │
                    ┌────────────────▼───────────────────────┐
                    │      REACT RE-RENDER (Virtual DOM)     │
                    │  · Diff changes → Yoga layout          │
                    │  · Write to terminal stdout            │
                    └────────────────────────────────────────┘
```

---

## 🗂️ File Structure Plan

```
src/
├── tui/                              # New TUI directory
│   ├── index.js                      # TUI entry point
│   ├── app.jsx                       # Root component
│   │
│   ├── components/
│   │   ├── layout/
│   │   │   ├── sidebar.jsx           # Left sidebar
│   │   │   ├── chat-area.jsx         # Main chat container
│   │   │   ├── input-area.jsx        # Bottom input
│   │   │   └── status-bar.jsx        # Bottom status line
│   │   │
│   │   ├── messages/
│   │   │   ├── message-list.jsx      # Virtualized message list
│   │   │   ├── user-message.jsx      # User bubble
│   │   │   ├── assistant-message.jsx # AI response bubble
│   │   │   ├── tool-call.jsx         # Tool execution display
│   │   │   └── system-message.jsx    # System notifications
│   │   │
│   │   └── shared/
│   │       ├── markdown.jsx          # Markdown renderer
│   │       ├── code-block.jsx        # Syntax highlighted code
│   │       ├── reasoning-block.jsx   # Collapsible reasoning
│   │       ├── spinner.jsx           # Animated spinner
│   │       └── progress-bar.jsx      # Token/progress bar
│   │
│   ├── hooks/
│   │   ├── use-agent.js              # Agent event subscription
│   │   ├── use-stream.js             # Streaming buffer management
│   │   ├── use-history.js            # Input history navigation
│   │   └── use-abort.js              # AbortController integration
│   │
│   ├── stores/
│   │   ├── agent-store.js            # Zustand: agent state
│   │   ├── session-store.js          # Zustand: session history
│   │   └── ui-store.js               # Zustand: UI preferences
│   │
│   ├── utils/
│   │   ├── emitter.js                # EventEmitter wrapper
│   │   ├── buffer.js                 # Token buffer/accumulator
│   │   ├── colors.js                 # Theme color definitions
│   │   └── keybindings.js            # Keyboard shortcut map
│   │
│   └── themes/
│       ├── default.js                # Default theme
│       └── dracula.js                # Dracula theme (example)
│
├── core/                             # Existing core (modified)
│   ├── agent.js                      # + EventEmitter, stream support
│   └── ...                           # (unchanged)
│
└── index.js                          # Updated entry: CLI or TUI?
```

---

## 🎯 Phased Implementation Roadmap

### Phase 0: Foundation ⚙️

> **Goal:** Set up build pipeline and modify Agent class for TUI compatibility.

| # | Task | Description | Dependencies |
|---|------|-------------|--------------|
| 0.1 | **Build Pipeline** | Setup `esbuild` to transpile JSX for Termux/Node | — |
| 0.2 | **Install Ink** | Add `ink`, `ink-markdown`, `ink-text-input` deps | 0.1 |
| 0.3 | **Event Emitter** | Add `EventEmitter` to Agent class | — |
| 0.4 | **Streaming Support** | Refactor `_request` to handle `stream: true` SSE | 0.3 |
| 0.5 | **Notify Callback** | Replace notify fn with event-driven architecture | 0.3 |

**Files modified:** `package.json`, `src/core/agent.js`  
**Files created:** `src/tui/`, `esbuild.config.js`

---

### Phase 1: State Management 💾

> **Goal:** Robust state layer that the UI can subscribe to.

| # | Task | Description | Dependencies |
|---|------|-------------|--------------|
| 1.1 | **Agent Store** | Zustand store for messages, streaming token, cost | 0.3 |
| 1.2 | **Output Buffer** | Ring buffer for rapid streaming chunks (debounce 50ms) | 1.1 |
| 1.3 | **Session Store** | Persist session history to disk (JSON) | 1.1 |
| 1.4 | **UI Store** | Theme, sidebar visibility, layout preferences | — |

**Files created:** `src/tui/stores/*`

---

### Phase 2: Core Components 🧩

> **Goal:** All UI components built and functional.

| # | Task | Description | Dependencies |
|---|------|-------------|--------------|
| 2.1 | **App Shell** | `FullScreen` + flex layout with resize handling | 0.1, 0.2 |
| 2.2 | **Sidebar** | Model info, cost tracker, token usage | — |
| 2.3 | **Chat Area** | Message list with auto-scroll-to-bottom | 1.1 |
| 2.4 | **Message Bubbles** | User/Assistant/Tool/System rendering | 2.3 |
| 2.5 | **Markdown Render** | `ink-markdown` integration with code blocks | 2.4 |
| 2.6 | **Streaming Display** | Real-time token-by-token rendering | 2.4, 1.2 |
| 2.7 | **Input Area** | Multiline input, send on Enter, history (↑↓) | — |
| 2.8 | **Status Bar** | Tool execution status, connection indicator | 0.3 |
| 2.9 | **Cancel Button** | AbortController integration | 2.7, 0.4 |

**Files created:** `src/tui/components/*`

---

### Phase 3: Interactions & Polish ✨

> **Goal:** Delightful UX with keyboard shortcuts, theming, and smooth animations.

| # | Task | Description | Dependencies |
|---|------|-------------|--------------|
| 3.1 | **Keyboard Shortcuts** | `Ctrl+N` new session, `Ctrl+D` delete, `Ctrl+Q` quit | 2.1 |
| 3.2 | **Reasoning Block** | Collapsible `thinking` content with `▼/▶` toggle | 2.4 |
| 3.3 | **Tool Visualizer** | Spinner during execution, expandable result | 2.6 |
| 3.4 | **Redaction Display** | Show `***REDACTED***` for sensitive tool calls | 2.4 |
| 3.5 | **Theming System** | Multiple themes (default, dracula, monokai) | 2.1 |
| 3.6 | **Session Management** | Save/load sessions, session browser in sidebar | 1.3 |
| 3.7 | **Search** | `Ctrl+F` search within messages | 2.3 |

---

### Phase 4: Production Hardening 🛡️

> **Goal:** Battle-test the TUI for daily driver usage.

| # | Task | Description | Dependencies |
|---|------|-------------|--------------|
| 4.1 | **Error Boundaries** | React error boundaries for graceful crash recovery | 2.1 |
| 4.2 | **Terminal Resize** | Handle `SIGWINCH` for responsive layout | 2.1 |
| 4.3 | **Performance** | Virtual scrolling for large message lists | 2.3 |
| 4.4 | **Testing** | Unit + integration tests with `ink-testing-library` | All |
| 4.5 | **Documentation** | Usage guide, config, keybindings reference | All |

---

## 🔬 Technical Decisions

### Why Ink over Blessed/React-Blessed?

| Factor | Ink | Blessed |
|--------|-----|---------|
| **React integration** | Native (JSX) | Requires adapters |
| **Performance** | Yoga layout (fast) | Custom layout (slower) |
| **Maintenance** | Active (18k+ ⭐) | Low activity |
| **Streaming** | Good (incremental render) | Full re-render |
| **Termux compat** | ✅ Works in Termux | ⚠️ May need patches |

### Why Zustand over Redux/Context?

- **Minimal boilerplate** — Direct store creation without providers
- **No provider wrapping** — Works better with Ink's component tree
- **Selective subscriptions** — Avoids unnecessary re-renders
- **Middleware** — Built-in persist middleware for session storage

### Token Buffer Design

```
Stream chunks ──▶ RingBuffer(100) ──▶ Debounce(50ms) ──▶ Store set
                                                              │
                                                     React re-render
```

- **Ring buffer** prevents memory blow on rapid streaming
- **Debounce** batches rapid tokens to avoid layout thrashing
- **Store** holds the current accumulated message for rendering

---

## ⚡ Quick Start (for implementation)

```bash
# Install dependencies
npm install ink ink-markdown ink-text-input zustand

# Install esbuild for JSX build
npm install --save-dev esbuild

# Build TUI
node esbuild.config.js

# Run TUI
node src/tui/index.js
```

---

## 🔗 Dependencies Reference

| Package | Version | Purpose |
|---------|---------|---------|
| `ink` | ^5.x | React for terminal |
| `ink-markdown` | ^1.x | Markdown rendering |
| `ink-text-input` | ^5.x | Text input component |
| `zustand` | ^5.x | State management |
| `esbuild` | ^0.25.x | JSX transpilation |

---

## 🧪 Testing Strategy

```bash
# Unit tests for stores
node --test src/tui/stores/*.test.js

# Component tests (ink-testing-library)
node --test src/tui/components/**/*.test.js

# Integration: full TUI flow
node --test src/tui/*.test.js
```

- **Store tests:** Pure logic, no terminal required
- **Component tests:** Use `ink-testing-library` for snapshot renders
- **E2E:** Manual testing with `script(1)` recording for regression

---

<div align="center">

## 📊 Progress Tracker

| Phase | Status | Tasks |
|-------|--------|-------|
| **Phase 0** Foundation | ⬜ Not started | 5 tasks |
| **Phase 1** State Management | ⬜ Not started | 4 tasks |
| **Phase 2** Core Components | ⬜ Not started | 9 tasks |
| **Phase 3** Interactions & Polish | ⬜ Not started | 7 tasks |
| **Phase 4** Production Hardening | ⬜ Not started | 5 tasks |
| **Total** | **0%** | **30 tasks** |

</div>

---

> 📝 **Last updated:** 2025-05-07
> 
> 🔗 **Related:** [TODO.md](./TODO.md) — Technical debt & improvements
