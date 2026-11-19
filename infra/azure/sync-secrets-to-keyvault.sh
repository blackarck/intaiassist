#!/usr/bin/env bash
# Copies the secrets from backend/.env (git-ignored) into Key Vault. Prints names and lengths only, never values.
# Accepts either variable spelling used in this project.
set -euo pipefail

KEY_VAULT="${KEY_VAULT:-vaiintassist-kv-f9ea}"
ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/../../backend" && pwd)/.env}"
[ -f "$ENV_FILE" ] || { echo "no $ENV_FILE"; exit 1; }

python3 - "$ENV_FILE" "$KEY_VAULT" <<'EOF'
import subprocess, sys
path, vault = sys.argv[1], sys.argv[2]
env = {}
for line in open(path):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    env[k.strip().removeprefix('export ').strip()] = v.strip().strip('"').strip("'")

# secret name in Key Vault  <-  env var names, first that is set wins
mapping = {
    'recall-api-key':        ['RECALL_API_KEY', 'RECALL_AI_API_KEY'],
    'recall-webhook-secret': ['RECALL_WEBHOOK_SECRET', 'RECALL_VERI_SECRET'],
    'intake-token':          ['INTAKE_TOKEN'],
}
for secret, names in mapping.items():
    value = next((env[n] for n in names if env.get(n)), None)
    if not value:
        print(f'SKIP  {secret}: none of {names} is set'); continue
    subprocess.run(['az', 'keyvault', 'secret', 'set', '--vault-name', vault, '--name', secret,
                    '--file', '/dev/stdin', '--encoding', 'utf-8', '-o', 'none'],
                   input=value.encode(), check=True)
    print(f'OK    {secret}  ({len(value)} chars)')
EOF
