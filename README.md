# Microsoft Teams channel for Claude Code

[![CI](https://github.com/gtapps/msteams-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/gtapps/msteams-channel/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/gtapps/msteams-channel?sort=semver)](https://github.com/gtapps/msteams-channel/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Chat with Claude Code from Microsoft Teams: direct messages and mention-gated
channel posts arrive in your session, and Claude replies in the right thread.
Built directly on the [Microsoft Agents SDK][sdk] (`@microsoft/teams.apps`) —
no third-party agent framework, no hosted relay, no service you don't run.

> **Status: MVP.** Inbound pipeline, outbound tools, access model and permission
> relay are complete and were each verified against a real Teams tenant. Two
> things are known not to work and are documented rather than hidden:
> [reactions](docs/REACTIONS.md) (Graph exposes no application-only permission
> for them — a permanent limitation, not a bug) and outbound file types other
> than images under 4MB.

## How it runs

One Bun process, spawned by Claude Code as a stdio MCP server. It also owns the
Teams webhook listener, bound to localhost:

```
Microsoft Teams ──HTTPS──> your ingress (prod: reverse proxy / dev: devtunnel)
                                   │
                            localhost:3978 /api/messages
                                   │
                       msteams MCP server (one Bun process)
                                   │  stdio MCP
                        Claude Code session
```

Every request is validated as an Entra JWT by the Microsoft SDK before it
reaches any of our code, so an anonymous dev tunnel is safe as a transport.

## Prerequisites

Unlike the Telegram and Discord channels, **Teams has to reach you** — it pushes
activities to a webhook rather than letting a bot poll. That is the one
structural difference, and it sets the bar for what you need:

- **[Bun](https://bun.sh)** on `PATH` — the MCP server runs on it. `curl -fsSL https://bun.sh/install | bash`.
- **A public HTTPS endpoint** that forwards to `127.0.0.1:3978` — a reverse proxy
  (Caddy) where you have a public IP, Cloudflare Tunnel behind NAT, or Microsoft
  `devtunnel` for development. The plugin binds localhost and you own the edge.
- **A Microsoft 365 tenant where you are Global Administrator**, plus an **Azure
  subscription with the Owner role** to hold the bot. The Azure Bot F0 tier is
  free; a Business Basic seat is ~$7/user/mo. Full cost table and the traps —
  including a trial that auto-converts to a twelve-month commitment — are in
  [docs/SETUP.md](docs/SETUP.md#cost).
- **Root on the machine running Claude Code**, once, to admit a third-party
  channel to the allowlist (see below).

## Install

This repo *is* its own marketplace — the plugin lives at the repo root and
`.claude-plugin/marketplace.json` points at it, so there is nothing else to
clone or host:

```
/plugin marketplace add gtapps/msteams-channel
/plugin install msteams@msteams-channel
```

A local checkout works the same way — `/plugin marketplace add <path-to-clone>`.

The marketplace name `msteams-channel` is load-bearing, not cosmetic:
it appears again in the allowlist entry and in the launch flag below, and all
three must agree or the channel silently fails to register.

## Two-step enablement (read this before filing a bug)

Installing the plugin is **not** enough. Two more things are required, both
verified against Claude Code v2.1.220.

**1. Admit the plugin to the channel allowlist** (root, once per machine).
Claude Code's default allowlist is exactly the channel plugins in
`anthropics/claude-plugins-official`, so a third-party channel needs an explicit
entry:

```bash
sudo mkdir -p /etc/claude-code
sudo tee /etc/claude-code/managed-settings.json >/dev/null <<'EOF'
{"channelsEnabled":true,"allowedChannelPlugins":[
  {"marketplace":"msteams-channel","plugin":"msteams"}]}
EOF
```

This list **replaces** the default allowlist rather than extending it, so any
other channel you use must be listed alongside it.

**2. Launch with the channel flag:**

```bash
claude --channels plugin:msteams@msteams-channel
```

That is the entire command — no `--plugin-dir`, no `--mcp-config`, and no
`--dangerously-load-development-channels`. `--channels` does not appear in
`claude --help`.

Two things worth knowing before you debug anything:

- **Inbound events are dropped silently** when the channel is not registered: no
  reply, no error, nothing in this plugin's log, because the message never
  reaches it. That is the protocol's normal failure mode, not a bug here.
- **The `Channels (experimental)` startup banner is cosmetic** — it prints
  whether or not registration succeeded. The only evidence is the
  `Channel notifications skipped:` line in `~/.claude/debug/<session-id>.txt`,
  which names the exact cause.

**`--dangerously-load-development-channels` does not work on v2.1.220.** The
published docs present it as the way to test an unpublished channel, but it never
registers the entry and its documented confirmation dialog never appears —
confirmed against Anthropic's own `fakechat` server under a non-allowlisted name,
which fails the same way. Use the managed-settings route above.

Full walkthrough and a failure-mode table: [`docs/SETUP.md`](docs/SETUP.md#step-6--enabling-the-channel).
Symptom-first index: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Setup

Per install you provide your own single-tenant Entra app registration and Azure
Bot resource, in your own tenant. The Azure Bot **F0 tier is free** and
Microsoft Teams counts as a "standard channel", so Teams messaging costs
nothing; you still need an Azure subscription to hold the resource.

**[docs/SETUP.md](docs/SETUP.md) is the runbook** — every command in it was
executed against a real tenant, and it records the several places where the
vendor tooling does not behave as documented (a broken `az bot msteams` command,
a tunnel hostname that ignores the alias you pin, a resource provider that is
unregistered by default). Read it before provisioning.

`/msteams:configure` will eventually walk this interactively; `/msteams:access`
manages pairing and allowlists.

Credentials live only in `~/.claude/channels/msteams/.env` (mode 0600), never
in argv or logs. Override the state dir with `MSTEAMS_STATE_DIR`.

Listener settings, all optional:

| Variable | Default | Notes |
|---|---|---|
| `MSTEAMS_WEBHOOK_PORT` | `3978` | One port per bot; several can share a host behind one proxy. |
| `MSTEAMS_WEBHOOK_PATH` | `/api/messages` | Must match the bot's messaging endpoint. |
| `MSTEAMS_WEBHOOK_HOST` | `127.0.0.1` | **Set to `0.0.0.0` in Docker** — loopback inside a container is the container's own, so a host-side proxy can't reach it. Publish the port too. |

## Security model

- **Transport auth**: Entra JWT validation by the Microsoft SDK — never
  hand-rolled.
- **Identity**: senders are matched on AAD object id. Display names never grant
  access.
- **Tenant boundary**: single-tenant registration plus an explicit tenant check
  on every activity.
- **Outbound gate**: replies, edits and proactive sends can only target
  conversations that were accepted inbound *and* are still allowed by the
  current access policy — a message cannot talk the bot into exfiltrating
  somewhere new, and revoking access revokes it in both directions.
- **Permission relay** reaches allowlisted DMs only; group chats are excluded.
  Answer with `y <code>` or `n <code>`; a code is one-shot.

  **The relay is dormant under `--permission-mode auto`.** Auto mode's
  classifier decides tool calls itself and emits no permission request at all,
  so nothing is ever relayed to Teams. This is expected, not a misconfiguration
  — the relay only does anything in a session started with
  `--permission-mode default`.

## Troubleshooting

Silence is this channel's normal failure mode — a message that is refused, or
never registered, produces no reply and no error anywhere the sender can see.
[**TROUBLESHOOTING.md**](TROUBLESHOOTING.md) is the symptom-first index: start
with the `Channel notifications` line in `~/.claude/debug/<session-id>.txt`,
which names the exact cause when nothing arrives at all.

## Development

```bash
bun test          # 249 tests, ~11s, no tenant or network required
bun run typecheck # must pass before committing
bun run dev       # run the MCP server standalone; stderr is the only log
bun send.ts --list  # proactive-send CLI: what is reachable right now
```

Use `bun run dev`, not `bun run start` — `start` is what Claude Code spawns and
installs production dependencies only, which prunes the devDependencies your
tests need. Full guide: [CONTRIBUTING.md](CONTRIBUTING.md).

CI runs exactly `bun run typecheck` and `bun test` — deliberately tenant-free,
so a fork can run it and no secret is ever exposed to one. Live verification is
the smoke test in [`docs/E2E.md`](docs/E2E.md), which an operator runs by hand.

One caveat when debugging a running session: **an MCP server's stderr reaches
`~/.claude/debug/<session-id>.txt` only at startup.** Mid-session writes go
nowhere, so server-side logging is a dev aid when running standalone, never
something to ask an operator to read live.

## Uninstall

```
/plugin uninstall msteams@msteams-channel
/plugin marketplace remove msteams-channel
```

Then remove the managed-settings entry from `/etc/claude-code/managed-settings.json`
(leaving any other channel you use in the list), and delete
`~/.claude/channels/msteams/` — it holds your credentials, access policy and
queued activities. Tearing down the Azure side is
[docs/SETUP.md § Teardown](docs/SETUP.md#teardown); cancel the M365 subscription
separately, in the admin center, before a trial converts.

## Support

Bugs and questions: [open an issue](https://github.com/gtapps/msteams-channel/issues).
Include the `Channel notifications` log line (or its absence) and your Claude
Code version, and **redact tenant ids, AAD object ids, conversation ids and any
`tempauth=` URL** — those are credentials.

Suspected security issue: [SECURITY.md](SECURITY.md) — report it privately, not
as an issue. Contributing: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the OpenClaw (MIT) and Claude
Code official-plugin (Apache-2.0) work this builds on.

[sdk]: https://github.com/microsoft/teams.ts
