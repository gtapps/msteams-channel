# Changelog

All notable changes to the msteams channel plugin are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.0.1] - 2026-08-13

Initial release.

### Added

- **webhook: inbound pipeline** — webhook → durable queue → gate → conversation
  registration → normalize → `claude/channel` notification, with unfinished
  queue entries replayed on boot.
- **gate: tenant, sender and mention access control** — tenant check, AAD
  object id match, per-channel opt-in and mention requirement, all re-read
  from `access.json` on every inbound message.
- **access: pairing, allowlists and revocation** — DM pairing codes, group
  opt-in, and revocation that closes both the inbound and outbound gate at once.
- **reply, edit_message** — two-way conversation: chunked replies into DMs,
  channel threads and group chats, with the ability to edit a previously sent
  message.
- **attachments: inbound download** — non-image attachments land in a local
  inbox via `download_attachment`; live OneDrive download URLs never touch
  logs or the model.
- **outbound: file sending** — images under 4MB inline; larger files and
  non-images via a `FileConsentCard` in DMs or SharePoint upload with a
  posted file card in channels and group chats.
- **send: proactive-send CLI** — `send.ts` reaches an already-known
  conversation from outside a live session, gated the same as `reply`.
- **permissions: relay** — Claude Code permission prompts surface in Teams
  and resolve by reply code.
- **security: silent refusals** — access denials are logged to stderr only,
  never echoed to the sender, except the pairing code itself.
- **docs: full operator runbook** — `README.md`, `SETUP.md`, `ACCESS.md`,
  `TROUBLESHOOTING.md`, `SECURITY.md`, `docs/REACTIONS.md`, plus
  `teams-app/` (sideloadable app package source) and `probe-files.ts`
  (standalone SharePoint grant probe).

### Known limitations

- **Reactions are unavailable.** Graph's `setReaction` has no
  application-only permission, and this channel authenticates as the app,
  not a user. See `docs/REACTIONS.md`.
- **Message history is unavailable.** Teams exposes none to this plugin.
- **Group-chat file sharing is unverified live.** Every other outbound file
  route (DM consent, channel upload) passed against a real tenant; the
  group-chat sharing link has only been verified by Graph probe, not through
  Teams end to end, because the bot has never been added to a group chat.

No state-dir or credential changes required.
