#!/usr/bin/env bash
# Base resources: resource group + Key Vault (secrets). Hosting is created separately (see doc/hosting.md).
#
# Usage:  LOCATION=eastus ./provision.sh
set -euo pipefail

RG="${RG:-vaiintassist}"
LOCATION="${LOCATION:-eastus}"
PREFIX="${PREFIX:-vaiintassist}"

SUB_NAME="$(az account show --query name -o tsv)"
SUB_ID="$(az account show --query id -o tsv)"
echo "Subscription : $SUB_NAME ($SUB_ID)"
echo "Resource group: $RG in $LOCATION"
echo

az group create -n "$RG" -l "$LOCATION" --tags project=interview-assist -o none
echo "OK resource group"

# Key Vault (RBAC mode). Name must be globally unique, 3-24 chars.
KV="${PREFIX}-kv-${SUB_ID:0:4}"
if ! az keyvault show -g "$RG" -n "$KV" -o none 2>/dev/null; then
  az keyvault create -g "$RG" -n "$KV" -l "$LOCATION" --enable-rbac-authorization true -o none
fi
echo "OK key vault: $KV"

echo
echo "Next: store the Recall secrets in the vault (recall-api-key, recall-webhook-secret), then deploy the backend."