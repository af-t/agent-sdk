#!/usr/bin/env bash
# ==============================================================
# remediation_helper.sh — Helper functions for code remediation
#
# Usage:
#   source remediation_helper.sh
#   check_path_traversal src/
#   find_secrets_in_logs src/
# ==============================================================

# ── Path Traversal Audit ──────────────────────────────────────

# Find files using raw path.resolve() without ensureSafePath()
check_path_traversal() {
  local dir="${1:-src}"
  echo "=== 🔍 Path Traversal Check ==="
  grep -rn "path\.resolve(" "$dir" --include='*.js' \
    | grep -v "ensureSafePath" \
    | grep -v "node_modules" \
    | grep -v "dirname\.js" \
    | grep -v "\.test\." \
    || echo "✅ No unguarded path.resolve() found"
  echo ""
}

# Find files missing ensureSafePath import
check_missing_import() {
  local dir="${1:-src}"
  echo "=== 🔍 Missing ensureSafePath Import ==="
  grep -rln "path\.resolve(" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "dirname\.js" \
    | grep -v "\.test\." \
    | while read -r f; do
        if ! grep -q "ensureSafePath" "$f"; then
          echo "⚠️  $f"
        fi
      done
  echo ""
}

# ── Secret Leakage Audit ──────────────────────────────────────

# Find potential API key exposure in logs/console
find_secrets_in_logs() {
  local dir="${1:-src}"
  echo "=== 🔍 Secret Leakage Check ==="
  echo "--- console.log (should use logger) ---"
  grep -rn "console\.log" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "\.test\." \
    || echo "✅ No console.log found"
  
  echo ""
  echo "--- Public apiKey properties ---"
  grep -rn "this\.apiKey\s*=" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "#apiKey" \
    || echo "✅ No public apiKey assignments found"
  echo ""
}

# Find env vars passed to child processes without stripSecrets
check_env_leakage() {
  local dir="${1:-src}"
  echo "=== 🔍 Env Leakage Check ==="
  grep -rn "process\.env" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "\.test\." \
    | grep -v "stripSecrets" \
    | grep -E "(spawn|exec|fork|pty\.spawn)" \
    || echo "✅ No unguarded process.env in spawn calls"
  echo ""
}

# ── Error Handling Audit ─────────────────────────────────────

# Find empty catch blocks
check_empty_catches() {
  local dir="${1:-src}"
  echo "=== 🔍 Empty Catch Blocks ==="
  grep -rn "catch\s*{" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "\.test\." \
    | grep -v "catch (err)" \
    | grep -v "catch (e)" \
    | grep -v "catch {"'$'"[A-Za-z]" \
    || echo "✅ No empty catch blocks found"
  echo ""
}

# Find tools still returning ERROR: strings instead of throwing
check_tool_error_pattern() {
  local dir="${1:-src/tools}"
  echo "=== 🔍 Tool Error Pattern Check ==="
  grep -rn "return.*ERROR:" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    || echo "✅ No tools returning ERROR: strings"
  echo ""
}

# ── SSRF Audit ────────────────────────────────────────────────

check_ssrf_protection() {
  local dir="${1:-src}"
  echo "=== 🔍 SSRF Protection Check ==="
  grep -rn "fetch(" "$dir" --include='*.js' \
    | grep -v "node_modules" \
    | grep -v "\.test\." \
    | grep -v "checkSSRF" \
    | grep -v "test/" \
    | while read -r line; do
        file=$(echo "$line" | cut -d: -f1)
        if ! grep -q "checkSSRF\|BLOCKED_IP\|localhost\|private" "$file" 2>/dev/null; then
          echo "⚠️  No SSRF protection: $line"
        fi
      done
  echo ""
}

# ── Summary ───────────────────────────────────────────────────

run_all_checks() {
  local dir="${1:-src}"
  echo "╔══════════════════════════════════════════╗"
  echo "║   🔒 Security & Quality Audit Report     ║"
  echo "╚══════════════════════════════════════════╝"
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
  
  echo "╔══════════════════════════════════════════╗"
  echo "║   ✅ Audit Complete                      ║"
  echo "╚══════════════════════════════════════════╝"
}

# If run directly (not sourced), run all checks
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  run_all_checks "${1:-src}"
fi
