# Setting up the msteams channel

This guide registers a bot with Microsoft, creates its credentials, connects it
to Teams and enables the plugin in Claude Code. The process is CLI-first, with a
few browser steps in the Microsoft 365 and Teams admin centers.

Everything here was tested end to end against a real Microsoft 365 organization
on 2026-07-31. Nothing phones home: you own the bot, credentials and HTTPS
endpoint.

## Agent-assisted setup

From this repository checkout, give Claude Code the following prompt:

```text
Help me set up msteams-channel by following SETUP.md in order.

Start with read-only checks. Verify Azure CLI, my active Microsoft organization,
Azure subscription and required roles. Explain the resources and costs before
creating anything.

Use Azure CLI where supported. Hand browser-only Microsoft 365 and Teams admin
steps back to me with exact instructions. Never print a secret or put one in
argv or logs; write credentials directly to
${MSTEAMS_STATE_DIR:-$HOME/.claude/channels/msteams}/.env with mode 0600.

Preserve existing allowedChannelPlugins entries instead of replacing them.
Verify each stage before continuing: local webhook, public ingress, bot,
plugin registration, pairing and allowlist mode. Do not run teardown.
```

## Cost

Prices below were verified on 2026-07-31 and may change.

| Item | Cost |
|---|---|
| Azure Bot, F0 tier | **$0** — Teams is a "standard channel", unlimited messages |
| Entra app registration, resource group | $0 |
| Azure subscription | Required to hold the bot; $0 if you provision nothing else |
| Microsoft 365 seat | **$7.00/user/mo annual, $8.40 month-to-month** (Business Basic, 1 seat is enough) |

**The Business Basic trial auto-converts to a twelve-month commitment, not
month-to-month.** Turn off recurring billing immediately after signing up, or
start on the monthly SKU. This is the single most expensive mistake available
in this whole process.

## Prerequisites

- **A tenant where you are Global Administrator.** Self-service signup makes you
  admin by construction, but confirm rather than assume — manifest upload needs
  it and finding out late is expensive.
- **The Microsoft 365 Developer Program sandbox is not a route.** It now requires
  a Visual Studio Professional/Enterprise *standard annual* subscription, ISV
  Success / partner status, or Premier/Unified Support. There is no general free
  signup. Plan on a paid Business Basic tenant.
- **Teams Essentials cannot host this bot.** It is absent from the plans that
  support Teams app development and has no Entra/admin-center access. This bites
  at install time, not chat time; end users in a properly licensed tenant need no
  license beyond Teams itself.
- Azure subscription with the **Owner** role. Contributor is not enough — the
  Azure Bot's role assignments need Owner, and discovering that mid-provision
  means an escalation round trip.

## Step 0 — Enable custom app upload, first

Do this before anything else, because **propagation takes up to 24 hours** on a
fresh tenant and it is the only step with a long clock.

1. <https://admin.teams.microsoft.com> → **Teams apps → Setup policies →
   Global (Org-wide default)** → **Upload custom apps: On** → Save
2. **Teams apps → Manage apps → Actions → Org-wide app settings → Custom apps** →
   enable both toggles

The org-wide gate dominates: if custom apps are off there, the setup policy is
ignored. If the toggle is unavailable, a global admin always has the
non-disableable **Manage apps → Upload new app** path — sideloading is gated,
not walled.

## Step 1 — Find your organization ID

Microsoft calls this the tenant ID. It is a GUID, not your username or phone
number. Read it from Microsoft's public discovery endpoint:

```bash
curl -s "https://login.microsoftonline.com/<your-domain>.onmicrosoft.com/v2.0/.well-known/openid-configuration" \
  | grep -o '"issuer":"[^"]*"'
```

The GUID in the issuer URL is your tenant ID. No credentials needed.

**Then confirm your Azure subscription lives in that same tenant.** A tenant's
*display name* and its *initial domain* are independent fields and commonly
differ, so seeing two different-looking names is not itself a problem — but a
subscription in a genuinely different directory provisions cleanly and then
never authenticates, which you would only discover at the smoke test.

```bash
az login --use-device-code
az account list --query "[].{name:name, tenantId:tenantId}" -o table
```

If `tenantId` matches the GUID above, you are clear.

## Step 2 — Register the BotService provider

**A fresh subscription has `Microsoft.BotService` in `NotRegistered` state**, and
bot creation fails until it is registered. This is not mentioned in the Azure Bot
quickstart. It is free, creates nothing, and takes a few minutes to propagate:

```bash
az provider register -n Microsoft.BotService
# wait for Registered
until [ "$(az provider show -n Microsoft.BotService --query registrationState -o tsv)" = "Registered" ]; do sleep 15; done
```

## Step 3 — A tunnel with a stable hostname (dev only)

Production uses your own HTTPS ingress (see below). For development, Microsoft's
`devtunnel` works, with two traps.

**Hosting requires a login.** Dev tunnels does not support anonymous *hosting*.
Anonymous *client* access — which is what Bot Service needs to reach you — is a
separate thing and does still work. The host token expires in days, so a
long-lived dev host needs periodic re-login.

