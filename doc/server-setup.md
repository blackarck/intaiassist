# Server Setup: Media Bot VM

How the Windows VM that runs the Teams media bot is built, secured, accessed, updated and torn down.
Scripts referenced here live in [`infra/azure/`](../infra/azure/). The spike plan is in
[spike-runbook.md](spike-runbook.md).

> **Status (2026-11-18):** the bot runs on the VM, answers HTTPS on `https://intassist.askproso.ai` with a valid Let's Encrypt certificate, and the media platform initializes (spike Q0 passed). Nothing has joined a real Teams meeting yet. See [spike-runbook.md](spike-runbook.md) for the remaining questions.

## 1. What runs where

```
Teams / Microsoft Graph ──HTTPS 443──► MediaBot.exe (Kestrel)  ── /callback      call-state webhooks (JWT-validated by the SDK)
                                                               ── /api/join,/leave  called by our backend (Bearer API key)
Teams media relay ──TCP 8445 / UDP media──► Real-Time Media Platform (inside MediaBot.exe)
MediaBot.exe ──► Azure Speech (per-speaker STT) ──► transcript segments ──► backend  POST /api/bot/events
```

| Component | Value |
|---|---|
| Subscription / region | `D365-Team-Subscription` / `eastus` |
| Resource group | `vaiintassist` |
| VM | `mediabot-1`, Windows Server 2022 Datacenter Azure Edition, `Standard_D4s_v5` (4 vCPU) |
| Public IP | `20.102.63.2` (static, Standard SKU) |
| DNS name | `intassist.askproso.ai` (A record, DNS only, at the registrar's DNS) -> `20.102.63.2`. The Azure-provided name `vaiint-bot-f9eaa4.eastus.cloudapp.azure.com` still resolves to the same IP but its certificate was replaced, so use the custom name |
| Network security group | `mediabot-1-nsg` |
| Auto-shutdown | 17:00 UTC daily (`shutdown-computevm-mediabot-1`) |
| VM identity | system-assigned managed identity, role *Key Vault Secrets User* on the vault |
| Key Vault | `vaiintassist-kv-f9ea` |
| Speech | `vaiintassist-speech` |
| Storage (deploy packages) | `vaiintassistf9eaa44c`, container `deploy`, private |
| Entra app | "Interview Assistant Bot", client id `afe0dc7c-dd99-4237-91f4-7b76ea08ebae`, multi-tenant |
| Azure Bot | `vaiintassist-bot` (SingleTenant, F0), Teams channel with calling, webhook `https://<fqdn>/callback` |

### Key Vault secrets

| Secret | Used for |
|---|---|
| `graphbot-app-id` | Entra app client id (not secret, kept for convenience) |
| `graphbot-app-secret` | Entra app client secret (expires 1 year after 2026-11-18) |
| `speech-key` | Azure Speech key |
| `mediabot-api-key` | Bearer key the backend uses to call `/api/join` and `/api/leave` |
| `mediabot-admin-password` | Windows `azureuser` password |

Secrets are never put in scripts, chat or git. The VM reads them at deploy time through its managed identity and
stores them as **machine environment variables**.

## 2. Network

Two layers, both must allow the traffic:

**Azure NSG `mediabot-1-nsg`**

| Rule | Port | Source | Purpose |
|---|---|---|---|
| allow-https-callback | TCP 443 | Internet | Graph call webhooks, backend API |
| allow-media-tcp | TCP 8445 | Internet | Media platform |
| allow-media-udp | UDP 3478-3481, 49152-65279 | Internet | Media. 49152-65279 is the media platform's **default** port range (`MediaPortRange`, per Microsoft's API docs); 3478-3481 comes from Microsoft samples and is unverified. Narrow by setting `MediaPortRange` in code and matching these rules, once the spike shows what is used. |
| allow-http-acme | TCP 80 | Internet | Let's Encrypt HTTP-01 validation and renewal. Not needed if you switch to DNS-01 |
| allow-rdp-me | TCP 3389 | one IP only | Remote Desktop |

**Windows Firewall** has matching inbound rules `mediabot-tcp` (80, 443, 8445) and `mediabot-udp`.

Microsoft requires each media-bot VM to be directly reachable on the internet through its own public IP. It cannot
sit behind an App Service or a plain proxy. A call is pinned to the VM that accepted it; stopping the VM drops calls.

## 3. TLS certificate

