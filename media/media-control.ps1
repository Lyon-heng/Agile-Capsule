# WinIsland 媒体控制: SMTC 会话优先，降级模拟多媒体按键
# 用法: powershell -File media-control.ps1 -Cmd play|pause|toggle|next|prev
param([string]$Cmd)
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

function Send-MediaKey($vk) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WinIslandKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
  [WinIslandKeys]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [WinIslandKeys]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)  # KEYEVENTF_KEYUP
}

# 来源为窗口标题降级（未接入 SMTC 的播放器）→ 直接模拟多媒体键
if ($env:WINISLAND_MEDIA_SOURCE -eq 'wintitle') {
  $vk = switch ($Cmd) {
    'next' { 0xB0 }   # VK_MEDIA_NEXT_TRACK
    'prev' { 0xB1 }   # VK_MEDIA_PREV_TRACK
    default { 0xB3 }  # VK_MEDIA_PLAY_PAUSE
  }
  Send-MediaKey $vk
  exit 0
}

function Get-SessionPlaybackStatus($s) {
  if (-not $s) { return 'Unknown' }
  try {
    $pi = $s.GetPlaybackInfo()
    if ($pi -and $pi.PlaybackStatus) {
      return $pi.PlaybackStatus.ToString()
    }
  } catch {}
  try {
    if ($s.PlaybackInfo -and $s.PlaybackInfo.Status) {
      return $s.PlaybackInfo.Status.ToString()
    }
  } catch {}
  return 'Unknown'
}

# SMTC 路径
try {
  [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
  $mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  $sessions = @($mgr.GetSessions() | Where-Object { 
    if ((Get-SessionPlaybackStatus $_) -eq 'Closed') { return $false }
    try {
      $pi = $_.GetPlaybackInfo()
      if ($pi -and $pi.PlaybackType -and $pi.PlaybackType.ToString() -eq 'Video') { return $false }
    } catch {}
    $aid = ($_.SourceAppUserModelId -replace '"','').ToLower()
    if ($aid -match 'zunevideo|potplayer|vlc|mpc-hc|mpc-be|kmplayer|iqiyi|youku|tencentvideo|bilibili') { return $false }
    return $true
  })
  $browserPattern = 'msedge|chrome|firefox|360se|brave|opera'
  $musicSessions = @($sessions | Where-Object { $_.SourceAppUserModelId.ToLower() -notmatch $browserPattern })
  $s = $null
  # 优先操作灵动岛当前显示的那个播放器，避免多会话时误控浏览器/其它应用
  $preferredApp = $env:WINISLAND_MEDIA_APP
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
    $st = Get-SessionPlaybackStatus $s
    switch ($Cmd) {
      'play'  { AwaitAction ($s.TryPlayAsync()) }
      'pause' { AwaitAction ($s.TryPauseAsync()) }
      'toggle' {
        if ($st -eq 'Playing') { AwaitAction ($s.TryPauseAsync()) }
        else { AwaitAction ($s.TryPlayAsync()) }
      }
      'next'  { AwaitAction ($s.TrySkipNextAsync()) }
      'prev'  { AwaitAction ($s.TrySkipPreviousAsync()) }
      'seek'  {
        if ($env:WINISLAND_SEEK_SEC) {
          $ticks = [long]([double]$env:WINISLAND_SEEK_SEC * 10000000)
          Await ($s.TryChangePlaybackPositionAsync($ticks)) ([bool])
        }
      }
      'rewind' {
        Await ($s.TryChangePlaybackPositionAsync(0)) ([bool]) | Out-Null
        AwaitAction ($s.TryPlayAsync())
      }
    }
    exit 0
  }
} catch { }

# SMTC 无会话 → 兜底多媒体键
$vk = switch ($Cmd) {
  'next' { 0xB0 }
  'prev' { 0xB1 }
  default { 0xB3 }
}
Send-MediaKey $vk