```bash
curl -sL https://aka.ms/DevTunnelCliInstall | bash
devtunnel user login          # -d for device code on a headless box
devtunnel create msteams-dev -a
devtunnel port create msteams-dev -p 3978 --protocol http
devtunnel host msteams-dev
```

**`--protocol http` is deliberate and easy to get wrong.** That flag describes
the *local* hop — how devtunnel talks to your listener — not what the public URL
serves. The public URL is HTTPS either way, because devtunnel terminates TLS at
its edge. Setting it to `https` makes devtunnel attempt a TLS handshake against
this plugin's plain-HTTP listener, and every request comes back **502** with
nothing at all in the plugin's log, because the request never reaches it.

If you see 502 from the public URL while `curl http://127.0.0.1:3978/api/messages`
returns 401 locally, this is the cause.

**Do not construct the tunnel URL from the tunnel ID.** The public hostname uses
an opaque generated token, *not* the alias you pinned — a tunnel created as
`msteams-dev` is reachable at something shaped like
`https://<8-char-token>-3978.<cluster>.devtunnels.ms`, with no trace of the
alias in it. Read the URL from the `devtunnel host` output and use it verbatim.

The good news, verified by stopping and restarting the host: **that hostname is
stable across restarts** as long as the tunnel object itself is not deleted. So
pinning does buy you a durable endpoint, just not a predictable one. Tunnels
expire after a maximum of 30 days.

## Step 4 — Register the bot identity

Microsoft calls the bot identity an app registration. The
`--sign-in-audience AzureADMyOrg` option restricts it to your organization, and
the plugin checks that boundary on every incoming message.

```bash
APPID=$(az ad app create \
  --display-name "msteams-channel" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)
```

**Now create the service principal. Do not skip this** — it is the step whose
absence costs the most time:

```bash
az ad sp create --id "$APPID"
```

`az ad app create` registers the application; it does not create the *enterprise
application* (service principal) that lets your tenant issue tokens to it. The
Teams CLI does this as a side effect of its own provisioning, so a manual
registration is the case that misses it.

Nothing fails until the bot's first outbound message, long after everything
looks correct: inbound messages arrive normally, the gate passes, Claude sees
them and composes a reply — and only the send fails, with
`AADSTS7000229: The client application <app-id> is missing service principal in
the tenant <tenant-id>`. Requires tenant admin. Reversible with
`az ad sp delete --id "$APPID"`.

Generate the client credential straight into the state dir. **Never pass it in
argv and never echo it** — argv is world-readable in `/proc` on Linux:

```bash
STATE="${MSTEAMS_STATE_DIR:-$HOME/.claude/channels/msteams}"
mkdir -p "$STATE" && chmod 700 "$STATE"
umask 077
PW=$(az ad app credential reset --id "$APPID" --append --years 1 \
       --display-name "msteams-channel" --query password -o tsv)
printf 'MSTEAMS_APP_ID=%s\nMSTEAMS_APP_PASSWORD=%s\nMSTEAMS_TENANT_ID=%s\n' \
  "$APPID" "$PW" "$TENANT_ID" > "$STATE/.env"
chmod 600 "$STATE/.env"
PW=""
```

Then the resource group and the bot, using the tunnel URL from step 3:

```bash
az group create -n rg-msteams-channel -l westeurope
az bot create \
  --resource-group rg-msteams-channel \
  --name <globally-unique-bot-name> \
  --app-type SingleTenant \
  --appid "$APPID" \
  --tenant-id "$TENANT_ID" \
  --sku F0 \
  --endpoint "https://<tunnel-host>/api/messages"
```

## Step 5 — Enable the Teams channel (the CLI is broken here)

**`az bot msteams create` fails.** The command group is in preview and its SDK
model cannot deserialize a `deploymentEnvironment` value the service now
returns:

```
Newtonsoft.Json.JsonSerializationException: Error converting value
"FallbackDeploymentEnvironment" to type
'Microsoft.Bot.Internal.Schema.FirstPartyChannelDeploymentEnvironment'
```

The bot itself is fine; only the channel enable fails. Go around the broken model
by calling ARM directly:

```bash
az rest --method put --uri \
  "https://management.azure.com/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.BotService/botServices/<bot>/channels/MsTeamsChannel?api-version=2022-09-15" \
  --body '{"location":"global","properties":{"channelName":"MsTeamsChannel","properties":{"isEnabled":true}}}'
```

Verify `isEnabled: true` and `provisioningState: Succeeded` in the response.

## Verify the path before involving Teams

