---
name: using-memory
description: Persistent file-based memory protocol — when to save, how to format, taxonomy, injection mechanics, and best practices. Use when the LLM needs to persist knowledge across sessions or retrieve previously saved memories.
---

# Using Memory

## Overview

This skill covers the persistent file-based memory system. Memory files are stored as markdown files with YAML-like frontmatter in the memory directory (see `<system-reminder>` for the exact path). The LLM uses standard **Write/Read/Edit** tools to manage memory files, and the **RecallMemory** tool to search memories by meaning. Nothing is auto-created; you create files on demand.

Memory is injected into the LLM's context on every turn via the **injector system** — specifically the `memoryIndex` (first-turn) and `memoryHint` (first-turn) injectors. Their output is concatenated into a single `<system-reminder>…</system-reminder>` block that appears before the last user message content part. The `date` injector (per-turn) also adds the current timestamp.

## Core Principles

### Why File-Based?

| Approach | Trade-off |
|----------|-----------|
| File-based (current) | Durable across sessions, inspectable by user, version-controlled with git |
| Dedicated memory tools | Would bypass file-system safeguards like `ensureSafePath` |
| LLM-managed (Write/Read/Edit) | Same tools as everything else — no special machinery |

### How Memory Gets Into Context

```
Write/Read/Edit (you)
    ↓
memory files on disk (<memoryDir> — see system-reminder for the current path)
    ↓
memoryIndex injector reads MEMORY.md → first-turn <system-reminder>
memoryHint injector emits dir + types → first-turn <system-reminder>
    ↓
LLM sees index on the very first turn → reads relevant files on demand
```

### Key Constraints

- **You** create, read, update, and delete memory files using standard tools — the agent never auto-writes memories.
- **`ensureSafePath`** applies to all memory file operations (paths are validated against the project root).
- **Subagents** (spawned via Delegate) receive the same builtin injectors with defaults but **do not** inherit custom injectors, custom `memoryDir`, or `memoryTypes` from the parent agent.
- The `memoryIndex` injector reads `<memoryDir>/MEMORY.md` — if the file is missing or empty, it returns an empty string (no error).

### Memory Directory

The memory directory is configured via the `storagePaths.memoryDir` option on the Agent constructor. The path is resolved to an absolute path at construction time, including `~` expansion. Default: **`.<appName>/memory/`** (where `appName` defaults to `agent-sdk`) relative to the project root. Do not rely on this literal — the `memoryHint` injector emits the actual resolved path at runtime; use that.

The directory is read from `agent._memoryDir` and is always an absolute path. If the configured directory is outside the project root, it is registered in `agent.trustedPaths` so Read/Write/Edit tools can access it normally — you do not need to do anything special to read or write memory files there.

Subagents inherit the parent's appName-derived default memory directory (or the parent's `storagePaths.memoryDir`). If a subagent needs a different memory dir, pass the path explicitly in the delegate prompt.

---

## Available Memory Types

The set of valid types is **runtime-configurable** via the `memoryTypes` constructor option. The live list — with a description of when each type applies — is injected into your context on the first turn via the `memoryHint` injector. **Always consult the `<system-reminder>` block** for the current set before choosing a type for a new memory; the defaults are `user`, `feedback`, `project`, and `reference`, but a host application may have added or replaced them.

Files follow the naming pattern `<type>_<slug>.md` regardless of which types are in use.

---

## When to Save

Save a memory when you encounter something you'd want to know in a future conversation. Red flags / signals:

- **User feedback**: The user tells you how to work better, preferences, conventions, or corrections. Save as `feedback` type.
- **Project context**: Decisions, deadlines, ongoing work that isn't derivable from code or git history. Save as `project` type.
- **User profile**: Role, goals, knowledge level, communication preferences. Save as `user` type.
- **External references**: Dashboard URLs, tracker project links, channel names, API keys location (never the keys themselves). Save as `reference` type.
- **Repetition**: If you find yourself searching for the same information across sessions.

## When NOT to Save

