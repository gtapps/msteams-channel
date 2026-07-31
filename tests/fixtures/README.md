# Fixture corpus

Real Bot Framework activities captured from a live Teams tenant on 2026-07-31,
through the actual SDK app (so every one of them passed Entra JWT validation
before being recorded), then scrubbed.

## Scrubbing

Identifiers are replaced with stand-ins **of the same shape**, because the code
under test parses that shape — `;messageid=`, the `29:`/`28:`/`19:` prefixes,
`@thread.tacv2`. Flattening them would make the fixtures test the wrong thing.
Replaced: tenant id, sender AAD object id, team AAD group id, sender thread id,
display name, bot id and name, channel thread id, personal conversation id.

Attachment URLs are **redacted outright, not mapped**. A Teams file attachment's
`content.downloadUrl` carries a live `tempauth=` bearer token granting read
access to the sender's OneDrive, and `contentUrl` leaks the tenant's SharePoint
host. Neither is needed to test parsing.

## The files

| File | What it pins down |
|---|---|
| `dm-text.json` | Baseline personal message. |
| `channel-mention-thread-root.json` | Top-level channel post that @-mentions the bot. |
| `channel-thread-reply.json` | A reply inside the thread rooted at the file above. |
| `dm-duplicate-first.json` / `dm-duplicate-redelivery.json` | The same activity delivered twice. |
| `dm-attachment-image.json` | A DM with a file attached. |
| `channel-conversation-update.json` / `channel-installation-update.json` | Non-message activities from installing the app into a team. |

## Thread semantics (the question these were captured to settle)

**`activity.replyToId` is absent — not null, not present — even on a genuine
thread reply.** Compare `channel-mention-thread-root.json` with
`channel-thread-reply.json`: their `activity.id`s differ, neither has a
`replyToId` key at all, and both carry the *same* `conversation.id`, ending
`;messageid=<root activity id>`.

So on Teams a thread is a container identified by its root, and that identity
lives only in the conversation id. Consequences:

- A reply must thread on the value extracted from `conversation.id`
  (`extractThreadId` in `src/gate.ts`), never on `activity.id`. A reply's own id
  is not a thread root; sending to it opens a *new* thread beside the one being
  answered.
- `replyToId` is kept only as a fallback for shapes that do populate it. This
  tenant never exercised that branch.
- Personal and group chats have no threads at all, so no thread id is emitted.
- Because `conversations/` stores the *stripped* conversation id, a proactive
  send (no live inbound) can only ever create a new top-level post in a channel.
  Resuming a thread requires a thread id the sender supplies.

This matches OpenClaw's precedence (MIT, `32b2e161a5a`,
`extensions/msteams/src/monitor.ts:691`), arrived at independently and then
confirmed against these captures.

## Attachments

Every message carries a `text/html` attachment holding the rendered body — even
a bare `"hey"` with no file. Attachment presence is therefore **not** a signal
that a file was sent; `dm-text.json` has one attachment and no file.

A real file is `application/vnd.microsoft.teams.file.download.info`, with
`name` at the top level and `content.{downloadUrl,uniqueId,fileType}`. Per
OpenClaw's `isAdvertisedFileAttachment`, `text/html`,
`application/vnd.microsoft.card.*` and `application/vnd.microsoft.teams.card.*`
are all excluded.

## Duplicate delivery

`dm-duplicate-first.json` and `dm-duplicate-redelivery.json` are **byte-identical
and share one `activity.id`**. They were produced by answering the first
delivery `500`, which made Bot Framework redeliver — confirming both that the
retry the persist-before-ack queue depends on is real, and that dedup on
`activity.id` alone is sufficient.
