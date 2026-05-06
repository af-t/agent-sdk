---
name: code-remediation
description: Systematic code remediation workflow for fixing bugs, security issues, and technical debt across a codebase. Covers delegation patterns, security hardening checklist, error handling standardization, and code review methodology. Use when tasked with implementing a remediation plan (like TODO.md), fixing verified issues, or performing security hardening.
---

# Code Remediation Workflow

## Overview

This skill captures patterns for efficiently working through a large remediation plan. It covers:

- **Delegation workflow**: Using sub-agents for implementation and review
- **Security hardening**: Path traversal, SSRF, env sanitization, secrets management
- **Error handling**: Standardized tool error patterns, circuit breakers, timeouts
- **Code review**: Systematic verification of correctness, security, edge cases

## Core Principles

### 1. Prioritize by Impact

| Priority | Category | Examples |
|----------|----------|---------|
| P0 | Critical Bug Hotfixes | Logic bugs that silently produce wrong results |
| P1 | Security Hardening | Path traversal, secret leakage, SSRF, command injection |
| P2 | Reliability & Error Handling | Empty catches, timeouts, circuit breakers, error standardization |
| P3 | Architecture | Provider abstraction, config improvements, naming consistency |
| P4 | Tool Improvements | Portability, in-memory operations, tests |

Always fix P0 and P1 before touching anything else. Security bugs compound.

### 2. Incremental Marking

Mark progress **immediately after each item**, not at the end. This:
- Prevents losing track of what's done
- Provides clear rollback points
- Makes review easier

### 3. Delegation Workflow (Most Efficient)

For complex phases, use this three-actor pattern:

```
You (Orchestrator)
  │
  ├──→ Delegate #1 (Implementor)
  │     ├── Read all relevant files
  │     ├── Apply all changes for the phase
  │     ├── Mark TODO.md [x] for each item
  │     └── Return summary
  │
  ├──→ Delegate #2 (Reviewer)
  │     ├── Read all modified files
  │     ├── Check: correctness, security, edge cases, regressions
  │     ├── Check: imports, consistency, TODO.md marks
  │     └── Report findings (✅ OK / ⚠️ FINDING / 🚨 CRITICAL)
  │
  └──→ You (Fixer)
        ├── Fix 🚨 CRITICAL issues immediately
        ├── Fix ⚠️ FINDING if quick/important
        └── Defer minor findings or skip intentional
```

**When to use this:**
- Multiple files need changes (>3 files)
- Changes are well-defined and can be described clearly
- Review requires careful cross-file verification

**When NOT to use this (do yourself):**
- Single-file changes
- Trivial fixes (1-2 lines)
- Review findings that are minor (fix directly instead of re-delegating)

---

## Security Hardening Checklist

### Path Traversal Prevention

```js
// BAD — no validation
const fullPath = path.resolve(filePath);

// GOOD — use ensureSafePath() 
import { ensureSafePath } from '../../core/utils.js';
const fullPath = ensureSafePath(filePath);
```

**`ensureSafePath()` harus menangani:**
1. ❌ Null bytes (`\0`) — CVE-2021-3805 bypass
2. ❌ URL-encoded traversal (`%2e%2e`, `%2f`, `%5c`) — double encoding
3. ❌ Protocol handlers (`file://`, etc.) — SSRF via file path
4. ❌ Directory traversal (`../../etc/passwd`) — keluar dari project root
5. ❌ Symlink TOCTOU — file yang di-resolve bisa redirect ke luar root

### Environment Variable Leakage

```js
// BAD — passes ALL env vars including API keys
env: { ...process.env }

// GOOD — strip secrets before passing to child processes
import { stripSecrets } from '../../core/utils.js';
env: { ...stripSecrets(process.env), ...(this.config.env || {}) }
```

**`stripSecrets()` harus men-strip env vars yang mengandung:**
- `api_key`, `apikey`, `api-key`
- `secret`, `token`, `password`
- `credential`, `auth`
- `openrouter`, `tavily` (provider-specific)
- `private_key`, `privatekey`