- Information derivable from code or git (`package.json`, git log, file structure).
- Temporary runtime state (running processes, current time).
- Obvious project conventions already in CLAUDE.md or AGENT.md.
- Large documents or logs — link to them instead.
- Secrets, tokens, or passwords.

## File Format

Each memory file lives at `<memoryDir>/<type>_<slug>.md` with this structure:

```markdown
---
name: <kebab-case-slug>
description: <one-line summary used for relevance scan>
metadata:
  type: <one of the available types — see the system-reminder for the live list>
---

# <Title>

<Markdown body with the full memory content.>
```

- The `name` field must be a kebab-case slug matching the filename (without `.md`).
- The `description` is a one-line summary. The memory hint injector scans this for relevance.
- `metadata.type` must be one of the available types (see `<system-reminder>` for the live list).
- Frontmatter is parsed by hand (no YAML library). Values may be quoted with `'` or `"` (stripped). No nested values, no arrays.

## Index (MEMORY.md)

`<memoryDir>/MEMORY.md` is a one-line-per-memory index. It is read by the `memoryIndex` injector and shown to the LLM on the **first turn** of every conversation.

Format:

```markdown
# Memory Index

- [Some memory](<type>_some-memory.md) — One-line description of that memory.
- [Another memory](<type>_another-memory.md) — Another one-line summary.
```

**Rules:**

- Update this index **every time** you create, rename, or delete a memory file.
- Each line uses `[Display Name](slug.md)` markdown link syntax.
- The **link text** is a human-readable title, the **link destination** is the kebab-case slug filename.
- Keep descriptions short (≤ 80 chars).
- If MEMORY.md is missing or empty, the injector returns nothing — no error is raised.

### Example Index Output in Context

When injected, it appears inside a `<system-reminder>` block like this:

```markdown
<system-reminder>

## Memory index

- [Name is Sayu](feedback_name_sayu.md) — User renamed me to Sayu, prefer this name.
- [Setup notes](project_setup.md) — Initial project setup and dependencies.
- [API keys location](reference_api_keys.md) — Where to find API keys (never the keys themselves).

</system-reminder>
```

## Linking Between Memories

Use `[Display Name](<type>_slug.md)` markdown link syntax to reference other memories within a memory body. This helps the LLM follow related context.

Example:

```markdown
See [Setup](project_setup.md) for initial configuration steps.
```

## Stale Memory Guidance

- **Before recommending from memory**: verify the information is still current. Check git log, file timestamps, or run a quick Bash command.
- **If a memory is stale**: update it in-place (Edit tool) rather than creating a duplicate.
- **If a memory is obsolete**: delete the file and remove its line from MEMORY.md.

## Workflow

### Quick Start — Common Patterns

```markdown
<!-- Pattern A: Save user preference -->
Write `<memoryDir>/feedback_name_sayu.md`
(The exact path is shown in the `<system-reminder>` block on the first turn)
→ name: feedback-name-sayu
→ type: feedback
→ Body: "User renamed me to Sayu, prefer this name from now on"

Then update MEMORY.md:
→ "- [Name is Sayu](feedback_name_sayu.md) — User renamed me to Sayu."
```

```markdown
<!-- Pattern B: Save a project decision -->
Write `<memoryDir>/project_use-pnpm.md`
→ name: project-use-pnpm
→ type: project
→ Body: "Project uses pnpm, not npm. Reason: workspace support."

Then update MEMORY.md:
→ "- [Use pnpm](project_use-pnpm.md) — Project uses pnpm for workspaces."
```

### Saving a New Memory

1. Choose a kebab-case slug (e.g., `user-prefers-pnpm`).
2. Create `<memoryDir>/<type>_<slug>.md` with proper frontmatter and markdown body.
3. Add `- [Display Name](type_slug.md) — Short description` to MEMORY.md.

### Retrieving Memories

