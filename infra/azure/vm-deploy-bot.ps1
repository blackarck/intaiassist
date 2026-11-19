# Runs ON the VM (via az vm run-command). Deploys the published MediaBot, pulls secrets from Key Vault using the
# VM's managed identity (no secret ever passes through run-command), and runs it as a SYSTEM scheduled task.
param(
  [Parameter(Mandatory)][string]$ZipUrl,
  [Parameter(Mandatory)][string]$Thumbprint,
  [string]$Fqdn = 'vaiint-bot-f9eaa4.eastus.cloudapp.azure.com',
  [string]$PublicIp = '20.102.63.2',
  [string]$AppId = 'afe0dc7c-dd99-4237-91f4-7b76ea08ebae',
  [string]$KeyVault = 'vaiintassist-kv-f9ea',
  [string]$SpeechRegion = 'eastus'
)
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 renders a progress bar for downloads/unzips that makes large files take extremely long
# (and can hang non-interactive run-commands). Silence it.
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$dir = 'C:\mediabot'

function Get-KvSecret([string]$name) {
  $tok = (Invoke-RestMethod -Headers @{ Metadata = 'true' } -Uri 'http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net').access_token
  (Invoke-RestMethod -Headers @{ Authorization = "Bearer $tok" } -Uri "https://$KeyVault.vault.azure.net/secrets/$name`?api-version=7.4").value
}

# stop any previous run
Stop-ScheduledTask -TaskName MediaBot -ErrorAction SilentlyContinue
Get-Process MediaBot -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2

# download + unpack
New-Item -ItemType Directory -Force -Path $dir, "$dir\logs" | Out-Null
$zip = "$env:TEMP\mediabot.zip"
& curl.exe -sS -L --fail --retry 3 -o $zip $ZipUrl          # curl.exe ships with Windows Server 2022
if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE); is the SAS link expired?" }
Write-Output ("downloaded {0:N1} MB" -f ((Get-Item $zip).Length / 1MB))
& tar.exe -xf $zip -C $dir                                    # bsdtar unzips far faster than Expand-Archive
if ($LASTEXITCODE -ne 0) { throw "unzip failed (tar exit $LASTEXITCODE)" }
Remove-Item $zip
Write-Output ("unpacked: " + (Get-ChildItem $dir -Recurse -File | Measure-Object).Count + " files")

# non-secret config
$cfg = @{
  Bot      = @{ Mode = 'graph' }
  GraphBot = @{
    AppId = $AppId; DisplayName = 'Interview Assistant'; JoinAs = 'app'
    NotificationUrl = "https://$Fqdn/callback"; ServiceFqdn = $Fqdn; CertificateThumbprint = $Thumbprint
    InstancePublicIpAddress = $PublicIp; InstancePublicPort = 8445; InstanceInternalPort = 8445
  }
  Speech   = @{ Region = $SpeechRegion; Language = 'en-US' }
  Backend  = @{ Url = 'http://localhost:3000' }   # backend not hosted yet; event posts fail quietly (logged)
  # NOT the standard 'Kestrel' section: the media platform's embedded host reads it too and takes the port first.
  BotHttp  = @{ Port = 443 }
}
$cfg | ConvertTo-Json -Depth 8 | Set-Content -Path "$dir\appsettings.Production.json" -Encoding UTF8

# secrets -> machine environment variables (read from Key Vault, never printed)
[Environment]::SetEnvironmentVariable('GraphBot__AppSecret', (Get-KvSecret 'graphbot-app-secret'), 'Machine')
[Environment]::SetEnvironmentVariable('Speech__Key',         (Get-KvSecret 'speech-key'),          'Machine')
[Environment]::SetEnvironmentVariable('Bot__ApiKey',         (Get-KvSecret 'mediabot-api-key'),    'Machine')
[Environment]::SetEnvironmentVariable('ASPNETCORE_ENVIRONMENT', 'Production', 'Machine')
Write-Output 'config + secrets set'

# SYSTEM scheduled task at startup, stdout/stderr to a log file
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$dir\MediaBot.exe >> $dir\logs\bot.log 2>&1`"" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName MediaBot -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Remove-Item "$dir\logs\bot.log" -ErrorAction SilentlyContinue
Start-ScheduledTask -TaskName MediaBot
Start-Sleep 25

Write-Output ("process: " + [bool](Get-Process MediaBot -ErrorAction SilentlyContinue))
Write-Output ("listening on 443: " + [bool](Get-NetTCPConnection -LocalPort 443 -State Listen -ErrorAction SilentlyContinue))
Write-Output '--- last log lines'
if (Test-Path "$dir\logs\bot.log") { Get-Content "$dir\logs\bot.log" -Tail 40 }
