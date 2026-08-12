# Claude Code Microsoft Teams Channel Plugin

[![CI](https://github.com/gtapps/msteams-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/gtapps/msteams-channel/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/gtapps/msteams-channel?sort=semver)](https://github.com/gtapps/msteams-channel/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A Claude Code **[channel plugin](https://code.claude.com/docs/en/channels)** that
connects a Microsoft Teams bot to your Claude Code session.

When the bot receives a message (a DM, or an @-mention in an opted-in channel or
group chat), the MCP server forwards it to Claude and provides tools to reply
and edit messages. Replies land in the same conversation or channel thread.

This is the Microsoft Teams counterpart to the official
[Discord](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord)
and [Telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)
channels, built on the [Microsoft Agents SDK][sdk]. Pairing, allowlists and the
permission relay work the same. There is no hosted relay or bot service: you run
the plugin and its HTTPS ingress, and the bot registration stays in your
Microsoft tenant.

## Prerequisites

Teams pushes messages to a webhook, so it must reach the machine running Claude Code.

- **[Bun](https://bun.sh)** on `PATH`: the MCP server runs on Bun.
- **A public HTTPS endpoint** forwarding to `127.0.0.1:3978`: a reverse proxy,
  Cloudflare Tunnel, or Microsoft `devtunnel` for development.
- **A Microsoft 365 organization you administer** and an **Azure subscription with the
  Owner role**. See [costs](SETUP.md#cost).
- **[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)**: the setup
  is CLI-first, with a few Microsoft 365 and Teams admin-center steps.
- Permission to edit Claude Code **managed settings**.

## Quick Setup

> Registering a Teams bot takes real Azure provisioning, with more steps than Discord
> or Telegram. [SETUP.md](SETUP.md) is the full runbook, and its
> [agent-assisted setup prompt](SETUP.md#agent-assisted-setup) lets Claude Code drive
> the process for you.

**1. Register the Teams bot.**

Follow [SETUP.md steps 0–5](SETUP.md#step-0-enable-custom-app-upload): Entra app
registration, credentials, Azure Bot, Teams channel. Credentials land in
`<state dir>/.env` with mode `0600`, never in command arguments or logs.

**2. Install the plugin.**

Run these where Claude Code runs:

```bash
claude plugin marketplace add gtapps/msteams-channel
claude plugin install msteams@msteams-channel --scope local
```

A local checkout works too: replace `gtapps/msteams-channel` in the first command with
`/path/to/msteams-channel`. Use **local scope**, because every session that loads the
plugin starts a webhook listener, and a user-scoped install creates port conflicts.

**3. Allow the community channel.**

On Claude Code v2.1.220+, community channel plugins must be allowlisted in the
managed-settings file (`/etc/claude-code/managed-settings.json` on Linux and
WSL, `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS),
with channels enabled:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [
    { "marketplace": "msteams-channel", "plugin": "msteams" }
  ]
}
```

> `allowedChannelPlugins` **replaces** the default allowlist, so preserve every
> existing channel entry. Once the file exists, `channelsEnabled: true` is required or
> every channel is silently blocked. Details:
> [SETUP.md step 6](SETUP.md#step-6-enable-the-channel-in-claude-code).

**4. Launch with the channel flag.**

```bash
claude --channels plugin:msteams@msteams-channel
```

Do not use `--dangerously-load-development-channels`: as of Claude Code v2.1.220 it
does not register community channels. The managed-settings route above is required.

**5. Pair.**

DM the bot on Teams and it replies with a pairing code. In your Claude Code session:

```text
/msteams:access pair <code>
```

Your next DM reaches the assistant. `/msteams:configure` shows configuration status if
nothing happens.

**6. Lock it down.**

Pairing is for capturing IDs. Once you're in, switch to `allowlist` so strangers don't
get pairing-code replies:

```text
/msteams:access policy allowlist
```

## Access control

See **[ACCESS.md](ACCESS.md)** for DM policies, channel and group-chat opt-in, mention
detection, the permission relay, skill commands, and the `access.json` schema.

Quick reference: senders are matched on **AAD object IDs** (pairing captures them;
display names never grant access). Default policy is `pairing`. Channels and group
chats are opt-in per conversation ID and mention-gated by default. Messages from other
tenants are refused outright.

Adding the bot to a team or group chat installs a Teams app, so it needs an app
package: `./teams-app/build.sh` builds one from your bot id. DMs need none of this.
See [SETUP.md](SETUP.md#adding-the-bot-to-a-team-or-group-chat).

## Tools exposed to the assistant

| Tool                  | Purpose                                                                                                          |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `reply`               | Reply to a DM, channel, group chat or channel thread. Auto-chunks long text; attaches files.                     |
| `edit_message`        | Replace the text of a message the bot previously sent. Useful for "working…" → result updates.                   |
| `download_attachment` | Download a non-image inbound attachment into the local inbox.                                                    |
| `react`               | Returns an explanatory error: Teams reactions need a signed-in user. See [docs/REACTIONS.md](docs/REACTIONS.md). |

Proactive sends need no running session:

```bash
bun send.ts --list
bun send.ts --conversation <id> --text "Deployment complete"
bun send.ts --conversation <id> --files ./report.pdf
```

## Differences from Discord and Telegram

| Capability         |            Teams            |  Discord   |  Telegram  |
| ------------------ | :-------------------------: | :--------: | :--------: |
| Reactions          | ❌ [why](docs/REACTIONS.md) |     ✅     |     ✅     |
| Typing indicator   |             ❌              |     ✅     |     ✅     |
| Outbound files     |       ✅ [how](#attachments)       |     ✅     |     ✅     |
| Permission prompts |   `y <code>` / `n <code>`   | ✅ buttons | ✅ buttons |
| Message history    |             ❌              | ✅ recent  |     ❌     |

Unchecked capabilities are unavailable today, not roadmap commitments.

## Attachments

Inbound images are downloaded automatically to `<state dir>/inbox/`; other file types
are listed in the notification and fetched on demand with `download_attachment`.

Outbound, Teams has no single "send a file" call, so each file takes one of three
routes. Claude just passes paths to `reply`; the routing is automatic.

| File | In a DM | In a channel or group chat |
|---|---|---|
| Image under 4MB | inline, renders in the message | inline, renders in the message |
| Anything else (and larger images) | consent card the recipient must Accept | uploaded to SharePoint, posted as a file card |

Limits: 100MB per file, 10 files and 200MB per reply.

**Consent cards are asynchronous.** In a DM the bot cannot push a file at someone: it
offers one, and the bytes move only when the recipient clicks Accept. The tool result
says `offered <name>`, and that is the end of it, no completion event follows. The
channel server must be running when they click, because it is what performs the
upload. Unaccepted offers expire after an hour.

**Channels and group chats need a SharePoint site** (`MSTEAMS_SHAREPOINT_SITE_ID`, see
[SETUP.md](SETUP.md#file-sending-to-channels-and-group-chats)). Without it, text,
inline images and DM file sends all keep working, and only those sends fail, with an
explanation. Channel files get an organization-wide link; group-chat files get a link
restricted to the people in that chat, and the send fails rather than widening the
link if that membership cannot be read.

Teams exposes no message history to bots, so Claude only sees messages as they
arrive; paste or summarize earlier context.

## How it works

Claude Code starts one Bun process that is both the MCP server and the Teams webhook:

```text
Microsoft Teams ──HTTPS──> your ingress
                                │
                     127.0.0.1:3978/api/messages
                                │
                      msteams MCP server
                                │ stdio
                         Claude Code session
```

The Microsoft SDK authenticates every request before it reaches plugin code. You own
the HTTPS edge; the plugin binds localhost by default.

| Variable               | Default         | Notes                                         |
| ---------------------- | --------------- | --------------------------------------------- |
| `MSTEAMS_WEBHOOK_PORT` | `3978`          | One port per bot.                             |
| `MSTEAMS_WEBHOOK_PATH` | `/api/messages` | Must match the bot's messaging endpoint.      |
| `MSTEAMS_WEBHOOK_HOST` | `127.0.0.1`     | Use `0.0.0.0` in Docker and publish the port. |

### State directory

`~/.claude/channels/msteams/` by default, beside the discord and telegram channels,
holding `.env`, `access.json`, conversation references and the queue. Dirs are `0700`,
files `0600`.

`MSTEAMS_STATE_DIR` moves it. Export it **in the shell that launches `claude`** so the
listener and the operator skills resolve the same directory; when they split, the
skills detect it and refuse to write. See
[TROUBLESHOOTING.md](TROUBLESHOOTING.md#access-changes-do-nothing-or-a-pairing-is-never-confirmed).
A project-local state dir holds live credentials, so gitignore it yourself.

One bot registration has one messaging endpoint, so Teams traffic reaches exactly one
listener. Running a second project needs its own bot registration end to end; see
[SETUP.md](SETUP.md#running-more-than-one-project).

## Security

- The Microsoft SDK authenticates requests; the plugin enforces the tenant boundary.
- AAD object IDs grant access; display names never do.
- Every outbound send requires a conversation the inbound gate already accepted _and_
  that is still allowed; revocation stops both directions immediately.
- Permission requests go only to allowlisted DMs and use one-shot verdicts. The relay
  needs `--permission-mode default`; auto mode never asks.
- Outbound files add one egress path: uploads go only to Microsoft hosts (allowlisted,
  HTTPS, refusing redirects, and rejecting any host that resolves to a private address)
  or to the SharePoint site you configured. The upload URL Teams hands back is treated
  as a credential: held in memory, never logged, never written to disk.
- Files the channel itself stores (credentials, conversation references, pending
  snapshots) can never be sent back out; the inbox is the one exception, since that is
  where inbound downloads land.

## Troubleshooting

An unregistered or refused message fails silently in Teams. Start with the
`Channel notifications skipped:` line in `~/.claude/debug/<session-id>.txt`, then
follow [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Development

```bash
bun test             # no tenant, no network
bun run typecheck
bun run dev
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow.

## Uninstall

```bash
claude plugin uninstall msteams@msteams-channel --scope local
claude plugin marketplace remove msteams-channel
```

Remove the `msteams` managed-settings entry, delete your state dir
(`MSTEAMS_STATE_DIR`, default `~/.claude/channels/msteams/`), then follow the
[Azure teardown](SETUP.md#teardown). Cancel paid Microsoft 365 licensing separately.

## Support

Bugs and questions: [open an issue](https://github.com/gtapps/msteams-channel/issues)
with your Claude Code version and `Channel notifications` log line, and **redact
tenant, account and conversation IDs and any `tempauth=` URL**. Suspected security
issues go through [SECURITY.md](SECURITY.md), not a public issue.

## License

MIT.

[sdk]: https://github.com/microsoft/teams.ts