1. Check `<memoryDir>/MEMORY.md` index for relevant entries (already visible in first-turn context).
2. If you need the full content of specific memories or want to search memories by meaning, call the `RecallMemory` tool with a descriptive query.
3. Read specific memory files directly if you need to browse them, or rely on the tool's recalled bodies.
4. Verify the information is still current before acting on it.

### Updating a Memory

1. Read the existing memory file.
2. Use Edit to update the body content.
3. If the description changed, update both the frontmatter `description` and the MEMORY.md index line.

### Deleting a Memory

1. Delete the memory file.
2. Remove its line from MEMORY.md.

## Best Practices

1. **Keep descriptions under 80 characters** — They appear in the index and serve as quick-summary for relevance scanning.
2. **One concern per file** — Don't mix user preferences with project decisions in the same file. Split into separate type/slug files.
3. **Always update MEMORY.md immediately** — If you create/rename/delete a memory file but forget the index, the injector won't show it. Do it atomically.
4. **Prefer Edit over Write for updates** — Use Edit to surgically update frontmatter or body. Only use Write for brand-new files.
5. **Never store secrets** — API keys, tokens, passwords must never go into memory files. Use the env config or a dedicated `.env` file instead.
6. **Clean up stale memories** — Outdated info is worse than no info. Review and delete obsolete files periodically.
7. **Use consistent kebab-case slugs** — `user-preferred-editor`, not `userPreferredEditor` or `User Preferred Editor`.
8. **Subagents don't inherit custom memory config** — If a subagent needs access to memory, it must use the default directory or you must pass the info explicitly in the delegate prompt.
9. **File paths are validated by `ensureSafePath`** — For memory files within the project root, use relative paths. For files in a configured external `memoryDir`, use absolute paths — they are trusted via `trustedPaths` and accessible through Read/Write/Edit tools without any special handling.
10. **The index is first-turn only** — MEMORY.md is only injected on the very first turn of a conversation. If you update memories mid-conversation, the LLM won't see the updated index until the next conversation start.

## How It Works (Technical Details)

This section is for understanding the injection machinery — not required for daily use.

### Injectors Involved

| Injector | Scope | What It Does |
|----------|-------|-------------|
| `memoryIndex` | first-turn | Reads `<memoryDir>/MEMORY.md` and injects its content |
| `memoryHint` | first-turn | Emits the memory directory path + available memory types |
| `date` | per-turn | Injects `Current date: YYYY-MM-DD HH:MM UTC` |

### Injection Order

```
1. first-turn injectors run (only on turn 1 of a fresh conversation):
   a. memoryIndex  → content of MEMORY.md (or empty)
   b. memoryHint   → "Memory files are stored at <appName>/memory/..."
   c. skillList    → available skills (from SkillRegistry)

2. per-turn injectors run (every turn, including turn 1):
   a. date         → current timestamp

Outputs within a scope are joined with double-newlines and wrapped in a
single <system-reminder>...</system-reminder> block. First-turn and per-turn
each produce their own block (different lifecycles), so turn 1 typically
carries two blocks.
```

### System-Reminder Placement

The reminder block is inserted as a new text part **before** the last content part of the last user message. This ensures that `cache_control: { type: 'ephemeral' }` stays on the actual last element (the cache marker is never moved to accommodate the reminder).

### Subagent Behavior

Subagents (spawned via the Delegate tool) construct their own Agent with default injectors. They **do not** inherit:

- Custom `memoryDir` or `memoryTypes` from the parent
- Custom injectors registered via `registerInjector()`
- Custom `contextFiles` list

They do get the same builtin `memoryIndex`, `memoryHint`, `date`, `skillList`, and `contextFiles` injectors with **default settings** (so they fall back to the appName-derived memory dir).

## Resources

### references/

*(This directory can hold quick-reference files, similar to `code-remediation/references/` or `tmux/references/`.)*

Potential references to add:

- `memory-cheatsheet.md` — Quick-reference for file format, types, and common commands.

### scripts/

*(This directory can hold helper scripts, similar to other skills.)*

No scripts are currently provided — the Write/Read/Edit tools are sufficient for all memory operations.
