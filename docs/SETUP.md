# Setting up the msteams channel

Everything here was executed end to end against a real tenant on 2026-07-31 and
reflects what actually happened, not what the vendor docs describe. Where the
two disagree, the observed behavior is recorded and the discrepancy called out.

You provision your own Entra app and Azure Bot, in your own tenant. Nothing in
this plugin phones home and there is no shared endpoint — one client org is one
deployment.

## Cost

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

## Step 1 — Find your tenant ID without logging in

Your tenant ID is a GUID. It is **not** your username and not your phone number.
You can read it straight off Microsoft's public discovery endpoint:

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
devtunnel create hermit-msteams-dev -a
devtunnel port create hermit-msteams-dev -p 3978 --protocol http
devtunnel host hermit-msteams-dev
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
`hermit-msteams-dev` is reachable at something shaped like
`https://<8-char-token>-3978.<cluster>.devtunnels.ms`, with no trace of the
alias in it. Read the URL from the `devtunnel host` output and use it verbatim.

The good news, verified by stopping and restarting the host: **that hostname is
stable across restarts** as long as the tunnel object itself is not deleted. So
pinning does buy you a durable endpoint, just not a predictable one. Tunnels
expire after a maximum of 30 days.

## Step 4 — Entra app, credential, bot

Single-tenant registration. `--sign-in-audience AzureADMyOrg` is what pins the
app to your tenant, and it is what the plugin's gate enforces on every inbound
activity.

```bash
APPID=$(az ad app create \
  --display-name "hermit-msteams-channel" \
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
STATE="$HOME/.claude/channels/msteams"
mkdir -p "$STATE" && chmod 700 "$STATE"
umask 077
PW=$(az ad app credential reset --id "$APPID" --append --years 1 \
       --display-name "hermit-msteams" --query password -o tsv)
printf 'MSTEAMS_APP_ID=%s\nMSTEAMS_APP_PASSWORD=%s\nMSTEAMS_TENANT_ID=%s\n' \
  "$APPID" "$PW" "$TENANT_ID" > "$STATE/.env"
chmod 600 "$STATE/.env"
PW=""
```

Then the resource group and the bot, using the tunnel URL from step 3:

```bash
az group create -n rg-msteams-hermit -l westeurope
az bot create \
  --resource-group rg-msteams-hermit \
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
claude plugin marketplace add /path/to/claude-code-msteams-channel
claude plugin install msteams@claude-code-msteams-channel --scope local
```

**Local scope, not user scope.** A channel plugin's MCP server is spawned by
every session that loads it. At user scope every Claude Code session on the
machine starts its own copy, and because this one binds a fixed webhook port they
evict each other — so the process holding the port is not the one attached to
your session, and inbound events land nowhere visible.

### 6b — Admit the plugin to the channel allowlist

Claude Code's default allowlist is exactly the channel plugins in
`anthropics/claude-plugins-official`, and that repo auto-closes third-party pull
requests. A third-party channel is admitted through managed settings, which
requires root:

```bash
sudo mkdir -p /etc/claude-code
sudo tee /etc/claude-code/managed-settings.json >/dev/null <<'EOF'
{"channelsEnabled":true,"allowedChannelPlugins":[
  {"marketplace":"claude-code-msteams-channel","plugin":"msteams"}]}
EOF
```

> **This list replaces the default allowlist — it does not extend it.** Any other
> channel you rely on (`discord`, `voice`, …) must be listed here too, or it
> silently stops receiving messages. Add entries, never swap them.

On Team and Enterprise plans this is the same `allowedChannelPlugins` an admin
sets centrally.

### 6c — Launch

