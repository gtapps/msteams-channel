#!/usr/bin/env bash
# Build the sideloadable Teams app package.
#
# Installing the bot as an app is what lets it be added to a team or a group
# chat; a DM works without it, over the bot's deep link. The bot id is read from
# the state dir .env at build time and never printed, so this script is safe to
# run with someone watching.
#
#   ./teams-app/build.sh   ->  teams-app/dist/msteams-channel.zip
#
# Upload that zip in Teams: Apps -> Manage your apps -> Upload an app ->
# Upload a custom app. Requires custom app upload to be enabled (SETUP.md Step 0).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
state_dir="${MSTEAMS_STATE_DIR:-$HOME/.claude/channels/msteams}"
env_file="$state_dir/.env"

[ -f "$env_file" ] || { echo "no .env in $state_dir (run /msteams:configure)" >&2; exit 2; }

bot_id="$(grep -E '^[[:space:]]*MSTEAMS_APP_ID[[:space:]]*=' "$env_file" |
  head -1 | cut -d= -f2- | tr -d '"'\''[:space:]')"

[ -n "$bot_id" ] || { echo "MSTEAMS_APP_ID is not set in $env_file" >&2; exit 2; }
# A wrong id produces an app that installs and then never responds, so fail here
# instead.
[[ "$bot_id" =~ ^[0-9a-fA-F-]{36}$ ]] || { echo "MSTEAMS_APP_ID is not a GUID" >&2; exit 2; }

out="$here/dist"
mkdir -p "$out"
sed "s/__BOT_ID__/$bot_id/g" "$here/manifest.json" > "$out/manifest.json"
cp "$here/color.png" "$here/outline.png" "$out/"

# Zip the files themselves, not the directory: Teams rejects a package whose
# manifest.json is nested inside a folder.
(cd "$out" && rm -f msteams-channel.zip && zip -q -X msteams-channel.zip manifest.json color.png outline.png)

echo "built $out/msteams-channel.zip"
