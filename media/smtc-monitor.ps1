# WinIsland SMTC 媒体监控 - 长驻进程，每 2s 输出一行 JSON
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

# WinRT IAsyncOperation -> .NET Task 辅助
$script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]

function Await($WinRtTask, $ResultType) {
  $netTask = $script:asTask.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(-1) | Out-Null
  $netTask.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

$artPath = Join-Path $env:TEMP 'winisland-art.png'
$lastKey = ''
$script:sessionHistory = @{} # AUMID -> @{ lastPos, lastAt, status }

function Get-SessionPlaybackStatus($s) {
  if (-not $s) { return 'Unknown' }
  $status = 'Unknown'
  try {
    $pi = $s.GetPlaybackInfo()
    if ($pi) {
      if ($pi.PlaybackStatus) {
        $status = $pi.PlaybackStatus.ToString()
      }
      # 强效识别：在部分 Web/Electron 播放器中，即使 PlaybackStatus 未置 Playing，但如果支持暂停且不能点播放，必在播放中
      if ($pi.Controls -and $pi.Controls.IsPauseEnabled -and (-not $pi.Controls.IsPlayEnabled)) {
        $status = 'Playing'
      }
    }
  } catch {}
  if ($status -eq 'Unknown') {
    try {
      if ($s.PlaybackInfo -and $s.PlaybackInfo.Status) {
        $status = $s.PlaybackInfo.Status.ToString()
      }
    } catch {}
  }

  return $status
}

# ---------- 窗口标题降级检测（适配未接入 SMTC 的国内播放器） ----------
# 网易云/QQ音乐等会把「歌名 - 歌手」写进主窗口标题
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WinIslandWinEnum {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lp);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static List<string> GetTitles() {
    var list = new List<string>();
    EnumWindows((h, lp) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(256);
      GetWindowText(h, sb, 256);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      list.Add(pid + "|" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@

# 支持降级检测的播放器进程名（含主流官方与知名第三方/开源/非官方播放器） -> 标准应用名
$fallbackApps = @{
  'cloudmusic'        = '网易云音乐'
  'qqmusic'           = 'QQ音乐'
  'qqmusicpc'         = 'QQ音乐'
  'kugou'             = '酷狗音乐'
  'kuwo'              = '酷我音乐'
  'migumusic'         = '咪咕音乐'
  'sodamusic'         = '汽水音乐'
  'soda'              = '汽水音乐'
  'yesplaymusic'      = 'YesPlayMusic'
  'lx-music-desktop'  = '洛雪音乐'
  'lx-music'          = '洛雪音乐'
  'musicfree'         = 'MusicFree'
  'listen1'           = 'Listen 1'
  'saltplayer'        = '椒盐音乐'
  'salt'              = '椒盐音乐'
  'hyplayer'          = 'HyPlayer'
  'cider'             = 'Cider'
  'musicbee'          = 'MusicBee'
  'foobar2000'        = 'foobar2000'
  'aimp'              = 'AIMP'
  'potplayer'         = 'PotPlayer'
  'potplayermini64'   = 'PotPlayer'
  'potplayermini'     = 'PotPlayer'
  'vlc'               = 'VLC'
  'dopamine'          = 'Dopamine'
  'tahoemusicstation' = 'Tahoe 音乐'
  'tahoe'             = 'Tahoe 音乐'
  'transubplayer'     = 'TransubPlayer'
  'gpplayer'          = 'Gpplayer'
  'feeluown'          = 'FeelUOwn'
  'moosync'           = 'Moosync'
  'mineradio'         = 'Mineradio'
}
# 静态标题（未播放时的窗口标题）
$staticTitles = @(
  '网易云音乐', 'QQ音乐', '酷狗音乐', '酷我音乐', '咪咕音乐', '汽水音乐',
  'YesPlayMusic', '洛雪音乐助手', 'LX Music', 'MusicFree', 'Listen 1',
  '椒盐音乐', 'Salt Player', 'HyPlayer', 'Cider', 'MusicBee',
  'foobar2000', 'AIMP', 'PotPlayer', 'VLC media player', 'Dopamine',
  'Mineradio', 'Folia', 'Folia Remote'
)
# 排除非音乐软件的窗口与进程
$excludeProcesses = @(
  'explorer', 'chrome', 'msedge', 'firefox', '360se', 'code', 'devenv', 'idea', 'taskmgr', 'cmd', 'powershell', 'pwsh', 'electron', 'winisland',
  'potplayer', 'potplayermini64', 'potplayermini', 'vlc', 'mpc-hc', 'mpc-hc64', 'mpc-be', 'mpc-be64', 'kmplayer',
  'baofeng', 'xunlei', 'kankan', 'iqiyi', 'youku', 'tencentvideo', 'qqlive', 'mgtv', 'bilibili', 'douyin', 'ffplay', 'mpv'
)

# 记住每个应用最近一次的有效歌名（悬停按钮时标题会被清空）
$lastFallbackTitle = @{}
$script:lastSource = ''  # smtc | wintitle，保持显示来源稳定不被其它应用抢占

# 常见音乐播放软件进程名（用于「是否有播放器在运行」判断）
$playerProcNames = @(
  'cloudmusic', 'qqmusic', 'qqmusicpc', 'kugou', 'kuwo', 'migumusic',
  'sodamusic', 'soda', 'yesplaymusic', 'lx-music-desktop', 'lx-music',
  'musicfree', 'listen1', 'saltplayer', 'salt', 'hyplayer', 'cider', 'musicbee',
  'spotify', 'music.ui', 'itunes', 'foobar2000', 'aimp', 'dopamine', 'tahoemusicstation', 'tahoe', 'transubplayer', 'gpplayer',
  'feeluown', 'moosync', 'mineradio', 'folia', 'folia-major'
)


function Test-IsVideoSession($s, $props, $duration) {
  if (-not $s) { return $false }
  try {
    $pi = $s.GetPlaybackInfo()
    if ($pi -and $pi.PlaybackType) {
      if ($pi.PlaybackType.ToString() -eq 'Video') { return $true }
    }
  } catch {}

  $appId = ($s.SourceAppUserModelId -replace '"', '').ToLower()
  $videoAppPatterns = 'zunevideo|potplayer|vlc|mpc-hc|mpc-be|kmplayer|iina|movist|gomplayer|baofeng|xunlei|kankan|iqiyi|qiyi|youku|tencentvideo|qqlive|mgtv|bilibili|douyin|kuaishou|ffplay|mpv'
  if ($appId -match $videoAppPatterns) { return $true }

  $title = if ($props -and $props.Title) { $props.Title.Trim() } else { '' }
  $artist = if ($props -and $props.Artist) { $props.Artist.Trim() } else { '' }
  $album = if ($props -and $props.AlbumTitle) { $props.AlbumTitle.Trim() } else { '' }

  # 视频扩展名
  $videoExtPattern = '(?i).(mp4|mkv|avi|flv|rmvb|wmv|mov|ts|m2ts|webm|vob|iso|rm|f4v|mpg|mpeg|m4v|3gp|asf)(s|$|?|#)'
  if ($title -match $videoExtPattern) { return $true }

  # 视频分辨率与压制标签
  $videoTagPattern = '(?i)(1080p|720p|2160p|4k|bluray|hdtv|web-dl|web-rip|bdrip|remux|x264|x265|hevc)|第s*d+s*[集话期]|(?i)(ep|sd+e)d+'
  if ($title -match $videoTagPattern) { return $true }

  # 长视频判定：时长大于 15 分钟 (900秒) 且 Artist 为空
  if ($duration -and $duration -gt 900 -and [string]::IsNullOrWhiteSpace($artist)) {
    return $true
  }

  # 浏览器网页视频过滤
  $browserPattern = 'msedge|chrome|firefox|360se|brave|opera'
  if ($appId -match $browserPattern) {
    $videoSitePattern = '(?i)( - 哔哩哔哩| - bilibili| - YouTube| - 优酷| - 爱奇艺| - 腾讯视频| - 西瓜视频| - 抖音| - 快手)'
    if ($title -match $videoSitePattern) { return $true }
    if ([string]::IsNullOrWhiteSpace($artist) -and [string]::IsNullOrWhiteSpace($album)) {
      return $true
    }
  }

  return $false
}

function Test-PlayerRunning {
  foreach ($n in $playerProcNames) {
    if (Get-Process -Name $n -ErrorAction SilentlyContinue) { return $true }
  }
  # 检查是否有任何包含 music / player / sound 的第三方进程正在运行
  $dyn = Get-Process -ErrorAction SilentlyContinue | Where-Object {
    ($_.ProcessName -match 'music|player|sound|audio') -and ($excludeProcesses -notcontains $_.ProcessName.ToLower())
  }
  if ($dyn) { return $true }

  # 只要存在任何非浏览器的 SMTC 媒体会话（如 Folia / top.izuna.foliamajor），立刻认定播放器在运行
  if ($mgr) {
    try {
      $sessions = @($mgr.GetSessions())
      foreach ($s in $sessions) {
        $aumid = $s.SourceAppUserModelId
        if ($aumid -and ($aumid.ToLower() -notmatch 'msedge|chrome|firefox|360se|brave|opera')) {
          return $true
        }
      }
    } catch {}
  }
  return $false
}

# 该 AUMID 是否属于「SMTC 残缺」的国内播放器（这些应用只走窗口标题通道）
function Test-IsFallbackApp($appId) {
  if (-not $appId) { return $false }
  foreach ($k in $fallbackApps.Keys) {
    if ($appId -match [regex]::Escape($k)) { return $true }
  }
  return $false
}

# ---------- 网易云无障碍进度读取（需 --force-renderer-accessibility 启动） ----------
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$script:uiaOk = $true

function Get-NeteaseProgress {
  # 返回 @{ pos=秒; dur=秒 } 或 $null
  if (-not $script:uiaOk) { return $null }
  try {
    $p = Get-Process cloudmusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $p) { return $null }
    $root = [System.Windows.Automation.AutomationElement]::FromHandle($p.MainWindowHandle)
    if (-not $root) { return $null }
    $cond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Text)
    $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
    $times = New-Object System.Collections.ArrayList
    foreach ($el in $els) {
      $n = $el.Current.Name
      if (-not $n) { continue }
      $m1 = [regex]::Match($n, '^\s*(\d{1,2}):(\d{2})\s*/\s*(\d{1,2}):(\d{2})\s*$')
      if ($m1.Success) {
        $pos = [int]$m1.Groups[1].Value * 60 + [int]$m1.Groups[2].Value
        $dur = [int]$m1.Groups[3].Value * 60 + [int]$m1.Groups[4].Value
        if ($dur -gt 0) { return @{ pos = $pos; dur = $dur } }
      }
      $m2 = [regex]::Match($n, '^\s*(\d{1,2}):(\d{2})\s*$')
      if ($m2.Success) {
        [void]$times.Add([int]$m2.Groups[1].Value * 60 + [int]$m2.Groups[2].Value)
      }
    }
    if ($times.Count -ge 2) {
      $dur = [Math]::Max($times[0], $times[1])
      $pos = [Math]::Min($times[0], $times[1])
      if ($dur -gt 0) { return @{ pos = $pos; dur = $dur } }
    }
    return $null
  } catch {
    return $null
  }
}

function Get-WindowTitleMedia {
  # 1. 优先从已知播放器列表精准提取
  $procNames = @($fallbackApps.Keys)
  $targets = @{}
  foreach ($p in (Get-Process -Name $procNames -ErrorAction SilentlyContinue)) {
    $targets[$p.Id] = $p
  }

  $titles = [WinIslandWinEnum]::GetTitles()
  if ($targets.Count -gt 0) {
    $byApp = @{}
    foreach ($entry in $titles) {
      $wpid = [int](($entry -split '\|')[0])
      if ($targets.ContainsKey($wpid)) {
        $procName = $targets[$wpid].Name.ToLower()
        $title = $entry.Substring($entry.IndexOf('|') + 1)
        if (-not $byApp.ContainsKey($procName)) { $byApp[$procName] = @{ hasWindow = $false; title = '' } }
        $byApp[$procName].hasWindow = $true
        if ($title.Trim().Length -gt 0) { $byApp[$procName].title = $title.Trim() }
      }
    }

    foreach ($procName in $byApp.Keys) {
      $appName = $fallbackApps[$procName]
      if (-not $appName) { $appName = $procName }
      $info = $byApp[$procName]
      $title = $info.title

      if (-not $info.hasWindow) {
        $lastFallbackTitle.Remove($procName) | Out-Null
        continue
      }
      if ($title -and ($staticTitles -contains $title -or $title -eq $appName)) {
        $lastFallbackTitle.Remove($procName) | Out-Null
        continue
      }
      if (-not $title) { $title = $lastFallbackTitle[$procName] }
      if (-not $title) { continue }
      $lastFallbackTitle[$procName] = $title

      $song = ($title -replace (' - ' + [regex]::Escape($appName) + '$'), '').Trim()
      $artist = ''
      $parts = $song -split ' - ', 2
      if ($parts.Count -eq 2 -and $parts[0].Length -gt 0) {
        $song = $parts[0].Trim(); $artist = $parts[1].Trim()
      }
      return [PSCustomObject]@{
        app = $procName; title = $song; artist = $artist; album = ''
        status = 'Playing'; duration = $null; position = $null; art = $null
        source = 'wintitle'; canSeek = $false
      }
    }
  }

  # 2. 启发式非官方播放器检测：查找标题中含有 " - " 且进程特征符合的可见窗口
  foreach ($entry in $titles) {
    $parts = $entry -split '\|', 2
    if ($parts.Count -lt 2) { continue }
    $wpid = [int]$parts[0]
    $title = $parts[1].Trim()
    if ($title.Length -lt 3 -or ($title -notmatch '\s*-\s*')) { continue }

    $p = Get-Process -Id $wpid -ErrorAction SilentlyContinue
    if (-not $p) { continue }
    $pName = $p.ProcessName.ToLower()
    if ($excludeProcesses -contains $pName) { continue }

    $isMusicClue = ($pName -match 'music|player|sound|audio|song|play|soda|lx|salt|hy|cider|mineradio|folia')
    if ($isMusicClue -and ($staticTitles -notcontains $title)) {
      $songParts = $title -split '\s*-\s*', 2
      $song = $songParts[0].Trim()
      $artist = if ($songParts.Count -gt 1) { $songParts[1].Trim() } else { '' }
      $artist = ($artist -replace ('\s*' + [regex]::Escape($pName) + '$'), '').Trim()

      return [PSCustomObject]@{
        app = $pName; title = $song; artist = $artist; album = ''
        status = 'Playing'; duration = $null; position = $null; art = $null
        source = 'wintitle'; canSeek = $false
      }
    }
  }

  return $null
}

function Get-MediaSessionObject($s) {
  $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])

  $status = Get-SessionPlaybackStatus $s

  $duration = $null; $position = $null; $canSeek = $false
  try {
    $tl = $s.GetTimelineProperties()
    $duration = [math]::Round($tl.EndTime.TotalSeconds, 2)
    $rawPos = $tl.Position.TotalSeconds

    # WinRT SMTC 规范：Position 是在 LastUpdatedTime 发生时的静态快照
    # 当处于播放状态且存在有效的 LastUpdatedTime 时，实时时间 = 快照 + 流逝秒数
    if ($status -eq 'Playing' -and $tl.LastUpdatedTime) {
      try {
        $nowUtc = [DateTimeOffset]::UtcNow
        $lut = $tl.LastUpdatedTime.ToUniversalTime()
        $elapsed = ($nowUtc - $lut).TotalSeconds
        if ($elapsed -gt 0 -and $elapsed -lt 86400) {
          $rawPos = $rawPos + $elapsed
        }
      } catch {}
    }
    if ($duration -and $rawPos -gt $duration) {
      $rawPos = $duration
    }
    if ($rawPos -lt 0) { $rawPos = 0 }
    $position = [math]::Round($rawPos, 2)
  } catch {}
  try { $canSeek = [bool]$s.Controls.IsPlaybackPositionEnabled } catch {}

  # 专辑封面（仅标题变化时重写文件）
  $art = $null
  try {
    $key = "$($s.SourceAppUserModelId)|$($props.Title)"
    if ($props.Title -and $key -ne $script:lastKey) {
      $script:lastKey = $key
      $script:hasArt = $false
      if ($props.Thumbnail) {
        $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
        if ($stream -and $stream.Size -gt 0) {
          $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
          Await ($reader.LoadAsync($stream.Size)) ([UInt32]) | Out-Null
          $bytes = New-Object byte[] $stream.Size
          $reader.ReadBytes($bytes)
          [IO.File]::WriteAllBytes($script:artPath, $bytes)
          $script:hasArt = $true
        }
      }
    }
    if ($props.Title -and $script:hasArt -and (Test-Path $script:artPath)) { $art = $script:artPath }
  } catch {}

  [PSCustomObject]@{
    app      = $s.SourceAppUserModelId
    title    = $props.Title
    artist   = $props.Artist
    album    = $props.AlbumTitle
    status   = $status
    duration = $duration
    position = $position
    art      = $art
    source   = 'smtc'
    canSeek  = $canSeek
  }
}

