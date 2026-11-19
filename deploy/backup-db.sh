#!/usr/bin/env bash
# Snapshot the SQLite database (consistent, safe while running) and keep the newest 7. Installed in cron by deploy-backend.sh.
# Backups live in the same Docker volume (/data/backups): they protect against corruption and mistakes, NOT against losing the VM.
# Off-box copies (Azure Blob) are a later step.
set -euo pipefail
cd "$(dirname "$0")"
docker compose --env-file /opt/intassist/.env exec -T backend node --disable-warning=ExperimentalWarning dist/backup.js
