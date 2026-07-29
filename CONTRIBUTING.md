# Contributing

## Set up the repository

1. Fork and clone the repository.
2. Install Node.js 22 or later.
3. Run `npm install`.
4. Copy `.env.example` to `.env` if your change needs live API access.

Tests should use injected keys and transports instead of a developer's
credentials.

## Make a change

Keep the change focused and follow the existing ES module structure. Public
JavaScript names use camel case, classes use Pascal case, and immutable
constants use uppercase snake case. Environment variables also use uppercase
snake case.

Tools have exactly four fields:

```js
const tool = {
  name: 'exampleTool',
  description: 'Describe what the tool does.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  execute: async (input, context) => 'result',
};
```

Model provider payloads keep their wire spelling. SDK options, schemas, event
envelopes, and internal metadata use camel case.

Comments should explain constraints, hazards, protocol behavior, or test setup
that the code cannot make obvious. Delete comments that only restate the next
line. Describe the code as it is instead of narrating the history of a change.

Do not weaken path containment, environment sanitization, SSRF prevention,
abort handling, secret redaction, or shell safeguards. Add a regression test
when a change touches one of those boundaries.

## Verify the change

Run the repository checks:

```bash
npm run lint
npx prettier --check '**/*.js'
npm test
```

Use a fresh temporary directory for a full test run when investigating leaked
files:

```bash
TMPDIR="$(mktemp -d)" NODE_DISABLE_COMPILE_CACHE=1 npm test
```

Tests must clean up files, processes, timers, agents, and servers even when an
assertion fails.

## Submit the change

Use a short plain-prose commit subject. In the pull request, explain the
behavior being changed and list the commands you ran. Include the Node.js
version and exact reproduction steps for a bug fix.

Report unrelated issues at
[GitHub Issues](https://github.com/af-t/agent-sdk/issues).
