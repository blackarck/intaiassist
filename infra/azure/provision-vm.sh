#!/usr/bin/env bash
# Windows VM for the media bot. THIS COSTS MONEY WHILE RUNNING (roughly a few USD/day for a 4-vCPU VM;
# check current pricing). Auto-shutdown is set; deallocate it when you are not testing:
#   az vm deallocate -g vaiintassist -n <vm>
#
# Required env:
#   CONFIRM_VM=yes             explicit go-ahead to create billable resources
#   VM_ADMIN_PASSWORD=...      12+ chars; never commit it
#   RDP_SOURCE_IP=a.b.c.d      your public IP, the only address allowed to RDP in
# Optional: RG, LOCATION, VM_NAME, VM_SIZE, DNS_LABEL, SHUTDOWN_UTC (HHMM, default 1700)
set -euo pipefail

: "${CONFIRM_VM:?set CONFIRM_VM=yes to create billable resources}"
[ "$CONFIRM_VM" = "yes" ] || { echo "CONFIRM_VM must be 'yes'"; exit 1; }
: "${VM_ADMIN_PASSWORD:?set VM_ADMIN_PASSWORD}"
: "${RDP_SOURCE_IP:?set RDP_SOURCE_IP to your public IP}"

RG="${RG:-vaiintassist}"
LOCATION="${LOCATION:-eastus}"
VM_NAME="${VM_NAME:-mediabot-1}"
VM_SIZE="${VM_SIZE:-Standard_D4s_v5}"   # Microsoft: at least 2 cores; 4 vCPU minimum for non-Dv2 sizes
SUB_ID="$(az account show --query id -o tsv)"
DNS_LABEL="${DNS_LABEL:-vaiint-bot-${SUB_ID:0:6}}"   # -> <label>.<region>.cloudapp.azure.com
SHUTDOWN_UTC="${SHUTDOWN_UTC:-1700}"
NSG="${VM_NAME}-nsg"

echo "Creating $VM_SIZE Windows VM '$VM_NAME' in $RG ($LOCATION), DNS ${DNS_LABEL}.${LOCATION}.cloudapp.azure.com"

az network nsg create -g "$RG" -n "$NSG" -l "$LOCATION" -o none

# Callback + media. Ports follow Microsoft's samples; NARROW AFTER the spike shows what is actually used.
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-https-callback --priority 100 \
  --access Allow --direction Inbound --protocol Tcp --destination-port-ranges 443 --source-address-prefixes Internet -o none
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-media-tcp --priority 110 \
  --access Allow --direction Inbound --protocol Tcp --destination-port-ranges 8445 --source-address-prefixes Internet -o none
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-media-udp --priority 120 \
  --access Allow --direction Inbound --protocol Udp --destination-port-ranges 3478-3481 49152-53247 --source-address-prefixes Internet -o none
# Let's Encrypt HTTP-01 for the TLS cert (remove once the cert is issued)
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-http-acme --priority 130 \
  --access Allow --direction Inbound --protocol Tcp --destination-port-ranges 80 --source-address-prefixes Internet -o none
az network nsg rule create -g "$RG" --nsg-name "$NSG" -n allow-rdp-me --priority 140 \
  --access Allow --direction Inbound --protocol Tcp --destination-port-ranges 3389 --source-address-prefixes "$RDP_SOURCE_IP" -o none

az network public-ip create -g "$RG" -n "${VM_NAME}-ip" -l "$LOCATION" --sku Standard --allocation-method Static \
  --dns-name "$DNS_LABEL" -o none

az vm create -g "$RG" -n "$VM_NAME" -l "$LOCATION" \
  --image MicrosoftWindowsServer:WindowsServer:2022-datacenter-azure-edition:latest \
  --size "$VM_SIZE" --admin-username azureuser --admin-password "$VM_ADMIN_PASSWORD" \
  --public-ip-address "${VM_NAME}-ip" --nsg "$NSG" --tags project=interview-assist -o none

az vm auto-shutdown -g "$RG" -n "$VM_NAME" --time "$SHUTDOWN_UTC" -o none

IP="$(az network public-ip show -g "$RG" -n "${VM_NAME}-ip" --query ipAddress -o tsv)"
echo
echo "VM ready."
echo "  Public IP : $IP"
echo "  FQDN      : ${DNS_LABEL}.${LOCATION}.cloudapp.azure.com"
echo "  Admin user: azureuser (password as supplied)"
echo "  Auto-shutdown daily at ${SHUTDOWN_UTC} UTC."
echo "Next: doc/spike-runbook.md, section 'On the VM'."
