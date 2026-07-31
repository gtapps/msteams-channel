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

**2026-07-31.** Legs 1–2 verified on `cf26d90`; legs 3–5 and 7–8 on `8f26992`
after the second instructions fix.

| Leg | Result |
|---|---|
| 1 DM → threaded reply | **pass** (after finding 1) |
| 2 channel mention → threaded reply | **pass** |
| 3 inbound attachments | **pass** (after finding 2) |
| 4 outbound image + refusals | **pass** |
| 5 `edit_message`, `react` 412 | **pass** |
| 6 pairing and revocation | **pass** — run without a second account, see below |
| 7 proactive CLI send | **pass** — `--list` marking correct, `--text` and stdin both exit 0 with ids, unknown conversation exit 3 without sending |
| 8 permission verdict | **pass** — request relayed to the DM, `y <code>` honoured |

**8 of 8 pass.**

Leg 6 needs an unknown sender, which looks like it needs a second Teams account.
It does not: set `dmPolicy` to `pairing` and remove your own AAD object id from
`allowFrom`, and you become a stranger to your own bot. That exercises the whole
leg with one account — only genuinely-different-person cases (another human
pairing, per-sender allowlists inside a channel) stay out of reach, and neither
is on the MVP path.

Observed, in order:

1. `send.ts` to the revoked DM → **exit 3** `sender_not_allowed`, with no
   restart. The gate re-read `access.json` on the spot. This is the
   anti-exfiltration property: a stored conversation reference is a claim about
   the past, not standing authority.
2. `--list` flipped that conversation to `unreachable:sender_not_allowed` while
   both channels stayed `reachable` — correct, since a group with
   `allowFrom: []` admits anyone in it and only DMs were revoked.
3. A DM from the now-unknown sender produced a 6-hex pairing code **in Teams and
   nothing in the session** — the revoked-inbound drop, exercised at the same time.
4. Writing `approved/<senderId>` with the conversation id as its contents was
   consumed by the server in **~1s** (poll interval is ~5s), and the "Paired!"
   confirmation went out.
5. `send.ts` to the same DM → **exit 0** with a message id. Outbound restored.

The one thing worth noting for anyone repeating this: the id `send.ts` wants is
the Bot Framework conversation id from `--list` (`a:1...`), not the
`19:...@unq.gbl.spaces` id in a Teams chat deep link. Passing the latter exits 3
with "no inbound conversation on record", which is correct but reads like a
gate refusal rather than a wrong-id-space mistake.

Leg 3 also confirmed the multi-attachment fix against the live tenant: two images
in one message both arrived and both were readable — precisely the case that
used to deliver one and drop the other with no count and no listing.

#### Finding 1 — instructions were being truncated (`cf26d90`)

Leg 1 failed first time. The message was delivered (`notifications/claude/channel`
in the debug log) but the model answered in the terminal, so the sender got
silence. Investigating surfaced an unrelated, older defect: **Claude Code
truncates MCP server instructions at 2048 characters**, announced only in a
`[DEBUG]` line. Ours were 2224, so the tail of the prompt-injection rule had been
deleted at every session start since M1 — and the contract test meant to catch
exactly that passed throughout, because it asserted against the raw `initialize`
response rather than the 2048 characters the model receives. Instructions are now
inside the budget, and the budget is pinned by a test.

This did **not** explain the failed leg: the reply-routing paragraph is first and
always survived. That cause is finding 2.

#### Finding 2 — a local action with no return path (`8f26992`)

Legs 1 and 2 were single-response turns and routed to `reply` correctly. Leg 3
began with `Read` calls for the attached images — and no reply followed. The
attachment instruction ended on a *local* action ("just Read it") with no return
path, so once the files were read the turn looked finished. Two sentences fixed
it: a general rule that a turn beginning with a Teams message is not finished
until `reply` has been called, however many other tools ran first, and a closing
line that reading a file is not answering. Confirmed by re-running leg 3.

So legs 1 and 3 shared one root cause. **The lesson generalizes past this
plugin:** in channel instructions, every branch that tells the model to act
locally must name the return path, or the sender gets silence while the terminal
gets the answer — and the failure is invisible from the Teams side.

#### Note for future runs

Under `--permission-mode default` every `reply` prompts for approval, and that
prompt is itself relayed to Teams. The circularity is harmless — verdicts are
intercepted on the inbound path, which does not depend on the tool being gated —
but approving `reply` once at the start makes the run much less tedious.

Last full pass: **2026-07-31, 8 of 8** (legs 1–2 on `cf26d90`, the rest on `8f26992`).
