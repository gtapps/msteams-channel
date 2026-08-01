# Contributing

## Runtime

**Bun**, same as the official Telegram, Discord and iMessage channels. Bun runs
TypeScript directly, so there is **no build step and no bundler**: what you read
in `server.ts` is what runs. Its `node_modules` are portable across OS and arch,
which is why the plugin can install itself at spawn time.

Bun must be on `PATH`. Install from [bun.sh](https://bun.sh).

## Getting set up

```bash
bun install          # full install, including devDependencies
bun test             # 256 tests, ~11s; no tenant, no network
bun run typecheck    # tsc --noEmit; must pass before committing
```

Neither the suite nor the typecheck touches Azure, Teams, or the network. You
can develop and review almost everything in this repo without a tenant.

## Running the server

```bash
bun run dev          # full install (devDeps included), then run the server
bun server.ts        # same, skipping the install step
bun send.ts --list   # proactive-send CLI: what is reachable right now
```

**Do not use `bun run start` for development.** That is the entry point Claude
Code spawns, and it runs `bun install --production`, which *prunes*
`node_modules` down to runtime dependencies, so `bun test` and
`bun run typecheck` break until you `bun install` again. `dev` exists precisely
so you never have to think about that.

The corollary matters when adding a dependency: **anything imported by
`server.ts`, `src/`, or `send.ts` must be a `dependency`, never a
`devDependency`.** A devDep that leaks into runtime code passes CI and fails at
every user's first launch. `jose` and `jwks-rsa` are devDeps because only
`tests/auth-coverage.test.ts` imports them; keep it that way.

stderr is the only log, and only startup output reaches
`~/.claude/debug/<session-id>.txt`; mid-session writes go nowhere. Treat stderr
logging as a dev aid for standalone runs, not something to point an operator at.

## Before you open a PR

1. `bun run typecheck` and `bun test` are green.
2. `claude plugin validate .` passes.
3. Read the **Invariants that are easy to break** section of
   [`CLAUDE.md`](CLAUDE.md). Most of them are one-line rules that no test can
   catch: credentials never in argv, threading on `extractThreadId()` rather
   than `activity.id`, nothing registered before the gate, attachment
   `downloadUrl`s never logged or persisted.
4. If you touched the inbound pipeline, an outbound tool, `send.ts`, the SDK
   pin, or the MCP `instructions` string, say so in the PR. Those changes are
   not fully covered by `bun test` and require maintainer-run live tenant
   verification before release.

## Tests

- **`tests/fixtures/`** holds real activities captured from a live tenant and
  scrubbed with same-shape stand-ins: the code parses those shapes, so
  flattening them would make the fixtures test the wrong thing. **Read
  [`tests/fixtures/README.md`](tests/fixtures/README.md) before touching
  them**, and never commit an unscrubbed capture. `fixtures.test.ts` asserts
  the scrubbing held; that guard is the last line of defence, not the first.
- Tests that write state use `mkdtempSync` + `MSTEAMS_STATE_DIR`. A green run
  legitimately prints `access.json is corrupt, moved aside` and the static-mode
  downgrade warning: those are assertions firing, not failures.
- **CI is deliberately tenant-free.** Nothing in `.github/workflows/ci.yml`
  needs an Azure subscription, a Teams tenant or a tunnel, so a fork can run it
  and no secret is ever exposed to one. Keep it that way: a test that depends
  on ambient `MSTEAMS_*` credentials must fail in CI rather than pass on your
  machine only.

## Never commit

`.env`, anything from `~/.claude/channels/msteams/`, a real tenant id, an AAD
object id, a conversation id, or an attachment `downloadUrl`. Stage files by
name rather than `git add -A`; this repo *is* its own distribution channel, so
a mistake on `main` is live for users immediately.

## Releasing (maintainers)

Run `/release` in a Claude Code session at the repo root. It validates, bumps
the version in all four manifests, writes the CHANGELOG entry, tags
`msteams--v<X.Y.Z>` and publishes the GitHub release. Don't do those steps by
hand: the version lives in four places and only two of them are checked
automatically.
