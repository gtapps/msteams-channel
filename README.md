# Claude Code Microsoft Teams Channel Plugin

[![CI](https://github.com/gtapps/msteams-channel/actions/workflows/ci.yml/badge.svg)](https://github.com/gtapps/msteams-channel/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/release/gtapps/msteams-channel?sort=semver)](https://github.com/gtapps/msteams-channel/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Connect Microsoft Teams to a local Claude Code session. Messages from direct
chats and opted-in channels reach Claude, and replies return to the same
conversation or channel thread.

This community plugin follows the same Claude Code channel protocol and core
access patterns as Anthropic's official
[Discord](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/discord)
and [Telegram](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)
plugins. Its pairing, allowlists, permission relay and tool conventions will be
familiar; transport and threading are adapted for Teams using the
[Microsoft Agents SDK][sdk].

There is no hosted relay or third-party bot service. You run the plugin and its
HTTPS ingress, while the bot registration stays in your Microsoft tenant.

## Features

### Messaging

- [x] Direct messages
- [x] Opt-in Teams channels and group chats
- [x] Mention-gated shared conversations
- [x] Replies in the correct Teams channel thread
- [x] Markdown and plain-text replies
- [x] Automatic chunking of long responses
- [x] Editing messages previously sent by the bot
- [x] Proactive sends from `send.ts`

### Attachments

- [x] Inbound images downloaded automatically
- [x] Multiple inbound attachments in one message
- [x] Other inbound files downloaded on demand with `download_attachment`
- [x] Outbound PNG, JPEG, GIF, WebP and BMP images

Outbound images are limited to 10 per reply and must be under 4MB each.

### Access and reliability

- [x] Pairing and Microsoft account ID (AAD object ID) allowlists
- [x] Per-conversation channel and group-chat policies
- [x] Messages restricted to your Microsoft 365 organization
- [x] Immediate inbound and outbound revocation
- [x] Permission requests relayed to allowlisted DMs
- [x] Durable inbound queue, deduplication and restart replay

### Differences from Discord and Telegram

Unchecked items are unavailable today; they are not necessarily roadmap
commitments.

- [ ] **Reactions** — require a signed-in Microsoft user; this bot runs
      unattended without one. See
      [docs/REACTIONS.md](docs/REACTIONS.md).
- [ ] **Typing indicator** — supported by both official plugins.
- [ ] **General outbound files** — Discord and Telegram support them; Teams
      sends images only.
- [ ] **Permission buttons** — Discord and Telegram provide Allow/Deny controls.
      Teams accepts `y <code>` or `n <code>`.
- [ ] **Recent message retrieval** — Discord can fetch recent history; Telegram
      and Teams process messages only as they arrive.

## Requirements

Teams pushes messages to a webhook, so it must reach the machine running Claude
Code.

- **[Bun](https://bun.sh)** on `PATH`.
- **A public HTTPS endpoint** forwarding to `127.0.0.1:3978`, such as a reverse
  proxy, Cloudflare Tunnel or Microsoft `devtunnel`.
- **A Microsoft 365 organization you administer** and an **Azure subscription
  with the Owner role**. See [costs](SETUP.md#cost).
- **[Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli)
  recommended.** The tested setup is CLI-first, with a few Microsoft 365 and
  Teams admin-center steps.
- Permission to configure Claude Code managed settings, locally or centrally.

## Quick setup

### 1. Register the Teams bot

Register the bot with Microsoft, create its credentials, and connect it to
Teams by following [provisioning steps 0–5](SETUP.md#step-0--enable-custom-app-upload-first).
They use Azure CLI where possible and `az rest` for one operation that
`az bot msteams create` currently cannot complete.

Credentials stay in `<state dir>/.env` with mode `0600`, never in command
arguments or logs. State lives in `~/.claude/channels/msteams/` — user scope,
beside the discord and telegram channels — and `MSTEAMS_STATE_DIR` moves it. The
runtime, the proactive-send CLI and both operator skills resolve the same rule,
so they always agree. See [state directory](#state-directory).

Want Claude to guide the process? Copy the prompt under
[Agent-assisted setup](SETUP.md#agent-assisted-setup).

### 2. Install the plugin

Run these commands where Claude Code runs:

```bash
claude plugin marketplace add gtapps/msteams-channel
claude plugin install msteams@msteams-channel --scope local
```

A local checkout works too: replace `gtapps/msteams-channel` in the first
command with `/path/to/msteams-channel`.

Use local scope: every loaded instance starts a webhook listener, so a
user-scoped install can create port conflicts.

### 3. Allow the community channel

Installing is not enough. `/etc/claude-code/managed-settings.json` has to both
enable channels and list this plugin — or ask your Claude Code administrator to
set the same values centrally:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [{ "marketplace": "msteams-channel", "plugin": "msteams" }]
}
```

`allowedChannelPlugins` **replaces** the defaults, so preserve every existing
channel entry. `channelsEnabled` is required as soon as the file exists at all:
creating it with the allowlist alone leaves channels off and inbound messages
silently dropped. See the
[full enablement walkthrough](SETUP.md#step-6--enabling-the-channel).

### 4. Launch and pair

```bash
claude --channels plugin:msteams@msteams-channel
```

Run `/msteams:configure` to check status. Then DM the bot, approve its pairing
code in Claude Code, and lock it down:

```text
/msteams:access pair <code>
/msteams:access policy allowlist
```

## Operator commands

```text
/msteams:configure                         Show configuration status
/msteams:access                            Show the current access policy
/msteams:access pair <code>                Approve a pending DM sender
/msteams:access deny <code>                Reject a pending pairing
/msteams:access allow <aad-object-id>       Allow a sender directly
/msteams:access remove <aad-object-id>      Revoke a sender
/msteams:access policy allowlist            Stop issuing new pairing codes
/msteams:access group add <conversation>    Enable a channel or group chat
/msteams:access group rm <conversation>     Disable a channel or group chat
```

See [ACCESS.md](ACCESS.md) for mention settings, per-conversation sender lists
and the full command reference.

Proactive sending does not require a running Claude Code session:

```bash
bun send.ts --list
bun send.ts --conversation <id> --text "Deployment complete"
```

## Tools exposed to Claude

| Tool                  | Purpose                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------- |
| `reply`               | Reply to a DM, channel, group chat or channel thread. Supports text chunking and outbound images. |
| `edit_message`        | Replace the text of a message previously sent by the bot.                                         |
| `download_attachment` | Download a non-image inbound attachment into the local inbox.                                     |
| `react`               | Currently returns an explanatory error because Teams reactions require delegated authentication.  |

## How it works

Claude Code starts one Bun process for MCP over stdio and the Teams webhook:

```text
Microsoft Teams ──HTTPS──> your ingress
                                │
                     127.0.0.1:3978/api/messages
                                │
                      msteams MCP server
                                │ stdio
                         Claude Code session
```

The Microsoft SDK authenticates requests before they reach the plugin. You own
the HTTPS edge; the plugin binds to localhost by default.

Optional listener settings:

| Variable               | Default         | Notes                                         |
| ---------------------- | --------------- | --------------------------------------------- |
| `MSTEAMS_WEBHOOK_PORT` | `3978`          | One port per bot.                             |
| `MSTEAMS_WEBHOOK_PATH` | `/api/messages` | Must match the bot's messaging endpoint.      |
| `MSTEAMS_WEBHOOK_HOST` | `127.0.0.1`     | Use `0.0.0.0` in Docker and publish the port. |

### State directory

State is user scope by default — `~/.claude/channels/msteams/`, beside the
discord and telegram channels — holding `.env`, `access.json`, conversation
references and the queue. Dirs are `0700`, files `0600`.

`MSTEAMS_STATE_DIR` moves it. Export it in the shell that launches `claude`, so
both the listener and the operator skills see it:

```bash
export MSTEAMS_STATE_DIR="$PWD/.claude/channels/msteams"
claude --channels plugin:msteams@msteams-channel
```

Declaring it in `.claude/settings.local.json` under `env` reaches the listener,
but does not reliably reach the skills — and when only one side moves,
`/msteams:access` edits a file the listener never reads. The skills detect that
split and refuse to write rather than report a revocation that did not happen.
`/msteams:configure` prints the directory it resolved; the listener's own answer
is the `ready (state dir …)` line in `~/.claude/debug/<session-id>.txt`.

A project-local state dir holds live credentials, so add it to that repo's
`.gitignore` yourself — nothing is written for you.

### One listener per bot

An Azure Bot registration has one messaging endpoint URL, so Teams traffic
reaches exactly one listener, on one host, on one port. No state layout changes
that.

Two projects sharing the default state dir see each other's `bot.pid`, and the
newer listener evicts the older one — the port changes hands, but the evicted
session goes quiet without saying so. Give them separate state dirs and they
collide on the port instead: the second logs `FAILED to bind …` and exits, which
is the same outcome stated out loud. Restarting within one project still
replaces its own stale listener either way.

Running two projects on Teams for real needs two Entra apps, two bot
registrations, two Teams app manifests, two tunnel hostnames and a distinct
`MSTEAMS_WEBHOOK_PORT` each. Sending is unaffected — `send.ts` needs no port.

## Security

- The Microsoft SDK authenticates requests and the plugin enforces the tenant.
- Microsoft account IDs grant access; display names never do.
- Every outbound send requires a previously accepted conversation that is still
  allowed, so revocation stops both directions immediately.
- Permission requests go only to allowlisted DMs and use one-shot verdicts.

Permission relay requires `--permission-mode default`; auto mode does not
produce permission requests.

## Troubleshooting

An unregistered or refused message fails silently in Teams. Start with the
`Channel notifications skipped:` line in
`~/.claude/debug/<session-id>.txt`, then use
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

The tested Claude Code version did not register this community channel through
`--dangerously-load-development-channels`; use managed settings and the
`--channels` launch flag described above.

## Development

```bash
bun test
bun run typecheck
bun run dev
bun send.ts --list
```

CI needs no tenant or network. Live tenant verification is maintainer-run; see
[CONTRIBUTING.md](CONTRIBUTING.md) for the public development workflow.

## Uninstall

```bash
claude plugin uninstall msteams@msteams-channel --scope local
claude plugin marketplace remove msteams-channel
```

Remove only the `msteams` managed-settings entry. Delete your state dir
(`MSTEAMS_STATE_DIR`, default `~/.claude/channels/msteams/`), then follow the
[Azure teardown](SETUP.md#teardown). Cancel paid Microsoft 365 licensing
separately.

## Support

Bugs and questions: [open an issue](https://github.com/gtapps/msteams-channel/issues)
with your Claude Code version and `Channel notifications` log line. Redact
tenant, account and conversation ids and any `tempauth=` URL.

Report suspected security issues through [SECURITY.md](SECURITY.md), not a
public issue. Contributions are covered in [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [ATTRIBUTIONS.md](ATTRIBUTIONS.md) for the OpenClaw (MIT) and Claude
Code official-plugin (Apache-2.0) work this builds on.

[sdk]: https://github.com/microsoft/teams.ts
