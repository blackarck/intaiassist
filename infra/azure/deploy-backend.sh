#!/usr/bin/env bash
# Deploys the committed code (git HEAD) to the VM: the backend (Docker image built on the VM) and the web app (built here,
# served as static files by Caddy), Caddy in front of both.
#   - copies source with `git archive` (only committed files, so .env and local junk can never be shipped)
#   - builds the web app from the committed sources with the PUBLIC settings below (no secrets go into a browser bundle)
#   - writes /opt/intassist/.env ON THE VM from Key Vault using the VM's managed identity
#   - takes a database snapshot, then docker compose up -d --build
# Re-running is the update procedure. A restart drops in-flight webhooks for a few seconds: do not deploy during interviews.
set -euo pipefail

RG="${RG:-vaiintassist}"
VM_NAME="${VM_NAME:-intassist-backend}"
KEY_VAULT="${KEY_VAULT:-vaiintassist-kv-f9ea}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/intassist_vm}"
DOMAIN="${DOMAIN:-intassistback.askproso.ai}"          # the API (backend)
WEB_DOMAIN="${WEB_DOMAIN:-intassist.askproso.ai}"        # the web app (static files)
# Public Microsoft app (client) id of the sign-in registration. Not a secret: it is visible in every browser that loads the app.
MS_CLIENT_ID="${MS_CLIENT_ID:-04573c76-f51a-4e4a-be8f-5987f3e21ae3}"
ALIAS_DOMAIN="${ALIAS_DOMAIN:-invite.askproso.ai}"   # the SendGrid Inbound Parse subdomain: invites go to iv-<alias>@<this>
RECALL_REGION="${RECALL_REGION:-us-west-2}"

[[ "$MS_CLIENT_ID" =~ ^[0-9a-f-]{36}$ && "$WEB_DOMAIN" =~ ^[a-z0-9.-]+$ ]] || { echo "bad MS_CLIENT_ID / WEB_DOMAIN"; exit 1; }
[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ && "$ALIAS_DOMAIN" =~ ^[a-z0-9.-]+$ && "$RECALL_REGION" =~ ^[a-z]{2}-[a-z]+-[0-9]$ ]] || { echo "bad DOMAIN / ALIAS_DOMAIN / RECALL_REGION"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"
[ -z "$(git status --porcelain)" ] || echo "WARNING: uncommitted changes are NOT deployed (only git HEAD is)."

IP="$(az network public-ip show -g "$RG" -n "${VM_NAME}-ip" --query ipAddress -o tsv)"

# Caddy asks Let's Encrypt for a certificate as soon as it starts. Failed attempts are rate limited, so do not start before DNS is right.
if [ "${SKIP_DNS_CHECK:-0}" != "1" ]; then
  # Ask the zone's AUTHORITATIVE server (what Let's Encrypt effectively sees), not one public resolver: a resolver can
  # serve a stale cached "no such name" for a while after the record was created.
  for NAME in "$DOMAIN" "$WEB_DOMAIN"; do
    ZONE="$(echo "$NAME" | awk -F. '{print $(NF-1)"."$NF}')"
    NS="$(dig +short NS "$ZONE" | head -1)"
    RESOLVED="$(dig +short @"${NS:-1.1.1.1}" A "$NAME" | sort | tr '\n' ' ' | sed 's/ $//')"
    if [ "$RESOLVED" != "$IP" ]; then
      echo "DNS check failed: $NAME resolves to '${RESOLVED:-nothing}' at ${NS:-1.1.1.1}, expected only $IP."
      echo "Fix the A record first (or SKIP_DNS_CHECK=1 to override)."; exit 1
    fi
  done
fi

# Your public IP changes; keep the SSH allow rule current.
MYIP="$(curl -s --max-time 10 https://api.ipify.org)"
if [ -n "$MYIP" ]; then
  az network nsg rule update -g "$RG" --nsg-name "${VM_NAME}-nsg" -n allow-ssh-me --source-address-prefixes "$MYIP" -o none
fi

SSH_OPTS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20)
ssh_() { ssh "${SSH_OPTS[@]}" "azureuser@$IP" "$@"; }

# Docker comes from Docker's official repo (idempotent: no-op when already installed)
ssh_ 'bash -s' < "$HERE/vm-install-docker.sh"

TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
git archive --format=tar.gz -o "$TMP/app.tgz" HEAD backend deploy
scp "${SSH_OPTS[@]}" "$TMP/app.tgz" "azureuser@$IP:/tmp/intassist-app.tgz"

# Web app: build from the committed sources. VITE_DEV_USER is deliberately NOT set (it would skip sign-in in the browser).
mkdir -p "$TMP/web-src" && git archive HEAD web | tar -x -C "$TMP/web-src"
( cd "$TMP/web-src/web" \
  && npm ci --no-audit --no-fund --silent \
  && VITE_API_URL="https://$DOMAIN" VITE_MS_CLIENT_ID="$MS_CLIENT_ID" VITE_MS_AUTHORITY="https://login.microsoftonline.com/common" VITE_DEV_USER= npm run build --silent )
