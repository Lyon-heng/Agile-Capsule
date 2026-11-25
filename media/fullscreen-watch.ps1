param(
  [string]$Scope = 'full'   # full = 只认真全屏/无边框全屏；max = 最大化也算
)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 全屏检测：前台窗口是否占满它所在的显示器
# 输出：状态变化时 FS 1 / FS 0；窗口覆盖率达到 85% 以上时每 3 秒输出一行 NEAR 供排查
#
# 两种"全屏"都算：
#   1) 铺满整块屏幕（含任务栏）—— 独占全屏 / 真全屏
#   2) 铺满工作区但**没有标题栏** —— 游戏里的"窗口化全屏"、播放器的无边框模式（任务栏还在）
# 普通"最大化"带标题栏，不算，避免平时把灵动岛藏掉。

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class FsWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
  }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  public static long[] TopWindows() {
    var list = new System.Collections.Generic.List<long>();
    EnumWindows((h, lp) => { list.Add(h.ToInt64()); return true; }, IntPtr.Zero);
    return list.ToArray();
  }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] public static extern IntPtr GetShellWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetDesktopWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr h, int idx);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT val, int size);
}
"@

[void][FsWin]::SetProcessDPIAware()
$DWMWA_EXTENDED_FRAME_BOUNDS = 9
$WS_CAPTION = 0x00C00000
$TOL = 4
# 后台“最大化”只对浏览器生效：浏览器最大化后，再弹出一个小窗口时仍应保持隐藏；
# 其他程序（资源管理器等）最大化不算，免得灵动岛整天不出现
$BrowserProcs = @('msedge', 'chrome', 'firefox', 'brave', 'opera', 'vivaldi', '360se', '360chrome', 'qqbrowser', 'sogouexplorer', 'iexplore')

function Get-Geom([IntPtr]$h) {
  $r = New-Object FsWin+RECT
  $ok = $false
  $hr = [FsWin]::DwmGetWindowAttribute($h, $DWMWA_EXTENDED_FRAME_BOUNDS, [ref]$r, 16)
  if ($hr -eq 0) { $ok = $true }
  if (-not $ok) { $ok = [FsWin]::GetWindowRect($h, [ref]$r) }
  if (-not $ok) { return $null }

  $mi = New-Object FsWin+MONITORINFO
  $mi.cbSize = 40
  $m = [FsWin]::MonitorFromWindow($h, 2)
  if (-not [FsWin]::GetMonitorInfo($m, [ref]$mi)) { return $null }

  $style = 0
  try { $style = [FsWin]::GetWindowLongPtr($h, -16).ToInt64() } catch { $style = 0 }

  return [pscustomobject]@{
    rect    = $r
    mon     = $mi.rcMonitor
    work    = $mi.rcWork
    caption = (($style -band $WS_CAPTION) -ne 0)
  }
}

function Test-Equal($a1, $a2, $b1, $b2) {
  return ([Math]::Abs($a1 - $b1) -le $TOL) -and ([Math]::Abs($a2 - $b2) -le $TOL)
}

function Test-Fullscreen($g, [bool]$allowMax = $true) {
  if (-not $g) { return 0 }
  $r = $g.rect
  $w = $r.Right - $r.Left
  $h = $r.Bottom - $r.Top
  $mw = $g.mon.Right - $g.mon.Left
  $mh = $g.mon.Bottom - $g.mon.Top
  $ww = $g.work.Right - $g.work.Left
  $wh = $g.work.Bottom - $g.work.Top

  # 1) 铺满整块屏幕（独占全屏 / 真全屏 / 盖住任务栏的窗口化全屏）
  if ((Test-Equal $w $h $mw $mh) -and (Test-Equal $r.Left $r.Top $g.mon.Left $g.mon.Top)) { return 1 }

  # 2) 铺满工作区（扣掉任务栏）
  if ((Test-Equal $w $h $ww $wh) -and (Test-Equal $r.Left $r.Top $g.work.Left $g.work.Top)) {
    # 无标题栏 = 无边框窗口化全屏，一定算
    if (-not $g.caption) { return 1 }
    # Scope=max：最大化也算（有些游戏的"窗口化全屏"仍带标题栏）
    if ($allowMax -and $Scope -eq 'max') { return 1 }
  }
  return 0
}