### API Key Encapsulation

```js
// BAD — public property, leaks via JSON.stringify
this.apiKey = apiKey;

// GOOD — private field + read-only getter
class Agent {
  #apiKey;
  
  constructor() {
    this.#apiKey = apiKey;
  }
  
  get apiKey() {
    return this.#apiKey;
  }
}
```

### Secret Redaction in Logs

```js
// BAD — secrets visible in console
console.error(`${msg}`, ...args);

// GOOD — redact before logging
const patterns = [
  /(sk-(?:or|ant)-[a-zA-Z0-9_-]+)/g,  // OpenRouter keys
  /(tvly-[a-zA-Z0-9_-]+)/g,           // Tavily keys
  /(Bearer\s+)[a-zA-Z0-9._-]+/g,      // Bearer tokens
];
function redact(msg) { /* apply patterns */ }
logger.error(`${redact(msg)}`, ...args.map(redact));
```

### SSRF Protection (Web Fetch)

```js
// Block these targets:
const BLOCKED_IPS = [
  /^127\./, /^10\./, /^192\.168\./,     // Private IPv4
  /^172\.(1[6-9]|2\d|3[01])\./,         // RFC 1918
  /^::1$/, /^fc00:/, /^fe80:/,          // IPv6 private
];

// Block protocols besides http/https
if (url.protocol !== 'http:' && url.protocol !== 'https:') {
  throw new Error('Protocol not allowed');
}

// Block localhost hostnames
if (hostname === 'localhost' || hostname === '127.0.0.1') {
  throw new Error('Localhost not allowed');
}
```

### Command Injection Prevention (Bash Tool)

```js
// Use blocklist for destruction-level commands
const BLOCKED = [
  'rm -rf /', 'dd if=', 'mkfs',
  ':(){ :|:& };:',  // fork bomb
  'shutdown', 'reboot', 'poweroff',
  'wget -O - | sh', 'curl | sh',
];

// Warn on suspicious patterns
const SUSPICIOUS = [
  /\b(eval|exec|source)\s+.*(\/etc\/|\.ssh|\.env)/,
  /\bsudo\b/, /\bchown\b/, /\bchmod\s+[0-7]+\b/,
];
```

### Temp File Security

```js
// BAD — predictable filename
path.join(os.tmpdir(), `temp${Date.now() + Math.random()}`);

// GOOD — unpredictable UUID
import crypto from 'node:crypto';
path.join(os.tmpdir(), `.appname-${crypto.randomUUID()}`);
```

---

## Error Handling Patterns

### Standard: Tools Throw, Agent Catches

```js
// In every tool — THROW on error, don't return string
try {
  // ... tool logic ...
} catch (error) {
  throw new Error(`Operation failed: ${error.message}`);
}

// In agent loop — CATCH the throw
try {
  const result = await this.tools.execute(name, input, context);
} catch (toolErr) {
  this.messages.push({
    role: 'tool',
    content: `Error: ${toolErr.message}`,
    tool_call_id: tc.id
  });
  continue;
}
```

### Circuit Breaker for Retries

```js
async function withRetry(func, count) {
  const NON_RETRYABLE = [401, 403, 400, 404];  // Client errors — don't retry
  const MAX_DELAY = 60_000;                     // Cap exponential backoff

  for (let i = 0; i < count; i++) {
    try {
      return await func();
    } catch (err) {
      if (err?.status && NON_RETRYABLE.includes(err.status)) throw err;
      const jitter = delay * (0.8 + Math.random() * 0.4);
      await sleep(Math.min(jitter, MAX_DELAY));
      delay = Math.min(delay * BACKOFF_FACTOR, MAX_DELAY);
    }
  }
  throw lastError;
}
```

### Empty Catch Blocks