tar -czf "$TMP/web.tgz" -C "$TMP/web-src/web/dist" .
scp "${SSH_OPTS[@]}" "$TMP/web.tgz" "azureuser@$IP:/tmp/intassist-web.tgz"

ssh_ "DOMAIN='$DOMAIN' WEB_DOMAIN='$WEB_DOMAIN' MS_CLIENT_ID='$MS_CLIENT_ID' KV='$KEY_VAULT' ALIAS_DOMAIN='$ALIAS_DOMAIN' RECALL_REGION='$RECALL_REGION' bash -s" <<'REMOTE'
set -euo pipefail
sudo cloud-init status --wait >/dev/null 2>&1 || true

# snapshot the database BEFORE the new code (and any schema upgrade) touches it; the previous deploy's script does it
if [ -x /opt/intassist/app/deploy/backup-db.sh ] && sudo docker ps --format '{{.Names}}' | grep -q backend; then
  sudo /opt/intassist/app/deploy/backup-db.sh && echo "database snapshot taken before deploy"
fi

rm -rf /opt/intassist/app && mkdir -p /opt/intassist/app
tar -xzf /tmp/intassist-app.tgz -C /opt/intassist/app && rm /tmp/intassist-app.tgz

# web app: swap the static files in one step (Caddy serves /opt/intassist/web read-only)
rm -rf /opt/intassist/web.new && mkdir -p /opt/intassist/web.new
tar -xzf /tmp/intassist-web.tgz -C /opt/intassist/web.new && rm /tmp/intassist-web.tgz
rm -rf /opt/intassist/web.old; [ -d /opt/intassist/web ] && mv /opt/intassist/web /opt/intassist/web.old
mv /opt/intassist/web.new /opt/intassist/web; rm -rf /opt/intassist/web.old

# secrets: Key Vault via the VM's managed identity
TOKEN="$(curl -s -H Metadata:true 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
get() { curl -sf -H "Authorization: Bearer $TOKEN" "https://$KV.vault.azure.net/secrets/$1?api-version=7.4" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"],end="")'; }

umask 077
{
  echo "DOMAIN=$DOMAIN"
  echo "WEB_DOMAIN=$WEB_DOMAIN"
  echo "ALLOWED_ORIGINS=https://$WEB_DOMAIN"
  echo "MS_CLIENT_ID=$MS_CLIENT_ID"
  echo "ADMIN_SUBJECTS=$(get admin-subjects)"
  echo "ANTHROPIC_API_KEY=$(get anthropic-api-key)"
  echo "AZURE_OPENAI_ENDPOINT=$(get azure-openai-endpoint)"
  echo "AZURE_OPENAI_API_KEY=$(get azure-openai-api-key)"
  echo "PUBLIC_BASE_URL=https://$DOMAIN"
  echo "ALIAS_DOMAIN=$ALIAS_DOMAIN"
  echo "RECALL_REGION=$RECALL_REGION"
  echo "RECALL_API_KEY=$(get recall-api-key)"
  echo "RECALL_WEBHOOK_SECRET=$(get recall-webhook-secret)"
  echo "INTAKE_TOKEN=$(get intake-token)"
  echo "INBOUND_TOKEN=$(get inbound-token)"
} > /opt/intassist/.env.new
mv /opt/intassist/.env.new /opt/intassist/.env
echo "env written ($(grep -c '=' /opt/intassist/.env) variables, mode $(stat -c %a /opt/intassist/.env))"

cd /opt/intassist/app/deploy
# A broken Caddyfile would take the API's HTTPS down with it, so check it (with this deploy's real values) before touching anything.
( set -a; . /opt/intassist/.env; set +a
  sudo docker run --rm -v /opt/intassist/app/deploy/Caddyfile:/etc/caddy/Caddyfile:ro -e DOMAIN -e WEB_DOMAIN caddy:2 caddy validate --config /etc/caddy/Caddyfile 2>&1 | tail -1 )
sudo docker compose --env-file /opt/intassist/.env up -d --build
sudo docker image prune -f >/dev/null

# nightly database snapshot at 03:00 (idempotent: replaces any previous entry)
chmod +x /opt/intassist/app/deploy/backup-db.sh
( crontab -l 2>/dev/null | grep -v backup-db.sh || true; echo '0 3 * * * sudo /opt/intassist/app/deploy/backup-db.sh >> /opt/intassist/backup.log 2>&1' ) | crontab -
sudo docker compose --env-file /opt/intassist/.env ps
REMOTE

echo
echo "Deployed. API: https://$DOMAIN/health   Web app: https://$WEB_DOMAIN/"
