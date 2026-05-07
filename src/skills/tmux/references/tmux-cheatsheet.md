# Tmux Quick Reference

## Session Commands

| Action                         | Command                                     |
| ------------------------------ | ------------------------------------------- |
| Create session (detached)      | `tmux new-session -d -s <name>`             |
| Create session in directory    | `tmux new-session -d -s <name> -c <dir>`    |
| Create session and run command | `tmux new-session -d -s <name> "<command>"` |
| List sessions                  | `tmux list-sessions`                        |
| Attach to session              | `tmux attach -t <name>`                     |
| Detach from session (inside)   | `Ctrl+b d`                                  |
| Kill session                   | `tmux kill-session -t <name>`               |
| Kill all sessions              | `tmux kill-server`                          |
| Rename session                 | `tmux rename-session -t <old> <new>`        |
| Check session exists           | `tmux has-session -t <name>`                |

## Sending Keys

| Action                  | Command                                         |
| ----------------------- | ----------------------------------------------- |
| Send text + Enter       | `tmux send-keys -t <session> "<text>" Enter`    |
| Send text only          | `tmux send-keys -t <session> "<text>"`          |
| Send Ctrl+C             | `tmux send-keys -t <session> C-c`               |
| Send Ctrl+D             | `tmux send-keys -t <session> C-d`               |
| Send Ctrl+Z             | `tmux send-keys -t <session> C-z`               |
| Send Enter key          | `tmux send-keys -t <session> Enter`             |
| Send Escape             | `tmux send-keys -t <session> Escape`            |
| Send Tab                | `tmux send-keys -t <session> Tab`               |
| Send Backspace          | `tmux send-keys -t <session> Backspace`         |
| Send to specific window | `tmux send-keys -t <session>:<window> "<text>"` |
| Send to specific pane   | `tmux send-keys -t <session>:<w>.<p> "<text>"`  |

## Capturing Output

| Action               | Command                                        |
| -------------------- | ---------------------------------------------- |
| Capture last N lines | `tmux capture-pane -t <session> -p -S -N`      |
| Capture all output   | `tmux capture-pane -t <session> -p`            |
| Capture to file      | `tmux capture-pane -t <session> -p > file.txt` |
| Save entire history  | `tmux capture-pane -t <session> -p -S -`       |

## Windows

| Action                  | Command                                          |
| ----------------------- | ------------------------------------------------ |
| List windows            | `tmux list-windows -t <session>`                 |
| New window              | `tmux new-window -t <session> -n <name>`         |
| New window in directory | `tmux new-window -t <session> -c <dir>`          |
| Select window           | `tmux select-window -t <session>:<index>`        |
| Rename window           | `tmux rename-window -t <session>:<index> <name>` |
| Kill window             | `tmux kill-window -t <session>:<index>`          |

## Panes

| Action             | Command                                 |
| ------------------ | --------------------------------------- |
| Split horizontally | `tmux split-window -h -t <session>`     |
| Split vertically   | `tmux split-window -v -t <session>`     |
| List panes         | `tmux list-panes -t <session>`          |
| Select pane        | `tmux select-pane -t <session>:<w>.<p>` |
| Kill pane          | `tmux kill-pane -t <session>:<w>.<p>`   |

## Formatting Flags

Use `-F` flag with custom format strings:

| Flag                      | Description                |
| ------------------------- | -------------------------- |
| `#{session_name}`         | Session name               |
| `#{session_windows}`      | Number of windows          |
| `#{session_attached}`     | Number of attached clients |
| `#{window_index}`         | Window index number        |
| `#{window_name}`          | Window name                |
| `#{pane_index}`           | Pane index number          |
| `#{pane_current_command}` | Command running in pane    |

Example: `tmux list-sessions -F "#{session_name}: #{session_windows} windows"`

## Common Patterns

### Run a background command

```bash
tmux new-session -d -s bg
tmux send-keys -t bg "command 2>&1" Enter
# ... later ...
tmux capture-pane -t bg -p -S -20
tmux kill-session -t bg
```

### Check if process is still running

```bash
if tmux has-session -t mysession 2>/dev/null; then
  echo "Still running:"
  tmux capture-pane -t mysession -p -S -5
else
  echo "Session ended"
fi
```

### Run command and wait (polling method)

```bash
tmux new-session -d -s build
tmux send-keys -t build "npm run build 2>&1" Enter
for i in $(seq 1 10); do
  sleep 3
  output=$(tmux capture-pane -t build -p -S -3)
  echo "$output" | grep -q "error\|success\|done" && break
done
tmux capture-pane -t build -p -S -50
tmux kill-session -t build
```

### Run multiple parallel commands

```bash
for task in lint test build; do
  tmux new-session -d -s "$task"
  tmux send-keys -t "$task" "npm run $task 2>&1" Enter
done
for task in lint test build; do
  echo "=== $task ==="
  sleep 2
  tmux capture-pane -t "$task" -p -S -10
  tmux kill-session -t "$task"
done
```

## Troubleshooting

| Problem                           | Solution                                                         |
| --------------------------------- | ---------------------------------------------------------------- |
| "sessions should be nested" error | Use `-d` flag when creating sessions from within tmux            |
| Empty output from capture-pane    | Add `sleep 1` after send-keys before capturing                   |
| "no server running"               | tmux server not started; creating a session starts it            |
| Duplicate session name            | Check with `has-session` first, or use `2>/dev/null`             |
| Command not found in tmux         | Ensure PATH is set; use absolute paths if needed                 |
| PTY issues                        | Tmux provides PTY; some programs may need `TERM=screen-256color` |

## Environment Variables

| Variable | Description                                              |
| -------- | -------------------------------------------------------- |
| `TMUX`   | Set when inside a tmux session (unset otherwise)         |
| `TERM`   | Usually `screen-256color` or `tmux-256color` inside tmux |
