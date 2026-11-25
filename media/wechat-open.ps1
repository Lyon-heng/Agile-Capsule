param(
  [Parameter(Mandatory = $true)][string]$Conv
)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WxGo {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);
  public struct RECT { public int left, top, right, bottom; }
  public const uint LEFTDOWN = 0x0002, LEFTUP = 0x0004;
  public static IntPtr FindMain(uint[] pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, lp) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      var cn = new StringBuilder(128); GetClassName(h, cn, 128);
      var tt = new StringBuilder(200); GetWindowText(h, tt, 200);
      RECT r; GetWindowRect(h, out r);
      int w = r.right - r.left, hh = r.bottom - r.top;
      bool isMain = cn.ToString().IndexOf("QWindowIcon", StringComparison.OrdinalIgnoreCase) >= 0
                    && (tt.ToString() == "微信" || (w >= 500 && hh >= 400));
      if (isMain) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static void Click(int x, int y) {
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(70);
    mouse_event(LEFTDOWN, 0, 0, 0, IntPtr.Zero);
    System.Threading.Thread.Sleep(45);
    mouse_event(LEFTUP, 0, 0, 0, IntPtr.Zero);
  }
}
"@

function Emit($o) { Write-Output ($o | ConvertTo-Json -Compress); exit }

# ---------- 1) 找窗口并恢复 ----------
$procs = @(Get-Process Weixin, WeChat -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Emit @{ ok = $false; reason = 'no-wechat-process' } }
$pids = [uint32[]]@($procs | ForEach-Object { [uint32]$_.Id })
$hwnd = [WxGo]::FindMain($pids)
if ($hwnd -eq [IntPtr]::Zero) {
  $p2 = $procs | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($p2) { $hwnd = [IntPtr]$p2.MainWindowHandle }
}
if ($hwnd -eq [IntPtr]::Zero) { Emit @{ ok = $false; reason = 'no-window' } }

[WxGo]::ShowWindow($hwnd, 9) | Out-Null
Start-Sleep -Milliseconds 280
[WxGo]::ShowWindow($hwnd, 5) | Out-Null
[WxGo]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 450

# ---------- 2) 搜索跳转 ----------
$oldClip = ''
try { $oldClip = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch { }
try {
  Set-Clipboard -Value $Conv
  [System.Windows.Forms.SendKeys]::SendWait('^f')
  Start-Sleep -Milliseconds 450
  [System.Windows.Forms.SendKeys]::SendWait('^v')
  Start-Sleep -Milliseconds 850
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Start-Sleep -Milliseconds 500
  try { if ($oldClip) { Set-Clipboard -Value $oldClip } } catch { }
  Emit @{ ok = $true; conv = $Conv; via = 'search' }
} catch {
  try { if ($oldClip) { Set-Clipboard -Value $oldClip } } catch { }
}

# ---------- 3) 兜底：UIA 会话项点击 ----------
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
if (-not $root) { Emit @{ ok = $false; reason = 'no-root' } }

$all = [System.Windows.Automation.Condition]::TrueCondition
$listCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::List)
$lists = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $listCond)
$target = $null
foreach ($l in $lists) { if ($l.Current.Name -match '会话|聊天') { $target = $l; break } }
if (-not $target) {
  $best = $null; $bc = 0
  foreach ($l in $lists) {
    $c = $l.FindAll([System.Windows.Automation.TreeScope]::Children, $all).Count
    if ($c -gt $bc) { $best = $l; $bc = $c }
  }
  $target = $best
}
if (-not $target) { Emit @{ ok = $false; reason = 'no-list' } }

$hit = $null
$kids = $target.FindAll([System.Windows.Automation.TreeScope]::Children, $all)
foreach ($k in $kids) {
  $nm = $k.Current.Name
  if ($nm -and (($nm -split "`r?`n")[0].Trim() -eq $Conv)) { $hit = $k; break }
}
if (-not $hit) {
  foreach ($k in $kids) {
    $nm = $k.Current.Name
    if ($nm -and $nm -like "*$Conv*") { $hit = $k; break }
  }
}
if (-not $hit) { Emit @{ ok = $false; reason = 'conv-not-found' } }

try {
  $si = $hit.GetCurrentPattern([System.Windows.Automation.ScrollItemPattern]::Pattern)
  if ($si) { $si.ScrollIntoView(); Start-Sleep -Milliseconds 160 }
} catch { }

$r = $hit.Current.BoundingRectangle
if ($r.Width -le 0 -or $r.Height -le 0) { Emit @{ ok = $false; reason = 'no-bounds' } }
[WxGo]::Click([int]($r.Left + $r.Width / 2), [int]($r.Top + $r.Height / 2))
Start-Sleep -Milliseconds 350
Emit @{ ok = $true; conv = $Conv; via = 'click' }
