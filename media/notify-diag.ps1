param()
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 消息通知诊断：一次性输出 JSON（保持纯 ASCII 源码，避免 PowerShell 5.1 按 GBK 读 UTF-8 出问题）
# 用途：判断某台电脑上"为什么灵动岛收不到微信/QQ 消息"，重点看
#   - 微信版本与 UIA 节点数（4.x 是 Qt 自绘，UIA 几乎没有节点 -> 老方案失效）
#   - 系统通知访问权限与当前通知数量（跨版本唯一可靠的通道）

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  try {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(2500) | Out-Null
    return $task.Result
  } catch { return $null }
}
$null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class DiagWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int m);
  public struct RECT { public int l, t, r, b; }
  public static IntPtr Biggest(uint targetPid) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.r - r.l) * (r.b - r.t);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@

$report = [ordered]@{}

# --- 系统通知通道 ---
$toastAccess = 'unknown'
$toastCount = 0
$recent = @()
try {
  $l = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  if ($l) {
    $st = Await ($l.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
    $toastAccess = [string]$st
    $list = Await ($l.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
    if ($list) {
      $toastCount = $list.Count
      $i = 0
      foreach ($n in $list) {
        $i++
        if ($i -gt 5) { break }
        $texts = @()
        $b = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
        if ($b) { foreach ($e in $b.GetTextElements()) { if ($e.Text) { $texts += [string]$e.Text } } }
        $recent += [ordered]@{
          aumid = [string]$n.AppInfo.AppUserModelId
          app   = [string]$n.AppInfo.DisplayInfo.DisplayName
          texts = $texts
        }
      }
    }
  }
} catch { }

$report['toastAccess'] = $toastAccess
$report['toastCount'] = $toastCount
$report['recentToasts'] = $recent

$g = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Notifications\Settings' -Name NOC_GLOBAL_SETTING_TOASTS_ENABLED -ErrorAction SilentlyContinue).NOC_GLOBAL_SETTING_TOASTS_ENABLED
$report['globalToastsEnabled'] = if ($null -eq $g) { 'default' } else { [string]$g }

# --- 微信 / QQ 进程与 UIA 可读性 ---
function Get-AppInfo($names) {
  $out = @()
  foreach ($p in (Get-Process $names -ErrorAction SilentlyContinue)) {
    $ver = ''
    $path = ''
    try { $path = $p.Path; $ver = (Get-Item $p.Path).VersionInfo.FileVersion } catch { }

    # 托盘状态下 MainWindowHandle 是 0，这里按 pid 自己找最大的窗口
    $hwnd = [IntPtr]$p.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { $hwnd = [DiagWin]::Biggest([uint32]$p.Id) }

    $nodes = -1
    $cls = ''
    if ($hwnd -ne [IntPtr]::Zero) {
      try {
        $sb = New-Object System.Text.StringBuilder 256
        [void][DiagWin]::GetClassName($hwnd, $sb, 256)
        $cls = $sb.ToString()
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
        if ($root) {
          $all = [System.Windows.Automation.Condition]::TrueCondition
          $nodes = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $all).Count
        }
      } catch { }
    }
    $out += [ordered]@{
      name     = $p.ProcessName
      version  = $ver
      path     = $path
      hwnd     = [int64]$hwnd
      cls      = $cls
      uiaNodes = $nodes
    }
  }
  return $out
}

$report['wechat'] = @(Get-AppInfo @('Weixin', 'WeChat'))
$report['qq'] = @(Get-AppInfo @('QQ', 'TIM'))

$report['os'] = (Get-CimInstance Win32_OperatingSystem).Version
$report['ts'] = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())

$report | ConvertTo-Json -Compress -Depth 6
