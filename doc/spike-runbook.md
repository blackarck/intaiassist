# Spike Runbook: Real Teams Bot (Option A)

Goal: prove the four things that decide whether we build on our own bot or fall back to a vendor
(see [bot-join-research.md](bot-join-research.md)). Code: [media-bot/](../media-bot/).

**Status of the code:** `GraphMeetingBot` compiles against Microsoft's current packages
(`Microsoft.Graph.Communications.Calls.Media` 1.2.0.18742 → `Microsoft.Skype.Bots.Media` 1.33 preview), but it has
**never run**: the media platform is Windows-only. Expect the first VM run to need small fixes. Everything on the
Mac side (backend, stub bot, URL parsing) is tested.

## Provisioned so far (2026-11-18)

Subscription `D365-Team-Subscription`, resource group `vaiintassist`, region `eastus`, home tenant `4d9af957-3066-404a-9b31-436e259d6742`.

| Item | Value |
|---|---|
| Speech | `vaiintassist-speech` |
| Key Vault | `vaiintassist-kv-f9ea` (secrets: `graphbot-app-id`, `graphbot-app-secret`; you and I hold Secrets Officer) |
| Entra app | "Interview Assist Bot", client id `afe0dc7c-dd99-4237-91f4-7b76ea08ebae`, multi-tenant, secret expires in 1 year |
| Graph permissions (admin-consented in home tenant) | `Calls.JoinGroupCall.All`, `Calls.AccessMedia.All` |
| Azure Bot | `vaiintassist-bot`, SingleTenant, F0, Teams channel with calling on |
| Webhooks (point at the future VM) | `https://intassist.askproso.ai/api/messages` and `/callback` |

| VM | `mediabot-1`, Windows Server 2022, `Standard_D4s_v5`, public IP `20.102.63.2`, FQDN `intassist.askproso.ai`, auto-shutdown 17:00 UTC |
| VM login | user `azureuser`; password in Key Vault secret `mediabot-admin-password`. RDP (3389) is open only to the IP the VM was created from; ports 443, 80 (cert only), 8445 and the UDP media ranges are open to the internet |

Full server documentation (network, certificate, login, operations, security): **[server-setup.md](server-setup.md)**.
Sections 1 and 2 below are done; section 3 is automated by `infra/azure/vm-setup-cert.ps1` and `vm-deploy-bot.ps1`.
**Costs money while running.** Stop billing with `az vm deallocate -g vaiintassist -n mediabot-1` (the public IP and disks still cost a little).
Heads-up: Azure warns the `2022-datacenter-azure-edition` image is blocked for new deployments after 1 Feb 2027; use a newer Windows Server image when rebuilding.

## 0. Things to know before starting

- **The media library expires.** Microsoft: use the newest `Calls.Media` package or one not older than ~3 months;
  older versions "don't work after a few months". Put a recurring task on updating it.
- **Not an App Service.** Must run on an Azure VM, VMSS, AKS or Cloud Service, with an instance-level public IP, at
  least 2 cores (4 vCPU recommended for non-Dv2 sizes). A call is pinned to the VM that accepted it; stopping the VM
  kills calls.
- **New multi-tenant Azure Bot resources can't be created** (deprecated after 31 Jul 2025). Create the Azure Bot as
  *SingleTenant* and keep the **Entra app registration multi-tenant**. Whether that works for joining meetings in
  other tenants is **spike question Q3** below. If it doesn't, one Azure Bot + app registration per customer tenant,
  or a Microsoft exception, is the fallback.