Teams requires a publicly trusted certificate for the bot's FQDN. The media platform loads it **from the Windows
certificate store by thumbprint**, not from a file.

- Issued by Let's Encrypt with [Posh-ACME](https://poshac.me) (`infra/azure/vm-setup-cert.ps1`), HTTP-01 on port 80,
  installed into `LocalMachine\My`. No contact e-mail was registered with Let's Encrypt.
- Current certificate: thumbprint `9F202024E33BE4EA51A7B5B32BCE67F565C86984`, **expires 2027-02-16**.
- Kestrel (port 443) picks the same certificate from the store by subject (see `appsettings.Production.json`).

### Renewal (not automated yet; do this before it matters)

A renewed certificate has a **new thumbprint**, and the media platform is configured by thumbprint. Renewal therefore
needs three steps, ideally in one scheduled script (run ~30 days before expiry):

1. `Submit-Renewal -AllOrders` (Posh-ACME) to get the new certificate into `LocalMachine\My`.
2. Write the new thumbprint into `C:\mediabot\appsettings.Production.json` (`GraphBot.CertificateThumbprint`).
3. Restart the bot task (`Stop-ScheduledTask`/`Start-ScheduledTask MediaBot`), **only when no interview is running**.

## 4. How you log in to the server

The VM is administered with **Remote Desktop (RDP)**. There is no SSL certificate you must manage to log in.

| | |
|---|---|
| Address | `intassist.askproso.ai` (or `20.102.63.2`), port 3389 |
| User | `azureuser` |
| Password | Key Vault secret `mediabot-admin-password` |
| Who can connect | only the IP in NSG rule `allow-rdp-me` |

Get the password without printing it into shared logs (copy it straight to the clipboard on macOS):

```bash
az keyvault secret show --vault-name vaiintassist-kv-f9ea --name mediabot-admin-password --query value -o tsv | pbcopy
```

Use Microsoft's *Windows App* (macOS) or any RDP client, host = the DNS name above.

**If your IP changes** (home/office/mobile) you will be locked out. Update the rule:

```bash
az network nsg rule update -g vaiintassist --nsg-name mediabot-1-nsg -n allow-rdp-me --source-address-prefixes <your.new.ip>
```

**About the certificate warning:** RDP encrypts with TLS using a self-signed certificate Windows generates, so your
client shows a warning the first time. That is normal. Check the thumbprint once and accept it. Optionally you can
make RDP use the Let's Encrypt certificate so the warning disappears (connect by the DNS name, which must match
the certificate); this is untested here:

```powershell
$thumb = '<certificate thumbprint>'
$ts = Get-WmiObject -Namespace root\cimv2\TerminalServices -Class Win32_TSGeneralSetting -Filter "TerminalName='RDP-tcp'"
Set-WmiInstance -Path $ts.__path -Argument @{ SSLCertificateSHA1Hash = $thumb }
# the RDP service account (NETWORK SERVICE) also needs read access to the certificate's private key
```

**Safer access options, in order of effort** (pick when this stops being a spike):
1. *Keep as is*: single-IP allow-list + long random password. Acceptable for the spike.
2. *Just-in-time access* (Microsoft Defender for Cloud): port 3389 closed by default, opened for you on request for a
   few hours.
3. *Microsoft Entra login for Windows VMs* (extension `AADLoginForWindows`): sign in with your work account (MFA)
   instead of a local password.
4. *Azure Bastion*: no public RDP at all, but a standing monthly cost.

You can also run commands without RDP at all:

```bash
az vm run-command invoke -g vaiintassist -n mediabot-1 --command-id RunPowerShellScript \
   --scripts "Get-Content C:\mediabot\logs\bot.log -Tail 50"
```

## 5. What is installed on the VM

| Path / item | Purpose |
|---|---|
| `C:\mediabot\` | the published bot (self-contained, no separate .NET install needed) |
| `C:\mediabot\appsettings.Production.json` | non-secret config: Graph, cert thumbprint, `BotHttp:Port`, speech region |
| `C:\mediabot\logs\bot.log` | stdout/stderr of the bot |
| Machine environment variables | `GraphBot__AppSecret`, `Speech__Key`, `Bot__ApiKey`, `ASPNETCORE_ENVIRONMENT` |
| Scheduled task `MediaBot` | runs `MediaBot.exe` as SYSTEM at startup, restarts up to 3 times |
| Certificate in `LocalMachine\My` | the Let's Encrypt cert |
| PowerShell modules | NuGet provider, Posh-ACME (all users) |
| Windows prerequisites | Media Foundation feature (`Server-Media-Foundation`), Visual C++ 2015-2022 x64 runtime. Installed by `infra/azure/vm-prereqs.ps1` |

`Backend:Url` is currently `http://localhost:3000` because the backend is not hosted anywhere yet. The bot logs
failed event posts but keeps running.

