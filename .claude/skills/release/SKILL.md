---
name: release
description: Cut a release of the msteams channel plugin — validate, bump the version in all four manifests, write a CHANGELOG entry, commit, push, tag, and publish a GitHub release. Use whenever the user says "release", "cut a release", "version bump", "ship it", "publish", "tag a release", "changelog and push", or finishes a batch of changes and wants to ship them.
---
# Release

Cut a release of the `msteams` channel plugin. This repo **is its own marketplace**:
the plugin lives at the repo root and `.claude-plugin/marketplace.json` points at
`./`, so users install it straight from GitHub with
`/plugin marketplace add gtapps/msteams-channel`. There is no registry and no
build artifact — **the git tag plus the pushed commit *are* the release**, and a
user's `/plugin update` pulls whatever `main` says.

That has one consequence worth internalizing before you start: **an unreleased
commit on `main` is already live** for anyone who runs `/plugin marketplace update`.
The tag is a marker for humans and for `version`-gated updates, not a gate on
distribution. So `main` must never carry a state you would not ship.

## Usage

`/release` — infer the bump level from the changes since the last tag.
`/release patch|minor|major` — force a bump level.
`/release 0.2.0` — force an exact version.

## The four version locations

Every release sets **all four** to the same `X.Y.Z`. `claude plugin tag` only
checks the first and the third, so the other two are on you.

| Location | How to read it |
|---|---|
| `.claude-plugin/plugin.json` | `jq -r '.version'` |
| `package.json` | `jq -r '.version'` |
| `.claude-plugin/marketplace.json` | `jq -r '.plugins[] \| select(.name=="msteams") \| .version'` |
| `server.ts` | the `{ name: 'msteams', version: 'X.Y.Z' }` literal in the `Server` constructor (~line 100) |

The `server.ts` literal is what a client sees in the MCP `initialize` response,
so a stale one misreports the running build to anyone debugging a live session.
Edit it with the Edit tool, never a blind `sed` — the file contains other
`version` strings.

## Steps

### 1. Pre-release validation

Run all of these first. Abort on any failure — a bad tag on a repo that *is* the
distribution channel is live for users the moment it lands on `main`.

```bash
bun install --frozen-lockfile     # lockfile must be current, not "fixable"
bun run typecheck                 # tsc --noEmit
bun test                          # 249+ tests, ~11s, no tenant or network
claude plugin validate .          # must print Validation passed (warnings ok)
```

Notes:

- A green run legitimately prints `access.json is corrupt, moved aside` and the
  static-mode downgrade warning. Those are assertions, not failures.
- `bun install --frozen-lockfile` failing means `bun.lock` is behind
  `package.json`. Fix it with `bun install` and commit the lockfile *before*
  releasing — users install from this lockfile.
- `claude plugin validate .` is clean today. `claude plugin tag` additionally
  warns that `CLAUDE.md` / `CLAUDE.local.md` at the plugin root aren't loaded as
  plugin context — expected, since the plugin root *is* the repo root. Warnings
  do not block a release; a hard `✘` does.

Then the check the suites cannot do — **the production install path**. Users
never get devDependencies, so a devDep that leaked into runtime code passes CI
and fails at *their* first launch:

```bash
D=$(mktemp -d) && cp package.json bun.lock .npmrc "$D"/ \
  && (cd "$D" && bun install --production --frozen-lockfile --no-summary) \
  && grep -rn "jose\|jwks-rsa\|@types/bun\|typescript" server.ts src/*.ts send.ts \
  && echo "LEAK: a devDependency is imported by runtime code — stop" || echo "runtime deps clean"
```

### 2. Drift the tests cannot see

Walk these four before deciding the bump. Each maps to something a user or
operator holds that the test suite has no view of:

1. **Wire-affecting change → the E2E smoke is mandatory.** If this release
   touches the inbound pipeline (`queue`/`gate`/`normalize`), any outbound tool,
   `send.ts`, the SDK pin, or the MCP `instructions` string, the release is not
   valid on `bun test` alone. Run `docs/E2E.md` against a live tenant, then
   append the result — build, date, any failed leg — to
   `.claude-code-hermit/compiled/topic-msteams-e2e-runs.md`, which is gitignored:
   run records are operator record-keeping, and the public doc carries only the
   procedure. If the operator cannot run it now, say so plainly and let them
   decide whether to ship untested — do not quietly skip it.
2. **`access.json` schema change** → operators hold a live copy in
   `~/.claude/channels/msteams/`. Any new, renamed, or newly-required key needs
   an explicit Upgrade Instructions step, and `ACCESS.md` § *Config file* must
   already describe it.
