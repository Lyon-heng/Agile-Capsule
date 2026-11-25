param(
  [int]$ParentPid = 0
)
# 进程占用监控：常驻运行，每 2 秒采样一次 CPU/内存，按程序名聚合后输出 JSON 行。
# 输出协议：{"topCpu":[{name,cpu,memMb}...],"topMem":[...]}
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }

$cores = [Environment]::ProcessorCount
$intervalMs = 2000
$selfPid = $PID

function Get-Snap {
  $map = @{}
  foreach ($p in (Get-Process)) {
    try {
      if ($p.Id -le 0) { continue }
      if ($p.Id -eq $selfPid) { continue }
      if ($p.ProcessName -eq 'Idle') { continue }
      $exePath = ''
      try { $exePath = $p.Path } catch { }
      $map[$p.Id] = [pscustomobject]@{
        name = $p.ProcessName
        path = $exePath
        cpuMs = [double]$p.TotalProcessorTime.TotalMilliseconds
        mem = [double]$p.WorkingSet64
      }
    } catch { }
  }
  return $map
}

$prev = Get-Snap
while ($true) {
  Start-Sleep -Milliseconds $intervalMs
  # 宿主进程（WinIsland）被强杀时自动退出，避免留下孤儿 PowerShell
  if ($ParentPid -gt 0) {
    $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if (-not $parent) { break }
  }
  $cur = Get-Snap
  $agg = @{}
  foreach ($k in $cur.Keys) {
    if (-not $prev.ContainsKey($k)) { continue }
    $c = $cur[$k]
    $p = $prev[$k]
    $d = $c.cpuMs - $p.cpuMs
    if ($d -lt 0) { $d = 0 }
    if (-not $agg.ContainsKey($c.name)) {
      $agg[$c.name] = [pscustomobject]@{ name = $c.name; path = ''; cpu = 0.0; memMb = 0.0; procs = 0 }
    }
    $a = $agg[$c.name]
    if (-not $a.path -and $c.path) { $a.path = $c.path }
    $a.cpu += ($d / $intervalMs) / $cores * 100
    $a.memMb += $c.mem / 1MB
    $a.procs++
  }
  $prev = $cur
  $rows = @($agg.Values)
  foreach ($r in $rows) {
    $r.cpu = [math]::Round($r.cpu, 1)
    $r.memMb = [math]::Round($r.memMb, 1)
  }
  if ($rows.Count -eq 0) { continue }
  $out = [pscustomobject]@{
    total = $cur.Count
    topCpu = @($rows | Sort-Object cpu -Descending | Select-Object -First 30)
    topMem = @($rows | Sort-Object memMb -Descending | Select-Object -First 30)
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Depth 4 -Compress))
}