## 6. Day-to-day operations

**Cost control.** The VM bills while it is allocated. Stop it when idle:

```bash
az vm deallocate -g vaiintassist -n mediabot-1      # stop billing for compute
az vm start      -g vaiintassist -n mediabot-1      # the bot starts by itself (task: At startup)
```

The public IP is static and keeps its address. The disk and IP still cost a small amount while deallocated.

**Logs and status**

```bash
az vm run-command invoke -g vaiintassist -n mediabot-1 --command-id RunPowerShellScript --scripts \
  "Get-ScheduledTask MediaBot | Get-ScheduledTaskInfo; Get-Process MediaBot -ErrorAction SilentlyContinue; Get-Content C:\mediabot\logs\bot.log -Tail 60"
```

**Deploy a new version** (from the repo root on your Mac):

```bash
cd media-bot && dotnet publish -c Release -r win-x64 --self-contained -o publish
cd publish && zip -qr ../mediabot.zip . && cd ..
SA=vaiintassistf9eaa44c
KEY=$(az storage account keys list -g vaiintassist -n $SA --query '[0].value' -o tsv)
az storage blob upload --account-name $SA --account-key "$KEY" -c deploy -n mediabot.zip -f mediabot.zip --overwrite
SAS=$(az storage blob generate-sas --account-name $SA --account-key "$KEY" -c deploy -n mediabot.zip \
      --permissions r --expiry $(date -u -v+3H '+%Y-%m-%dT%H:%MZ') --https-only -o tsv)
az vm run-command invoke -g vaiintassist -n mediabot-1 --command-id RunPowerShellScript \
  --scripts @../infra/azure/vm-deploy-bot.ps1 \
  --parameters "ZipUrl=https://$SA.blob.core.windows.net/deploy/mediabot.zip?$SAS" "Thumbprint=<current thumbprint>"
```

The deploy script stops the running bot, unpacks the new version, rewrites the config, reloads secrets from Key Vault and
restarts the task. **Do not deploy during a live interview**: it ends the call.

**Keep the Microsoft media library current.** Microsoft requires the newest `Microsoft.Graph.Communications.Calls.Media`
package or one under about three months old; older versions stop working. Current: `1.2.0.18742`.

**Rotate the Entra client secret** (before it expires): create a new secret on the app, update Key Vault
`graphbot-app-secret`, re-run the deploy script (it re-reads secrets).

## 7. Security notes

- Secrets live in Key Vault, are read by the VM identity, and are never in git, scripts or run-command text.
- `/callback` is authenticated by the Graph SDK's JWT validation (our `GraphAuthProvider`). **Microsoft marked the
  `SetAuthenticationProvider` method obsolete** in the current SDK and replaced it with `SetAuthentication` plus
  trusted-issuer/caller options. Review and migrate before production.
- `/api/*` requires the Bearer key `mediabot-api-key`. Put the backend and the VM on a private path (VNet peering or
  IP allow-list on 443) before real customer data flows.