3. **`.env` key change** (`MSTEAMS_APP_ID` / `_APP_PASSWORD` / `_TENANT_ID`, or a
   new `MSTEAMS_*` listener variable) → Upgrade Instructions step, plus the
   variable table in `README.md` and the relevant step in `docs/SETUP.md`.
4. **SDK pin bump** (`@microsoft/teams.apps` / `@microsoft/teams.api`) → at
   minimum a **minor**, and it forces item 1. The pin is the one load-bearing
   upstream; `tests/auth-coverage.test.ts` fails loudly when a release moves the
   validators, which is the point, but a green suite does not prove the live
   wire still works.

Also confirm the prose still describes reality: `README.md` (tool table,
enablement, variable table), `ACCESS.md`, `docs/SETUP.md`, `CLAUDE.md`
invariants. Fix inaccuracies in this release; docs-only corrections go in the
commit message, **not** the CHANGELOG.

### 3. Determine the version

**Already-tagged fast-path:** if `HEAD` already carries an `msteams--v*` tag,
there is nothing to release. Report it and stop.

**Already-bumped fast-path:** if `plugin.json` is ahead of the newest tag, the
bump and CHANGELOG were done in an earlier session — skip to Step 7's commit
check, then tag.

Normal path:

```bash
LAST=$(git tag --list 'msteams--v*' | sort -V | tail -1)
git log --oneline "$LAST"..HEAD
git diff --stat "$LAST"..HEAD
```

Pre-1.0, so err toward minor whenever an operator could notice:

- **Patch** (0.0.X) — bug fixes, internal refactors, added tests, doc-only releases.
- **Minor** (0.X.0) — new tool, new meta key, gate/threading behavior change, new
  or renamed `access.json` or `.env` key, SDK pin bump, anything requiring the
  operator to re-read a doc or touch their state dir.
- **Major** (X.0.0) — only if the user explicitly asks, or for the 1.0.0 cut.

A **security-relevant** change to the gate, the outbound gate, the permission
relay, or credential handling is at least a **minor** however small the diff, and
its CHANGELOG bullet leads with `security:`.

Present the suggested version with a rationale naming the specific changes, and
**wait for confirmation** before editing anything.

### 4. Write the CHANGELOG entry

If `CHANGELOG.md` does not exist, create it:

```markdown
# Changelog

All notable changes to the msteams channel plugin are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).
```

Prepend the new entry directly after that header, before the previous version.
Rename an existing `[Unreleased]` section instead of prepending to it.

**Docs-only double-check first.** Every bullet must describe a change an
*operator or user* experiences. Verify against
`git diff "$LAST"..HEAD -- server.ts src/ send.ts skills/ .claude-plugin/`;
drop any bullet whose only backing change is a `.md` file or a comment.

**Format:**

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added / Changed / Fixed / Security
(use whichever sections apply — skip empty ones)

- **subsystem: one-line summary** — optional ≤1-sentence rationale.

### Upgrade Instructions

1. **Imperative step title** — what to do, in one sentence.

No state-dir or credential changes required.
```

Constraints:

1. **Narrative bullets** — `- **subsystem: what changed** — short rationale if
   non-obvious.` One line, ~40 words max. Lead with the subsystem in this
   codebase's own vocabulary: `gate:`, `queue:`, `normalize:`, `outbound:`,
   `attachments:`, `access:`, `permissions:`, `send:`, `webhook:`, `security:`,
   `docs:`. Do not list internal refactors, helper extractions, or test
   scaffolding — those live in `git diff`.
2. **Upgrade Instructions** — imperative, one action per numbered step, every
   step starting with a verb (`Run`, `Add`, `Replace`, `Re-pair`, `Restart`).
   Include a step for each of:
   - New/renamed `access.json` key → name the key and its default.
   - New/renamed `MSTEAMS_*` variable → name it and where it goes (`.env`, mode 0600).
   - Changed tool name or argument → the exact old→new call shape.
   - Anything that changes the bot's Azure-side config (messaging endpoint, a new
     Graph permission) → the exact portal/CLI step, since that is not in the repo.
   - A change to the MCP `instructions` string or the channel registration →
     `Restart the session with \`claude --channels plugin:msteams@msteams-channel\`.`

   Close with `No state-dir or credential changes required.` when true — it is
   the common case and operators scan for it.
3. **What belongs where:** why it changed → the bullet. What the operator must
   execute → Upgrade Instructions. A behavior delta needing no action → one final
   line prefixed `**Note:**`, not a numbered step.
4. **Never put a credential, tenant id, AAD object id, conversation id, or
   attachment URL in the CHANGELOG.** Same rule as the code: those are the
   things this plugin exists to keep out of logs.

### 5. Bump all four version locations

Edit each of the four from the table above, then confirm they agree:

