# Setting up the msteams channel

This guide registers a bot with Microsoft, creates its credentials, connects it
to Teams and enables the plugin in Claude Code. The process is CLI-first, with a
few browser steps in the Microsoft 365 and Teams admin centers.

Everything here was tested end to end against a real Microsoft 365 organization.
Nothing phones home: you own the bot, the credentials and the HTTPS endpoint.

## Agent-assisted setup

Give Claude Code the following prompt:

```text
Help me set up msteams-channel by following SETUP.md in order. Fetch it from
https://raw.githubusercontent.com/gtapps/msteams-channel/main/SETUP.md.

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

Prices verified on 2026-07-31 and subject to change.

| Item | Cost |
|---|---|
| Azure Bot, F0 tier | **$0**: Teams is a "standard channel", unlimited messages |
| Entra app registration, resource group | $0 |
| Azure subscription | Required to hold the bot; $0 if you provision nothing else |
| Microsoft 365 seat | **$7.00/user/mo annual, $8.40 month-to-month** (Business Basic, 1 seat is enough) |

> **The Business Basic trial auto-converts to a twelve-month commitment, not
> month-to-month.** Turn off recurring billing immediately after signing up, or
> start on the monthly SKU.

## Prerequisites

- **A tenant where you are Global Administrator.** Self-service signup makes you
  admin by construction, but confirm rather than assume: manifest upload needs
  it, and finding out late is expensive.
- **The Microsoft 365 Developer Program sandbox is not a route.** It now requires
  a Visual Studio Professional/Enterprise annual subscription, ISV Success or
  partner status, or Premier/Unified Support. Plan on a paid Business Basic
  tenant.
- **Teams Essentials cannot host this bot.** It lacks Teams app development
  support and Entra/admin-center access. This bites at install time, not chat
  time; end users in a properly licensed tenant need no license beyond Teams.
- **An Azure subscription with the Owner role.** Contributor is not enough: the
  Azure Bot's role assignments need Owner.

## Step 0: Enable custom app upload

Do this before anything else. **Propagation takes up to 24 hours** on a fresh
tenant, and it is the only step with a long clock.

1. <https://admin.teams.microsoft.com> → **Teams apps → Setup policies →
   Global (Org-wide default)** → **Upload custom apps: On** → Save
2. **Teams apps → Manage apps → Actions → Org-wide app settings → Custom apps** →
   enable both toggles

The org-wide gate dominates: if custom apps are off there, the setup policy is
ignored. If the toggle is unavailable, a global admin always has the
non-disableable **Manage apps → Upload new app** path.

## Step 1: Find your tenant ID

Microsoft calls your organization ID the tenant ID. It is a GUID, not your
username or domain. Read it from Microsoft's public discovery endpoint, no
credentials needed:

```bash
curl -s "https://login.microsoftonline.com/<your-domain>.onmicrosoft.com/v2.0/.well-known/openid-configuration" \
  | grep -o '"issuer":"[^"]*"'
```

The GUID in the issuer URL is your tenant ID.

**Confirm your Azure subscription lives in that same tenant.** A subscription in
a different directory provisions cleanly and then never authenticates, which you
would only discover at the smoke test:

```bash
az login --use-device-code
az account list --query "[].{name:name, tenantId:tenantId}" -o table
```

If `tenantId` matches the GUID above, you are clear. A tenant's display name and
its initial domain are independent fields and commonly differ; two
different-looking names are not themselves a problem.

## Step 2: Register the BotService provider

**A fresh subscription has `Microsoft.BotService` in `NotRegistered` state**, and
bot creation fails until it is registered. This is missing from the Azure Bot
quickstart. It is free, creates nothing, and takes a few minutes to propagate:

```bash
az provider register -n Microsoft.BotService
# wait for Registered
until [ "$(az provider show -n Microsoft.BotService --query registrationState -o tsv)" = "Registered" ]; do sleep 15; done
```

## Step 3: A tunnel with a stable hostname (dev only)

Production uses your own HTTPS ingress (see
[Production ingress](#production-ingress)). For development, Microsoft's
`devtunnel` works, with three traps.

```bash
curl -sL https://aka.ms/DevTunnelCliInstall | bash
devtunnel user login          # -d for device code on a headless box
devtunnel create msteams-dev -a
devtunnel port create msteams-dev -p 3978 --protocol http
devtunnel host msteams-dev
```

**Hosting requires a login.** Anonymous *client* access (what Bot Service needs
to reach you) still works, but anonymous *hosting* does not. The host token
expires in days, so a long-lived dev host needs periodic re-login.

**`--protocol http` describes the local hop, not the public URL.** The public
URL is HTTPS either way; devtunnel terminates TLS at its edge. Setting it to
`https` makes devtunnel attempt a TLS handshake against this plugin's plain-HTTP
listener, and every request returns **502** with nothing in the plugin's log. If
the public URL gives 502 while `curl http://127.0.0.1:3978/api/messages` returns
401 locally, this is the cause.

