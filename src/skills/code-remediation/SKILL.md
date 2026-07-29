---
name: code-remediation
description: Repair verified bugs, security defects, and technical debt without weakening existing safeguards.
---

# Code remediation

Use this workflow when a repository has a concrete defect list or a verified
security problem. Read the implementation and its tests before changing
anything. Confirm each reported problem against the current source.

## Set the order

| Priority | Work                                                        |
| -------- | ----------------------------------------------------------- |
| P0       | Defects that silently produce the wrong result              |
| P1       | Path traversal, secret exposure, SSRF, or command injection |
| P2       | Abort, timeout, retry, and error-handling defects           |
| P3       | Naming, configuration, or module-boundary work              |
| P4       | Local tooling and maintenance improvements                  |

Fix higher-risk items first when one change does not depend on another. Keep
unrelated refactors out of the patch.

## Work one finding at a time

For each finding:

1. Locate the behavior and the nearest tests.
2. Add or identify a check that fails for the reported reason.
3. Make the smallest change that fixes that failure.
4. Run focused checks.
5. Review the diff for lost security or protocol behavior.
6. Run the repository's full verification before committing.

If the repository has a remediation checklist, mark an item complete only
after its check passes.

## Path containment

Pass caller-controlled paths through `resolveSafePath`. The helper rejects null
bytes, encoded traversal characters, protocol handlers, parent traversal, and
paths outside the project or an explicit trusted root. It also resolves
existing ancestors and checks symlink targets.

```js
import { resolveSafePath } from '../../support/path-safety.js';

const fullPath = resolveSafePath(filePath, context.agent.trustedPaths, {
  restricted: context.agent.restricted,
});
```

Do not replace every `path.resolve` call mechanically. Paths used only to
construct an internal location can be safe. Trace the value's source and the
operation performed on it.

Tests should cover:

- a null byte;
- encoded slash or parent traversal;
- a protocol such as `file://`;
- a relative path that escapes the project;
- an existing symlink that points outside its allowed root;
- a trusted external root when the feature supports one.

## Child environments

Never spread the host environment directly into a child process. Remove
secrets from inherited values and sanitize caller-supplied values:

```js
import { removeSecrets, sanitizeChildEnvironment } from '../../support/environment.js';

const environment = {
  ...removeSecrets(process.env),
  ...sanitizeChildEnvironment(options.env || {}),
};
```

The sanitizer removes names associated with API keys, credentials, tokens,
passwords, OpenRouter, Tavily, and private keys. It also blocks loader and
startup variables such as `LD_PRELOAD`, `NODE_OPTIONS`, `BASH_ENV`, and
language-specific library paths.

Tests should put distinctive secret values in both inherited and custom
environments. Assert that logs, warnings, subprocess output, and thrown errors
do not contain them.

## Log redaction and ownership

Use the logger supplied through the current context or constructor. Do not
import a mutable process-wide logger.

```js
context.logger.warn({ component: 'worker', error }, 'Worker request failed');
```

Put errors and structured fields in the context object. Keep the message short.
The SDK's logger facade redacts sensitive keys and known secret patterns before
forwarding a record.

A consumer-supplied logger belongs to the consumer. SDK cleanup must not close,
flush, or reconfigure it.

## SSRF checks

`fetchUrl` accepts only HTTP and HTTPS. It rejects localhost and private,
reserved, link-local, and unspecified addresses. For hostnames, it checks
resolved IPv4 and IPv6 addresses and pins the connection to the validated
address set so a second DNS lookup cannot change the target.

Keep the check on every redirect. Tests should include direct IP addresses,
hostnames that resolve to blocked addresses, IPv4-mapped IPv6, redirects to
blocked targets, and an abort during a request.

## Shell safeguards

`runShell` blocks destructive root or home deletion, disk formatting and raw
device writes, shutdown commands, input redirected into a shell, pipes into a
shell, and evaluation of sensitive paths. It warns for commands such as
`sudo`, `chmod`, `chown`, process termination, downloads, and device
redirection.

Do not weaken normalization when changing these rules. Glued operators such as
`x|bash` and `x>/dev/sda` must be treated like their spaced forms. Preserve the
environment sanitizer for both PTY and child-process execution.

## Tool errors

Tools throw on failure. The registry wraps ordinary exceptions in `ToolError`,
while existing `ToolError` instances pass through unchanged.

```js
if (!target) {
  throw new Error('A target path is required.');
}
```

Do not return a success-looking string that starts with `ERROR:`. Keep abort
errors distinguishable so callers can stop retries and active work.

## Retry and timeout cleanup

Use the shared retry and payload limits:

```js
import { LIMITS } from '../../support/payload.js';
import { retry } from '../../support/retry.js';

await retry(operation, {
  attempts: config.maxRetries,
  baseDelayMs: LIMITS.retryBaseDelayMs,
  maxDelayMs: 60_000,
  signal,
});
```

Always clear timers and detach abort listeners on every settlement path:

```js
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), timeoutMs);

try {
  return await fetch(url, { signal: controller.signal });
} finally {
  clearTimeout(timer);
}
```

## Review the patch

Check the completed diff against these questions:

- Does the test fail when the fix is removed?
- Does the code preserve path, environment, SSRF, shell, and redaction rules?
- Do caller aborts stop network, tool, and background work?
- Do temporary files, processes, timers, and listeners have failure-safe
  cleanup?
- Are public names and provider wire names kept in their respective casing?
- Do messages describe the present failure without leaking inputs or secrets?
- Are imports, exports, and tests updated together?

Run the repository's exact lint, formatting, and test commands. Inspect
`git diff --check` and the staged diff before committing.

## Resources

`references/security-checklist.md` is the short review checklist.

`scripts/remediation_helper.sh` searches JavaScript sources for likely path,
environment, logging, error, and SSRF problems:

```bash
bash scripts/remediation_helper.sh src/
```

Treat its output as leads to inspect, not proof that a line is unsafe.
