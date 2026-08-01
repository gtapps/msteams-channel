# Troubleshooting

Everything here was observed on Claude Code **v2.1.220** against a real tenant.
Where it contradicts the published channels reference, the observed behavior is
what is recorded — see [`SETUP.md`](SETUP.md#step-6--enabling-the-channel).

**Start here, always.** Inbound events are dropped *silently* when the channel
isn't registered — no reply, no error, and nothing in this plugin's log, because
the message never reaches it. There is exactly one place that says why:

```bash
claude --debug                                        # prints the session's debug-log path
grep "Channel notifications" ~/.claude/debug/<session-id>.txt
```

**The `Channels (experimental)` startup banner is cosmetic** — it prints whether
or not registration succeeded. Never debug from the banner.

## Nothing arrives at all

| Symptom / log line | Cause and fix |
|---|---|
| `not on the approved channels allowlist` | The managed-settings entry is missing. [SETUP 6b](SETUP.md#6b--admit-the-plugin-to-the-channel-allowlist). |
| `channels not enabled by org policy` | `/etc/claude-code/managed-settings.json` exists but omits `"channelsEnabled": true` — the allowlist alone is not enough, and adding the file for the allowlist alone is what usually causes this. [SETUP 6b](SETUP.md#6b--admit-the-plugin-to-the-channel-allowlist). |
| `not in --channels list for this session` | The entry never resolved to an installed plugin — usually a shadowed MCP server, see the next row. |
| `Suppressing plugin MCP server "plugin:msteams:msteams": duplicates manually-configured "msteams"` | A stray `--mcp-config` or project `.mcp.json` also defines an `msteams` server. Claude Code silently prefers it: the listener runs happily under `server:msteams` and accepts real Teams traffic while `--channels plugin:msteams@…` points at a server that no longer exists. Delete the stray config and relaunch. |
| `you asked for plugin:msteams@X but the installed msteams plugin is from Y` | Wrong marketplace name in `--channels`. Use the name from `claude plugin marketplace list`. |
| No `Channel notifications` line at all | The session was launched without `--channels plugin:msteams@msteams-channel`. That flag does not appear in `claude --help`. |
| Installed with `--plugin-dir` | Yields the id `plugin:msteams:msteams`, with no marketplace component, which `plugin:msteams@msteams-channel` can never match. Install properly: [SETUP 6a](SETUP.md#6a--install-at-local-scope). |
| Installed at user scope, works intermittently | Every session on the machine spawns its own copy and they evict each other on the fixed webhook port. Install at **local** scope. |
| `--dangerously-load-development-channels` does nothing | Confirmed on v2.1.220: it never enters the entry into the session's channel list and its documented confirmation dialog never appears — reproduced with Anthropic's own `fakechat` server, so it is not specific to this plugin. Use the managed-settings route. |
| Teams shows nothing and the bot never responds | Is the listener actually reachable? `curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3978/api/messages` locally, then confirm the bot's messaging endpoint in Azure matches your public URL + `/api/messages`. Recreating a devtunnel changes the hostname; the alias is not part of it. |

## DMs work, channel messages are ignored

Channels are **opt-in**, and a channel that isn't opted in is refused silently —
saying why would confirm the bot exists and leak policy.

| Check | Fix |
|---|---|
| Is the channel opted in? | `/msteams:access` with no arguments lists what is. Add it with `/msteams:access group add 19:…@thread.tacv2`. |
| Do you have the right id? | In Teams: channel **⋯ → Copy link**; the URL carries the conversation id URL-encoded (`%3A` → `:`, `%40` → `@`). Strip anything from `;messageid=` onward. See [Channels and group chats](ACCESS.md#channels-and-group-chats). |
| Did you actually @-mention the bot? | `requireMention` defaults to true, and Teams sends a real mention entity — typing the bot's name as plain text does not count. |
| Group chat rather than a channel? | Group chats have no shareable link. Run the server standalone briefly to capture the refused conversation id, then opt it in. See [Channels and group chats](ACCESS.md#channels-and-group-chats). |

`access.json` is re-read on every inbound message — edits take effect immediately,
no restart.

## Access changes do nothing, or a pairing is never confirmed

Symptoms: `/msteams:access pair <code>` says there is no such code although the
bot just issued one; or `remove`, `policy` and `deny` report success and change
nothing the bot does.

One cause — the skill and the listener are using **different state directories**,
so the skill is editing a file nobody reads.

| Check | Fix |
|---|---|
| Which dir does the listener use? | `msteams channel: ready (state dir …)` in `~/.claude/debug/<session-id>.txt`. Startup output reaches that log; mid-session stderr does not. |
| Which dir does the skill use? | `/msteams:configure` prints it. If the two differ, that is the bug. |
| Why do they differ? | `MSTEAMS_STATE_DIR` reached one and not the other. Declaring it in `.claude/settings.local.json` under `env` reaches the MCP server but not reliably the skills. |
| Fix | `export MSTEAMS_STATE_DIR=…` in the shell that launches `claude`, so both see it, then restart the session. |

`/msteams:access` refuses to write when it detects this rather than reporting a
revocation that did not happen. A credential change also needs a restart —
`.env` is read once at boot, unlike `access.json`.

## Messages arrive but replies fail

The tool reports the underlying error verbatim. Read it rather than guessing.

| Error | Cause |
|---|---|
| `AADSTS7000229: … missing service principal in the tenant …` | The service principal was never created. `az ad sp create --id <app-id>` — the common one after a manual registration. |
| `AADSTS7000215: Invalid client secret` | Wrong or expired credential in `.env`. Check nothing quoted it. |
| `AADSTS700016: Application not found in the directory` | `MSTEAMS_APP_ID` doesn't match the registration, or you're pointed at the wrong tenant. |
| `refused: no inbound conversation on record` | Working as designed — the bot may only reply where it was spoken to. Message it from Teams first. With `send.ts`, note it wants the Bot Framework conversation id from `--list` (`a:1…`), **not** the `19:…@unq.gbl.spaces` id from a Teams deep link. |
| `412` from `react` | Expected with the current unattended authentication. No application permission or manifest edit fixes it. [`docs/REACTIONS.md`](docs/REACTIONS.md). |

## Other things that look broken and aren't

| Symptom | Explanation |
|---|---|
| Permission prompts never reach Teams | The relay is dormant under `--permission-mode auto` — auto mode's classifier decides tool calls itself and emits no permission request at all. Start the session with `--permission-mode default`. |
| A stranger DMs the bot and gets a pairing code | Deliberate: without it, `dmPolicy: "pairing"` would be indistinguishable from `disabled`. Once your ids are captured, switch to `allowlist` (`/msteams:access policy allowlist`) so strangers get silence instead. |
| The answer appears in the terminal but not in Teams | The model treated the turn as finished without calling `reply`. The MCP `instructions` string exists to prevent exactly this; if you can reproduce it, it's a bug worth reporting — include what the turn did first. |
| Non-image file attachments fail outbound | Only images are supported (inline data URI, <4 MB, ≤10 per reply). Other types need the FileConsentCard / SharePoint routes, which are not implemented. |
| Claude has no memory of earlier Teams messages | Teams exposes no history to this plugin, so there is no `fetch_messages` tool to write. Paste or summarize. |
| A message sent while the server was down never arrives | The queue is persist-before-ack: it survives a crash mid-processing, not an offline window. Bot Framework's retries are shallow. |
| Nothing in `~/.claude/debug/<session-id>.txt` from the server mid-session | Only an MCP server's *startup* stderr reaches that file. Mid-session writes go nowhere — run `bun server.ts` standalone if you need to watch it live. |

Still stuck? Open an issue with the `Channel notifications` log line (or its
absence), your Claude Code version, and what you expected — and **redact tenant
ids, AAD object ids, conversation ids and any `tempauth=` URL** before pasting.
Suspected security issue: [`SECURITY.md`](SECURITY.md), not a public issue.
