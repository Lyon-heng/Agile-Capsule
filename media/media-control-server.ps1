# WinIsland 常驻媒体控制服务：从 stdin 逐行读取 JSON 指令并立即执行
# 每行格式: {"cmd":"play|pause|toggle|next|prev|seek|rewind","source":"smtc|wintitle","app":"AUMID","seek":12.5}
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$script:asTaskOp = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
$script:asAction = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncAction' })[0]

function Await($WinRtTask, $ResultType) {
  $netTask = $script:asTaskOp.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}
function AwaitAction($WinRtAction) {
  $script:asAction.Invoke($null, @($WinRtAction)).Wait(-1)
}

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinIslandKeys2 {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
function Send-MediaKey($vk) {
  [WinIslandKeys2]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [WinIslandKeys2]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
}

function Get-SessionPlaybackStatus($s) {
  if (-not $s) { return 'Unknown' }
  try {
    $pi = $s.GetPlaybackInfo()
    if ($pi -and $pi.PlaybackStatus) { return $pi.PlaybackStatus.ToString() }
  } catch {}
  return 'Unknown'
}

function Get-SessionList($mgr) {
  return @($mgr.GetSessions() | Where-Object {
    if ((Get-SessionPlaybackStatus $_) -eq 'Closed') { return $false }
    try {
      $pi = $_.GetPlaybackInfo()
      if ($pi -and $pi.PlaybackType -and $pi.PlaybackType.ToString() -eq 'Video') { return $false }
    } catch {}
    $aid = ($_.SourceAppUserModelId -replace '"', '').ToLower()
    if ($aid -match 'zunevideo|potplayer|vlc|mpc-hc|mpc-be|kmplayer|iqiyi|youku|tencentvideo|bilibili') { return $false }
    return $true
  })
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }
  try { $req = $line | ConvertFrom-Json } catch { continue }
  $Cmd = [string]$req.cmd
  if (-not $Cmd) { continue }

  # 标题模式：未接入 SMTC 的播放器，直接模拟多媒体键（主进程已做状态去重）
  if ($req.source -eq 'wintitle') {
    $vk = switch ($Cmd) {
      'next' { 0xB0 }
      'prev' { 0xB1 }
      default { 0xB3 }
    }
    Send-MediaKey $vk
    continue
  }

  try {
    $sessions = Get-SessionList $mgr
    $browserPattern = 'msedge|chrome|firefox|360se|brave|opera'
    $musicSessions = @($sessions | Where-Object { $_.SourceAppUserModelId.ToLower() -notmatch $browserPattern })
    $s = $null
    $preferredApp = [string]$req.app
    if ($preferredApp) {
      $preferredLower = $preferredApp.ToLower()
      $s = $sessions | Where-Object { $_.SourceAppUserModelId.ToLower().Contains($preferredLower) } | Select-Object -First 1
    }
    if (-not $s -and $musicSessions.Count -gt 0) {
      $s = $musicSessions | Where-Object { (Get-SessionPlaybackStatus $_) -eq 'Playing' } | Select-Object -First 1
      if (-not $s) { $s = $musicSessions | Select-Object -First 1 }
    }
    if (-not $s) {
      $s = $sessions | Where-Object { (Get-SessionPlaybackStatus $_) -eq 'Playing' } | Select-Object -First 1
      if (-not $s) { $s = $sessions | Select-Object -First 1 }
    }

    if ($s) {
      switch ($Cmd) {
        'play'  { AwaitAction ($s.TryPlayAsync()) }
        'pause' { AwaitAction ($s.TryPauseAsync()) }
        'toggle' {
          if ((Get-SessionPlaybackStatus $s) -eq 'Playing') { AwaitAction ($s.TryPauseAsync()) }
          else { AwaitAction ($s.TryPlayAsync()) }
        }
        'next'  { AwaitAction ($s.TrySkipNextAsync()) }
        'prev'  { AwaitAction ($s.TrySkipPreviousAsync()) }
        'seek'  {
          if ($req.seek) {
            $ticks = [long]([double]$req.seek * 10000000)
            Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool]) | Out-Null
          }
        }
        'rewind' {
          Await ($s.TryChangePlaybackPositionAsync(0)) ([bool]) | Out-Null
          AwaitAction ($s.TryPlayAsync())
        }
      }
      continue
    }
  } catch { }

  # 无 SMTC 会话 → 兜底多媒体键
  $vk = switch ($Cmd) {
    'next' { 0xB0 }
    'prev' { 0xB1 }
    default { 0xB3 }
  }
  Send-MediaKey $vk
}
