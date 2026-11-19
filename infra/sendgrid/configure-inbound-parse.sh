#!/usr/bin/env bash
# Creates the SendGrid Inbound Parse host: mail for <HOSTNAME> is POSTed (raw MIME) to our backend.
#
# STATUS: written from SendGrid's "Create a Parse Setting" API reference; NOT yet run against a live account.
# If it fails, the same setting can be made by hand: SendGrid > Settings > Inbound Parse > Add Host & URL
# (see doc/inbound-email.md). Secrets come from Key Vault and are never printed.
#
# Prerequisites: DNS MX record  invite -> mx.sendgrid.net (priority 10);  Key Vault secrets sendgrid-api-key, inbound-token.
set -euo pipefail

KEY_VAULT="${KEY_VAULT:-vaiintassist-kv-f9ea}"
HOSTNAME_="${PARSE_HOSTNAME:-invite.askproso.ai}"
BACKEND="${BACKEND_URL:-https://intassistback.askproso.ai}"
API="${SENDGRID_API:-https://api.sendgrid.com}"        # EU subusers: https://api.eu.sendgrid.com

secret() { az keyvault secret show --vault-name "$KEY_VAULT" --name "$1" --query value -o tsv | tr -d '\r\n'; }
SG_KEY="$(secret sendgrid-api-key)"
TOKEN="$(secret inbound-token)"
URL="$BACKEND/inbound/sendgrid/$TOKEN"

BODY="$(python3 -c 'import json,sys; print(json.dumps({"hostname": sys.argv[1], "url": sys.argv[2], "spam_check": False, "send_raw": True}))' "$HOSTNAME_" "$URL")"

echo "Creating Inbound Parse host: $HOSTNAME_ -> $BACKEND/inbound/sendgrid/<secret>  (raw MIME, spam check off)"
# the API key is passed through curl's config on stdin so it never appears in the process list
STATUS="$(printf 'header = "Authorization: Bearer %s"\n' "$SG_KEY" | curl -sS -K - -o /tmp/sg-parse.out -w '%{http_code}' \
  -X POST "$API/v3/user/webhooks/parse/settings" -H 'Content-Type: application/json' -d "$BODY")"

if [ "$STATUS" = "201" ]; then
  echo "OK (HTTP 201)."
else
  echo "SendGrid answered HTTP $STATUS:"
  sed "s#$TOKEN#<secret>#g; s#$SG_KEY#<key>#g" /tmp/sg-parse.out | head -c 600; echo
  rm -f /tmp/sg-parse.out
  echo "If this host already exists, or the hostname must be authenticated first, use the dashboard steps in doc/inbound-email.md."
  exit 1
fi
rm -f /tmp/sg-parse.out
