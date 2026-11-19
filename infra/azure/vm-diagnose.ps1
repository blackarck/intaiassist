# Runs ON the VM (PowerShell). READ-ONLY: changes nothing. Prints who owns the bot's ports, the task/process state,
# firewall rules, certificates and the end of the bot log. Paste the output (or a screenshot) back.
$ErrorActionPreference = 'Continue'

Write-Output '=== listeners on 80/443/8445 (who owns them)'
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $_.LocalPort -in 80, 443, 8445, 5000, 5001 } |
  Select-Object LocalAddress, LocalPort, OwningProcess,
    @{ n = 'Process'; e = { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).ProcessName } } |
  Sort-Object LocalPort | Format-Table -AutoSize | Out-String | Write-Output

Write-Output '=== MediaBot processes'
Get-Process MediaBot -ErrorAction SilentlyContinue | Select-Object Id, StartTime, @{ n = 'MB'; e = { [int]($_.WorkingSet64 / 1MB) } } | Format-Table -AutoSize | Out-String | Write-Output

Write-Output '=== scheduled task'
Get-ScheduledTask -TaskName MediaBot | Get-ScheduledTaskInfo | Select-Object LastRunTime, LastTaskResult, NumberOfMissedRuns | Format-List | Out-String | Write-Output

Write-Output '=== http.sys URL reservations on 443 (anything else using 443?)'
(netsh http show urlacl | Select-String ':443') | Out-String | Write-Output

Write-Output '=== Windows firewall rules for the bot'
Get-NetFirewallRule -DisplayName 'mediabot-*' | Select-Object DisplayName, Enabled, Direction, Action,
  @{ n = 'Ports'; e = { ($_ | Get-NetFirewallPortFilter).LocalPort -join ',' } } | Format-Table -AutoSize | Out-String | Write-Output

Write-Output '=== certificates in LocalMachine\My'
Get-ChildItem Cert:\LocalMachine\My | Select-Object Thumbprint, Subject, NotAfter | Format-Table -AutoSize | Out-String | Write-Output

Write-Output '=== config (non-secret)'
Get-Content C:\mediabot\appsettings.Production.json -Raw | Write-Output

Write-Output '=== first 12 and last 25 lines of the bot log'
$log = 'C:\mediabot\logs\bot.log'
if (Test-Path $log) { Get-Content $log -TotalCount 12; Write-Output '   ...'; Get-Content $log -Tail 25 } else { Write-Output '(no log file)' }
