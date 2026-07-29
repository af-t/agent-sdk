#!/usr/bin/env bash
# remediation_helper.sh: Helper functions for code remediation
#
# Usage:
#   source remediation_helper.sh
#   check_path_traversal src/
#   find_secrets_in_logs src/
# Path checks

# Find files using raw path.resolve() without resolveSafePath()
check_path_traversal() {
  local dir="${1:-src}"
  echo "Path traversal check"
  grep -rn "path\.resolve(" "$dir" --include='*.js' \
    | grep -v "resolveSafePath" \
    | grep -v "node_modules" \
    | grep -v "dirname\.js" \
    | grep -v "\.test\." \
    || echo "No unguarded path.resolve() calls found"
  echo ""
}

# Find files missing resolveSafePath import
check_missing_import() {
  local dir="${1:-src}"
  echo "Files missing a resolveSafePath import"
  grep -rln "path\.resolve(" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "dirname\.js" \
    | grep -v "\.test\." \
    | while read -r f; do
        if ! grep -q "resolveSafePath" "$f"; then
          echo "$f"
        fi
      done
  echo ""
}

# Secret checks

# Find potential API key exposure in logs/console
find_secrets_in_logs() {
  local dir="${1:-src}"
  echo "Secret leakage check"
  echo "console.log calls that should use a logger:"
  grep -rn "console\.log" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "\.test\." \
    || echo "No console.log calls found"

  echo ""
  echo "Public apiKey assignments:"
  grep -rn "this\.apiKey\s*=" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "#apiKey" \
    || echo "No public apiKey assignments found"
  echo ""
}

# Find env vars passed to child processes without sanitizeChildEnvironment
check_env_leakage() {
  local dir="${1:-src}"
  echo "Child environment check"
  grep -rn "process\.env" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "\.test\." \
    | grep -v "sanitizeChildEnvironment" \
    | grep -E "(spawn|exec|fork|pty\.spawn)" \
    || echo "No unguarded process.env values found in spawn calls"
  echo ""
}

# Error checks

# Find empty catch blocks
check_empty_catches() {
  local dir="${1:-src}"
  echo "Empty catch blocks"
  grep -rn "catch\s*{" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "\.test\." \
    | grep -v "catch (err)" \
    | grep -v "catch (e)" \
    | grep -v "catch {"'$'"[A-Za-z]" \
    || echo "No empty catch blocks found"
  echo ""
}

# Find tools still returning ERROR: strings instead of throwing
check_tool_error_pattern() {
  local dir="${1:-src/tools}"
  echo "Tool error string check"
  grep -rn "return.*ERROR:" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    || echo "No tools return ERROR: strings"
  echo ""
}

# SSRF checks

check_ssrf_protection() {
  local dir="${1:-src}"
  echo "SSRF protection check"
  grep -rn "fetch(" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "\.test\." \
    | grep -v "checkSSRF" \
    | grep -v "test/" \
    | while read -r line; do
        file=$(echo "$line" | cut -d: -f1)
        if ! grep -q "checkSSRF\|BLOCKED_IP\|localhost\|private" "$file" 2>/dev/null; then
          echo "Possible missing SSRF protection: $line"
        fi
      done
  echo ""
}

# Summary

run_all_checks() {
  local dir="${1:-src}"
  echo "Security and quality audit"
  echo "Directory: $dir"
  echo "Date: $(date)"
  echo ""

  check_path_traversal "$dir"
  check_missing_import "$dir"
  check_env_leakage "$dir"
  find_secrets_in_logs "$dir"
  check_empty_catches "$dir"
  check_tool_error_pattern "$dir"
  check_ssrf_protection "$dir"

  echo "Audit complete"
}

# If run directly (not sourced), run all checks
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_all_checks "${1:-src}"
fi
