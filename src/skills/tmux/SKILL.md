---
name: tmux
description: Terminal multiplexer (tmux) usage for managing persistent terminal sessions, running background processes, and maintaining long-running programs that require PTY access. Use when the agent needs to run long-lived processes, maintain multiple terminal sessions, detach/reattach to running programs, or manage processes that need to survive shell session termination.
---

# Tmux

## Overview

Tmux is a terminal multiplexer that allows you to run and manage multiple terminal sessions within a single shell. This skill teaches you how to use tmux effectively via the `Bash` tool to:

- Run long-lived processes that survive agent shell termination
- Manage multiple parallel terminal sessions
- Control interactive programs that require a PTY (pseudo-terminal)
- Detach from processes and reattach later
- Run programs in the background without blocking the agent's shell

## Core Principles

### Why tmux for AI Agents?

The agent's `Bash` tool runs commands in ephemeral shells. When a command completes or times out, the session is destroyed. Tmux solves this:

```
Bash(tmux) → creates persistent session → survives timeout/detach
                                     → reattach later with new Bash call
                                     → program keeps running in background
```

### When to Use Tmux

| Scenario                           | Without tmux          | With tmux                    |
| ---------------------------------- | --------------------- | ---------------------------- |
| Long-running build/test            | Timeout kills process | Process continues in session |
| Interactive program (nano, htop)   | No PTY available      | Full PTY support via tmux    |
| Multiple parallel tasks            | Sequential only       | Parallel sessions            |
| Reconnect to running process       | Not possible          | `tmux attach` works          |
| Background server (dev server, db) | Dies with shell       | Persists in tmux session     |

## Quick Start

### Basic Session Lifecycle

```bash
# Create a new named session (detached)
tmux new-session -d -s mysession

# Run a command inside the session
tmux send-keys -t mysession "npm run dev" Enter

# Check if session is still running
tmux list-sessions

# View output (last N lines)
tmux capture-pane -t mysession -p -S -50

# Attach to session (interactive)
tmux attach-session -t mysession

# Kill session when done
tmux kill-session -t mysession
```

### Pattern: Run and Monitor

```bash
# Step 1: Create session and start process
tmux new-session -d -s build
tmux send-keys -t build "npm run build 2>&1" Enter

# Step 2: Wait and check output
sleep 30
tmux capture-pane -t build -p -S -30

# Step 3: If still running, wait more; if done, check result
tmux capture-pane -t build -p -S -50
```

### Pattern: Interactive Program

```bash
# Start nano in a tmux session (gets a real PTY)
tmux new-session -d -s editor
tmux send-keys -t editor "nano /path/to/file" Enter

# Send keystrokes (Ctrl+O to save, then Enter, then Ctrl+X to exit)
tmux send-keys -t editor C-o
sleep 0.5
tmux send-keys -t editor Enter
sleep 0.5
tmux send-keys -t editor C-x

# Wait for completion
sleep 2
tmux capture-pane -t editor -p -S -20
```

## Common Operations

### Session Management

```bash
# List all sessions
tmux list-sessions

# List sessions with more detail
tmux list-sessions -F "#{session_name}: #{session_windows} windows (#{session_attached} attached)"

# Create detached session
tmux new-session -d -s <name>

# Create session in specific directory
tmux new-session -d -s <name> -c /path/to/dir

# Rename session
tmux rename-session -t <oldname> <newname>

# Kill session
tmux kill-session -t <name>

# Kill all sessions except current
tmux kill-session -a

# Kill all sessions entirely
tmux kill-server
```

### Sending Commands

```bash
# Send text (adds newline)
tmux send-keys -t <session> "command" Enter

# Send text without Enter (for building a command)
tmux send-keys -t <session> "echo hello"

# Send special keys
tmux send-keys -t <session> C-c        # Ctrl+C (interrupt)
tmux send-keys -t <session> C-d        # Ctrl+D (EOF)
tmux send-keys -t <session> C-z        # Ctrl+Z (suspend)
tmux send-keys -t <session> Escape     # Escape key
tmux send-keys -t <session> Backspace  # Backspace
tmux send-keys -t <session> Tab        # Tab
tmux send-keys -t <session> Enter      # Enter (same as pressing Enter)

# Wait for a target string before sending more
# Use a loop with capture-pane to check output
```

### Reading Output

```bash
# Capture last N lines
tmux capture-pane -t <session> -p -S -50

# Capture entire pane content
tmux capture-pane -t <session> -p

# Capture and save to file
tmux capture-pane -t <session> -p -S -100 > /tmp/output.txt

# Start capturing new output (save mode)
tmux capture-pane -t <session> -p -S -0 > /tmp/full_output.txt

# Pipe captured output to process
tmux capture-pane -t <session> -p | tail -20
```

