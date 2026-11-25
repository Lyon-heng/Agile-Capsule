param(
  [int]$IntervalMs = 1000,
  [int]$LifetimeSec = 0,
  [switch]$Debug,
  [switch]$AllApps,
  [switch]$HookDiag
)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# ---------- WinRT 系统通知读取 ----------
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  try {
    $task = $script:asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(2500) | Out-Null
    return $task.Result
  } catch { return $null }
}

$null = [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.NotificationKinds, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime]
$null = [Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus, Windows.UI.Notifications, ContentType = WindowsRuntime]

# 通知访问权限：没授予时 GetNotificationsAsync 一律返回空，
# 而微信 4.x 砍掉了 UIA 可读性，系统通知是唯一跨版本可靠的通道，所以这里必须显式申请并上报状态
$script:toastAccess = 'unknown'
$script:lastAccessTry = [datetime]::MinValue

function Sync-ToastAccess {
  try {
    $l = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
    if (-not $l) { return }
    $st = Await ($l.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
    $s = [string]$st
    if ($s -ne $script:toastAccess) {
      $script:toastAccess = $s
      Write-Output ('{"type":"access","status":"' + $s + '"}')
    }
  } catch { }
}

function Get-ToastList {
  try {
    $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
    if (-not $listener) { return @() }
    $list = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) ([System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]])
    if ($null -eq $list) { return @() }
    return $list
  } catch { return @() }
}

# ---------- 微信 / QQ 弹窗窗口 ----------
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

# ---------- 任务栏闪烁（HSHELL_FLASH）：微信/QQ 在后台收到消息时最可靠的信号 ----------
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Text;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class FlashHookForm : Form {
  [DllImport("user32.dll")] static extern bool RegisterShellHookWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern int RegisterWindowMessage(string lpString);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder sb, ref uint size);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  int msg;
  Queue<string> queue = new Queue<string>();
  public bool HookOk = false;
  public int HookMsg = 0;

  public FlashHookForm() {
    ShowInTaskbar = false;
    FormBorderStyle = FormBorderStyle.None;
    StartPosition = FormStartPosition.Manual;
    Bounds = new System.Drawing.Rectangle(-2000, -2000, 1, 1);
    Opacity = 0;
  }

  protected override void OnHandleCreated(EventArgs e) {
    base.OnHandleCreated(e);
    msg = RegisterWindowMessage("SHELLHOOK");
    HookMsg = msg;
    HookOk = RegisterShellHookWindow(Handle);
  }

  protected override void WndProc(ref Message m) {
    if (msg != 0 && m.Msg == msg) {
      int code = m.WParam.ToInt32();
      if (code == 0x8006) {
        string exe = ExeOf(m.LParam);
        if (exe.Length > 0) queue.Enqueue(exe);
      }
    }
    base.WndProc(ref m);
  }

  public string[] Drain() {
    string[] a = queue.ToArray();
    queue.Clear();
    return a;
  }

  static string ExeOf(IntPtr hwnd) {
    try {
      uint pid = 0;
      GetWindowThreadProcessId(hwnd, out pid);
      if (pid == 0) return "";
      IntPtr h = OpenProcess(0x1000, false, pid);
      if (h == IntPtr.Zero) return "";
      try {
        StringBuilder sb = new StringBuilder(1024);
        uint size = 1024;
        if (QueryFullProcessImageName(h, 0, sb, ref size)) {
          string p = sb.ToString();
          int i = p.LastIndexOf('\\');
          return (i >= 0 ? p.Substring(i + 1) : p).ToLowerInvariant();
        }
      } finally { CloseHandle(h); }
    } catch { }
    return "";
  }
}
"@

$hookForm = New-Object FlashHookForm
$hookForm.Show()
if ($HookDiag) {
  $ok = if ($hookForm) { [bool]$hookForm.HookOk } else { $false }
  $msg = if ($hookForm) { [int]$hookForm.HookMsg } else { 0 }
  Write-Output ('{"type":"hook","ok":' + $ok.ToString().ToLower() + ',"msg":' + $msg + '}')
}
$lastFlash = @{}
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class NotifyWin {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  public struct RECT { public int left, top, right, bottom; }
  public static List<string> List(uint[] pids) {
    var res = new List<string>();
    EnumWindows((h, lp) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      if (!IsWindowVisible(h)) return true;
      var cn = new StringBuilder(128); GetClassName(h, cn, 128);
      var tt = new StringBuilder(256); GetWindowText(h, tt, 256);
      RECT r; GetWindowRect(h, out r);
      int w = r.right - r.left, hh = r.bottom - r.top;
      if (w < 40 || hh < 30 || w > 900 || hh > 700) return true;
      res.Add(h.ToInt64() + "|" + cn + "|" + tt + "|" + w + "|" + hh);
      return true;
    }, IntPtr.Zero);
    return res;
  }
}
"@

