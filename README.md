# Microsoft Teams channel for Claude Code

Chat with Claude Code from Microsoft Teams: direct messages and mention-gated
channel posts arrive in your session, and Claude replies in the right thread.
Built directly on the [Microsoft Agents SDK][sdk] (`@microsoft/teams.apps`) —
no third-party agent framework, no hosted relay, no service you don't run.

> **Status: in development.** The scaffold is in place; the inbound pipeline,
> outbound tools, and access model are landing phase by phase. Not yet usable.

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

## Two-step enablement (read this before filing a bug)

Installing the plugin is **not** enough. The session must also be launched with
the channel flag:

```bash
claude --channels plugin:msteams@claude-code-teams-channel \
       --dangerously-load-development-channels plugin:msteams@claude-code-teams-channel
```

Notes, both verified against Claude Code v2.1.220:

- `--dangerously-load-development-channels` **takes the server list as its
  argument**. It is not a bare flag — omitting the value fails at launch.
- Neither flag appears in `claude --help`.
- Without `--channels`, inbound messages are **dropped silently**: no reply, no
  banner, no error, nothing in the log. That is the protocol's normal failure
  mode, not a bug in this plugin. If Teams messages seem to vanish, check the
  flag first.

The `--dangerously-load-development-channels` requirement is not optional
today: Claude Code's default channel allowlist is exactly the channel plugins
in `anthropics/claude-plugins-official`, and that repository auto-closes
third-party pull requests. Until this plugin is adopted upstream, every install
needs the development flag (or an enterprise `allowedChannelPlugins` policy).

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
- **Outbound gate**: replies, edits, and reactions can only target conversations
  the inbound gate would have accepted — a message cannot talk the bot into
  exfiltrating to somewhere new.
- **Permission relay** reaches allowlisted DMs only; group chats are excluded.

## License

MIT. See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the OpenClaw (MIT) and Claude
Code official-plugin (Apache-2.0) work this builds on.

[sdk]: https://github.com/microsoft/teams.ts