# 前台不是全屏时，再看同一显示器上是否还有“铺满屏幕”的窗口留在后面。
# 场景：浏览器视频全屏，用户又打开一个小窗口盖在前面；此时不能把灵动岛放出来。
function Find-BackgroundFullscreen([IntPtr]$fg, [IntPtr]$mon) {
  if ($mon -eq [IntPtr]::Zero) { return '' }
  $mi = New-Object FsWin+MONITORINFO
  $mi.cbSize = 40
  if (-not [FsWin]::GetMonitorInfo($mon, [ref]$mi)) { return '' }
  $mw = $mi.rcMonitor.Right - $mi.rcMonitor.Left
  $mh = $mi.rcMonitor.Bottom - $mi.rcMonitor.Top
  if ($mw -le 0 -or $mh -le 0) { return '' }

  $i = 0
  foreach ($hv in [FsWin]::TopWindows()) {
    $i++
    if ($i -gt 90) { break }
    $h = [IntPtr]$hv
    if ($h -eq $fg) { continue }
    if ($h -eq [FsWin]::GetShellWindow() -or $h -eq [FsWin]::GetDesktopWindow()) { continue }
    if (-not [FsWin]::IsWindowVisible($h)) { continue }
    if ([FsWin]::IsIconic($h)) { continue }
    if ([FsWin]::MonitorFromWindow($h, 2) -ne $mon) { continue }

    # 先做便宜的矩形粗筛，避免对几十个普通窗口都走 DWM
    $r = New-Object FsWin+RECT
    if (-not [FsWin]::GetWindowRect($h, [ref]$r)) { continue }
    $w = $r.Right - $r.Left
    $hh = $r.Bottom - $r.Top
    if ($w -lt [int]($mw * 0.85) -or $hh -lt [int]($mh * 0.85)) { continue }

    $g = Get-Geom $h
    if (-not $g) { continue }
    # 后台只认真正的全屏（含无边框工作区全屏）；Scope=max 时额外允许“浏览器最大化”
    $strict = Test-Fullscreen $g $false
    $wpid = 0
    [void][FsWin]::GetWindowThreadProcessId($h, [ref]$wpid)
    $proc = (Get-Process -Id $wpid -ErrorAction SilentlyContinue).ProcessName
    if (-not $proc) { $proc = '?' }
    if ($proc -eq 'Agile Capsule' -or $proc -eq 'WinIsland') { continue }
    if ($strict -ne 1) {
      if ($Scope -ne 'max') { continue }
      if (-not ($BrowserProcs -contains $proc.ToLower())) { continue }
      if ((Test-Fullscreen $g $true) -ne 1) { continue }
    }
    return $proc
  }
  return ''
}

$last = -1
$lastNear = [datetime]::MinValue

while ($true) {
  $hwnd = [FsWin]::GetForegroundWindow()
  $state = 0
  $g = $null
  $pname = '-'
  $fgMon = [IntPtr]::Zero

  if ($hwnd -ne [IntPtr]::Zero -and $hwnd -ne [FsWin]::GetShellWindow() -and
      $hwnd -ne [FsWin]::GetDesktopWindow() -and [FsWin]::IsWindowVisible($hwnd)) {
    $fgMon = [FsWin]::MonitorFromWindow($hwnd, 2)
    $g = Get-Geom $hwnd
    if ($g) {
      $wpid = 0
      [void][FsWin]::GetWindowThreadProcessId($hwnd, [ref]$wpid)
      $pname = (Get-Process -Id $wpid -ErrorAction SilentlyContinue).ProcessName
      if (-not $pname) { $pname = '?' }
      if ($pname -eq 'Agile Capsule' -or $pname -eq 'WinIsland') { $g = $null; $pname = 'Agile Capsule' } else { $state = Test-Fullscreen $g }
    }
  }

  # 前台不是全屏，但同一显示器后面还压着全屏窗口（浏览器视频、播放器）→ 仍然算全屏
  if ($state -eq 0 -and ($pname -ne 'Agile Capsule' -and $pname -ne 'WinIsland') -and $fgMon -ne [IntPtr]::Zero) {
    $bgProc = Find-BackgroundFullscreen $hwnd $fgMon
    if ($bgProc) { $state = 1; $pname = $bgProc + '(后台全屏)' }
  }

  if ($state -ne $last) {
    [Console]::Out.WriteLine("FS $state proc=$pname")
    [Console]::Out.Flush()
    $last = $state
  }

  # 接近满屏时打一行几何，方便排查"为什么没判成全屏"
  if ($g) {
    $r = $g.rect
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
    $mw = $g.mon.Right - $g.mon.Left; $mh = $g.mon.Bottom - $g.mon.Top
    $cover = 0
    if ($mw -gt 0 -and $mh -gt 0) { $cover = [Math]::Round(100.0 * $w * $h / ($mw * $mh), 1) }
    if ($cover -ge 85 -and ((Get-Date) - $lastNear).TotalSeconds -ge 3) {
      $lastNear = Get-Date
      $ww = $g.work.Right - $g.work.Left
      $wh = $g.work.Bottom - $g.work.Top
      $line = "NEAR proc=$pname cover=$cover% w=$w h=$h pos=$($r.Left),$($r.Top) mon=${mw}x${mh} work=${ww}x${wh} caption=$($g.caption) scope=$Scope"
      [Console]::Out.WriteLine($line)
      [Console]::Out.Flush()
    }
  }

  Start-Sleep -Milliseconds 700
}

