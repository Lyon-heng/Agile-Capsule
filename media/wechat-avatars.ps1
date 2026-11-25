param(
  [string]$Conv = '',
  [switch]$All
)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WxCap {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public struct RECT { public int left, top, right, bottom; }
  public static IntPtr Find(uint[] pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, lp) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      var cn = new StringBuilder(128); GetClassName(h, cn, 128);
      var tt = new StringBuilder(200); GetWindowText(h, tt, 200);
      RECT r; GetWindowRect(h, out r);
      int w = r.right - r.left, hh = r.bottom - r.top;
      if (cn.ToString().IndexOf("QWindowIcon", StringComparison.OrdinalIgnoreCase) >= 0
          && (tt.ToString() == "微信" || (w >= 500 && hh >= 400))) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[WxCap]::SetProcessDPIAware() | Out-Null

$outDir = Join-Path $env:APPDATA 'win-island\avatars'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }

$procs = @(Get-Process Weixin, WeChat -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Write-Output '{"ok":false,"reason":"no-process"}'; exit }
$pids = [uint32[]]@($procs | ForEach-Object { [uint32]$_.Id })
$hwnd = [WxCap]::Find($pids)
if ($hwnd -eq [IntPtr]::Zero) { Write-Output '{"ok":false,"reason":"no-window"}'; exit }

$winRect = New-Object WxCap+RECT
[WxCap]::GetWindowRect($hwnd, [ref]$winRect) | Out-Null
$winW = $winRect.right - $winRect.left
$winH = $winRect.bottom - $winRect.top
if ($winW -le 0 -or $winH -le 0) { Write-Output '{"ok":false,"reason":"bad-rect"}'; exit }

$full = New-Object System.Drawing.Bitmap($winW, $winH)
$g = [System.Drawing.Graphics]::FromImage($full)
$hdc = $g.GetHdc()
$okCap = [WxCap]::PrintWindow($hwnd, $hdc, 2)
$g.ReleaseHdc($hdc)
$g.Dispose()
if (-not $okCap) { $full.Dispose(); Write-Output '{"ok":false,"reason":"printwindow-failed"}'; exit }

$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if (-not $root) { $full.Dispose(); Write-Output '{"ok":false,"reason":"no-root"}'; exit }

$cellCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::ListItem)
$cells = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cellCond)
if ($cells.Count -eq 0) { $full.Dispose(); Write-Output '{"ok":false,"reason":"no-cells"}'; exit }

$saved = @()
foreach ($c in $cells) {
  # 只取会话列表单元格，排除聊天区消息项
  if ($c.Current.ClassName -notmatch 'ChatSessionCell') { continue }
  $nm = $c.Current.Name
  if (-not $nm) { continue }
  $convName = ($nm -split "`r?`n")[0].Trim()
  if (-not $convName) { continue }
  if (-not $All -and $Conv -and $convName -ne $Conv) { continue }
  $r = $c.Current.BoundingRectangle
  if ($r.Width -le 0 -or $r.Height -le 0) { continue }
  $h = [int]$r.Height
  $side = [int][Math]::Max(24, [Math]::Min(46, $h - 25))
  $relX = [int]($r.Left - $winRect.left) + 10
  $relY = [int]($r.Top - $winRect.top) + [int](($h - $side) / 2)
  if ($relX -lt 0 -or $relY -lt 0 -or ($relX + $side) -gt $winW -or ($relY + $side) -gt $winH) { continue }
  $crop = New-Object System.Drawing.Bitmap($side, $side)
  $cg = [System.Drawing.Graphics]::FromImage($crop)
  $cg.DrawImage($full,
    (New-Object System.Drawing.Rectangle(0, 0, $side, $side)),
    (New-Object System.Drawing.Rectangle($relX, $relY, $side, $side)),
    [System.Drawing.GraphicsUnit]::Pixel)
  $cg.Dispose()
  $safe = [System.BitConverter]::ToString(
    [System.Security.Cryptography.MD5]::Create().ComputeHash([System.Text.Encoding]::UTF8.GetBytes($convName))
  ).Replace('-', '').ToLower()
  $file = Join-Path $outDir ($safe + '.png')
  try { $crop.Save($file, [System.Drawing.Imaging.ImageFormat]::Png) } catch { }
  $crop.Dispose()
  $saved += @{ conv = $convName; path = $file }
  if (-not $All -and $Conv) { break }
}
$full.Dispose()
$obj = @{ ok = $true; count = $saved.Count; items = $saved }
Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