- The storage SAS links used for deployment are read-only and expire in 3 hours. The storage account blocks public blob access.
- The VM uses password login for RDP from a single IP. See [section 4](#4-how-you-log-in-to-the-server) for stronger options.
- Interview audio is processed in memory and sent to Azure Speech. The bot does not write audio to disk.

## 8. Verification checklist

Run top to bottom. Each line has an expected result.

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | VM running | `az vm show -d -g vaiintassist -n mediabot-1 --query powerState -o tsv` | `VM running` |
| 2 | DNS resolves | `dig +short intassist.askproso.ai` | `20.102.63.2` |
| 3 | Bot process up | run-command `Get-Process MediaBot` | one process |
| 4 | HTTPS answers | `curl https://intassist.askproso.ai/health` | `{"ok":true,"mode":"graph"}` and a valid certificate |
| 5 | Media platform started | `bot.log` has no exception from `CommunicationsClientBuilder.Build()` | no stack trace |
| 6 | Callback is protected | `curl -X POST https://<fqdn>/callback -d '{}'` | rejected (401/403), not 200 |
| 7 | API is protected | `curl -X POST https://<fqdn>/api/join` | 401 |

## 8b. Troubleshooting (things that actually went wrong)

| Symptom | Cause | Fix |
|---|---|---|
| `Media platform failed to initialize ... Unable to load DLL 'NativeMedia'` | `Microsoft.Skype.Bots.Media` was only a *transitive* package reference. NuGet imports a package's `build/` targets only for **direct** references, so the native binaries (`NativeMedia.dll`, `RtmPal.dll`, `skypert.dll`, ...) were not copied into the publish output | Reference `Microsoft.Skype.Bots.Media` directly in `MediaBot.csproj` (done) and check `NativeMedia.dll` exists in `publish/` before zipping |
| `az vm run-command` hangs / `Conflict: Run command extension execution is in progress`; VM provisioning state stuck on `Updating` | A hung remote script keeps Azure's run-command lock; rebooting does not clear it. The hang was `Invoke-WebRequest` progress rendering on a 60+ MB download | Scripts now set `$ProgressPreference='SilentlyContinue'` and use `curl.exe` + `tar.exe`. To clear a stuck lock: `az vm deallocate`, then `az vm start` (it can take a long time to complete). `az vm reapply` did not help |
| RDP "credentials did not work" | Copying the password with `-o tsv` adds a trailing newline | `... --query value -o tsv \| tr -d '\r\n' \| pbcopy` |
| Still `Unable to load DLL 'NativeMedia' or one of its dependencies (0x8007007E)` after the native files are present | The VM lacked what the native binaries import: the Visual C++ 2015-2022 x64 runtime and the **Media Foundation** Windows Server feature (`wmvcore.dll`, `MFPlat.dll`) | Run `infra/azure/vm-prereqs.ps1` once on the VM (installs both, reboots if needed) |
| Bot crashes at start with `Failed to bind to address https://[::]:<port>: address already in use` on **any** port, although Windows can bind the port | Microsoft's media platform embeds its own ASP.NET Core host (Kestrel via `CreateDefaultBuilder`) that reads the **same** `appsettings*.json` and environment variables. A standard `Kestrel:Endpoints` setting (or `ASPNETCORE_URLS`) made the media platform grab our port first | Our web port is configured in code from a private `BotHttp:Port` setting (`Program.cs`), and the deploy script no longer writes a `Kestrel` section. Never put Kestrel endpoints or `ASPNETCORE_URLS` in config/env for this app in graph mode |
| Records in DNS not visible locally right after creating them | Local resolver cached the earlier miss | Test against `@8.8.8.8` / `@1.1.1.1` or the zone's own name servers |

## 9. Custom domain and Caddy

**Custom domain: yes.** Create an `A` record (or a `CNAME` to the Azure DNS name) pointing at `20.102.63.2`, for
example `bot1.<yourdomain>`. A name per instance (`bot1`, `bot2`, ...) is also Microsoft's pattern for scaling media bots.
Changing the name means updating, in this order: DNS, a new certificate for the new name, the VM config
(`ServiceFqdn`, `NotificationUrl`, `CertificateThumbprint`), the Azure Bot messaging endpoint and calling webhook
(`az bot update` and `az bot msteams create`/update), and the Teams app manifest `validDomains`.

**Caddy: possible, but it does not remove the hard part.** Caddy would terminate TLS on port 443 and reverse-proxy
to the bot on `localhost`. That covers only the **HTTPS callback/API**. The **media platform on TCP 8445 does its own
TLS and needs the certificate in the Windows certificate store, found by thumbprint.** Caddy keeps its certificates in
its own storage, so you would still need a second process that exports Caddy's renewed certificate into the Windows store
and updates the thumbprint. That is more moving parts than Posh-ACME, which already installs into the store.

| Option | Verdict |
|---|---|
| **Posh-ACME + scheduled renewal script** (current) | Fewer parts; the only cert consumer on the box is the bot. **Recommended for now.** Finish the renewal automation in [section 3](#renewal-not-automated-yet-do-this-before-it-matters) |
| **Posh-ACME with DNS-01 on Azure DNS** | If your domain is hosted in Azure DNS: no inbound port 80, supports wildcard certificates, works for many instances. **Best next step with a custom domain** |
| **Caddy in front + export hook** | Worth it only if you want Caddy for other reasons (routing several services, automatic HTTP to HTTPS). Does not replace the Windows-store certificate |
