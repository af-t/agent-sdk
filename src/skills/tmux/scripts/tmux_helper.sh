#!/usr/bin/env bash
#
# Tmux Helper Script
# Provides reliable, repeatable tmux operations for AI agents.
# Each function is self-contained and outputs clean LLM-friendly text.
#
# Usage:
#   source tmux_helper.sh
#   session_create "mysession" "/path/to/dir"
#   session_send "mysession" "echo hello"
#   session_read "mysession" 20
#

# Color codes for output (disabled if not a terminal)
if [[ -t 1 ]]; then
  RED='\033[0;31m'
  GREEN='\033[0;32m'
  YELLOW='\033[1;33m'
  NC='\033[0m'
else
  RED=''; GREEN=''; YELLOW=''; NC=''
fi

# Check if tmux is available
_require_tmux() {
  if ! command -v tmux &>/dev/null; then
    echo "FAIL: tmux is not installed. Install it first."
    return 1
  fi
}

# ─── Session Management ───────────────────────────────────────────────

# Create a detached session
# Usage: session_create <name> [directory]
session_create() {
  _require_tmux || return 1
  local name="$1"
  local dir="${2:-$PWD}"

  if [[ -z "$name" ]]; then
    echo "FAIL: Usage: session_create <name> [directory]"
    return 1
  fi

  if tmux has-session -t "$name" 2>/dev/null; then
    echo "OK: Session '$name' already exists."
    return 0
  fi

  tmux new-session -d -s "$name" -c "$dir" 2>/dev/null
  if [[ $? -eq 0 ]]; then
    echo "OK: Created session '$name' in $dir"
  else
    echo "FAIL: Could not create session '$name'"
    return 1
  fi
}

# Kill a session
# Usage: session_kill <name>
session_kill() {
  _require_tmux || return 1
  local name="$1"

  if [[ -z "$name" ]]; then
    echo "FAIL: Usage: session_kill <name>"
    return 1
  fi

  if tmux has-session -t "$name" 2>/dev/null; then
    tmux kill-session -t "$name"
    echo "OK: Killed session '$name'"
  else
    echo "WARN: Session '$name' does not exist (nothing to kill)"
  fi
}

# List all sessions
# Usage: session_list
session_list() {
  _require_tmux || return 1

  if ! tmux list-sessions 2>/dev/null; then
    echo "INFO: No tmux sessions running."
  fi
}

# Check if session exists
# Usage: session_exists <name>
session_exists() {
  _require_tmux || return 1
  local name="$1"

  if tmux has-session -t "$name" 2>/dev/null; then
    echo "YES: Session '$name' exists"
    return 0
  else
    echo "NO: Session '$name' does not exist"
    return 1
  fi
}

# ─── Sending Commands ─────────────────────────────────────────────────

# Send a command to a session (with Enter)
# Usage: session_send <name> <command>
session_send() {
  _require_tmux || return 1
  local name="$1"
  local cmd="$2"

  if [[ -z "$name" || -z "$cmd" ]]; then
    echo "FAIL: Usage: session_send <name> <command>"
    return 1
  fi

  if ! tmux has-session -t "$name" 2>/dev/null; then
    echo "FAIL: Session '$name' does not exist. Create it first."
    return 1
  fi

  tmux send-keys -t "$name" "$cmd" Enter
  echo "OK: Sent command to session '$name': $cmd"
}

# Send text without Enter (for building partial commands)
# Usage: session_type <name> <text>
session_type() {
  _require_tmux || return 1
  local name="$1"
  local text="$2"

  if [[ -z "$name" || -z "$text" ]]; then
    echo "FAIL: Usage: session_type <name> <text>"
    return 1
  fi

  if ! tmux has-session -t "$name" 2>/dev/null; then
    echo "FAIL: Session '$name' does not exist."
    return 1
  fi

  tmux send-keys -t "$name" "$text"
  echo "OK: Typed text into session '$name': $text"
}

# Send a special key sequence
# Usage: session_key <name> <key>
# Examples:
#   session_key mysession C-c     # Ctrl+C
#   session_key mysession C-d     # Ctrl+D
#   session_key mysession Escape
#   session_key mysession Enter
session_key() {
  _require_tmux || return 1
  local name="$1"
  local key="$2"

  if [[ -z "$name" || -z "$key" ]]; then
    echo "FAIL: Usage: session_key <name> <key>"
    return 1
  fi

  if ! tmux has-session -t "$name" 2>/dev/null; then
    echo "FAIL: Session '$name' does not exist."
    return 1
  fi

  tmux send-keys -t "$name" "$key"
  echo "OK: Sent key '$key' to session '$name'"
}

# ─── Reading Output ───────────────────────────────────────────────────

# Read last N lines from a session
# Usage: session_read <name> [lines]
session_read() {
  _require_tmux || return 1
  local name="$1"
  local lines="${2:-50}"

  if [[ -z "$name" ]]; then
    echo "FAIL: Usage: session_read <name> [lines]"
    return 1
  fi

  if ! tmux has-session -t "$name" 2>/dev/null; then
    echo "FAIL: Session '$name' does not exist."
    return 1
  fi

  tmux capture-pane -t "$name" -p -S "-${lines}" 2>/dev/null
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "FAIL: Could not read from session '$name'"
    return 1
  fi
  # Returns the captured output directly (no extra wrapper)
  return 0
}

