# Security policy

This plugin sits between a Microsoft Teams tenant and a Claude Code session
that can run tools on your machine. Everything it refuses, it refuses
deliberately; the model is described in [`README.md`](README.md#security) and
[`ACCESS.md`](ACCESS.md). This file is about what to do when you find a hole
in it.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting on
this repository (**Security → Report a vulnerability**), which opens a private
advisory visible only to the maintainer.

If that button isn't there, open an ordinary issue saying only that you have a
security report and asking for a private channel (no details, no reproduction)
and one will be opened for you.

Include, as far as you can: the version or commit, which half of the pipeline
it affects (inbound gate, outbound gate, permission relay, credential
handling), and a concrete sequence that reproduces it. A fixture-shaped
activity JSON is the most useful thing you can attach: see
[`tests/fixtures/README.md`](tests/fixtures/README.md) for the shape, and
**scrub it the same way** before sending. Never attach a real `tempauth=`
download URL, an app password, or an unscrubbed tenant id; a report that leaks
a credential is worse than the bug it describes.

This is a solo-maintained project with no bounty program. Expect a first
response within a few days, not hours. Fixes ship as a normal release with a
`security:` CHANGELOG bullet.

## What counts as a vulnerability here

Anything that breaks one of these properties:

- **Inbound gate.** A message from an unlisted tenant, an unlisted AAD object
  id, a channel that was never opted in, or an unmentioned post in a
  `requireMention` channel reaching the session anyway. Identity is the AAD
  object id; a display name must never grant access.
- **Outbound gate.** A reply, edit, or proactive send reaching a conversation
  that was never accepted inbound, or one whose access has since been revoked.
  Both halves must hold: a stored conversation reference is a claim about the
  past, not standing authority.
- **Permission relay.** A verdict accepted from a sender who is not
  allowlisted, from a group chat, for a request id that was never issued, or a
  second time for a one-shot id.
- **Credential handling.** Any path that puts an app password, a tenant
  secret, or an inbound attachment's `downloadUrl` (a live OneDrive bearer
  token) into argv, a log line, an error message, a notification, or a file on
  disk.
- **Access mutation from untrusted input.** Any route by which a Teams
  message, rather than the operator at their terminal, changes `access.json`
  or approves a pairing. That request is what a prompt injection looks like.
- **Queue and state.** A path that lets an unauthenticated request write
  outside the state dir, or that leaves state-dir files more permissive than
  0700/0600.

Prompt-injection reports are welcome and in scope when they cross one of those
lines. "A Teams message can put attacker-controlled text in front of the
model" on its own is the nature of any chat channel, not a defect: the
mitigations are that content is never trusted as instruction, paths travel in
`meta` rather than `content`, and access mutations are refused from the
channel.

## What is not a vulnerability

These are documented behaviors. Reporting them privately is fine, but they
will be closed as working-as-designed:

- **Reactions always fail with 412.** Graph exposes no application-only
  permission for `setReaction`. Evidence: [`docs/REACTIONS.md`](docs/REACTIONS.md).
- **Refusals are silent toward Teams.** Telling a stranger why they were
  refused confirms the bot exists and leaks policy. The pairing code is the
  one deliberate exception.
- **The managed-settings allowlist requirement.** Admitting a third-party
  channel needs root on the machine; that is Claude Code's design, not this
  plugin's. See [`SETUP.md`](SETUP.md#6b-allowlist-the-plugin-in-managed-settings).
- **Messages are lost while the listener is down.** The queue is
  persist-before-ack; it survives a crash mid-processing, not an offline
  window. Bot Framework's retries are shallow and Teams exposes no history to
  this plugin.
- **Anything that presumes access to the operator's machine or shell.** Read
  access to the state dir (`MSTEAMS_STATE_DIR`, default
  `~/.claude/channels/msteams/`) is read access to the credentials by
  construction; the file modes protect against other users, not against you.
  If you point `MSTEAMS_STATE_DIR` inside a repository, gitignoring it is
  yours to do; a committed `.env` is a leak you created, not a plugin
  vulnerability.
- **Findings in `@microsoft/teams.apps` / `@microsoft/teams.api` or in Entra
  itself.** Report those to [MSRC](https://msrc.microsoft.com/report). If the
  SDK ships a fix, this plugin's pin bump is a normal release; tell us too so
  the pin moves promptly.

## Supported versions

The most recent release is the only supported one. There is no backport
branch: fixes land on `main` and are cut as a new tag.
