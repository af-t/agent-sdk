---
name: using-memory
description: Store and retrieve durable Markdown memories through the agent's file tools and memory index.
---

# Using memory

Memory is a set of Markdown files managed through `writeFile`, `readFile`, and
`editFile`. The agent does not create or update these files on its own.
`recallMemory` searches existing entries without modifying them.

The first-turn system reminder gives the absolute memory directory and the
available memory types. Use that runtime information instead of assuming a
path or type list.

## What belongs in memory

Save information that should survive into another conversation and is not
available from the repository itself. Good candidates include:

- user preferences or corrections;
- project decisions and deadlines that are absent from code and git history;
- a user's role, goals, or communication preferences;
- links and names for external dashboards, trackers, or channels.

Do not store secrets, credentials, transient process state, logs, or facts that
can be read from the repository. Link to a large document instead of copying it
into a memory file.

The default types are `user`, `feedback`, `project`, and `reference`, but the
host can add or replace them through `memoryTypes`. Read the live type list in
the system reminder before choosing one.

## Directory and access

`storagePaths.memoryDir` sets the directory. Without it, the agent uses
`.<appName>/memory`, where `appName` defaults to `agent-sdk`. The constructor
resolves the path to an absolute path and expands a leading `~`.

An external configured directory is added to the agent's trusted paths. File
tools still pass access through `resolveSafePath`, so use the exact directory
from the system reminder.

The first-turn `memoryIndex` injector reads `<memoryDir>/MEMORY.md`. A missing
or empty index produces no index text and no error. The `memoryHint` injector
adds the directory and type list on the same first turn.

## Memory file format

Store each entry at:

```text
<memoryDir>/<type>_<slug>.md
```

Use a short kebab-case slug. A memory file has this form:

```markdown
---
name: prefers-pnpm
description: User prefers pnpm for this project.
metadata:
  type: user
---

# Package manager preference

The user prefers pnpm for this project because it uses workspaces.
```

The top-level `description` is used during recall. Keep it to one line and make
it specific enough to distinguish the entry. `metadata.type` should match one
of the types from the current system reminder.

Frontmatter parsing is deliberately small. Keep scalar values on one line.
Single or double quotes around a scalar are accepted, but arrays and general
YAML features are not.

Keep one concern in each file. This makes index entries and recall results
useful without loading unrelated personal or project context.

## MEMORY.md

`MEMORY.md` is a one-line-per-entry index:

```markdown
# Memory index

- [Package manager preference](user_prefers-pnpm.md): User prefers pnpm for this project.
- [Release dashboard](reference_release-dashboard.md): Link to the release status dashboard.
```

Update the index in the same task whenever you create, rename, or delete a
memory file. Each link target is relative to the memory directory. Keep the
description short enough to scan quickly.

The index is injected only on the first turn of a conversation. If you update
it during an active conversation, the new index appears when a fresh
conversation starts.

## Save an entry

1. Read the memory directory and `MEMORY.md` if they exist.
2. Select a current memory type and a distinct slug.
3. Create the entry with `writeFile`.
4. Add its link to `MEMORY.md` with `editFile`, or create the index if needed.
5. Read the changed files when the file tools require a read-before-edit
   workflow.

Example targets:

```text
<memoryDir>/feedback_prefers-short-updates.md
<memoryDir>/MEMORY.md
```

Do not put an API key, token, password, or credential location containing the
secret itself in either file.

## Retrieve entries

The first-turn index may already identify the file you need. Use `readFile`
when you know the exact entry.

Use `recallMemory` for a meaning-based search:

```json
{
  "query": "package manager preference for this project",
  "limit": 5
}
```

Recall returns complete memory bodies ranked by relevance. With an API key, it
uses embeddings and caches vectors in `.embeddings.json`. When embedding fails
for a reason other than cancellation, it falls back to lexical ranking.
Cancellation still propagates to the caller.

Verify a remembered fact before using it when the underlying information may
have changed. Check the referenced system, repository, or timestamp rather
than presenting stale memory as current.

## Update or remove entries

For an update:

1. Read the existing file.
2. Edit the body and top-level description together when both changed.
3. Update the `MEMORY.md` description if it no longer matches.

For removal, delete the entry and its index line. If two entries describe the
same concern, merge them instead of keeping competing versions.

## Injector behavior

The relevant built-in injectors are:

| Injector      | Scope      | Output                                                   |
| ------------- | ---------- | -------------------------------------------------------- |
| `memoryIndex` | first turn | Contents of `MEMORY.md`                                  |
| `memoryHint`  | first turn | Directory, type list, and instruction to load this skill |
| `date`        | each turn  | Current UTC date and time                                |

Injector output is wrapped in `<system-reminder>` and inserted before the last
content part of the latest user message. The last part stays in place so an
existing provider cache marker remains last.

## Subagents

`delegateTask` passes the parent's `storagePaths` and `appName` to a new
subagent, so a configured memory directory is shared. The subagent also uses
the shared tool and skill registries.

It does not copy custom `memoryTypes`, custom injectors, or a custom
`contextFiles` list. Its built-in injectors use their default options. Put any
nondefault type or context requirement in the delegated prompt if the
subagent needs it.
