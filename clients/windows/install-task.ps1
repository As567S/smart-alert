# 注册每10分钟任务计划 (以管理员身份在 PowerShell 里运行一次)
# 先把 smart-report.ps1 放到 C:\ProgramData\smart-alert\ 下再跑这个
$dir = 'C:\ProgramData\smart-alert'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' `
               -Argument "-NoProfile -ExecutionPolicy Bypass -File $dir\smart-report.ps1"
$trigger   = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
               -RepetitionInterval (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName 'SmartReport' -Action $action -Trigger $trigger `
  -Principal $principal -Force

# 立即手动跑一次验证:
Start-ScheduledTask -TaskName 'SmartReport'
