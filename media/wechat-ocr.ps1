param(
  [int]$IntervalMs = 600,
  [switch]$TestShot,
  [switch]$SelfTest,
  [string]$TestHwnd = ''
)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# WeChat 4.x fallback channel: we cannot read its Qt-drawn UI via UIA, so we
# screenshot the notification popup and OCR it with the built-in Windows OCR.
# Only popup-sized windows of WeChat processes are captured (no full-screen polling).

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime

Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class OcrWin {
  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int m);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int m);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  public struct RECT { public int l, t, r, b; }
  public static bool CaptureTo(IntPtr h, IntPtr hdc) { return PrintWindow(h, hdc, 2); }

  public static List<string> Candidates(uint[] pids) {
    var res = new List<string>();
    EnumWindows((h, p) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0) return true;
      AddWin(h, res);
      EnumChildWindows(h, (c, q) => { AddWin(c, res); return true; }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return res;
  }

  static void AddWin(IntPtr h, List<string> res) {
    if (!IsWindowVisible(h)) return;
    RECT r; GetWindowRect(h, out r);
    int w = r.r - r.l, hh = r.b - r.t;
    if (w < 160 || hh < 50) return;
    if (w > 760 || hh > 520) return;
    // 通知弹窗是宽扁的卡片；聊天窗口偏方，靠长宽比排掉，避免误报
    if (hh > 240) return;
    if (w / (double)hh < 1.8) return;
    var cn = new StringBuilder(160); GetClassName(h, cn, 160);
    var tt = new StringBuilder(160); GetWindowText(h, tt, 160);
    if (cn.ToString() -match 'IME|MSCTF') return;
    res.Add(h.ToInt64() + "|" + r.l + "|" + r.t + "|" + w + "|" + hh + "|" + cn + "|" + tt);
  }
}
"@

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, $type) {
  try {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(4000) | Out-Null
    return $task.Result
  } catch { return $null }
}

$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.InMemoryRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataWriter, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if (-not $engine) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language 'zh-Hans-CN'))
}
if (-not $engine) { Write-Output '{"type":"ocr-unavailable"}'; exit }

function Get-BitmapFromHwnd([int64]$hwnd) {
  $r = New-Object OcrWin+RECT
  if (-not [OcrWin]::GetWindowRect([IntPtr]$hwnd, [ref]$r)) { return $null }
  $w = $r.r - $r.l; $h = $r.b - $r.t
  if ($w -le 0 -or $h -le 0) { return $null }
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $ok = $false
  try {
    $hdc = $g.GetHdc()
    $ok = [OcrWin]::CaptureTo([IntPtr]$hwnd, $hdc)
    $g.ReleaseHdc($hdc)
  } catch { }
  if (-not $ok) {
    # PrintWindow 失败（部分自绘窗口）时退回屏幕拷贝
    try { $g.CopyFromScreen($r.l, $r.t, 0, 0, $bmp.Size); $ok = $true } catch { }
  }
  $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); return $null }
  # PrintWindow 对半透明/分层窗口常返回全黑图，抽几个点判断，黑图就改用屏幕拷贝
  $dark = 0
  foreach ($pt in @(@(2, 2), @([int]($w / 2), [int]($h / 2)), @($w - 3, $h - 3), @([int]($w / 2), 3))) {
    $c = $bmp.GetPixel($pt[0], $pt[1])
    if ($c.R -lt 8 -and $c.G -lt 8 -and $c.B -lt 8) { $dark++ }
  }
  if ($dark -ge 4) {
    try { $g2 = [System.Drawing.Graphics]::FromImage($bmp); $g2.CopyFromScreen($r.l, $r.t, 0, 0, $bmp.Size); $g2.Dispose() } catch { }
  }
  return $bmp
}

function Norm-Text([string]$t) {
  if (-not $t) { return '' }
  # OCR 会在中文字之间插空格，去掉；再把连续空格合并
  $t = $t -replace '(?<=[\u3000-\u303f\u4e00-\u9fa5\uff00-\uffef])\s+(?=[\u3000-\u303f\u4e00-\u9fa5\uff00-\uffef])', ''
  $t = $t -replace '[ \t]+', ' '
  return $t.Trim()
}