```js
// BAD — silent failure, impossible to debug
catch {}

// GOOD — log with context
catch (err) { logger.debug('Operation failed:', err.message); }
// or at minimum: add a comment explaining why it's safe to skip
catch { /* path doesn't exist — skip silently */ }
```

### Timeout Pattern

```js
async function requestWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);  // Always clean up
  }
}
```

---

## Code Review Methodology

When reviewing changes, check these dimensions:

### 1. Correctness
- Does the logic produce the right result?
- Are edge cases handled (null, undefined, empty, 0)?
- Are error paths tested?

### 2. Security
- Are all file paths validated with `ensureSafePath()`?
- Are child process env vars sanitized with `stripSecrets()`?
- Are API keys private fields (not serializable)?
- Are secrets redacted from logs?
- Is SSRF prevented in fetch operations?
- Are temp file names unpredictable?

### 3. Regressions
- Does the change break existing functionality?
- Are imports/exports still compatible?
- Are renamed things updated everywhere?

### 4. Consistency
- Does the change follow the project's established patterns?
- Is error handling consistent with other tools?
- Are naming conventions followed?

### 5. Import/Export Verification
- Every new import is actually used
- Every renamed export has all references updated
- No circular dependencies

---

## Workflow Example

### Starting a Remediation Phase

```
1. Read TODO.md — understand the phase scope
2. Group items by complexity:
   - Simple (1 file, 1 change) → do yourself
   - Complex (multiple files, coordinated changes) → delegate
3. For complex items:
   a. Delegate #1: "Implement all items in this group"
      - Give file paths, specific changes, and mark TODO.md
   b. Delegate #2: "Review all changes in these files"
      - Check correctness, security, edge cases, regressions
   c. Fix findings yourself (don't re-delegate for minor fixes)
4. Mark TODO.md [x] as each item completes
```

### Reporting Findings

Categorize findings as:
- **✅ OK** — No issues, implementation is correct
- **⚠️ FINDING** — Minor issue or improvement suggestion
- **🚨 CRITICAL** — Bug or security hole that must be fixed before proceeding

### When to NOT Delegate

- Single-file, single-line changes (faster to do yourself)
- Review findings that are minor (fix directly)
- Exploratory work where requirements aren't clear yet
- Changes that require understanding of the full system context

---

## Best Practices

1. **Read before you write** — Always read the current file state before making changes
2. **One change at a time** — Apply changes incrementally, not all at once
3. **Mark as you go** — Update TODO.md [x] immediately after each item
4. **Delegate complex, do simple** — Use sub-agents for multi-file changes, do trivial fixes yourself
5. **Review before accepting** — Always verify delegated work with a reviewer
6. **Fix criticals immediately** — Never leave 🚨 CRITICAL findings unresolved
7. **Size limits are security** — Add max read/write sizes to prevent resource exhaustion
8. **Default deny for paths** — Block everything outside project root by default
9. **Least privilege for env** — Only pass necessary env vars to child processes
10. **Deep freeze config** — Make configuration immutable to prevent runtime mutation

## Resources

### references/security-checklist.md
Quick-reference checklist for security hardening reviews. Covers 7 categories with checkboxes:
- Path Traversal, Secret Leakage, SSRF Prevention, Command Injection, File Operations, Config & Environment
- Print or use digitally during code review

### scripts/remediation_helper.sh
Bash script for automated security auditing

```bash
# source the script
source scripts/remediation_helper.js

# or execute immediately
bash scripts/remediation_helper.sh
```

**Usage examples:**
```bash
# Find missed traversal paths
check_path_traversal src/

# Check env leakage
check_env_leakage src/

# Search empty catch blocks
check_empty_catches src/

# Check all
run_all_checks src/
```

The script scans for:
- Unguarded `path.resolve()` calls
- Missing `ensureSafePath` imports
- `process.env` leaked to child processes
- Public `apiKey` assignments
- Empty catch blocks
- Tools still returning `ERROR:` strings
- Missing SSRF protection on fetch calls