Prove the whole chain reaches your listener before you go looking for problems
in Teams. With the tunnel hosting and the plugin running, POST to the public
URL:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://<tunnel-host>/api/messages" -H 'content-type: application/json' -d '{}'
```

**401 is success here.** It means the request traversed the tunnel, reached the
listener, and was correctly rejected for having no valid Entra token — which is
exactly what Bot Service's traffic will do differently. Anything else:

| Code | Meaning |
|---|---|
| 401 | Correct. Path works, JWT validation is live. |
| 502 | Tunnel can't reach the backend — check the port protocol above, and that the plugin is actually running. |
| 404 | Wrong path, or `MSTEAMS_WEBHOOK_PATH` doesn't match the bot's messaging endpoint. |
| timeout | Tunnel not hosting. |

## Step 6 — Enabling the channel

Installing the plugin is not enough, and this is the step most likely to waste
an afternoon. Everything below was established empirically on Claude Code
**v2.1.220**; where it contradicts the published channels reference, the observed
behavior is what is recorded.

### 6a — Install at local scope

```bash
claude plugin marketplace add gtapps/msteams-channel
claude plugin install msteams@msteams-channel --scope local
```

For a local checkout, replace `gtapps/msteams-channel` in the first command with
`/path/to/msteams-channel`.

**Local scope, not user scope.** A channel plugin's MCP server is spawned by
every session that loads it. At user scope every Claude Code session on the
machine starts its own copy, and because this one binds a fixed webhook port they
evict each other — so the process holding the port is not the one attached to
your session, and inbound events land nowhere visible.

### 6b — Admit the plugin to the channel allowlist

Claude Code's default allowlist contains the official channel plugins. Two keys
in `/etc/claude-code/managed-settings.json` are involved — add this entry to the
existing `allowedChannelPlugins` array, and make sure `channelsEnabled` is on:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [{"marketplace":"msteams-channel","plugin":"msteams"}]
}
```

Root can edit the local file. On Team and Enterprise plans, an administrator can
set the same values centrally.

> **The array replaces the default allowlist — it does not extend it.** Preserve
> every existing channel entry. Replacing the file with a one-plugin example can
> silently disable Discord, Telegram, voice or another channel already in use.

> **`channelsEnabled: true` is not optional once the file exists.** With no
> managed-settings file at all, channels are on by default on Console plans; the
> moment the file exists and omits the key, every channel is blocked — so
> creating it for the allowlist alone is worse than not creating it. On Team and
> Enterprise plans the key is required *unconditionally*, file or no file. The
> debug log says `channels not enabled by org policy` either way.

### 6c — Launch

```bash
claude --channels plugin:msteams@msteams-channel
```

That is the whole command. **Do not** add `--plugin-dir`, `--mcp-config`, or
`--dangerously-load-development-channels`. `--channels` does not appear in
`claude --help`.

**`--dangerously-load-development-channels` does not work on v2.1.220.** The
published docs present it as the route for testing an unpublished channel, but it
never enters the entry into the session's channel list and the documented
full-screen "I am using this for local development" dialog never appears. This
was confirmed against Anthropic's own `fakechat` server copied into a private
marketplace under a different name, which fails identically — so it is not a
defect in this plugin. Use the managed-settings route above.

## If setup fails

Messages that never register or fail the access policy are silent in Teams.
Start with:

```bash
grep "Channel notifications" ~/.claude/debug/<session-id>.txt
```

Then follow [TROUBLESHOOTING.md](TROUBLESHOOTING.md), which covers channel
registration, duplicate MCP configuration, channel opt-in, credentials,
reaction errors and outbound refusals. Access commands and channel IDs are in
[ACCESS.md](ACCESS.md).

## Production ingress

devtunnel is public preview and documents itself as not for production. Run your
own HTTPS ingress instead — a reverse proxy (Caddy → `127.0.0.1:3978`) where you
have a public IP, or Cloudflare Tunnel behind NAT. Either satisfies the design:
the plugin binds localhost and you own the public edge.

An anonymous tunnel is still safe as a transport because the Microsoft SDK
validates the Entra JWT on every request before any plugin code runs.

### Running in Docker

The listener binds `127.0.0.1` by default. **Inside a container that is the
container's own loopback**, so a host-side reverse proxy cannot reach it. Set
`MSTEAMS_WEBHOOK_HOST=0.0.0.0` and publish the port.

To run several bots on one host, give each its own `MSTEAMS_WEBHOOK_PORT` and
point one subdomain at each behind a single proxy.

### Running more than one project

A bot registration has one messaging endpoint URL, so Teams traffic reaches one
listener, on one host, on one port. Each extra project needs its own Entra app,
bot registration, Teams app manifest, tunnel hostname and `MSTEAMS_WEBHOOK_PORT`
— plus its own `MSTEAMS_STATE_DIR`, since `bot.pid` and the conversation
references live there.

Skip any of that and the two projects contend. Sharing a state dir, the newer
listener finds the older one's `bot.pid` and evicts it: the port transfers, but
the evicted session goes quiet without a word in its own log. With separate state
dirs neither sees the other's pidfile, so the second fails to bind and exits with
`FAILED to bind 127.0.0.1:3978` — the same loss, said out loud at startup, where
`~/.claude/debug/<session-id>.txt` records it.

Sending is unaffected either way: `send.ts` needs no port.

## Teardown

The whole experiment unwinds cleanly because everything lives in one group:

```bash
az group delete -n rg-msteams-channel --yes
az ad app delete --id "$APPID"
devtunnel delete msteams-dev
```

Then remove your state dir (`MSTEAMS_STATE_DIR`, default
`~/.claude/channels/msteams/`). Cancel the M365 subscription
separately, in the admin center, before the trial converts.
