# SMART 上报脚本 (Windows): 由任务计划以 SYSTEM 身份每 10 分钟运行
# 依赖: smartmontools 官方 Windows 版 (装好后有 smartctl.exe)
# 客户端不做判断, 判断全在 Worker; smartctl 读不到的盘用系统自带计数器降级补报
$ErrorActionPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12  # PS 5.1 必须, 否则 Cloudflare 拒连

$WorkerUrl = 'https://smart.example.com/report'
$Token     = '改成你的REPORT_TOKEN'                              # ← 与 Worker 的 REPORT_TOKEN 一致
$Smartctl  = 'C:\Program Files\smartmontools\bin\smartctl.exe'
$HostName  = $env:COMPUTERNAME

$reports     = @()
$seenSerials = @()

$scan = (& $Smartctl --scan-open -j | ConvertFrom-Json)
foreach ($dev in $scan.devices) {
    $ctlArgs = @('-a', '-j', '--nocheck', 'standby')   # 休眠盘不唤醒, 本次跳过
    if ($dev.type -and $dev.type -ne 'ata') { $ctlArgs += @('-d', $dev.type) }
    $ctlArgs += $dev.name
    $out = & $Smartctl @ctlArgs 2>$null | ConvertFrom-Json
    if ($out -and ($out.smart_status -or $out.nvme_smart_health_information_log -or $out.ata_smart_attributes)) {
        $reports += $out
        if ($out.serial_number) { $seenSerials += $out.serial_number.Trim() }
    }
}

# 降级补报: smartctl 读不到的盘 (典型: Intel RST/VMD 模式下的 NVMe)
# 只有磨损/温度/读写错误总数这种粗粒度数据, 上报里带 coarse 标记, Worker 按粗粒度规则判断
$coarse = @()
foreach ($pd in Get-PhysicalDisk) {
    if ($seenSerials -contains $pd.SerialNumber.Trim()) { continue }
    $rc = $pd | Get-StorageReliabilityCounter
    if ($rc) {
        $coarse += @{
            model        = $pd.FriendlyName
            serial       = $pd.SerialNumber.Trim()
            wear         = $rc.Wear
            temp         = $rc.Temperature
            read_errors  = $rc.ReadErrorsTotal
            write_errors = $rc.WriteErrorsTotal
        }
    }
}

$payload = @{ host = $HostName; reports = $reports; coarse = $coarse } |
    ConvertTo-Json -Depth 20 -Compress
Invoke-RestMethod -Method Post -Uri $WorkerUrl `
    -Headers @{ Authorization = "Bearer $Token" } `
    -ContentType 'application/json' -Body $payload
