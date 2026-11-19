#!/usr/bin/env bash
# Linux VM that runs the backend (Docker) behind Caddy. Fixed public IP; SSH key-only, allowed from one IP.
# Cost (East US list price): B1ms about $15/mo + static IP about $4/mo + disk a few dollars.
#
#   ./provision-backend-vm.sh                # defaults below
#   VM_SIZE=Standard_B2s ./provision-backend-vm.sh
set -euo pipefail

RG="${RG:-vaiintassist}"
LOCATION="${LOCATION:-eastus}"
VM_NAME="${VM_NAME:-intassist-backend}"
VM_SIZE="${VM_SIZE:-Standard_B1ms}"          # 2 GiB RAM: enough for Node + Caddy and for building the image
KEY_VAULT="${KEY_VAULT:-vaiintassist-kv-f9ea}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/intassist_vm}"
SSH_SOURCE_IP="${SSH_SOURCE_IP:-$(curl -s --max-time 10 https://api.ipify.org)}"
HERE="$(cd "$(dirname "$0")" && pwd)"

[ -n "$SSH_SOURCE_IP" ] || { echo "could not determine your public IP; set SSH_SOURCE_IP"; exit 1; }

if [ ! -f "$SSH_KEY" ]; then
  # No passphrase so scripts can deploy unattended. Anyone who can read this file can log in: keep it private.
  ssh-keygen -t ed25519 -N "" -C "intassist-backend-vm" -f "$SSH_KEY" >/dev/null
  echo "created SSH key $SSH_KEY"
fi

NSG="${VM_NAME}-nsg"
PIP="${VM_NAME}-ip"

echo "Creating $VM_SIZE Ubuntu VM '$VM_NAME' in $RG ($LOCATION); SSH allowed from $SSH_SOURCE_IP only"

az network nsg create -g "$RG" -n "$NSG" -l "$LOCATION" -o none
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-http   --priority 100 --access Allow --direction Inbound \
  --protocol Tcp --destination-port-ranges 80  --source-address-prefixes Internet -o none   # Let's Encrypt HTTP-01 + redirect
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-https  --priority 110 --access Allow --direction Inbound \
  --protocol '*' --destination-port-ranges 443 --source-address-prefixes Internet -o none   # TCP + UDP (HTTP/3)
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-ssh-me --priority 120 --access Allow --direction Inbound \
  --protocol Tcp --destination-port-ranges 22  --source-address-prefixes "$SSH_SOURCE_IP" -o none

az network public-ip create -g "$RG" -n "$PIP" -l "$LOCATION" --sku Standard --allocation-method Static -o none

az vm create -g "$RG" -n "$VM_NAME" -l "$LOCATION" \
  --image Canonical:ubuntu-24_04-lts:server:latest --size "$VM_SIZE" \
  --admin-username azureuser --authentication-type ssh --ssh-key-values "${SSH_KEY}.pub" \
  --public-ip-address "$PIP" --nsg "$NSG" \
  --storage-sku StandardSSD_LRS --os-disk-size-gb 30 \
  --custom-data "$HERE/cloud-init-backend.yaml" \
  --assign-identity '[system]' --tags project=interview-assist -o none

# The VM reads its secrets from Key Vault with its own identity (nothing secret is ever copied by hand).
PRINCIPAL="$(az vm show -g "$RG" -n "$VM_NAME" --query identity.principalId -o tsv)"
KV_ID="$(az keyvault show -g "$RG" -n "$KEY_VAULT" --query id -o tsv)"
az role assignment create --assignee-object-id "$PRINCIPAL" --assignee-principal-type ServicePrincipal \
  --role "Key Vault Secrets User" --scope "$KV_ID" -o none

IP="$(az network public-ip show -g "$RG" -n "$PIP" --query ipAddress -o tsv)"
echo
echo "VM ready."
echo "  Public IP : $IP   (static)"
echo "  SSH       : ssh -i $SSH_KEY azureuser@$IP"
echo
echo "NEXT: create the DNS record  A  intassistback  ->  $IP   (DNS only), then run ./deploy-backend.sh"