### Window Management

```bash
# Create new window in session
tmux new-window -t <session> -n <windowname>

# Create window in specific directory
tmux new-window -t <session> -c /path/to/dir

# Rename window
tmux rename-window -t <session>:<window-index> <newname>

# Select window
tmux select-window -t <session>:<window-index>

# List windows in a session
tmux list-windows -t <session>

# Kill window
tmux kill-window -t <session>:<window-index>

# Send keys to specific window
tmux send-keys -t <session>:<window-index> "command" Enter
```

### Split Panes

```bash
# Split horizontally (side by side)
tmux split-window -h -t <session>

# Split vertically (top/bottom)
tmux split-window -v -t <session>

# Split in specific directory
tmux split-window -h -t <session> -c /path/to/dir

# Send command to specific pane
tmux send-keys -t <session>:<window>.<pane> "command" Enter

# Select pane
tmux select-pane -t <session>:<window>.<pane>

# Kill pane (exits shell in that pane)
tmux kill-pane -t <session>:<window>.<pane>
```

## Advanced Patterns

### Pattern: Non-blocking Long Process

When a Bash command might timeout, use tmux to run it asynchronously:

```bash
# Instead of: npm run build (might timeout)
# Do this:
tmux new-session -d -s build 2>/dev/null
tmux send-keys -t build "cd /project && npm run build 2>&1 | tail -100" Enter

# Check progress periodically
for i in 1 2 3 4 5; do
  sleep 10
  output=$(tmux capture-pane -t build -p -S -5 2>/dev/null)
  echo "Check $i: $output"
  # Check if process finished
  if tmux capture-pane -t build -p -S -1 | grep -q "Finished\|error\|Error\|Done\|done"; then
    break
  fi
done

# Final output
tmux capture-pane -t build -p -S -50
tmux kill-session -t build
```

### Pattern: Parallel Tasks

Run multiple tasks simultaneously:

```bash
# Create sessions for each task
tmux new-session -d -s task1
tmux new-session -d -s task2
tmux new-session -d -s task3

# Start tasks
tmux send-keys -t task1 "npm run lint" Enter
tmux send-keys -t task2 "npm run test" Enter
tmux send-keys -t task3 "npm run build" Enter

# Check all outputs
for s in task1 task2 task3; do
  echo "=== $s ==="
  tmux capture-pane -t $s -p -S -10
  echo ""
done
```

### Pattern: Server Process Management

```bash
# Start a dev server in a session
tmux new-session -d -s server
tmux send-keys -t server "cd /project && npm run dev" Enter

# Confirm it started
sleep 3
tmux capture-pane -t server -p -S -10

# Later, check if still running
if tmux has-session -t server 2>/dev/null; then
  echo "Server is still running"
  tmux capture-pane -t server -p -S -5
else
  echo "Server session ended"
fi

# Gracefully stop
tmux send-keys -t server C-c
sleep 2
tmux kill-session -t server
```

## Best Practices

1. **Always use named sessions** - Never rely on default session numbers. Use `-s <descriptive-name>`.

2. **Detach by default** - Create sessions with `-d` (detached) so the Bash tool returns immediately.

3. **Check session existence first** - Before sending to a session, verify it exists:

   ```bash
   if tmux has-session -t mysession 2>/dev/null; then
     tmux send-keys -t mysession "command" Enter
   fi
   ```

4. **Add sleep between send and capture** - Tmux output is asynchronous. Always add `sleep 0.5-2` between sending a command and capturing output.

5. **Limit capture lines** - Use `-S -N` to limit output (e.g., `-S -50` for last 50 lines) to avoid context overflow.

6. **Clean up sessions** - Kill sessions when done to avoid accumulating stale sessions.

7. **Redirect stderr** - When running commands in tmux, redirect stderr: `command 2>&1` to see errors in captured output.

8. **Use 2>/dev/null for session creation** - Suppress "duplicate session" errors:

   ```bash
   tmux new-session -d -s mysession 2>/dev/null
   ```

9. **Check if tmux is available** - Verify tmux exists:
   ```bash
   command -v tmux >/dev/null 2>&1 || { echo "tmux not installed"; exit 1; }
   ```

## Resources

### scripts/tmux_helper.sh

A bash helper script for common tmux operations. Use this for reliable, repeatable tmux workflows:

- `session_create <name> [directory]` - Create a detached session
- `session_send <name> <command>` - Send a command to a session
- `session_read <name> [lines]` - Read last N lines from a session
- `session_wait <name> <target_string> [timeout]` - Wait for output pattern
- `session_kill <name>` - Kill a session
- `session_run <name> <command> [timeout]` - Run command in session and wait for completion

### references/tmux-cheatsheet.md

Quick reference for all tmux commands and patterns used in this skill.
