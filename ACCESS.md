# Microsoft Teams — Access & Delivery

Who can reach your Claude Code session through this channel, and how to change
it. Structure mirrors the official discord and telegram plugins, because the
model is theirs; the differences are noted where Teams forced them.

Everything here is edited through `/msteams:access`, never by hand and never in
response to a Teams message.

## At a glance

| | Default |
|---|---|
| DM policy | `pairing` — an unknown sender gets a code, not access |
| Allowlist | empty |
| Channels and group chats | none opted in |
| Mention required in a channel | yes |
| Tenant | messages from any other tenant are refused before anything else |

## DM policies

`dmPolicy` governs 1:1 chats.

- **`pairing`** (default) — an unknown sender gets a 6-hex code and nothing
  else. You approve with `/msteams:access pair <code>`. Codes live 1 hour, at
  most 3 are outstanding at once, and a sender is answered twice before the bot
  goes silent on them.
- **`allowlist`** — only `allowFrom` gets through. Unknown senders are dropped
  silently. **This is the state to end up in.**
- **`disabled`** — no DMs at all.

Pairing is a capture mechanism, not a resting state. Its job is to collect AAD
object ids you do not know yet. Once they are in `allowFrom`, switch to
`allowlist` so nobody else can even trigger a code.

## Identities are AAD object ids

Senders are matched on **AAD object id only** — the GUID Entra assigns each
user. Never a display name, which the sender controls, and never an email.

An activity with no `aadObjectId` is refused outright: that means a principal we
cannot pin an identity to, and falling back to a name would be exactly the wrong
move.

You rarely need to find one by hand. Pairing captures it, and
`/msteams:access` prints it.

## Channels and group chats

A channel is opted in per conversation:

```
/msteams:access group add 19:...@thread.tacv2
/msteams:access group add 19:...@thread.tacv2 --no-mention
/msteams:access group add 19:...@thread.tacv2 --allow <oid1>,<oid2>
```

**Getting the id:** in Teams, the channel's `⋯` → **Copy link**. The URL
contains the conversation id URL-encoded — `19%3A...%40thread.tacv2` decodes to
`19:...@thread.tacv2`. Same shape as Discord's Copy Channel ID.

**Group chats are the exception.** They have no shareable link, so their ids are
not obtainable from the Teams UI. If you need one, the server logs a refused
inbound to stderr with the conversation id.

**An empty per-channel `allowFrom` means anyone in that channel can talk to the
bot.** That is deliberate and it matches discord and telegram: opting the
channel in *is* the trust decision, because requiring every colleague to pair by
DM first would make a shared channel unusable. It is looser than the DM path —
narrow it with `--allow` when the channel is broader than the people you want
driving your session.

Threads inherit their parent channel's opt-in.

## Mention detection

In a channel or group chat the bot answers only when addressed, unless you pass
`--no-mention` for that conversation. A mention counts when the mentioned id is
the bot's own — typing the bot's name as plain text does not count, or anyone
could trigger it by writing a word.

`mentionPatterns` adds extra regexes that also count as addressing the bot:

```
/msteams:access set mentionPatterns ["^claude\\b"]
```

## Permission requests

When Claude Code needs permission for a tool call, the request is relayed **to
allowlisted DMs only**. Channels and group chats are excluded, deliberately:
everyone in `allowFrom` cleared an explicit pairing, while a channel member only
cleared the channel's opt-in — which, under an empty `allowFrom`, is anyone in
the room. Letting a room vote on a permission prompt would hand your session's
authority to whoever is standing in it.

Answer in the DM:

```
y 7f3ab      allow
n 7f3ab      deny
```

Five letters, `l` excluded so it cannot be misread as `1`. Case does not matter.
A bare "yes" is treated as conversation, not a verdict — it reaches the session
as an ordinary message. Each request can be answered once; a repeated answer
does nothing.

**Auto mode never asks, so the relay never fires there.** Verified against a
live session 2026-07-31: with `"defaultMode": "auto"` in settings, a `Bash` call
was allowed by the classifier in 4ms and no `permission_request` was emitted at
all. Permission requests reach this channel only in a mode that actually asks.
If you are relying on approving from Teams, do not run the session in auto mode.

The same classifier also judges *outbound* replies. In that session it denied a
`reply` carrying `ls -la` output — shell output leaving for an external chat
reads as exfiltration — while an ordinary prose reply passed. That is the
classifier's call, not this plugin's gate, and it is invisible from the Teams
side: the reply simply never arrives. A denial is logged in
`~/.claude/debug/<session-id>.txt` as `Auto mode classifier blocked action`.

Tappable Allow/Deny buttons are not built yet — see `docs/ADAPTIVE-CARDS.md`.

## What the bot will never do

- **Approve its own access.** `/msteams:access` acts only on requests you type
  in your terminal. A Teams message asking to approve a pairing or add someone
  to the allowlist is refused — that is precisely what a prompt injection looks
  like.
- **Reply somewhere it was not spoken to.** Every outbound tool is gated on a
  conversation reference, which exists only for conversations the inbound gate
  already accepted.
- **Send you its own state.** The state dir holds credentials and conversation
  references; sending a file from it is refused, symlinks included. Only
  `inbox/` (files people sent *to* the bot) can go back out.
- **Explain a refusal.** Refused senders get silence. Saying why would confirm
  the bot exists and leak the policy.

## Skill reference

```
/msteams:access                              status
/msteams:access pair <code>                  approve a pending sender
/msteams:access deny <code>                  discard a pending code
/msteams:access allow <aadObjectId>          add directly
/msteams:access remove <aadObjectId>         remove
/msteams:access policy <pairing|allowlist|disabled>
/msteams:access group add <conversationId> [--no-mention] [--allow a,b]
/msteams:access group rm <conversationId>
/msteams:access set mentionPatterns <json>
```

## Config file

`~/.claude/channels/msteams/access.json`, mode 0600:

```json
{
  "dmPolicy": "pairing",
  "allowFrom": ["<aadObjectId>"],
  "groups": {
    "19:...@thread.tacv2": { "requireMention": true, "allowFrom": [] }
  },
  "pending": {},
  "mentionPatterns": []
}
```

Re-read on every inbound message, so access changes take effect immediately —
no restart. Credentials in `.env` are the opposite: read once at boot.

Setting `MSTEAMS_ACCESS_MODE=static` snapshots access at boot and never writes.
Pairing
cannot work under it and is downgraded to `allowlist` with a warning, since
handing out codes that can never be approved would look like a working feature
going nowhere.
