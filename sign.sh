#!/usr/bin/env bash
# Signs the Hub Dashboard add-on with Mozilla so Firefox will keep it installed.
# Asks for your addons.mozilla.org API key and secret (the secret isn't shown as you type).
set -e
cd "$(dirname "$0")"

read -r -p "API key (looks like user:12345678:563): " KEY
read -r -s -p "API secret (paste it, then press Enter): " SECRET
echo
KEY="$(echo -n "$KEY" | tr -d '[:space:]')"
SECRET="$(echo -n "$SECRET" | tr -d '[:space:]')"

echo "Uploading and waiting for Mozilla to sign it. This can take a few minutes; don't press Ctrl+C."
WEB_EXT_API_KEY="$KEY" WEB_EXT_API_SECRET="$SECRET" \
  npx --yes web-ext sign --channel=unlisted -s extension -a web-ext-artifacts --ignore-files ".amo-upload-uuid"

echo
echo "Done. Drag this file into a Firefox window and click Add:"
ls -1 "$PWD"/web-ext-artifacts/*.xpi
