# Reactions, and why they return 412

**Verdict: reactions cannot work with the authentication this plugin uses.**
Not a misconfiguration, not a missing grant, and there is no manifest change
that fixes it. Settled 2026-07-31 against the vendor docs and a working
third-party implementation, after a live tenant returned 412.

This file exists so nobody spends another session re-deriving it. If you are
picking this up cold, read the Evidence section before writing any code — two
plausible-sounding fixes are ruled out there, and both cost real time to try.

## What was observed

`react` against a live tenant, with an application (client-credentials) token:

```
POST https://graph.microsoft.com/beta/chats/{id}/messages/{id}/setReaction
→ 412 Precondition Failed
```

The shape of that failure is the informative part. Graph **accepted the token**
(not 401/403) and **resolved the message** (not 404), then refused the
operation. That pattern is what sent the original investigation toward
permissions, which was the wrong direction.

## Why

`setReaction` accepts **no application permissions at all** — not tenant-wide,
not resource-specific. From the beta reference
([chatMessage: setReaction](https://learn.microsoft.com/en-us/graph/api/chatmessage-setreaction?view=graph-rest-beta)):

| Scope | Delegated (work/school) | Application |
| --- | --- | --- |
| channel | `ChannelMessage.Send` | **Not supported** |
| chat | `Chat.ReadWrite`, `ChatMessage.Send` | **Not supported** |

412 is Graph's status for "this API has no application-only form." The sibling
chat-message APIs return the same 412 with an explicit body —
*"Requested API is not supported in application-only context"* — see the
Microsoft Q&A threads on
[posting a message to a chat](https://learn.microsoft.com/en-us/answers/questions/1324308/precondition-failed-error-412-when-trying-to-post)
and [sending to a Teams chat](https://learn.microsoft.com/en-us/answers/questions/1059937/precondition-failed-error-while-trying-to-send-mes).
Same status, same cause, different endpoint.

This plugin authenticates as the application, by design: a hermit runs
unattended, with no signed-in user. That is what makes reactions unreachable.

## Ruled out — do not retry these

**Resource-specific consent (RSC) in the Teams manifest.** This was the leading
hypothesis and it is dead. RSC grants are a *form of* application permission,
and `setReaction` supports none. Confirmed by reading every RSC scope in the
[RSC reference](https://learn.microsoft.com/en-us/microsoftteams/platform/graph-api/rsc/resource-specific-consent):
there is no reaction-related permission in the team, chat, or user tables, in
either application or delegated mode. `ChannelMessage.Send.Group` exists and
lets an app *send* channel messages app-only — which is why this looks
promising at a glance — but sending is not reacting, and this plugin sends
through Bot Framework anyway, not Graph.

**Granting `ChatMessage.ReadWrite.All` (or any other application permission) in
Entra.** No application permission unlocks this endpoint. Adding one changes
nothing, and admin-consenting a broad write scope for no benefit is worse than
leaving it ungranted.

**Switching from `beta` to `v1.0`.** Backwards — `setReaction` exists *only* in
beta. v1.0 returns 404.

## Corroboration from OpenClaw

OpenClaw (MIT, `~/Projects/gtapps/openclaw` @ `32b2e161a5a`) ships a working
Teams integration, and its source agrees — more usefully than its docs, which
barely mention this.

- `preferDelegated: true` appears at **exactly two call sites in the entire
  codebase**: `reactMessageMSTeams` and `unreactMessageMSTeams`
  (`extensions/msteams/src/graph-messages.ts:352,370`). Every other Graph
  operation they perform uses the app-only token. They singled out reactions,
  and only reactions.
- Their default delegated scope list (`extensions/msteams/src/oauth.shared.ts:7`)
  is precisely the `setReaction` permission set from the table above:

  ```ts
  export const MSTEAMS_DEFAULT_DELEGATED_SCOPES = [
    "ChatMessage.Send",
    "ChannelMessage.Send",
    "Chat.ReadWrite",
    "offline_access",   // refresh token
  ] as const
  ```

- They built an entire OAuth subsystem — auth-code flow, token cache, refresh,
  a setup-wizard step, a probe reporting delegated status — and reactions are
  the only capability it unlocks.

**A trap in their design worth not copying:** `resolveGraphToken`
(`extensions/msteams/src/graph.ts:233`) silently falls through to the app-only
token when `delegatedAuth.enabled` is false. So an OpenClaw install without
delegated auth configured hits this identical 412, with no warning that the
fallback can never succeed for this call.

## What implementing it would actually take

Reactions are reachable only behind delegated auth, which is listed as out of
scope in Plan §9. The work, if it is ever wanted:

1. **OAuth auth-code flow** with a local redirect listener — the operator signs
   in once, in a browser, as themselves.
2. **Refresh-token cache** in the state dir at `0600`, with the same
   `assertSendable`-style guard that keeps `.env` unreadable to outbound sends.
3. **Per-operation token selection** — reactions use the delegated token,
   everything else keeps the application token. Do *not* make delegated the
   default; the app-only path is what lets the hermit run unattended.
4. **A second consent walkthrough** in `skills/configure/SKILL.md`: delegated
   `ChannelMessage.Send`, `Chat.ReadWrite`, `ChatMessage.Send`, plus
   `offline_access`.
5. **Reaction attribution changes.** A delegated reaction is attributed to the
   *signed-in operator*, not to the bot. A 👍 from the hermit would appear in
   Teams as a 👍 from the person who consented. That is a product decision, not
   just a technical one, and it may be reason enough not to do this.

OpenClaw's `oauth.ts`, `oauth.flow.ts`, `oauth.shared.ts`, `token.ts`, and
`delegated-state.ts` are a complete reference for 1–3.

## Current state of the code

`react` is still registered as a tool and still fails. The 412 branch in
`describeGraphFailure` (`src/graph.ts`) now states the cause plainly instead of
naming two hypotheses to try.

**The open decision — for the operator, not for an agent to make unilaterally:**

- **Remove `react` entirely.** Deletes `src/graph.ts` (121 lines),
  `tests/graph.test.ts` (139 lines), the tool registration in `server.ts`, and
  `ConversationRef.teamId`/`channelId` — whose only consumer in the repo is the
  react call site (`server.ts:255`). Smallest honest surface: no tool that
  always fails, no Graph dependency. Recoverable from git history if delegated
  auth ever lands.
- **Keep it, degraded.** Costs a tool slot in every session's context and Claude
  will periodically attempt it and always fail, but the addressing logic stays
  in place.
- **Implement delegated auth.** See above; note point 5 first.

Everything else in this channel works without reactions. `reply`,
`edit_message`, `download_attachment`, and proactive `send.ts` were all verified
live against a real tenant and none of them touch Graph.
