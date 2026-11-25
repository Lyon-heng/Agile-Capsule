param(
  [int]$IntervalMs = 700
)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WxStates {
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
"@

$all = [System.Windows.Automation.Condition]::TrueCondition

function Find-ListCond {
  return New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::List)
}

# 返回 @{ state = 'ok'|'minimized'|'no-process'|'no-window'|'nouia'; rows = @() }
function SnapshotSessions {
  $p = Get-Process Weixin, WeChat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $p) { return @{ state = 'no-window'; rows = @() } }
  $hwnd = [IntPtr]$p.MainWindowHandle
  if ([WxStates]::IsIconic($hwnd)) { return @{ state = 'minimized'; rows = @() } }

  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if (-not $root) { return @{ state = 'no-window'; rows = @() } }

  # 微信 4.2.0.13 起把界面收进单个 MMUIRenderSubWindowHW，UIA 只暴露 1 个 Pane
  $desc = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $all)
  if ($desc.Count -le 1) { return @{ state = 'nouia'; rows = @() } }

  $lists = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, (Find-ListCond))
  $target = $null
  foreach ($l in $lists) {
    $nm = $l.Current.Name
    if ($nm -eq '会话' -or $nm -eq '聊天' -or $nm -eq '' -or $nm -match '会话') { $target = $l; break }
  }
  if (-not $target) {
    $best = $null; $bestCount = 0
    foreach ($l in $lists) {
      $cnt = $l.FindAll([System.Windows.Automation.TreeScope]::Children, $all).Count
      if ($cnt -gt $bestCount) { $best = $l; $bestCount = $cnt }
    }
    $target = $best
  }
  if (-not $target) { return @{ state = 'nouia'; rows = @() } }

  $rows = @()
  $kids = $target.FindAll([System.Windows.Automation.TreeScope]::Children, $all)
  foreach ($k in $kids) {
    $nm = $k.Current.Name
    if (-not $nm) { continue }
    $lines = @($nm -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($lines.Count -eq 0) { continue }
    $unread = 0
    foreach ($ln in $lines) {
      $m = [regex]::Match($ln, '^\[(\d+)条\]$')
      if ($m.Success) { $unread = [int]$m.Groups[1].Value }
    }
    $rows += [pscustomobject]@{
      key    = $lines[0]
      raw    = ($lines -join ' | ')
      unread = $unread
    }
  }
  if ($rows.Count -eq 0) { return @{ state = 'nouia'; rows = @() } }
  return @{ state = 'ok'; rows = $rows }
}

$lastState = ''
$lastStateAt = 0
while ($true) {
  $s = SnapshotSessions
  $ts = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
  if ($s.state -eq 'ok') {
    $obj = [ordered]@{ type = 'wxsessions'; rows = $s.rows; ts = $ts }
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
    $lastState = 'ok'
  } else {
    # 状态变化或每 60 秒上报一次，避免刷屏
    if ($s.state -ne $lastState -or ($ts - $lastStateAt) -gt 60000) {
      $obj = [ordered]@{ type = 'wxsessions-state'; state = $s.state; ts = $ts }
      Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
      $lastState = $s.state
      $lastStateAt = $ts
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}
