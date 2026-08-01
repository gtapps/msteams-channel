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
devtunnel host msteams-dev        # leave running; note the public URL
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
claude --channels plugin:msteams@msteams-channel
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

No session needed — this is the path an agent integration uses.

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
auto`, which is the usual choice for an unattended session:

```bash
claude --permission-mode default --channels plugin:msteams@msteams-channel
```

Ask Claude to do something requiring approval (e.g. run a shell command).

- [ ] A `🔐 Permission requested:` message arrives in the allowlisted DM with a
      5-letter code
- [ ] Replying `y <code>` in Teams lets the tool proceed
- [ ] Replying `y <code>` a second time does nothing — codes are one-shot
- [ ] The verdict text is intercepted, not forwarded into the session as chat

## Recording the result

Note the commit under test, the date, and any leg that failed, wherever you track
releases. A failed leg is a release blocker unless it is one of the two
documented known-impossible items (reactions; non-image outbound files).

## Pitfalls

Things a run has actually surfaced, kept here so the next one does not rediscover
them:

- **A reply that never leaves the terminal.** If the model answers in the session
  but the sender gets silence, suspect the MCP `instructions` string rather than
  the wire — the message *was* delivered. Two causes have shown up: instructions
  exceeding the **2048-character budget** Claude Code silently truncates them to
  (announced only in a `[DEBUG]` line, and now pinned by a test), and an
  instruction branch that ends on a *local* action with no return path, so the
  turn looks finished once the local work is done. The general rule: every branch
  that tells the model to act locally must also name the way back to `reply`.
- **`send.ts` wants the Bot Framework conversation id** from `--list` (`a:1…`),
  not the `19:…@unq.gbl.spaces` id in a Teams chat deep link. The latter exits 3
  with "no inbound conversation on record" — correct, but it reads like a gate
  refusal rather than a wrong-id-space mistake.
- **Approve `reply` once at the start of leg 8.** Under `--permission-mode
  default` every `reply` prompts, and that prompt is itself relayed to Teams. The
  circularity is harmless — verdicts are intercepted on the inbound path, which
  does not depend on the tool being gated — but it makes the run tedious.
- **Leg 6 does not need a second Teams account.** Set `dmPolicy` to `pairing` and
  remove your own AAD object id from `allowFrom`, and you are a stranger to your
  own bot. Only genuinely-different-person cases (another human pairing,
  per-sender allowlists inside a channel) stay out of reach.