function Invoke-Ocr($bmp) {
  $script:ocrErr = ''
  try {
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bytes = $ms.ToArray()
    $ms.Dispose()

    $ras = New-Object Windows.Storage.Streams.InMemoryRandomAccessStream
    $writer = New-Object Windows.Storage.Streams.DataWriter($ras.GetOutputStreamAt(0))
    $writer.WriteBytes($bytes)
    $null = Await ($writer.StoreAsync()) ([uint32])
    $null = Await ($writer.FlushAsync()) ([bool])
    try { $writer.DetachStream() | Out-Null } catch { }
    $ras.Seek(0)

    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($ras)) ([Windows.Graphics.Imaging.BitmapDecoder])
    if (-not $decoder) { $script:ocrErr = 'decoder-null'; return '' }
    $soft = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    if (-not $soft) { $script:ocrErr = 'softwarebitmap-null'; return '' }
    $res = Await ($engine.RecognizeAsync($soft)) ([Windows.Media.Ocr.OcrResult])
    $soft.Dispose()
    $ras.Dispose()
    if (-not $res) { $script:ocrErr = 'result-null'; return '' }
    return [string]$res.Text
  } catch {
    $script:ocrErr = $_.Exception.Message
    return ''
  }
}

if ($SelfTest) {
  # 不依赖屏幕，直接画一张中文图验证 OCR 管线
  $bmp = New-Object System.Drawing.Bitmap(420, 120)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.Clear([System.Drawing.Color]::White)
  $font = New-Object System.Drawing.Font('Microsoft YaHei', 16)
  $g.DrawString('张三: 你好，这是一条测试消息', $font, [System.Drawing.Brushes]::Black, 10, 20)
  $g.DrawString('WeChat OCR self test 123', $font, [System.Drawing.Brushes]::DimGray, 10, 60)
  $g.Dispose()
  $txt = Norm-Text (Invoke-Ocr $bmp)
  $bmp.Dispose()
  Write-Output (@{ type = 'selftest'; text = $txt; err = $script:ocrErr } | ConvertTo-Json -Compress)
  exit
}

if ($TestShot) {
  $hwnd = [int64]$TestHwnd
  if (-not $hwnd) {
    $p = Get-Process Weixin, WeChat -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { $hwnd = [int64]$p.MainWindowHandle }
  }
  if (-not $hwnd) { Write-Output '{"type":"test","ok":false,"reason":"no-window"}'; exit }
  $bmp = Get-BitmapFromHwnd $hwnd
  if (-not $bmp) { Write-Output '{"type":"test","ok":false,"reason":"capture-failed"}'; exit }
  $txt = Norm-Text (Invoke-Ocr $bmp)
  $bmp.Dispose()
  $obj = [ordered]@{ type = 'test'; ok = [bool]$txt; text = $txt }
  Write-Output ($obj | ConvertTo-Json -Compress)
  exit
}

$seen = @{}
while ($true) {
  $pids = @(Get-Process Weixin, WeChat -ErrorAction SilentlyContinue | ForEach-Object { [uint32]$_.Id })
  $current = @{}
  if ($pids.Count -gt 0) {
    foreach ($line in [OcrWin]::Candidates([uint32[]]$pids)) {
      $parts = $line -split '\|'
      $hwnd = $parts[0]
      $current[$hwnd] = 1
      $bmp = Get-BitmapFromHwnd ([int64]$hwnd)
      if (-not $bmp) { continue }
      $txt = Invoke-Ocr $bmp
      $bmp.Dispose()
      if (-not $txt -or $txt.Trim().Length -lt 2) { continue }
      $lines = @($txt -split "`r?`n" | ForEach-Object { Norm-Text $_ } | Where-Object { $_ })
      if ($lines.Count -eq 0) { continue }
      # 同一个弹窗句柄会被复用，必须用「句柄+文字」做签名，文字变了才是一条新消息
      $sig = "$hwnd|$($lines -join '/')"
      if ($seen.ContainsKey($sig)) { continue }
      $seen[$sig] = (Get-Date)
      $obj = [ordered]@{
        type = 'wxpopup'
        cls  = $parts[5]
        texts = $lines
        ts   = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
      }
      Write-Output ($obj | ConvertTo-Json -Compress -Depth 4)
    }
  }
  # 弹窗消失后清掉它的签名，下次同一句柄再弹出还能识别
  if ($seen.Count -gt 0) {
    foreach ($k in @($seen.Keys)) {
      $h = ($k -split '\|')[0]
      if (-not $current.ContainsKey($h)) { $seen.Remove($k) }
    }
  }
  if ($seen.Count -gt 400) { $seen = @{} }
  Start-Sleep -Milliseconds $IntervalMs
}
