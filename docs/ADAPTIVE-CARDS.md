# Deferred: Adaptive Card buttons for permission requests

**Status: not built, deliberately.** The MVP relays permission requests as text
and reads verdicts with the same regex the official plugins use. This file
records what full button parity would take, and the one thing to verify before
writing any of it.

Deferred by operator decision 2026-07-31, after the access model was settled.

## What the reference plugins do

Both official channel plugins put tappable controls on a permission request:

- **Discord** (`external_plugins/discord/server.ts:487-517`) — an
  `ActionRowBuilder` with three `ButtonBuilder`s: `See more`, `✅ Allow`,
  `❌ Deny`. Custom ids are `perm:<behavior>:<request_id>`. The click handler
  (`:744-803`) re-checks `access.allowFrom` before honoring the verdict, emits
  `notifications/claude/channel/permission`, then edits the original message to
  strip the buttons so a verdict cannot be replayed.
- **Telegram** (`external_plugins/telegram/server.ts:429-440`) — the same three
  controls as an inline keyboard, same `perm:` callback-data grammar, same
  `allowFrom` re-check (`:740`).

Both **also** accept a text verdict, which is what this plugin ships. So the
text path is established convention, not a shortcut — it is simply the less
convenient half of what they offer.

## What Teams would need

Teams' equivalent is an **Adaptive Card** with `Action.Submit` actions in the
`attachments` array of the outbound activity.

**Verify this first — it decides the whole shape of the work:** does an
`Action.Submit` press arrive as a **message activity** with `activity.value`
populated (which `app.on('message')` already receives), or does it arrive as an
**invoke** activity, which this server does not register a handler for at all?

Do not answer that from the docs or from memory. It is exactly the shape of
assumption that produced the `graph.api is not a function` incident — a
plausible API shape, a unit test written against the invention, and a failure
that only appeared against a live tenant. Send one card to the live tenant,
press the button, and read what the adapter receives.

If it is an invoke activity, note that the same missing handler blocks the
deferred Tier 2 file-upload work (`FileConsentCard` replies are invokes), so the
two features share a prerequisite and should probably be built together.

Then:

1. **Build the card** — `AdaptiveCard` attachment, `Action.Submit` with
   `data: { action: 'perm', behavior: 'allow' | 'deny', request_id }`.
2. **Handle the submit** in whichever activity type step 0 established.
   Re-check `allowFrom` on the *submitter*, exactly as both reference plugins
   do — the press must be authorized independently of who received the card,
   because a card can be forwarded.
3. **Make the verdict one-shot.** Discord and Telegram both edit the sent
   message to remove the controls after a verdict. Teams' equivalent is
   `app.api.conversations.updateActivity` (already used by `edit_message`), so
   store the sent activity id alongside the pending permission entry.
4. **Keep the text path working.** It is the fallback when a card fails to
   render, and it is what the operator already knows.

## Why it was deferred

The text verdict is functionally complete: the operator can allow or deny from
their phone, which is the point. Buttons are ergonomics. They also carry the
unverified-platform-behavior risk above, and the MVP's remaining gates (M5, M6)
do not depend on them.

Pick this up after M6, alongside Tier 2 file uploads if they turn out to share
the invoke-handler prerequisite.
