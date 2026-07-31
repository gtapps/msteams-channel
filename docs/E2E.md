# E2E smoke test

The MVP acceptance run. Every leg below has been verified individually against a
real tenant during development; this is the consolidated pass that exercises
them in one sitting, against one build, after any change that could plausibly
affect the wire.

It is deliberately **not** in CI. Everything here needs a live Teams tenant, an
Azure Bot resource and a public ingress, none of which belong in a workflow that
a fork can run. CI covers the offline half (`bun test`); this covers the rest.

Budget ~20 minutes. Provisioning is [`docs/SETUP.md`](SETUP.md) — do that first;
this assumes a working bot.

## Preconditions

```bash
devtunnel host hermit-msteams-dev        # leave running; note the public URL
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3978/api/messages
```

The tunnel's public URL must match the bot's messaging endpoint in Azure
(`<url>/api/messages`). If you recreated the tunnel, the hostname changed — the
alias is not part of it. See SETUP.md §5.

Then, in the repo:

```bash
bun test && bun run typecheck    # both green before starting
```

Record the build under test: `git rev-parse --short HEAD`.

## Legs

Launch the session for legs 1–6 with:

```bash
claude --channels plugin:msteams@claude-code-teams-channel
```

**If nothing arrives at all, stop and read
`~/.claude/debug/<session-id>.txt` for the `Channel notifications skipped:`
line before changing anything.** It names the exact cause. The startup banner is
cosmetic and prints either way. Do not debug from the banner.

### 1. DM → threaded reply

Send the bot a DM: `what is 2+2?`

- [ ] The message appears in the session as a `<channel source="msteams" ...>` tag
- [ ] Claude's reply arrives back in the same DM
- [ ] `meta` carries `conversation_type="personal"` and **no** `thread_id`

### 2. Channel mention → reply in the right thread

In an opted-in channel (`/msteams:access group add <id>` first — the id comes
from the channel's `⋯` → Copy link), post a new thread mentioning the bot.

- [ ] Delivered, and only because it mentioned the bot
- [ ] The reply lands **inside that thread**, not as a new top-level post
- [ ] Post an unmentioned follow-up in the same thread → silently ignored

This is the leg that once regressed: replying to a message's own id opens a new
thread every turn. If replies appear as new posts, `extractThreadId()` is wrong.

### 3. Inbound attachment

Send a DM with a PDF attached, then one with two images attached.

- [ ] PDF: `attachment_id` in meta; `download_attachment` returns a path under
      `~/.claude/channels/msteams/inbox/`; Claude can Read it
- [ ] Two images: **both** arrive — `attachment_count=2` and `image_paths` lists
      two paths. One image arriving is the multi-attachment regression.
- [ ] No `downloadUrl` appears anywhere in the transcript or the debug log

### 4. Outbound image

Ask Claude to reply with an image file attached (PNG under 4MB).

- [ ] It arrives in Teams
- [ ] Ask it to attach a `.zip` → refused with an explanation, nothing sent
- [ ] Ask it to attach `~/.claude/channels/msteams/.env` → refused

### 5. edit_message and react

- [ ] `edit_message` updates a message already posted
- [ ] `react` fails with a 412 and an explanation naming the application-only
      limitation — **this is the expected result**, see [REACTIONS.md](REACTIONS.md).
      A success here would mean something changed upstream; a 412 blamed on a
      missing Entra grant means the error text regressed.

### 6. Pairing and revocation

From a Teams account **not** on the allowlist, DM the bot.

- [ ] A 6-hex pairing code comes back (and nothing reaches the session)
- [ ] `/msteams:access pair <code>` → "Paired!" confirmation arrives in that DM
      within ~5s
- [ ] A follow-up DM from that account is now delivered
- [ ] `/msteams:access remove <oid>` → a further DM is silently dropped
- [ ] **And outbound stops too**: `bun send.ts --conversation <that DM> --text hi`
      exits 3. Revocation must revoke in both directions; a stored conversation
      reference is not sufficient authority.

### 7. Proactive CLI send

No session needed — this is the path the hermit integration uses.

```bash
bun send.ts --list
bun send.ts --conversation <id> --text 'proactive hello'
echo 'from stdin' | bun send.ts --conversation <id>
```

- [ ] `--list` marks reachable vs `unreachable:<reason>` correctly
- [ ] Both sends arrive; exit 0 and a message id on stdout
- [ ] A conversation never seen inbound exits 3 without sending

### 8. Permission verdict

**Needs its own session** — the relay emits nothing under `--permission-mode
auto`, which is the fleet default:

```bash
claude --permission-mode default --channels plugin:msteams@claude-code-teams-channel
```

Ask Claude to do something requiring approval (e.g. run a shell command).

- [ ] A `🔐 Permission requested:` message arrives in the allowlisted DM with a
      5-letter code
- [ ] Replying `y <code>` in Teams lets the tool proceed
- [ ] Replying `y <code>` a second time does nothing — codes are one-shot
- [ ] The verdict text is intercepted, not forwarded into the session as chat

## Recording the result

Note the commit, the date, and any leg that failed. A failed leg is a release
blocker unless it is one of the two documented known-impossible items
(reactions; non-image outbound files).

### Run log

**2026-07-31, build `cf26d90`** — in progress.

| Leg | Result |
|---|---|
| 1 DM → threaded reply | **pass** (after the instructions fix below) |
| 8 permission request relayed to Teams | **pass** — arrived in the DM |
| 2–7, and the `y <code>` verdict | not yet run |

Leg 1 failed on the first attempt against `b25dfce`: the message was delivered
(`notifications/claude/channel` in the debug log) but the model answered in the
terminal transcript instead of calling `reply`, so the sender got silence. What
that surfaced — see `cf26d90` — is that **Claude Code truncates MCP server
instructions at 2048 characters** and says so only in a `[DEBUG]` line. Ours
were 2224, so the tail of the prompt-injection rule had been deleted at every
session start since M1, and the contract test that was meant to catch it passed
because it asserted against the raw `initialize` response rather than the 2048
characters the model receives. Instructions are now 1643 chars and the budget is
pinned by a test.

Note the truncation did **not** explain the failed leg — the reply-routing
paragraph is first and always survived. The leg passed on retry after a session
restart, so the original cause is not established. If it recurs, the untested
suspect is instruction dilution: that session had nine MCP servers loaded.

**Worth knowing for the remaining legs:** under `--permission-mode default`
every `reply` prompts for approval, and that prompt is itself relayed to Teams.
The circularity is harmless — verdicts are intercepted on the inbound path, which
does not depend on the tool being gated — but approving `reply` once for the
session makes legs 2–7 much less tedious.

Last full pass: _not yet complete_.