**Read the public URL from the `devtunnel host` output.** The hostname uses an
opaque generated token, not your alias: a tunnel created as `msteams-dev` is
reachable at something shaped like
`https://<8-char-token>-3978.<cluster>.devtunnels.ms`. The hostname is stable
across host restarts as long as the tunnel object is not deleted. Tunnels expire
after at most 30 days.

## Step 4: Register the bot identity

Microsoft calls the bot identity an app registration. `--sign-in-audience
AzureADMyOrg` restricts it to your organization, and the plugin checks that
boundary on every incoming message:

```bash
APPID=$(az ad app create \
  --display-name "msteams-channel" \
  --sign-in-audience AzureADMyOrg \
  --query appId -o tsv)
```

**Now create the service principal. Do not skip this:**

```bash
az ad sp create --id "$APPID"
```

`az ad app create` registers the application but not the *enterprise
application* (service principal) that lets your tenant issue tokens to it.
Nothing fails until the bot's first outbound reply, long after everything looks
correct, when the send dies with `AADSTS7000229: The client application <app-id>
is missing service principal in the tenant <tenant-id>`.

Generate the client credential straight into the state dir. **Never pass it in
argv and never echo it**: argv is world-readable in `/proc` on Linux.

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

## Step 5: Enable the Teams channel

**`az bot msteams create` fails.** The command group is in preview and its SDK
model cannot deserialize a `deploymentEnvironment` value the service now returns
(`Newtonsoft.Json.JsonSerializationException` converting
`"FallbackDeploymentEnvironment"`). The bot itself is fine; only the channel
enable fails. Go around the broken model by calling ARM directly:

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
listener, and was correctly rejected for having no valid Entra token. Anything
else:

| Code | Meaning |
|---|---|
| 401 | Correct. Path works, JWT validation is live. |
| 502 | Tunnel can't reach the backend: check the port protocol above, and that the plugin is actually running. |
| 404 | Wrong path, or `MSTEAMS_WEBHOOK_PATH` doesn't match the bot's messaging endpoint. |
| timeout | Tunnel not hosting. |

## Step 6: Enable the channel in Claude Code

Installing the plugin is not enough. Everything below was observed on Claude
Code v2.1.220; where it contradicts the published channels reference, the
observed behavior is what is recorded.

### 6a: Install at local scope

```bash
claude plugin marketplace add gtapps/msteams-channel
claude plugin install msteams@msteams-channel --scope local
```

For a local checkout, replace `gtapps/msteams-channel` in the first command with
`/path/to/msteams-channel`.

**Local scope, not user scope.** A channel plugin's MCP server is spawned by
every session that loads it. At user scope every Claude Code session on the
machine starts its own copy, and because this one binds a fixed webhook port
they evict each other, so inbound events land nowhere visible.

### 6b: Allowlist the plugin in managed settings

Claude Code's default channel allowlist contains only the official plugins. Add
this entry to the `allowedChannelPlugins` array in the managed-settings file,
and make sure `channelsEnabled` is on. The file lives at
`/etc/claude-code/managed-settings.json` on Linux and WSL, and
`/Library/Application Support/ClaudeCode/managed-settings.json` on macOS. Root
can edit it locally; on Team and Enterprise plans an administrator can set the
same values centrally:

```json
{
  "channelsEnabled": true,
  "allowedChannelPlugins": [{"marketplace":"msteams-channel","plugin":"msteams"}]
}
```

> **The array replaces the default allowlist; it does not extend it.** Preserve
> every existing channel entry, or you can silently disable Discord, Telegram or
> another channel already in use.

> **`channelsEnabled: true` is required once the file exists.** With no
> managed-settings file at all, channels are on by default on Console plans; the
> moment the file exists and omits the key, every channel is blocked. On Team
> and Enterprise plans the key is required unconditionally. The debug log says
> `channels not enabled by org policy` either way.

### 6c: Launch

```bash
claude --channels plugin:msteams@msteams-channel
```

That is the whole command. Do not add `--plugin-dir`, `--mcp-config`, or
`--dangerously-load-development-channels`. The `--channels` flag does not appear
in `claude --help`.

**`--dangerously-load-development-channels` does not work on v2.1.220.** The
published docs present it as the route for testing an unpublished channel, but
it never enters the entry into the session's channel list and its documented
confirmation dialog never appears. Confirmed against Anthropic's own `fakechat`
server, so it is not specific to this plugin. Use the managed-settings route
above.

## File sending to channels and group chats

Optional, and only for files. Text, inline images (under 4MB) and DM file sends
work with nothing here.

**Prerequisite for DM file sends: an app package whose manifest sets
`supportsFiles: true`.**

