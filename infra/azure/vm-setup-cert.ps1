# Runs ON the VM (via az vm run-command). Opens the Windows firewall and gets a Let's Encrypt cert for the VM's FQDN
# into LocalMachine\My. No account e-mail is registered with Let's Encrypt (contact omitted on purpose).
param([string]$Fqdn = 'vaiint-bot-f9eaa4.eastus.cloudapp.azure.com')
$ErrorActionPreference = 'Stop'

# Windows firewall (the Azure NSG is separate and already open)
New-NetFirewallRule -DisplayName 'mediabot-tcp' -Direction Inbound -Protocol TCP -LocalPort 80,443,8445 -Action Allow -ErrorAction SilentlyContinue | Out-Null
New-NetFirewallRule -DisplayName 'mediabot-udp' -Direction Inbound -Protocol UDP -LocalPort '3478-3481','49152-53247' -Action Allow -ErrorAction SilentlyContinue | Out-Null
Write-Output 'firewall rules ok'

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force | Out-Null
Install-Module -Name Posh-ACME -Force -Scope AllUsers -AllowClobber
Import-Module Posh-ACME
Set-PAServer LE_PROD

# HTTP-01 on port 80 via Posh-ACME's built-in listener; -Install puts the cert in LocalMachine\My
$cert = New-PACertificate $Fqdn -AcceptTOS -Plugin WebSelfHost -Install
Write-Output ("THUMBPRINT=" + $cert.Thumbprint)
Write-Output ("NOTAFTER=" + $cert.NotAfter)
Get-ChildItem Cert:\LocalMachine\My | Where-Object { $_.Subject -like "*$Fqdn*" } |
  Select-Object Thumbprint, Subject, NotAfter | Format-List | Out-String | Write-Output