```bash
claude --channels plugin:msteams@claude-code-msteams-channel
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

### 6d — If messages still vanish

Inbound events are dropped **silently** — no reply, no error, nothing in this
plugin's log, because the message never reaches it. There is exactly one place
that tells you why:

```bash
grep "Channel notifications" ~/.claude/debug/<session-id>.txt
```

Run `claude --debug` to get that path. The line names the precise cause:

| Log line | Cause |
|---|---|
| `not in --channels list for this session` | The entry never resolved to an installed plugin — usually a shadowed server, see below. |
| `not on the approved channels allowlist` | Step 6b missing or the plugin is absent from `allowedChannelPlugins`. |
| `you asked for plugin:msteams@X but the installed msteams plugin is from Y` | Wrong marketplace name in `--channels`. Use the name from `claude plugin marketplace list`. |
| `server did not declare claude/channel capability` | Not this plugin — that line appears for every ordinary MCP server. |

**The most expensive trap: a stale `--mcp-config` or project `.mcp.json` that
also defines an `msteams` server.** Claude Code silently prefers it and suppresses
the plugin's own server:

```
Suppressing plugin MCP server "plugin:msteams:msteams": duplicates manually-configured "msteams"
```

The listener then runs happily under the id `server:msteams` — accepting real
Teams traffic, writing to the queue — while `--channels plugin:msteams@…` refers
to a server that no longer exists. Everything looks healthy and nothing is
delivered. Delete the stray config and relaunch.

`--plugin-dir` causes the same class of failure for a different reason: it yields
the id `plugin:msteams:msteams` with no marketplace component, which
`plugin:msteams@claude-code-msteams-channel` can never match. Install properly
(6a) instead.

**Do not trust the startup banner.** The dim
`Channels (experimental) messages from plugin:msteams@… inject directly in this
session` notice prints whether or not registration actually succeeded. Only the
debug log is evidence.

### 6e — If DMs work but channel messages are ignored

Channels are opt-in, and a channel that is not opted in is refused **silently**
— telling the sender why would confirm the bot exists and leak policy. So the
symptom is: DMs work perfectly, @-mentions in a channel do nothing at all.

Two conditions, both in `~/.claude/channels/msteams/access.json`:

```json
{
  "groups": {
    "19:<channel-thread-id>@thread.tacv2": {
      "requireMention": true,
      "allowFrom": []
    }
  }
}
```

**Prefer the skill over hand-editing:** `/msteams:access group add
19:…@thread.tacv2` writes exactly this, and `/msteams:access` with no arguments
shows what is currently opted in. Full reference: [`ACCESS.md`](../ACCESS.md).

The file is re-read on every inbound message, so edits take effect immediately —
no restart.

**Teams hands you the channel id.** In Teams, open the channel's **⋯ → Copy
link**. The URL contains the conversation id, URL-encoded:

```
https://teams.microsoft.com/l/channel/19%3AaEHRk…%40thread.tacv2/General?groupId=…
                                      └──── the conversation id ────┘
```

Decode it — `%3A` is `:` and `%40` is `@` — giving
`19:aEHRk…@thread.tacv2`. That is exactly the key under `groups`. This is the
same approach the Discord plugin takes (Developer Mode → Copy Channel ID); the
id comes from the client, not from the bot.

Strip anything from `;messageid=` onwards if present — the key is the bare
conversation id, so every thread in the channel inherits the opt-in.

`allowFrom` inside a group entry narrows *who* in that channel may drive the
bot, by AAD object id. **Left empty, anyone in the channel can** — opting the
channel in is itself the trust decision, matching the discord and telegram
plugins.

Group chats are the gap: unlike channels they have no shareable link, so there
is no way to read their id from the UI. Opt-in for those is on the DM/channel
path only for now.

`requireMention: true` (the default) additionally means a channel post must
@-mention the bot. A post that merely contains its name does not count; Teams
sends a real mention entity and the gate checks for that.

### 6f — If messages arrive but replies fail

The opposite symptom to 6d, and a much easier one: inbound works, Claude sees the
message, and only the send fails. The tool reports the underlying error verbatim,
so read it rather than guessing.

| Error | Cause |
|---|---|
| `AADSTS7000229: … missing service principal in the tenant …` | The service principal was never created. Run `az ad sp create --id <app-id>` (step 4). This is the common one for a manual registration. |
| `AADSTS7000215: Invalid client secret` | The credential in `.env` is wrong or expired. Reset it per step 4 — and check nothing quoted it. |
| `AADSTS700016: Application not found in the directory` | `MSTEAMS_APP_ID` does not match the registration, or you are pointed at the wrong tenant. |
| `412` from `react` | Expected — reactions do not work with this plugin's authentication, and no setting fixes it. See below. |
| `refused: no inbound conversation on record` | Working as designed. The bot may only reply where it was spoken to; message it from Teams first. |

**Reactions do not work, and there is nothing to configure.** Graph's
`setReaction` accepts no application permission of any kind — resource-specific
consent included — and this plugin authenticates as the application so it can
run unattended. Graph reports that refusal as 412. Do not grant Entra
permissions or edit the Teams manifest hoping to fix it; neither can.

Full evidence, the two hypotheses that were ruled out, and what delegated auth
would take: [`REACTIONS.md`](REACTIONS.md).

Everything else in this channel works without reactions, and the tool degrades
with a clear message rather than failing obscurely.

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

## Teardown

The whole experiment unwinds cleanly because everything lives in one group:

```bash
az group delete -n rg-msteams-hermit --yes
az ad app delete --id "$APPID"
devtunnel delete hermit-msteams-dev
```

Then remove `~/.claude/channels/msteams/`. Cancel the M365 subscription
separately, in the admin center, before the trial converts.
