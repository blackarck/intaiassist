#!/usr/bin/env bash
# Stores the SendGrid API key in Key Vault (secret `sendgrid-api-key`).
#   - the key is typed/pasted at a hidden prompt: it never appears on screen, in shell history, or in the process list
#   - before storing, asks SendGrid which permissions the key has (GET /v3/scopes) and shows YES/NO for the ones we need;
#     only permission NAMES are printed, never the key
#
#   infra/sendgrid/store-api-key.sh
set -euo pipefail

KEY_VAULT="${KEY_VAULT:-vaiintassist-kv-f9ea}"
API="${SENDGRID_API:-https://api.sendgrid.com}"     # EU subusers: https://api.eu.sendgrid.com
HERE="$(cd "$(dirname "$0")" && pwd)"

read -rsp "Paste the SendGrid API key (input is hidden), then press Enter: " SG_KEY
echo
[ -n "$SG_KEY" ] || { echo "Nothing entered."; exit 1; }
if [[ "$SG_KEY" != SG.* ]]; then
  read -rp "SendGrid keys start with 'SG.' and this one does not. Continue anyway? [y/N] " yn
  [ "$yn" = "y" ] || exit 1
fi

# The key goes to curl through its config on stdin, so it is not visible in `ps`.
RESP="$(printf 'header = "Authorization: Bearer %s"\n' "$SG_KEY" | curl -sS -K - -w '\n%{http_code}' "$API/v3/scopes")"
CODE="${RESP##*$'\n'}"
BODY="${RESP%$'\n'*}"

if [ "$CODE" = "401" ]; then
  echo "SendGrid does not recognise this key (HTTP 401). It was NOT stored. Check that you copied the whole key."
  exit 1
elif [ "$CODE" = "200" ]; then
  SCOPES_JSON="$BODY" python3 "$HERE/report_scopes.py"
else
  echo "Could not check the key's permissions (HTTP $CODE); continuing without that check."
fi

read -rp "Store it in Key Vault $KEY_VAULT as sendgrid-api-key? [y/N] " yn
[ "$yn" = "y" ] || { echo "Not stored."; exit 0; }
printf '%s' "$SG_KEY" | az keyvault secret set --vault-name "$KEY_VAULT" --name sendgrid-api-key \
  --file /dev/stdin --encoding utf-8 --query name -o tsv
unset SG_KEY
echo "Stored. (The key is not saved anywhere else; if you lose it, create a new one in SendGrid.)"