while ($true) {
  try {
    $playerRunning = Test-PlayerRunning
    $all = @($mgr.GetSessions())
    if ($env:WINISLAND_MEDIA_DEBUG) {
      Write-Output ('{"debug":true,"count":' + $all.Count + ',"playerRunning":' + $playerRunning + '}')
      try {
        $fbDbg = Get-WindowTitleMedia
        if ($fbDbg) {
          Write-Output ('{"debug":true,"fb":' + ($fbDbg | ConvertTo-Json -Compress) + '}')
        } else {
          Write-Output '{"debug":true,"fb":null}'
        }
      } catch {
        Write-Output ('{"debug":true,"fberr":"' + ($_.Exception.Message -replace '"', '') + '"}')
      }
      foreach ($s in $all) {
        $st = Get-SessionPlaybackStatus $s
        $t = ''
        try {
          $p2 = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
          if ($p2 -and $p2.Title) { $t = ($p2.Title -replace '"', '') -replace '\\', '/' }
        } catch {}
        if ($t.Length -gt 60) { $t = $t.Substring(0, 60) }
        $aid = ''
        if ($s.SourceAppUserModelId) { $aid = $s.SourceAppUserModelId -replace '"', '' }
        Write-Output ('{"debug":true,"app":"' + $aid + '","status":"' + $st + '","title":"' + $t + '"}')
      }
    }

    $smtcUsable = @()
    foreach ($s in $all) {
      $st = Get-SessionPlaybackStatus $s
      if ($st -eq 'Closed') { continue }
      # 残缺 SMTC 的国内播放器（网易云等）永不使用其 SMTC 会话，避免来源摇摆
      if (Test-IsFallbackApp $s.SourceAppUserModelId) { continue }

      # 过滤视频会话，避免播放视频时灵动岛跳出提示
      try {
        $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $tl = $s.GetTimelineProperties()
        $dur = if ($tl) { $tl.EndTime.TotalSeconds } else { 0 }
        if (Test-IsVideoSession $s $p $dur) { continue }
      } catch {}

      $smtcUsable += $s
    }

    # 专属音乐播放器（如 Folia、Spotify、汽水等）会话绝对优先于通用浏览器
    $browserPattern = 'msedge|chrome|firefox|360se|brave|opera'
    $musicSessions = @($smtcUsable | Where-Object { $_.SourceAppUserModelId.ToLower() -notmatch $browserPattern })
    $browserSessions = @($smtcUsable | Where-Object { $_.SourceAppUserModelId.ToLower() -match $browserPattern })

    $smtcSelected = $null
    if ($musicSessions.Count -gt 0) {
      # 专属音乐软件优先：首选 Playing
      $smtcSelected = $musicSessions | Where-Object { (Get-SessionPlaybackStatus $_) -eq 'Playing' } | Select-Object -First 1
      if (-not $smtcSelected) {
        # 次选 Paused 或只要有曲目标题的会话
        $smtcSelected = $musicSessions | Where-Object {
          try {
            $p = Await ($_.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            return [bool]($p -and $p.Title)
          } catch { return $false }
        } | Select-Object -First 1
      }
      if (-not $smtcSelected) {
        $smtcSelected = $musicSessions | Select-Object -First 1
      }
    }

    # 若无任何专属音乐会话，才考虑浏览器会话
    if (-not $smtcSelected -and $browserSessions.Count -gt 0) {
      $smtcSelected = $browserSessions | Where-Object { (Get-SessionPlaybackStatus $_) -eq 'Playing' } | Select-Object -First 1
      if (-not $smtcSelected) {
        $smtcSelected = $browserSessions | Where-Object { (Get-SessionPlaybackStatus $_) -eq 'Paused' } | Select-Object -First 1
      }
    }

    $fb = Get-WindowTitleMedia

    # 网易云无障碍进度（有则补充 duration/position/canSeek）
    if ($fb -and $fb.app -eq 'cloudmusic') {
      $prog = Get-NeteaseProgress
      if ($prog) {
        $fb | Add-Member -NotePropertyName duration -NotePropertyValue $prog.dur -Force
        $fb | Add-Member -NotePropertyName position -NotePropertyValue $prog.pos -Force
        $fb | Add-Member -NotePropertyName canSeek -NotePropertyValue $true -Force
      }
    }

    $obj = $null
    $outSource = ''
    if ($fb -and $smtcSelected) {
      $selIsMusic = ($smtcSelected.SourceAppUserModelId.ToLower() -notmatch $browserPattern)
      if ($selIsMusic) {
        # 正规音乐软件的 SMTC 会话（非浏览器）优先
        $obj = Get-MediaSessionObject $smtcSelected; $outSource = 'smtc'
      } else {
        # 浏览器会话（网页/短视频）让位给正在显示曲目的本地音乐软件，
        # 否则网易云这类只走窗口标题的播放器永远抢不到显示
        $obj = $fb; $outSource = 'wintitle'
      }
    } elseif ($fb) {
      $obj = $fb; $outSource = 'wintitle'
    } elseif ($smtcSelected) {
      $obj = Get-MediaSessionObject $smtcSelected; $outSource = 'smtc'
    }

    if ($obj) {
      $obj | Add-Member -NotePropertyName playerRunning -NotePropertyValue $playerRunning -Force
      if ($outSource) { $script:lastSource = $outSource }
      $obj | ConvertTo-Json -Compress
    } else {
      $script:lastSource = ''
      [PSCustomObject]@{
        app = $null; title = ''; artist = ''; album = ''; status = 'None'
        duration = $null; position = $null; art = $null; source = $null
        canSeek = $false; playerRunning = $playerRunning
      } | ConvertTo-Json -Compress
    }
  } catch {
    '{"app":null,"title":"","artist":"","album":"","status":"None","duration":null,"position":null,"art":null,"source":null,"canSeek":false,"playerRunning":false}'
  }
  Start-Sleep -Milliseconds 1000
}
