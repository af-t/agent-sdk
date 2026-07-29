# Tmux command reference

## Sessions

| Action                    | Command                                     |
| ------------------------- | ------------------------------------------- |
| Create a detached session | `tmux new-session -d -s <name>`             |
| Create in a directory     | `tmux new-session -d -s <name> -c <dir>`    |
| Run a command immediately | `tmux new-session -d -s <name> "<command>"` |
| Check for a session       | `tmux has-session -t <name>`                |
| List sessions             | `tmux list-sessions`                        |
| Attach                    | `tmux attach-session -t <name>`             |
| Rename                    | `tmux rename-session -t <old> <new>`        |
| Kill one session          | `tmux kill-session -t <name>`               |
| Kill the tmux server      | `tmux kill-server`                          |

Press `Ctrl+b d` inside tmux to detach.

## Input

| Action              | Command                                                |
| ------------------- | ------------------------------------------------------ |
| Send text and Enter | `tmux send-keys -t <session> "<text>" Enter`           |
| Send text only      | `tmux send-keys -t <session> "<text>"`                 |
| Interrupt           | `tmux send-keys -t <session> C-c`                      |
| Send EOF            | `tmux send-keys -t <session> C-d`                      |
| Send Enter          | `tmux send-keys -t <session> Enter`                    |
| Send Escape         | `tmux send-keys -t <session> Escape`                   |
| Send Tab            | `tmux send-keys -t <session> Tab`                      |
| Send Backspace      | `tmux send-keys -t <session> Backspace`                |
| Target a window     | `tmux send-keys -t <session>:<window> "<text>"`        |
| Target a pane       | `tmux send-keys -t <session>:<window>.<pane> "<text>"` |

## Output

| Action                   | Command                                          |
| ------------------------ | ------------------------------------------------ |
| Capture the last N lines | `tmux capture-pane -t <session> -p -S -N`        |
| Capture visible content  | `tmux capture-pane -t <session> -p`              |
| Capture retained history | `tmux capture-pane -t <session> -p -S -`         |
| Save captured output     | `tmux capture-pane -t <session> -p > output.txt` |

## Windows

| Action                | Command                                          |
| --------------------- | ------------------------------------------------ |
| List                  | `tmux list-windows -t <session>`                 |
| Create                | `tmux new-window -t <session> -n <name>`         |
| Create in a directory | `tmux new-window -t <session> -c <dir>`          |
| Select                | `tmux select-window -t <session>:<index>`        |
| Rename                | `tmux rename-window -t <session>:<index> <name>` |
| Kill                  | `tmux kill-window -t <session>:<index>`          |

## Panes

| Action               | Command                                         |
| -------------------- | ----------------------------------------------- |
| Split left and right | `tmux split-window -h -t <session>`             |
| Split top and bottom | `tmux split-window -v -t <session>`             |
| List                 | `tmux list-panes -t <session>`                  |
| Select               | `tmux select-pane -t <session>:<window>.<pane>` |
| Kill                 | `tmux kill-pane -t <session>:<window>.<pane>`   |

## Formats

Use `-F` with tmux format strings:

| Value                     | Meaning               |
| ------------------------- | --------------------- |
| `#{session_name}`         | Session name          |
| `#{session_windows}`      | Window count          |
| `#{session_attached}`     | Attached client count |
| `#{window_index}`         | Window index          |
| `#{window_name}`          | Window name           |
| `#{pane_index}`           | Pane index            |
| `#{pane_current_command}` | Current pane command  |

```bash
tmux list-sessions -F "#{session_name}: #{session_windows} windows"
```

## Troubleshooting

| Problem                  | Check                                                                 |
| ------------------------ | --------------------------------------------------------------------- |
| Nested-session warning   | Create the session with `-d`                                          |
| Empty capture            | Wait for the program's readiness signal, then capture again           |
| No server running        | Create a session before listing or attaching                          |
| Duplicate name           | Call `has-session` before `new-session`                               |
| Command missing          | Check the tmux session's `PATH` or use an absolute path               |
| Terminal incompatibility | Check `TERM`; tmux commonly uses `screen-256color` or `tmux-256color` |

`TMUX` is set inside an attached tmux session.
