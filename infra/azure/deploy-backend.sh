#!/usr/bin/env bash
# Deploys the committed code (git HEAD) to the backend VM: Docker image build on the VM, Caddy in front.
#   - copies source with `git archive` (only committed files, so .env and local junk can never be shipped)
#   - writes /opt/intassist/.env ON THE VM from Key Vault using the VM's managed identity
#   - docker compose up -d --build
# Re-running is the update procedure. A restart drops in-flight webhooks for a few seconds: do not deploy during interviews.
set -euo pipefail

RG="${RG:-vaiintassist}"
VM_NAME="${VM_NAME:-intassist-backend}"
KEY_VAULT="${KEY_VAULT:-vaiintassist-kv-f9ea}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/intassist_vm}"
DOMAIN="${DOMAIN:-intassistback.askproso.ai}"
ALIAS_DOMAIN="${ALIAS_DOMAIN:-invite.askproso.ai}"   # the SendGrid Inbound Parse subdomain: invites go to iv-<alias>@<this>
RECALL_REGION="${RECALL_REGION:-us-west-2}"

[[ "$DOMAIN" =~ ^[a-z0-9.-]+$ && "$ALIAS_DOMAIN" =~ ^[a-z0-9.-]+$ && "$RECALL_REGION" =~ ^[a-z]{2}-[a-z]+-[0-9]$ ]] || { echo "bad DOMAIN / ALIAS_DOMAIN / RECALL_REGION"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
cd "$REPO"
[ -z "$(git status --porcelain)" ] || echo "WARNING: uncommitted changes are NOT deployed (only git HEAD is)."

IP="$(az network public-ip show -g "$RG" -n "${VM_NAME}-ip" --query ipAddress -o tsv)"

# Caddy asks Let's Encrypt for a certificate as soon as it starts. Failed attempts are rate limited, so do not start before DNS is right.
if [ "${SKIP_DNS_CHECK:-0}" != "1" ]; then
  RESOLVED="$(dig +short @8.8.8.8 "$DOMAIN" | tail -1)"
  if [ "$RESOLVED" != "$IP" ]; then
    echo "DNS check failed: $DOMAIN resolves to '${RESOLVED:-nothing}', expected $IP."
    echo "Create the A record first (or SKIP_DNS_CHECK=1 to override)."; exit 1
  fi
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

ssh_ "DOMAIN='$DOMAIN' KV='$KEY_VAULT' ALIAS_DOMAIN='$ALIAS_DOMAIN' RECALL_REGION='$RECALL_REGION' bash -s" <<'REMOTE'
set -euo pipefail
sudo cloud-init status --wait >/dev/null 2>&1 || true

rm -rf /opt/intassist/app && mkdir -p /opt/intassist/app
tar -xzf /tmp/intassist-app.tgz -C /opt/intassist/app && rm /tmp/intassist-app.tgz

# secrets: Key Vault via the VM's managed identity
TOKEN="$(curl -s -H Metadata:true 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net' \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')"
get() { curl -sf -H "Authorization: Bearer $TOKEN" "https://$KV.vault.azure.net/secrets/$1?api-version=7.4" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["value"],end="")'; }

umask 077
{
  echo "DOMAIN=$DOMAIN"
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
sudo docker compose --env-file /opt/intassist/.env up -d --build
sudo docker image prune -f >/dev/null

# nightly database snapshot at 03:00 (idempotent: replaces any previous entry)
chmod +x /opt/intassist/app/deploy/backup-db.sh
( crontab -l 2>/dev/null | grep -v backup-db.sh || true; echo '0 3 * * * sudo /opt/intassist/app/deploy/backup-db.sh >> /opt/intassist/backup.log 2>&1' ) | crontab -
sudo docker compose --env-file /opt/intassist/.env ps
REMOTE

echo
echo "Deployed. Check: https://$DOMAIN/health"
