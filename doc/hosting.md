# Hosting and DNS

## Layout

One Linux VM runs everything. Docker Compose starts two containers: **Caddy** (the only thing exposed to the internet:
ports 80 and 443, automatic Let's Encrypt certificates) and the **backend** (reachable only through Caddy).

```
Recall.ai ────────► https://intassistback.askproso.ai/webhooks/recall ─┐
SendGrid ─────────► https://intassistback.askproso.ai/inbound/sendgrid/<secret> ─┤  Caddy ─► backend (Node, SQLite)
operator / portal ► https://intassistback.askproso.ai/api/...   ─┘
```

| Item | Value |
|---|---|
| Resource group / region | `vaiintassist` / `eastus`, subscription `D365-Team-Subscription` |
| VM | `intassist-backend`, Ubuntu 24.04, `Standard_B2als_v2` (2 vCPU, 4 GiB), 30 GB disk |
| Public IP | `168.62.166.49` (static) |
| Network rules | 80 and 443 open to the internet; SSH (22) only from one IP, kept current by the deploy script |
| Secrets | Key Vault `vaiintassist-kv-f9ea`; the VM reads them with its managed identity and writes `/opt/intassist/.env` (mode 600) |
| Data | SQLite on the Docker volume `backend_data` (see [data.md](data.md)); certificates on `caddy_data` |

Approximate cost (East US list prices, 24/7): VM about $27, static IP about $4, disk a few dollars, so **about $34 a month**.
Resize later with `az vm resize` (a short restart).

## DNS names

All records live at the registrar's DNS for `askproso.ai` (name servers `dns1/dns2.registrar-servers.com`).
**Enter only the host part** (`intassistback`, not `intassistback.askproso.ai`); typing the full name creates
`intassistback.askproso.ai.askproso.ai`, which is harmless but junk.

| Host | Type | Value | Purpose | Status |
|---|---|---|---|---|
| `intassistback` | A | `168.62.166.49` | Backend: Recall webhooks, SendGrid inbound webhook, API, health check | **Done and live** (Let's Encrypt certificate issued by Caddy, valid to 2027-02-17, renewed automatically) |
| `intassist` | A | `168.62.166.49` | Frontend (portal). Nothing serves it yet; see below | Placeholder. **Delete the old record that points to `20.102.63.2`** |
| `invite` | MX, priority 10 | `mx.sendgrid.net` | Receives invite e-mail (SendGrid Inbound Parse). A dedicated subdomain, so the root domain's mail is untouched | To do ([inbound-email.md](inbound-email.md)) |
| (3 records) | CNAME | values shown by SendGrid | SendGrid domain authentication (needed to send e-mail, and per SendGrid's API docs the Inbound Parse hostname must be an authenticated domain) | To do |

**No other names are needed.** In particular no `api` and no `worker`: the backend is a single service (webhooks and API are
paths on the same host, and background work runs inside it). A staging environment later would get its own pair of names.
**Do not touch the root `askproso.ai` MX or SPF records**; they belong to the registrar's e-mail forwarding.

**About the frontend name.** Caddy currently serves only the backend's host. If the portal is built as static files, it
can be served from this same VM (add a site block to `deploy/Caddyfile`). If it goes to Azure Static Web Apps instead, the
name needs a CNAME to the `*.azurestaticapps.net` address and the A record is removed. A browser-based portal also needs
real user login and CORS on the backend: the shared `INTAKE_TOKEN` must never be placed in browser code.

## Deploying

From the repo root, with everything committed (only git HEAD is deployed):

```bash
infra/azure/deploy-backend.sh        # checks DNS, installs Docker if needed, ships the code, builds, restarts
```

It refuses to run until `intassistback.askproso.ai` resolves to the VM, because Caddy requests a certificate on start and
failed attempts are rate-limited. **A restart drops in-flight webhooks for a few seconds: do not deploy during interviews.**

Update secrets: change the value in Key Vault, then run the deploy script again (it re-reads them).

One-time VM creation: `infra/azure/provision-backend-vm.sh` (already done). Secrets from `backend/.env` into Key Vault:
`infra/azure/sync-secrets-to-keyvault.sh`.

## Operating it

```bash
ssh -i ~/.ssh/intassist_vm azureuser@168.62.166.49
cd /opt/intassist/app/deploy
sudo docker compose --env-file /opt/intassist/.env ps
sudo docker compose --env-file /opt/intassist/.env logs --tail 100 backend
sudo docker compose --env-file /opt/intassist/.env restart backend
```

If your IP changed and SSH times out, the next `deploy-backend.sh` run fixes the rule, or run:
`az network nsg rule update -g vaiintassist --nsg-name intassist-backend-nsg -n allow-ssh-me --source-address-prefixes <your-ip>`.

## Known limits

- One VM, one backend instance (SQLite allows exactly one). No failover; an outage longer than about a minute during an
  interview loses that interview's live transcript (Recall stops retrying after 60 attempts).
- Backups stay on the same disk ([data.md](data.md)).
- Ubuntu's own `docker.io` package could not be installed on first boot (Azure's mirror served the `universe` section with
  every package ignored), so Docker comes from Docker's official repository via `infra/azure/vm-install-docker.sh`.
