#!/usr/bin/env bash
# Cheap, safe resources for the spike: resource group, Speech (pay-per-use), Key Vault.
# No VM here; see provision-vm.sh (costs money while running).
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

# Azure AI Speech (S0 = pay as you go, no standing cost)
SPEECH="${PREFIX}-speech"
if ! az cognitiveservices account show -g "$RG" -n "$SPEECH" -o none 2>/dev/null; then
  az cognitiveservices account create -g "$RG" -n "$SPEECH" --kind SpeechServices --sku S0 -l "$LOCATION" --yes -o none
fi
echo "OK speech: $SPEECH"

# Key Vault (RBAC mode). Name must be globally unique, 3-24 chars.
KV="${PREFIX}-kv-${SUB_ID:0:4}"
if ! az keyvault show -g "$RG" -n "$KV" -o none 2>/dev/null; then
  az keyvault create -g "$RG" -n "$KV" -l "$LOCATION" --enable-rbac-authorization true -o none
fi
echo "OK key vault: $KV"

echo
echo "Next:"
echo "  Speech key (do not paste it into chat or commit it):"
echo "    az cognitiveservices account keys list -g $RG -n $SPEECH --query key1 -o tsv"
echo "  Speech region for config: $LOCATION"
echo "  Then follow doc/spike-runbook.md (Entra app, Azure Bot, VM)."