```bash
NEW=X.Y.Z
jq -r '.version' .claude-plugin/plugin.json
jq -r '.version' package.json
jq -r '.plugins[] | select(.name=="msteams") | .version' .claude-plugin/marketplace.json
grep -n "name: 'msteams', version:" server.ts
```

All four must show `$NEW`. Then sweep for stray references to the *previous*
version:

```bash
grep -rn "$OLD" --include='*.md' --include='*.json' --include='*.ts' --include='*.yml' . \
  | grep -v -E '(node_modules|\.claude-code-hermit|bun\.lock|CHANGELOG\.md)'
```

`CHANGELOG.md` keeping old versions in its history is not drift.

### 6. Final validation

Steps 4–5 touch Markdown, JSON and one TS literal, so the suites need no re-run.
Confirm the manifests still parse and the tree contains only release files:

```bash
jq -e . .claude-plugin/plugin.json > /dev/null
jq -e . .claude-plugin/marketplace.json > /dev/null
jq -e . package.json > /dev/null
claude plugin validate .
git status --short
```

`git status` must show only `CHANGELOG.md`, the four version locations, and any
doc this release legitimately corrected. `.claude-code-hermit/`,
`CLAUDE.local.md`, `.claude/settings.local.json`, `node_modules/` and
`graphify-out/` are gitignored and must never appear. Anything unexpected →
investigate before committing.

### 7. Commit and push

Stage the release files **by name** — never `git add -A`; an accidentally staged
`.env` or state file in a public repo is unrecoverable. Commit with the house
format:

```
msteams v<X.Y.Z>: one-line summary of the release
```

Add a body summarizing the release and any docs corrections kept out of the
CHANGELOG. Push to `origin`.

### 8. Before tagging: branch and visibility

```bash
git branch --show-current
gh repo view gtapps/msteams-channel --json visibility -q .visibility
```

- **Not on `main`** → **stop, do not tag.** Tagging a branch tip pins a SHA that
  `main` never carries after a squash or rebase merge, stranding the tag on an
  orphan commit. Recommended path: open a PR, merge, re-run `/release` from
  `main` (Step 3's fast-path jumps straight here). Offer tagging-now only as an
  explicit second option and wait for the user's choice.
- **`PRIVATE`** → the release is not installable by anyone:
  `/plugin marketplace add gtapps/msteams-channel` fails against a private repo
  for everyone but the owner. Say so and ask whether to make it public
  (`gh repo edit gtapps/msteams-channel --visibility public`) before tagging.
  Never flip visibility without an explicit yes — publishing is irreversible in
  practice.

### 9. Tag and publish

The tag is `msteams--v<X.Y.Z>` (double dash) — what `claude plugin tag` produces.
It validates that `plugin.json` and the marketplace entry agree, requires a clean
tree, and refuses to clobber an existing tag:

```bash
claude plugin tag . --push
```

Fall back to plain git only if that command is unavailable:

```bash
VERSION=$(jq -r '.version' .claude-plugin/plugin.json)
git tag -a "msteams--v$VERSION" -m "msteams v$VERSION"
git push origin "msteams--v$VERSION"
```

Then create the GitHub release from the CHANGELOG section just written — not
`--generate-notes`, which would re-list raw commits over the curated entry:

```bash
VERSION=$(jq -r '.version' .claude-plugin/plugin.json)
TAG="msteams--v$VERSION"
NOTES_FILE=$(mktemp)
awk -v ver="$VERSION" '
  $0 ~ "^## \\[" ver "\\]" {flag=1; next}
  /^## \[/ && flag {exit}
  flag {print}
' CHANGELOG.md > "$NOTES_FILE"
[ ! -s "$NOTES_FILE" ] && { echo "CHANGELOG section for $VERSION not found — fix and retry"; rm "$NOTES_FILE"; exit 1; }
gh release create "$TAG" --title "$TAG" --notes-file "$NOTES_FILE"
rm "$NOTES_FILE"
```

Confirm the CI run on the pushed commit went green before announcing.

### 10. Report

Print the new version, the commit hash, the tag, the GitHub release URL, and
whether the E2E smoke was run for this build (and if not, that it wasn't). Remind
the user that existing installs pick this up with:

```
/plugin marketplace update msteams-channel
/plugin update msteams@msteams-channel
```

and that the session must be relaunched with
`claude --channels plugin:msteams@msteams-channel` for a new build to take effect.

## Don't

- Don't `git add -A` — stage release files by name.
- Don't tag off a non-`main` branch without the user's explicit go-ahead.
- Don't skip the production-install check in Step 1 — CI never exercises the path
  every user takes.
- Don't ship a wire-affecting release on `bun test` alone; either run
  `docs/E2E.md` or state clearly that it wasn't run.
- Don't bump the version anywhere before the user has confirmed the level in Step 3.
- Don't flip the repo to public as a side effect of releasing.
