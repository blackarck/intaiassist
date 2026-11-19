#!/usr/bin/env bash
# Runs ON the Ubuntu VM. Installs Docker Engine + Compose from Docker's official apt repository, and prepares /opt/intassist.
# Idempotent: does nothing if Docker and the compose plugin are already there.
#
# Why not Ubuntu's own docker.io package: on first boot Azure's Ubuntu mirror served the `universe` section with
# every package "Ign"-ored, so docker.io / docker-compose-v2 could never be downloaded and cloud-init hung for 20+ minutes.
set -euo pipefail

if command -v docker >/dev/null && docker compose version >/dev/null 2>&1; then
  echo "docker already installed: $(docker --version)"
else
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get update -o Acquire::Retries=3
  sudo apt-get install -y -o Acquire::Retries=3 ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL --retry 3 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -o Acquire::Retries=3
  sudo apt-get install -y -o Acquire::Retries=3 docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi

sudo systemctl enable --now docker
sudo usermod -aG docker "$USER"
sudo mkdir -p /opt/intassist
sudo chown "$USER":"$USER" /opt/intassist
echo "ready: $(docker --version) | $(docker compose version)"
