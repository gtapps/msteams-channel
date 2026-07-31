# Attributions

This plugin is MIT licensed. It reuses designs, and in places small verbatim
chunks, from the projects below.

## OpenClaw — MIT

Consulted at commit `32b2e161a5a` (`openclaw/openclaw`), specifically
`extensions/msteams/**` and `docs/channels/msteams.md`.

OpenClaw is a **reference, not a dependency** — this plugin takes zero code
dependency on the OpenClaw runtime or its `plugin-sdk`. What was adopted:

- The durable-ingress contract (persist raw activity before acking, dedup by
  `activity.id`, replay on boot) — reimplemented here in `src/queue.ts` rather
  than vendored, since OpenClaw's `msteams-ingress.ts` is glue over its own
  `plugin-sdk` queue modules.
- The bearer-prefix pre-gate and bounded JSON body read before SDK parsing
  (`src/monitor.ts:218-225`).
- Conversation-ID normalization (stripping `;messageid=…`) and the refusal of
  name-based principals in favour of AAD object ids (`src/inbound.ts:88`,
  `src/monitor-handler/access.ts:66-70`).
- The local-JWKS auth-coverage test pattern (`auth-coverage.test.ts`).
- Webhook timeout tuning and the config-schema shape.

Periodically diff `extensions/msteams` and `docs/channels/msteams.md` against
newer OpenClaw commits for edge cases worth porting.

## Claude Code official plugins — Apache-2.0

Consulted at commit `db253f26` (`anthropics/claude-plugins-official`):
`external_plugins/fakechat/server.ts` (minimal channel-server structure) and
`external_plugins/telegram/server.ts` (access model, pairing, permission relay,
outbound gate, lifecycle/orphan-watchdog hardening).

This plugin mirrors **behavior and shapes** — the channel capability
declaration, notification payload shape, tool conventions, and access-model
semantics — rather than copying source. Any verbatim-lifted Apache-2.0 code
retains its header and notice at the point of use.

## Microsoft Agents SDK — MIT

`@microsoft/teams.apps` and `@microsoft/teams.api` are consumed as ordinary
pinned npm dependencies. They provide the webhook server adapter, Entra JWT
validation, activity routing, conversation references, and proactive send.
