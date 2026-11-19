# Runs ON the VM (elevated PowerShell). One-time Windows prerequisites for Microsoft's real-time media platform.
# Found by scanning the imports of NativeMedia.dll / RtmPal.dll / RtmCodecs.dll / SlimCV.dll:
#   - Visual C++ 2015-2022 x64 runtime (MSVCP140, VCRUNTIME140, VCRUNTIME140_1, MSVCP140_ATOMIC_WAIT)
#   - Media Foundation (wmvcore.dll, MFPlat.dll, MFReadWrite.dll). NOT installed by default on Windows Server.
# Reboots the VM if Windows asks for it. The MediaBot scheduled task starts by itself after boot.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
New-Item -ItemType Directory -Force C:\setup | Out-Null

Write-Output '--- 1/2 Media Foundation (Windows Server feature)'
$mf = Install-WindowsFeature -Name Server-Media-Foundation
Write-Output ("success={0} restartNeeded={1}" -f $mf.Success, $mf.RestartNeeded)

Write-Output '--- 2/2 Visual C++ 2015-2022 x64 runtime (Microsoft, https://aka.ms/vs/17/release/vc_redist.x64.exe)'
$exe = 'C:\setup\vc_redist.x64.exe'
& curl.exe -sS -L --fail -o $exe 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
if ($LASTEXITCODE -ne 0) { throw "download failed (curl exit $LASTEXITCODE)" }
$sig = Get-AuthenticodeSignature $exe
Write-Output ("signature: {0}; signer: {1}" -f $sig.Status, $sig.SignerCertificate.Subject)
if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'unexpected installer signature, aborting' }
$p = Start-Process -FilePath $exe -ArgumentList '/install', '/quiet', '/norestart' -Wait -PassThru
Write-Output ("vc_redist exit code: {0}  (0 = installed, 3010 = installed, reboot needed, 1638 = newer already present)" -f $p.ExitCode)
if ($p.ExitCode -notin 0, 1638, 3010) { throw "vc_redist failed with exit code $($p.ExitCode)" }

$needReboot = $mf.RestartNeeded -eq 'Yes' -or $p.ExitCode -eq 3010
if ($needReboot) {
  Write-Output 'Restart required: rebooting in 15 seconds. The bot starts automatically after boot. Reconnect afterwards if you want to look.'
  Start-Sleep 15
  Restart-Computer -Force
} else {
  Write-Output 'No restart needed. Starting the bot task now.'
  Start-ScheduledTask -TaskName MediaBot
  Start-Sleep 20
  Get-Content C:\mediabot\logs\bot.log -Tail 30
}
