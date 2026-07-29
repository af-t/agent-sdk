---
name: tmux
description: Manage named tmux sessions for interactive programs and processes that must remain available across shell calls.
---

# Tmux

Use tmux when a process needs an interactive terminal or a named session that
you can inspect and control later. For an ordinary background command,
`runShell` with `background: true` is simpler and integrates with
`manageJobs`.

Check that tmux is installed:

```bash
command -v tmux
```

## Session lifecycle

Create a detached session, send a command, read its output, and remove the
session when the work is done:

```bash
tmux new-session -d -s build -c /path/to/project
tmux send-keys -t build "npm test" Enter
tmux capture-pane -t build -p -S -50
tmux kill-session -t build
```

Use descriptive names. Check for an existing session before reusing one:

```bash
if tmux has-session -t build 2>/dev/null; then
  tmux capture-pane -t build -p -S -20
else
  tmux new-session -d -s build -c /path/to/project
fi
```

List or attach to sessions:

```bash
tmux list-sessions
tmux attach-session -t build
```

Inside an attached session, press `Ctrl+b d` to detach without stopping its
process.

## Send input

`send-keys` sends literal text unless the final argument names a key:

```bash
tmux send-keys -t build "npm run dev" Enter
tmux send-keys -t build C-c
tmux send-keys -t build C-d
tmux send-keys -t build Escape
```

Target a specific window or pane with
`<session>:<window>.<pane>`:

```bash
tmux send-keys -t work:1.0 "node server.js" Enter
```

Be careful with commands that contain secrets. The command can appear in pane
history and status output.

## Read output

Capture a bounded section of pane history:

```bash
tmux capture-pane -t build -p -S -50
```

Capture all retained history:

```bash
tmux capture-pane -t build -p -S -
```

Output is asynchronous. Poll for a condition when the next action depends on a
specific line:

```bash
for attempt in 1 2 3 4 5; do
  output=$(tmux capture-pane -t server -p -S -20 2>/dev/null)
  if printf '%s\n' "$output" | grep -q "listening"; then
    break
  fi
  sleep 2
done
```

Do not infer success from a quiet pane or a stable prompt. Use a process exit
marker, application health check, or other explicit condition when possible.

## Windows and panes

Create and select windows:

```bash
tmux new-window -t work -n tests -c /path/to/project
tmux list-windows -t work
tmux select-window -t work:tests
tmux kill-window -t work:tests
```

Split and address panes:

```bash
tmux split-window -h -t work
tmux split-window -v -t work
tmux list-panes -t work
tmux select-pane -t work:0.1
tmux kill-pane -t work:0.1
```

## Interactive programs

Tmux provides a PTY for programs that require terminal input:

```bash
tmux new-session -d -s editor
tmux send-keys -t editor "nano /path/to/file" Enter
tmux send-keys -t editor C-o
tmux send-keys -t editor Enter
tmux send-keys -t editor C-x
```

Prefer repository-native file editing tools for normal source changes.
Interactive editors are useful only when the program itself must be exercised.

## Servers

Start a server in a named session and verify its own readiness signal:

```bash
tmux new-session -d -s server -c /path/to/project
tmux send-keys -t server "npm run dev" Enter
tmux capture-pane -t server -p -S -20
```

Stop it gracefully before killing the session:

```bash
tmux send-keys -t server C-c
tmux kill-session -t server
```

Always clean up sessions created for a task.

## Resources

`references/tmux-cheatsheet.md` lists the command forms used here.

Source `scripts/tmux_helper.sh` for named helper functions:

```bash
source scripts/tmux_helper.sh
session_create build /path/to/project
session_send build "npm test"
session_read build 50
session_kill build
```

`session_run` and `session_exec` use output timing as a convenience, not a
reliable process-exit protocol. Use an explicit completion condition for
commands where the exit status matters.