function Get-PlayerPids {
  $names = @('Weixin', 'WeChat', 'QQ', 'TIM')
  $ids = @()
  foreach ($n in $names) {
    $ids += @(Get-Process -Name $n -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  }
  return $ids
}

function Get-UiaTexts($hwnd) {
  $out = @()
  try {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$hwnd)
    if (-not $root) { return $out }
    $cond = [System.Windows.Automation.Condition]::TrueCondition
    $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    foreach ($el in $els) {
      $c = $el.Current
      $t = $c.ControlType.ProgrammaticName -replace 'ControlType\.', ''
      if ($c.Name -and ($t -eq 'Text' -or $t -eq 'Button' -or $t -eq 'Image')) {
        $out += [string]$c.Name
      }
      if ($out.Count -ge 20) { break }
    }
  } catch { }
  return $out
}

$seenToast = @{}
$seenWin = @{}
$baselineToast = $true
$deadline = if ($LifetimeSec -gt 0) { (Get-Date).AddSeconds($LifetimeSec) } else { [datetime]::MaxValue }

Sync-ToastAccess

while ((Get-Date) -lt $deadline) {
  # 任务栏闪烁（WinForms 消息泵只在 DoEvents 时派发）
  [System.Windows.Forms.Application]::DoEvents()
  foreach ($exe in $hookForm.Drain()) {
    if ($exe -notin @('weixin.exe', 'wechat.exe', 'qq.exe', 'tim.exe', 'qqnt.exe')) {
      if (-not $AllApps) { continue }
    }
    $now = Get-Date
    if ($lastFlash.ContainsKey($exe) -and ($now - $lastFlash[$exe]).TotalSeconds -lt 8) { continue }
    $lastFlash[$exe] = $now
    $obj = [ordered]@{
      type = 'flash'
      exe  = $exe
      ts   = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
    }
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 3)
  }

  # 权限被拒时每 30s 重试一次（用户可能在设置里放开了通知）
  if ($script:toastAccess -ne 'Allowed' -and ((Get-Date) - $script:lastAccessTry).TotalSeconds -gt 30) {
    $script:lastAccessTry = Get-Date
    Sync-ToastAccess
  }
  # 1) 系统通知
  $toasts = Get-ToastList
  # 首次只建立基线：系统通知中心里的历史 toast 不能一次性全弹出来
  if ($baselineToast -and $toasts.Count -gt 0) {
    foreach ($n in $toasts) {
      try {
        $app = $n.AppInfo
        $seenToast["$($app.AppUserModelId)#$($n.Id)#$($n.CreationTime.ToString('o'))"] = 1
      } catch { }
    }
    $baselineToast = $false
    Write-Output ('{"type":"baseline","count":' + $toasts.Count + '}')
    $toasts = @()
  }
  foreach ($n in $toasts) {
    try {
      $app = $n.AppInfo
      $key = "$($app.AppUserModelId)#$($n.Id)#$($n.CreationTime.ToString('o'))"
      if ($seenToast.ContainsKey($key)) { continue }
      $seenToast[$key] = 1
      $texts = @()
      $b = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
      if (-not $b) { $b = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::Toast) }
      if ($b) { foreach ($e in $b.GetTextElements()) { if ($e.Text) { $texts += [string]$e.Text } } }
      if ($texts.Count -eq 0) { continue }
      $obj = [ordered]@{
        type  = 'toast'
        aumid = [string]$app.AppUserModelId
        app   = [string]$app.DisplayInfo.DisplayName
        texts = $texts
        ts    = [int64]($n.CreationTime.ToUnixTimeMilliseconds())
        id    = [string]$n.Id
      }
      Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
    } catch { }
  }
  # 清理过旧的去重记录
  if ($seenToast.Count -gt 400) { $seenToast = @{} }

  # 2) 微信/QQ 弹窗窗口
  $pids = Get-PlayerPids
  if ($pids.Count -gt 0) {
    foreach ($line in [NotifyWin]::List([uint32[]]$pids)) {
      $parts = $line -split '\|'
      $hwnd = $parts[0]; $cls = $parts[1]; $title = $parts[2]; $w = $parts[3]; $h = $parts[4]
      # 通知弹窗判定（跨版本）：可见 + 尺寸像弹窗 + 不是主窗口
      $ww = [int]$w; $hh = [int]$h
      if ($cls -match 'Base_PowerMessageWindow|IME|MSCTFIME|SystemMessageWindow|DisplayICC') { continue }
      $isMain = ($title -eq '微信' -and $ww -ge 500)
      if ($isMain) { continue }
      $looksPopup = ($cls -match 'WxTrayIcon|Toast|Notif|Popup|Tips|Bubble') -or ($ww -ge 120 -and $ww -le 620 -and $hh -ge 40 -and $hh -le 420)
      if (-not $looksPopup) { continue }
      $uia = Get-UiaTexts $hwnd
      if (-not $uia -or $uia.Count -eq 0) { continue }
      $sig = "$hwnd|$title|$($uia -join '/')"
      if ($seenWin.ContainsKey($sig)) { continue }
      $seenWin[$sig] = 1
      $obj = [ordered]@{
        type  = 'popup'
        app   = if ($cls -match 'QQ|Tim') { 'qq' } else { 'wechat' }
        cls   = $cls
        title = $title
        texts = $uia
        size  = "$w x $h"
        ts    = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
      }
      Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
    }
    if ($seenWin.Count -gt 300) { $seenWin = @{} }
  }

  Start-Sleep -Milliseconds $IntervalMs
}
