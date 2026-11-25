$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# 无线外设电量采集：
# 1) 蓝牙 HID 设备 —— 读 PnP 属性 DEVPKEY_Bluetooth_Battery
# 2) 含 "Battery" 关键字的设备属性兜底
# 3) 分类：鼠标 / 键盘 / 耳机 / 其他

function Get-Kind($name) {
  $n = [string]$name
  if ($n -match '鼠标|mouse|mice|MX Master|MX Anywhere|G Pro|Razer|罗技鼠标') { return 'mouse' }
  if ($n -match '键盘|keyboard|Keychron|Filco|HHKB') { return 'keyboard' }
  if ($n -match '耳机|headset|headphone|AirPods|Buds|Ear|Audio') { return 'headset' }
  if ($n -match '手柄|controller|gamepad|Xbox|DualSense|DualShock') { return 'gamepad' }
  return 'other'
}

$result = @()
$seen = @{}

$classes = @('Mouse', 'Keyboard', 'HIDClass', 'Bluetooth')
$devices = Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $classes -contains $_.Class }

foreach ($d in $devices) {
  $name = $d.FriendlyName
  if (-not $name) { continue }
  if ($name -match '符合 HID 标准|HID-compliant|USB 输入设备|USB Input Device|虚拟|Virtual|Root') { continue }

  $level = $null
  $keys = @('DEVPKEY_Bluetooth_Battery', 'DEVPKEY_Device_BatteryLevel')
  foreach ($k in $keys) {
    $p = Get-PnpDeviceProperty -InstanceId $d.InstanceId -KeyName $k -ErrorAction SilentlyContinue
    if ($p -and $null -ne $p.Data) {
      $v = 0
      if ([int]::TryParse([string]$p.Data, [ref]$v) -and $v -gt 0 -and $v -le 100) { $level = $v; break }
    }
  }
  # 兜底：扫描该设备全部属性中带 Battery 的键（不同厂商/驱动键名不一致）
  if ($null -eq $level) {
    $all = Get-PnpDeviceProperty -InstanceId $d.InstanceId -ErrorAction SilentlyContinue |
      Where-Object { $_.KeyName -match 'Battery' -and $null -ne $_.Data }
    foreach ($ap in $all) {
      $v = 0
      if ([int]::TryParse([string]$ap.Data, [ref]$v) -and $v -gt 0 -and $v -le 100) { $level = $v; break }
    }
  }
  if ($null -eq $level) { continue }

  $key = "$name|$level"
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = 1
  $result += [pscustomobject]@{
    name     = $name
    kind     = (Get-Kind $name)
    level    = $level
    conn     = 'BT'
    charging = $false
    protocol = 'BLE'
    stale    = $false
    class    = $d.Class
  }
}

$obj = [ordered]@{
  ok      = $true
  count   = $result.Count
  devices = $result
  ts      = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
}
Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
