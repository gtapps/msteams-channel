# Microsoft Teams: Access & Delivery

Who can reach your Claude Code session through this channel, and how to change
it. The model matches the official discord and telegram plugins; differences
are noted where Teams forced them.

Everything here is edited through `/msteams:access`, never by hand and never in
response to a Teams message.

## At a glance

| | Default |
|---|---|
| DM policy | `pairing`: an unknown sender gets a code, not access |
| Allowlist | empty |
| Channels and group chats | none opted in |
| Mention required in a channel | yes |
| Tenant | messages from any other tenant are refused before anything else |

## DM policies

`dmPolicy` governs 1:1 chats.

| Policy | Behavior |
|---|---|
| `pairing` (default) | An unknown sender gets a 6-hex code and nothing else. Approve with `/msteams:access pair <code>`. Codes live 1 hour, at most 3 are outstanding at once, and a sender is answered twice before the bot goes silent on them. |
| `allowlist` | Only `allowFrom` gets through; unknown senders are dropped silently. The state to end up in. |
| `disabled` | No DMs at all. |

Pairing is a capture mechanism, not a resting state: its job is to collect AAD
object IDs you do not know yet. Once they are in `allowFrom`, switch to
`allowlist` so nobody else can even trigger a code:

```
/msteams:access policy allowlist
```

## Identities are AAD object IDs

Senders are matched on the **AAD object ID** only: the GUID Entra assigns each
user. Never a display name, which the sender controls, and never an email. An
activity with no `aadObjectId` is refused outright.

You rarely need to find one by hand: pairing captures it, and
`/msteams:access` prints it.

## Channels and group chats

A channel is opted in per conversation:

```
/msteams:access group add 19:...@thread.tacv2
/msteams:access group add 19:...@thread.tacv2 --no-mention
/msteams:access group add 19:...@thread.tacv2 --allow <oid1>,<oid2>
```

**Getting the ID:** in Teams, the channel's `⋯` → **Copy link**. The URL
contains the conversation ID URL-encoded: `19%3A...%40thread.tacv2` decodes to
`19:...@thread.tacv2`.

**Group chats have no shareable link**, so their IDs are not obtainable from
the Teams UI. The one place a group chat's ID surfaces is the server's own
stderr, where a refused inbound is logged with it, and mid-session stderr from
an MCP server never reaches `~/.claude/debug/`. Run the server standalone once:

```
bun server.ts          # in its own terminal, with the tunnel pointed at it
                       # then send one message in the group chat
msteams channel: refused inbound (conversation_not_opted_in) conversation=19:...@thread.v2 type=groupChat
```

Then `/msteams:access group add <that id>`. If that is too awkward, prefer a
channel: channels have Copy link.

**An empty per-conversation `allowFrom` means anyone in that conversation can
talk to the bot.** That is deliberate and matches discord and telegram: opting
the channel in is the trust decision. Narrow it with `--allow` when the channel
is broader than the people you want driving your session.

Threads inherit their parent channel's opt-in.

## Mention detection

In a channel or group chat the bot answers only when addressed, unless you pass
`--no-mention` for that conversation. A mention counts only when the mentioned
ID is the bot's own; typing the bot's name as plain text does not count.

`mentionPatterns` adds regexes that also count as addressing the bot:

```
/msteams:access set mentionPatterns ["^claude\\b"]
```

## Permission requests

When Claude Code needs permission for a tool call, the request is relayed to
**allowlisted DMs only**. Channels and group chats are excluded deliberately:
a channel member only cleared the channel's opt-in, and letting a room vote on
a permission prompt would hand your session's authority to whoever is in it.

Answer in the DM:

```
y 7f3ab      allow
n 7f3ab      deny
```

Codes are five letters (`l` excluded so it cannot be misread as `1`), case
does not matter. A bare "yes" is treated as conversation, not a verdict. Each
request can be answered once; a repeated answer does nothing.

**Auto mode never asks, so the relay never fires there.** The relay works only
in a permission mode that actually asks: if you rely on approving from Teams,
start the session with `--permission-mode default`. Auto mode's classifier also
judges outbound replies (shell output leaving for an external chat can be
blocked as exfiltration); a denial is invisible from Teams and logged in
`~/.claude/debug/<session-id>.txt` as `Auto mode classifier blocked action`.

Tappable Allow/Deny buttons are not built; use the text verdicts above.

## What the bot will never do

- **Approve its own access.** `/msteams:access` acts only on requests you type
  in your terminal. A Teams message asking to approve a pairing or extend the
  allowlist is refused: that is what a prompt injection looks like.
- **Reply somewhere it was not spoken to.** Every outbound tool requires a
  conversation reference, which exists only for conversations the inbound gate
  already accepted.
- **Send you its own state.** The state dir holds credentials, conversation
  references and snapshots of files offered to other people; sending a file from
  it is refused, symlinks included. Only `inbox/` (files people sent *to* the
  bot) can go back out.
- **Finish a file offer for someone who has lost access.** A file offered in a
  DM moves only when the recipient accepts it, and that acceptance passes the
  same gate as a message. Revoke someone between the offer and their click and
  the click is refused like anything else: silently, with the pending copy
  discarded within the hour.
- **Explain a refusal.** Refused senders get silence. Saying why would confirm
  the bot exists and leak the policy.

## Skill reference

| Command | Effect |
|---|---|
| `/msteams:access` | Print current state: policy, allowlist, pending pairings, opted-in conversations. |
| `/msteams:access pair <code>` | Approve a pending sender. |
| `/msteams:access deny <code>` | Discard a pending code. The sender is not notified. |
| `/msteams:access allow <aadObjectId>` | Add a sender directly. |
| `/msteams:access remove <aadObjectId>` | Remove from the allowlist. |
| `/msteams:access policy <policy>` | Set `dmPolicy`: `pairing`, `allowlist`, `disabled`. |
| `/msteams:access group add <conversationId>` | Opt in a channel or group chat. Flags: `--no-mention`, `--allow id1,id2`. |
| `/msteams:access group rm <conversationId>` | Opt out. |
| `/msteams:access set mentionPatterns <json>` | Extra regexes that count as a mention. |

## Config file

`<state dir>/access.json`, mode 0600, where the state dir is
`MSTEAMS_STATE_DIR`, default `~/.claude/channels/msteams`:

```jsonc
{
  // Handling for DMs from senders not in allowFrom.
  "dmPolicy": "pairing",

  // AAD object IDs allowed to DM.
  "allowFrom": ["<aadObjectId>"],

  // Opted-in channels and group chats. Empty object = DM-only.
  "groups": {
    "19:...@thread.tacv2": {
      // true: respond only when the bot is @-mentioned.
      "requireMention": true,
      // Restrict triggers to these senders. Empty = anyone in the conversation.
      "allowFrom": []
    }
  },

  // Pairing codes awaiting a verdict. Managed by the server.
  "pending": {},

  // Case-insensitive regexes that count as a mention.
  "mentionPatterns": []
}
```

Re-read on every inbound message, so access changes take effect immediately,
no restart. Credentials in `.env` are the opposite: read once at boot.

`MSTEAMS_ACCESS_MODE=static` snapshots access at boot and never writes. Pairing
cannot work under it and is downgraded to `allowlist` with a warning.