- Short links (`teams.microsoft.com/meet/<id>?p=...`) don't contain the organizer's tenant. The backend must pass
  `tenantId` (the interviewer's Entra tenant). Long `meetup-join` links carry it.

## 1. Azure resources (script)

You must be signed in first (the CLI session currently needs fresh MFA):

```bash
az logout
az login --tenant 4d9af957-3066-404a-9b31-436e259d6742 --scope https://management.core.windows.net//.default
```

```bash
cd infra/azure
LOCATION=eastus ./provision.sh        # resource group vaiintassist, Speech (S0 pay-per-use), Key Vault. No VM.
```

VM (billable; auto-shutdown at 17:00 UTC; deallocate when idle):

```bash
CONFIRM_VM=yes VM_ADMIN_PASSWORD='<12+ chars>' RDP_SOURCE_IP=<your.public.ip> ./provision-vm.sh
```

## 2. Entra app + Azure Bot

```bash
HOME_TENANT=4d9af957-3066-404a-9b31-436e259d6742
APP=$(az ad app create --display-name "Interview Assistant Bot" \
        --sign-in-audience AzureADMultipleOrgs --query appId -o tsv)
az ad sp create --id "$APP"

# secret: capture into a variable / Key Vault, never echo or commit
SECRET=$(az ad app credential reset --id "$APP" --display-name spike --years 1 --query password -o tsv)

# Graph application permissions the bot needs (role ids looked up, not hardcoded)
GRAPH=00000003-0000-0000-c000-000000000000
for P in Calls.JoinGroupCall.All Calls.AccessMedia.All; do
  ID=$(az ad sp show --id $GRAPH --query "appRoles[?value=='$P'].id | [0]" -o tsv)
  az ad app permission add --id "$APP" --api $GRAPH --api-permissions "$ID=Role"
done
az ad app permission admin-consent --id "$APP"      # a Global Admin of YOUR tenant

# Azure Bot (single tenant), Teams channel with calling enabled
FQDN=<from provision-vm.sh output>
az bot create -g vaiintassist -n vaiintassist-bot --app-type SingleTenant --appid "$APP" \
   --tenant-id "$HOME_TENANT" --endpoint "https://$FQDN/api/messages" --sku F0
az bot msteams create -g vaiintassist -n vaiintassist-bot --enable-calling true \
   --calling-web-hook "https://$FQDN/callback"
```

Customer ("other tenant") consent for the test tenant:
`https://login.microsoftonline.com/<TEST_TENANT_ID>/adminconsent?client_id=<APP>`
For the RSC variant, install the Teams app in the meeting instead (see `teams-app/`, Q2 below).

## 3. On the VM

1. RDP in. Install the **.NET 8 ASP.NET Core Runtime** (or publish self-contained).
2. TLS certificate for the FQDN into **LocalMachine\My** (win-acme / Let's Encrypt works for `*.cloudapp.azure.com`;
   needs port 80 open once). Note the **thumbprint**.
3. Publish from your Mac and copy over:
   ```bash
   cd media-bot && dotnet publish -c Release -r win-x64 --self-contained -o publish
   ```
4. Copy `appsettings.Graph.example.json` → `appsettings.Production.json`, fill in values. Secrets as machine env vars:
   `GraphBot__AppSecret`, `Speech__Key`, `Bot__ApiKey`, `Backend__Token`.
5. Run `MediaBot.exe`. Success = it starts without an exception from `CommunicationsClientBuilder.Build()`
   (that's the media platform initializing the cert/FQDN/port). `GET https://<fqdn>/health` returns `mode: graph`.
6. Backend (anywhere reachable): `MEDIA_BOT_URL=https://<fqdn> MEDIA_BOT_API_KEY=<same Bot__ApiKey>`.

## 4. The spike questions

Run each, then fill in the **Result** column and commit this file.

| # | Question | How to test | Pass looks like | Result |
|---|---|---|---|---|
| Q0 | Media platform starts on the VM | Run `MediaBot.exe` | No exception; `/health` ok | **PASSED 2026-11-18.** Needed: direct `Microsoft.Skype.Bots.Media` reference (native files), VC++ runtime + Media Foundation, and our web port configured in code (`BotHttp:Port`), not via `Kestrel` config. `/health` returns `{"ok":true,"mode":"graph"}` over a trusted certificate. See server-setup.md troubleshooting |
| Q1 | Does Graph accept `updateRecordingStatus` for a bot that **joined by link**? | Join a meeting in your own tenant; watch backend `recording_status` event | `ok:true`, then transcript segments flow | **FAILED 2026-11-18 (by design, not a bug).** The bot joined a same-tenant meeting by a short `/meet/` link in seconds, no lobby. `UpdateRecordingStatusAsync` threw, so the bot correctly stayed silent: no transcript, no Teams recording banner. Microsoft's API reference: updateRecordingStatus "requires the use of the Teams policy-based recording solution"; community reports the error as 8506 "API call not allowed for non-Compliance Recording call". **A link-joined media bot cannot compliantly transcribe.** |
| Q2 | Does the **per-meeting (RSC)** route work, or is tenant-wide admin consent required? | Install the Teams app (with RSC) in the meeting; do **not** grant `*.All` consent in the test tenant | Join succeeds | |
| Q3 | Join a meeting in **another tenant** with a single-tenant Azure Bot + multi-tenant Entra app | Use the test "customer" tenant, short link with `tenantId` | Join succeeds, audio arrives | |
| Q4 | What does the lobby look like to us? | Join as `app`, then as `guest` (`GraphBot:JoinAs`); watch call states + `ResultInfo` | Know which state means "waiting", and the code on denial/timeout | |
| Q5 | Bot-detection lobby | Customer tenant default policy (`RequireApprovalWhenDetected`) | Held in lobby until admitted; message the interviewer | |
| Q6 | Speaker attribution | Two humans talk; compare `speakerName`/`role` in segments | Correct names, roles interviewer/candidate | |
| Q7 | Transcript quality/latency | Read the backend `[segment]` log | Final segments within ~1-2 s of speech end | |

**Q1 failed.** Options are compared in bot-join-research.md, section "After Q1".

## 5. Known gaps in this code

- Lobby: we emit `lobby_waiting` if the call isn't `Established` right after joining; real Teams call states while in
  the lobby need to be observed (Q4).
- Role tagging assumes a two-person interview when `interviewerAadId` is given (everyone else = candidate).
- Per-speaker recognizers are created lazily and never recycled mid-call; fine for interviews, not for 50-person calls.
- No retry/buffering when the backend is unreachable (events are dropped and logged).
- `/callback` auth is the SDK's JWT validation (`GraphAuthProvider`), ported from Microsoft's sample. Review before production.
