# Security Hardening Quick Checklist

## Path Traversal

- [ ] All `path.resolve()` replaced with `ensureSafePath()`
- [ ] Null byte check (`\0`)
- [ ] URL-encoded traversal check (`%2e%2e`, `%2f`, `%5c`)
- [ ] Protocol handler rejection (`file://`)
- [ ] Symlink TOCTOU resolution (`realpathSync`)
- [ ] Parent directory validation for new files

## Secret Leakage

- [ ] API keys using `#privateField` (not `this.publicField`)
- [ ] Getter for read-only access instead of direct property
- [ ] Child process env vars sanitized with `stripSecrets()`
- [ ] Logger redacts known secret patterns
- [ ] `console.log` → `logger.info` (gets auto-redaction)

## SSRF Prevention (Web Fetch)

- [ ] Block localhost / 127.0.0.1 / 0.0.0.0
- [ ] Block private IPv4 ranges (10.x, 172.16-31.x, 192.168.x)
- [ ] Block private IPv6 ranges (::1, fc00:, fe80:, fd00:)
- [ ] Block non-HTTP(S) protocols
- [ ] URL format validation (`new URL(url)`)

## Command Injection (Bash)

- [ ] Destruction-level commands blocked (rm -rf /, dd, mkfs, fork bomb, shutdown)
- [ ] Suspicious patterns trigger warnings (eval, sudo, chmod, curl|sh)
- [ ] Spawn errors caught (e.g., bash not found)

## File Operations

- [ ] Read size limit (prevent OOM)
- [ ] Write size limit (prevent disk exhaustion)
- [ ] Temp files use `crypto.randomUUID()`
- [ ] Temp files use prefix `.appname-` for easy cleanup

## Config & Environment

- [ ] Config object deeply frozen (immutable)
- [ ] Array configs also frozen (ORDER, ONLY)
- [ ] `.env` values accessed through config, not directly via `process.env`