Steps 4 and 5 register the bot in Azure and enable its Teams channel, which is
enough to DM it through its deep link
(`https://teams.microsoft.com/l/chat/0/0?users=28:<app-id>`). That path uploads
no app package, so a tenant set up only that way has no manifest and nowhere to
set this property. Microsoft documents `supportsFiles` as the switch for a bot
sending files in a personal chat, so DM file sends need a package created and
sideloaded (Teams client, Apps, Manage your apps, Upload an app). Not yet
verified against this tenant: the symptom to watch for is a consent card that
renders with no Accept button.

Channel and group chat file sends do not depend on this. They upload through
Graph to the SharePoint site configured below, so they need only that site and
its grant. Getting the bot into a team in the first place does require an
installed app package.

Outside a DM a bot has no personal drive to upload to (Graph's `/me` needs a
signed-in user, and this channel authenticates as the application), so files
there are uploaded to a SharePoint site you designate and shared from it.

1. **Pick or create a site** to hold them. A dedicated one is easiest to reason
   about: everything the bot sends lands in an `AgentShared` folder in its
   default document library, and never overwrites (each upload gets a random
   suffix).

2. **Get the site id:**

   ```bash
   curl -H "Authorization: Bearer $TOKEN" \
     "https://graph.microsoft.com/v1.0/sites/contoso.sharepoint.com:/sites/BotFiles?\$select=id"
   # -> "id": "contoso.sharepoint.com,<guid>,<guid>"
   ```

3. **Grant the app write access to that one site.** In Entra ID, add the
   application permission `Sites.Selected` and grant admin consent, then bind it
   to the site (this call needs an admin token with `Sites.FullControl.All`):

   ```bash
   curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
     "https://graph.microsoft.com/v1.0/sites/<site-id>/permissions" \
     -d '{"roles":["write"],"grantedToIdentities":[{"application":{"id":"<MSTEAMS_APP_ID>","displayName":"Claude Teams channel"}}]}'
   ```

   `Sites.Selected` is preferred because it bounds the damage: a leaked bot
   credential can write to that one site rather than every site in the tenant.
   `Sites.ReadWrite.All` (application) also works and needs no per-site call, at
   that cost.

4. **Point the channel at it,** in the state dir `.env` (`0600`, same file as
   the credentials):

   ```bash
   MSTEAMS_SHAREPOINT_SITE_ID=contoso.sharepoint.com,<guid>,<guid>
   ```

Restart the session to pick it up. Group-chat sends additionally read the chat's
member list through Bot Framework (no extra Graph permission) so the sharing
link covers only those people; if that read fails, the send fails rather than
sharing more widely.

## If setup fails

Messages that never register or fail the access policy are silent in Teams.
Start with:

```bash
grep "Channel notifications" ~/.claude/debug/<session-id>.txt
```

Then follow [TROUBLESHOOTING.md](TROUBLESHOOTING.md). Access commands and
channel IDs are in [ACCESS.md](ACCESS.md).

## Production ingress

devtunnel is a public preview and documents itself as not for production. Run
your own HTTPS ingress instead: a reverse proxy (Caddy → `127.0.0.1:3978`) where
you have a public IP, or Cloudflare Tunnel behind NAT. Either satisfies the
design: the plugin binds localhost and you own the public edge.

An anonymous tunnel is still safe as a transport, because the Microsoft SDK
validates the Entra JWT on every request before any plugin code runs.

### Running in Docker

The listener binds `127.0.0.1` by default, and inside a container that is the
container's own loopback, unreachable from a host-side reverse proxy. Set
`MSTEAMS_WEBHOOK_HOST=0.0.0.0` and publish the port.

To run several bots on one host, give each its own `MSTEAMS_WEBHOOK_PORT` and
point one subdomain at each behind a single proxy.

### Running more than one project

A bot registration has one messaging endpoint URL, so Teams traffic reaches
exactly one listener. Each extra project needs its own Entra app, bot
registration, Teams app manifest, tunnel hostname and `MSTEAMS_WEBHOOK_PORT`,
plus its own `MSTEAMS_STATE_DIR`, since `bot.pid` and the conversation
references live there.

Skip any of that and the projects contend. Sharing a state dir, the newer
listener silently evicts the older one via `bot.pid`. With separate state dirs,
the second fails at startup with `FAILED to bind 127.0.0.1:3978`, recorded in
`~/.claude/debug/<session-id>.txt`. Either way only one listener receives
traffic. Sending is unaffected: `send.ts` needs no port.

## Teardown

Everything unwinds cleanly because it all lives in one group:

```bash
az group delete -n rg-msteams-channel --yes
az ad app delete --id "$APPID"
devtunnel delete msteams-dev
```

Then remove your state dir (`MSTEAMS_STATE_DIR`, default
`~/.claude/channels/msteams/`). Cancel the Microsoft 365 subscription
separately, in the admin center, before the trial converts.
