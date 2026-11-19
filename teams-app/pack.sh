#!/usr/bin/env bash
# Usage: BOT_APP_ID=<guid> PUBLIC_HOST=<host> DEVELOPER_NAME="<name>" ./pack.sh
# Produces interview-assistant.zip for sideloading (Teams > Apps > Manage your apps > Upload a custom app).
set -euo pipefail
: "${BOT_APP_ID:?set BOT_APP_ID to the Entra app client ID of the bot}"
: "${PUBLIC_HOST:?set PUBLIC_HOST, for example bot.example.com}"
: "${DEVELOPER_NAME:=Interview Assistant Dev}"
cd "$(dirname "$0")"
rm -rf build interview-assistant.zip && mkdir build
sed -e "s/{{BOT_APP_ID}}/${BOT_APP_ID}/g" \
    -e "s/{{PUBLIC_HOST}}/${PUBLIC_HOST}/g" \
    -e "s/{{DEVELOPER_NAME}}/${DEVELOPER_NAME}/g" manifest.template.json > build/manifest.json
cp color.png outline.png build/
(cd build && zip -q ../interview-assistant.zip manifest.json color.png outline.png)
echo "Wrote $(pwd)/interview-assistant.zip"