# Read entire session output
# Usage: session_read_all <name>
session_read_all() {
  _require_tmux || return 1
  local name="$1"

  if [[ -z "$name" ]]; then
    echo "FAIL: Usage: session_read_all <name>"
    return 1
  fi

  if ! tmux has-session -t "$name" 2>/dev/null; then
    echo "FAIL: Session '$name' does not exist."
    return 1
  fi

  tmux capture-pane -t "$name" -p 2>/dev/null
  local rc=$?
  if [[ $rc -ne 0 ]]; then
    echo "FAIL: Could not read from session '$name'"
    return 1
  fi
  return 0
}

# ─── Waiting and Monitoring ──────────────────────────────────────────

# Wait for a specific string to appear in session output
# Usage: session_wait <name> <target_string> [timeout_seconds]
# Returns 0 if found, 1 if timeout
session_wait() {
  _require_tmux || return 1
  local name="$1"
  local target="$2"
  local timeout="${3:-60}"

  if [[ -z "$name" || -z "$target" ]]; then
    echo "FAIL: Usage: session_wait <name> <target_string> [timeout]"
    return 1
  fi

  if ! tmux has-session -t "$name" 2>/dev/null; then
    echo "FAIL: Session '$name' does not exist."
    return 1
  fi

  local elapsed=0
  local interval=2

  while [[ $elapsed -lt $timeout ]]; do
    local output
    output=$(tmux capture-pane -t "$name" -p -S -20 2>/dev/null)
    if echo "$output" | grep -q "$target"; then
      echo "FOUND: Target '$target' appeared in session '$name' after ${elapsed}s"
      return 0
    fi
    sleep "$interval"
    elapsed=$((elapsed + interval))
  done

  echo "TIMEOUT: Target '$target' not found in session '$name' after ${timeout}s"
  return 1
}

# ─── High-Level Workflows ────────────────────────────────────────────

# Run a command in a session and wait for it to complete
# Usage: session_run <name> <command> [timeout_seconds]
# Creates session if needed, runs command, waits for prompt/completion
session_run() {
  _require_tmux || return 1
  local name="$1"
  local command="$2"
  local timeout="${3:-120}"

  if [[ -z "$name" || -z "$command" ]]; then
    echo "FAIL: Usage: session_run <name> <command> [timeout]"
    return 1
  fi

  # Create session if not exists
  if ! tmux has-session -t "$name" 2>/dev/null; then
    tmux new-session -d -s "$name" 2>/dev/null
    echo "OK: Created new session '$name'"
  fi

  # Send the command
  tmux send-keys -t "$name" "$command" Enter
  echo "OK: Running command in session '$name': $command"

  # Wait for the command to finish (check for shell prompt)
  # We look for the command to complete by checking output stability
  local elapsed=0
  local interval=3
  local prev_output=""
  local stable_count=0

  while [[ $elapsed -lt $timeout ]]; do
    sleep "$interval"
    elapsed=$((elapsed + interval))

    local current_output
    current_output=$(tmux capture-pane -t "$name" -p -S -5 2>/dev/null)

    if [[ "$current_output" == "$prev_output" ]]; then
      stable_count=$((stable_count + 1))
    else
      stable_count=0
    fi

    # Output stable for 2 checks (6s) = likely finished
    if [[ $stable_count -ge 2 && -n "$current_output" ]]; then
      echo "DONE: Command finished in session '$name' (output stable)"
      tmux capture-pane -t "$name" -p -S -30
      return 0
    fi

    prev_output="$current_output"
  done

  echo "TIMEOUT: Command still running after ${timeout}s in session '$name'"
  echo "Latest output:"
  tmux capture-pane -t "$name" -p -S -10
  return 1
}

# Run a command and get output immediately (blocking within tmux)
# Usage: session_exec <name> <command> [wait_seconds]
session_exec() {
  _require_tmux || return 1
  local name="$1"
  local command="$2"
  local wait_time="${3:-5}"

  if [[ -z "$name" || -z "$command" ]]; then
    echo "FAIL: Usage: session_exec <name> <command> [wait_seconds]"
    return 1
  fi

  # Create session if not exists
  if ! tmux has-session -t "$name" 2>/dev/null; then
    tmux new-session -d -s "$name" 2>/dev/null
  fi

  # Clear pane and run command
  tmux send-keys -t "$name" "clear" Enter
  sleep 0.5
  tmux send-keys -t "$name" "$command" Enter

  # Wait specified time
  sleep "$wait_time"

  # Capture and return output
  echo "OUTPUT from session '$name':"
  echo "---"
  tmux capture-pane -t "$name" -p -S -50
  echo "---"
}

# ─── Display Help ─────────────────────────────────────────────────────

session_help() {
  cat <<'EOF'
Tmux Helper - Available Functions
==================================

== Session Management ==
  session_create <name> [dir]     Create a detached tmux session
  session_kill <name>             Kill/terminate a session
  session_list                    List all running sessions
  session_exists <name>           Check if a session exists

== Sending Commands ==
  session_send <name> <cmd>       Send a command (with Enter)
  session_type <name> <text>      Type text (no Enter)
  session_key <name> <key>        Send special key (C-c, Enter, etc.)

== Reading Output ==
  session_read <name> [lines]     Read last N lines (default: 50)
  session_read_all <name>         Read entire pane history

== Monitoring ==
  session_wait <name> <str> [t]   Wait for string in output (timeout sec)

== Workflows ==
  session_run <name> <cmd> [t]    Run cmd, wait for completion
  session_exec <name> <cmd> [t]   Run cmd, wait N sec, show output
EOF
}

# If run directly (not sourced), show help
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  session_help
fi
