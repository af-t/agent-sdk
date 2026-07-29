# Security review checklist

## Path containment

- [ ] Caller-controlled paths pass through `resolveSafePath`.
- [ ] Tests cover null bytes, encoded traversal, and protocol handlers.
- [ ] Relative and absolute paths cannot escape the project or a trusted root.
- [ ] Existing symlinks cannot redirect an operation outside an allowed root.
- [ ] New-file paths validate their nearest existing ancestor.

## Secrets and logging

- [ ] API keys are private fields or scoped values, not serializable properties.
- [ ] Every child environment passes through `sanitizeChildEnvironment`.
- [ ] Unsafe loader and startup environment variables are removed.
- [ ] Structured log context and messages are redacted.
- [ ] Logs do not contain commands, credentials, environment values, or
      authorization headers.
- [ ] Consumer-owned loggers are not closed, flushed, or reconfigured.

## SSRF

- [ ] Fetching accepts only HTTP and HTTPS.
- [ ] Localhost and private, reserved, link-local, and unspecified addresses are
      blocked for IPv4 and IPv6.
- [ ] Every DNS answer is validated.
- [ ] Connections use the validated address rather than resolving again.
- [ ] Redirect targets repeat the complete check.

## Shell execution

- [ ] Catastrophic root or home deletion is blocked across flag variants.
- [ ] Shell pipes, input redirects, and glued operators are normalized before
      matching.
- [ ] Raw-device writes, formatting, shutdown, and fork bombs are blocked.
- [ ] Suspicious commands produce redacted warnings.
- [ ] PTY and child-process paths apply the same environment rules.
- [ ] Abort escalates from graceful termination to a bounded forced kill.

## File operations

- [ ] Read and write sizes have explicit limits.
- [ ] Failed multi-edit operations leave the file unchanged.
- [ ] Temporary names are unpredictable.
- [ ] Tests remove temporary files and directories through failure-safe hooks.

## Configuration and protocol

- [ ] Environment configuration is parsed into frozen camel-case objects.
- [ ] Environment variable names remain uppercase snake case.
- [ ] SDK-authored options, events, and metadata use camel case.
- [ ] Provider payloads and message history keep their wire spelling.
- [ ] Tools expose exactly `{ name, description, inputSchema, execute }`.

## Cancellation

- [ ] An already-aborted signal prevents work from starting.
- [ ] Network readers, retries, MCP calls, tools, and background jobs observe
      cancellation.
- [ ] Abort errors remain distinguishable from ordinary failures.
- [ ] Timers and event listeners are released when work settles.
