---
name: configure
description: Set up the Microsoft Teams channel — save Entra credentials and review access policy. Use when the user pastes a Teams app id or secret, asks to configure Teams, asks "how do I set this up" or "who can reach me," or wants to check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(echo *)
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(chmod *)
---

# /msteams:configure — Teams Channel Setup

Writes Entra credentials to `<STATE_DIR>/.env` and orients the user on access
policy. The server reads `.env` once at boot and `access.json` on every inbound
message.

## Resolve the state dir

Run this first and use the output as `<STATE_DIR>` for every path below:

```bash
echo "${MSTEAMS_STATE_DIR:-$HOME/.claude/channels/msteams}"
```

This is the same rule `server.ts` uses, so the skill and the listener agree
whenever they see the same environment. Report the resolved path in your status
output — if it is not what the operator expects, that is the bug, and everything
else you say will be about the wrong directory.

**Never `mkdir` while reporting status.** A missing directory is a status to
report, not a state to fix; creating one here would shadow the operator's real
state dir. Only the credential-saving path below creates anything.

Unlike a Discord bot token, Teams needs a provisioning chain: an Entra app, a
service principal, an Azure Bot, a tunnel, and a Teams app manifest. The full
walkthrough with exact commands is `SETUP.md` in this plugin's repo. Send
the user there for provisioning; this skill handles credentials, status, and the
few steps that are easy to get wrong.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give a complete picture:

0. **State dir** — report the resolved `<STATE_DIR>` on its own line, so a
   relocation that only reached half the system is visible rather than inferred.

1. **Credentials** — check `<STATE_DIR>/.env` for
   `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`, `MSTEAMS_TENANT_ID`. Show
   set/not-set per key; never echo the secret, and mask the app id beyond its
   first segment. All three are required — the listener does not start without
   them, though MCP still serves so this skill stays reachable.

2. **Access** — read `<STATE_DIR>/access.json` (missing =
   defaults: `dmPolicy: "pairing"`, empty allowlist). Show the DM policy and
   what it means in one line, allowed senders, pending pairings with codes, and
   opted-in conversations.

3. **What next** — one concrete step for where they actually are. Missing
   credentials sends them to `SETUP.md`; credentials present but nobody
   allowed means they should DM the bot in Teams and approve the code it returns
   with `/msteams:access pair <code>`; everything set means they are ready.

**Push toward lockdown — always.** The goal for every setup is `allowlist` with
a defined list. `pairing` is not a policy to stay on; it is a temporary way to
capture AAD object ids you do not know yet. Once the ids are in, pairing has
done its job.

Drive that conversation: read the allowlist, tell the user who is in it, ask
whether that is everyone who should reach them. If yes and the policy is still
`pairing`, offer to run `/msteams:access policy allowlist` — proactively, don't
wait to be asked. If people are missing, have them message the bot and approve
each one. If the allowlist is empty and they have not paired themselves, that is
the first step. Never frame `pairing` as the correct long-term choice.

Teams already limits reach to your tenant, but a tenant is not an allowlist —
every colleague is inside it.

### Saving credentials

Accept them one at a time or together. Recognize what you were handed:

- an **app id** / **client id** / **tenant id** — a GUID
- an **app password** / **client secret** — the value Azure shows once at
  creation, never the "secret ID" beside it, which is not a credential

Then:

1. `mkdir -p "<STATE_DIR>"`
2. Read the existing `.env` if present; update or add only the keys you were
   given and preserve the rest. No quotes around values.
3. `chmod 600 "<STATE_DIR>/.env"` — these credentials let anyone post as the bot.
4. Confirm what was saved — naming `<STATE_DIR>`, never the secret — then show
   the no-args status.

**The server reads `.env` at boot.** A credential change needs a session restart
to take effect; say so after saving.

Never pass a credential as a command argument: argv is world-readable in `/proc`
on Linux. Write the file with the Write tool.

### `clear` — remove credentials

Delete the `MSTEAMS_*` lines (or the file, if that is all it holds).

---

## The step everyone misses

**`az ad sp create --id <app-id>` is mandatory.** `az ad app create` registers
the application but does not create the enterprise application (service
principal), so the tenant refuses to issue it a token.

Raise this whenever a user reports that inbound works but replies fail, and
whenever you walk someone through a manual registration. The failure is
maximally delayed and misleading: everything provisions, the channel registers,
inbound messages arrive and pass the gate, Claude composes a reply — and only
the *send* fails, with:

```
AADSTS7000229: The client application <app-id> is missing service principal in the tenant <tenant-id>
```

`@microsoft/teams.cli` does this as a side effect of its own provisioning, so
only manual registrations hit it — which is exactly the path `SETUP.md`
documents.

---

## Implementation notes

- The state dir may not exist if the server has never run. Missing file =
  not configured, not an error.
- **If `<STATE_DIR>` is not where the operator expects**, `MSTEAMS_STATE_DIR` is
  not reaching this shell. Anything written here then lands where the listener
  never looks: credentials appear unset to the server, and `/msteams:access`
  changes take effect nowhere. Declaring the variable in
  `.claude/settings.local.json` reaches the MCP server but may not reach skills —
  `export MSTEAMS_STATE_DIR=…` in the shell that launches `claude` reaches both.
  The listener's own answer is authoritative and is in
  `~/.claude/debug/<session-id>.txt`: `msteams channel: ready (state dir …)`.
- `access.json` is re-read on every inbound message, so policy changes via
  `/msteams:access` take effect immediately — no restart. Credentials are the
  opposite. Be precise about which is which when telling the user what to do.
- Enabling the channel in Claude Code is a **separate** two-part step from
  provisioning: an `allowedChannelPlugins` entry in
  `/etc/claude-code/managed-settings.json` (root-written; that list *replaces*
  the default, so every channel already in use must be re-listed) plus launching
  with `--channels plugin:msteams@msteams-channel`. If the user says
  the bot is running but nothing reaches the session, that is where to look —
  `TROUBLESHOOTING.md` has the diagnosis, which starts at the `Channel
  notifications skipped:` line in `~/.claude/debug/<session-id>.txt`.
- Never write credentials anywhere but `.env`, and never echo a secret back to
  the user — not even to confirm it was received.
