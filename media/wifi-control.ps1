param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$SSID = '',
  [string]$Password = '',
  [string]$Enabled = ''
)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Get-WifiRadioInfo {
  try {
    $null = [Windows.Devices.Radios.Radio, Windows.Devices.Radios, ContentType = WindowsRuntime]
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $op = [Windows.Devices.Radios.Radio]::GetRadiosAsync()
    $task = $asTask.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]).Invoke($null, @($op))
    $task.Wait(2500) | Out-Null
    foreach ($r in $task.Result) {
      if ($r.Kind -eq [Windows.Devices.Radios.RadioKind]::WiFi) {
        return @{ supported = $true; state = ([string]$r.State).ToLower(); name = $r.Name }
      }
    }
  } catch { }
  return @{ supported = $false; state = 'none'; name = '' }
}

function Set-WifiRadioState([bool]$On) {
  try {
    $null = [Windows.Devices.Radios.Radio, Windows.Devices.Radios, ContentType = WindowsRuntime]
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $op = [Windows.Devices.Radios.Radio]::GetRadiosAsync()
    $task = $asTask.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]).Invoke($null, @($op))
    $task.Wait(2500) | Out-Null
    $radio = $null
    foreach ($r in $task.Result) {
      if ($r.Kind -eq [Windows.Devices.Radios.RadioKind]::WiFi) { $radio = $r; break }
    }
    if (-not $radio) {
      Write-Output (@{ ok = $false; supported = $false; enabled = $false; error = '无可用无线网卡' } | ConvertTo-Json -Compress)
      return
    }
    $accessOp = [Windows.Devices.Radios.Radio]::RequestAccessAsync()
    $accessTask = $asTask.MakeGenericMethod([Windows.Devices.Radios.RadioAccessStatus]).Invoke($null, @($accessOp))
    $accessTask.Wait(2500) | Out-Null
    $access = [string]$accessTask.Result
    if ($access -ne 'Allowed') {
      Write-Output (@{ ok = $false; supported = $true; enabled = ([string]$radio.State -eq 'On'); access = $access; error = '系统未授权控制无线开关' } | ConvertTo-Json -Compress)
      return
    }
    $state = if ($On) { [Windows.Devices.Radios.RadioState]::On } else { [Windows.Devices.Radios.RadioState]::Off }
    $setOp = $radio.SetStateAsync($state)
    $setTask = $asTask.MakeGenericMethod([Windows.Devices.Radios.RadioAccessStatus]).Invoke($null, @($setOp))
    $setTask.Wait(4000) | Out-Null
    Start-Sleep -Milliseconds 1200
    $now = Get-WifiRadioInfo
    Write-Output (@{
      ok        = $true
      supported = $true
      enabled   = ($now.state -eq 'on')
      access    = [string]$setTask.Result
      state     = $now.state
    } | ConvertTo-Json -Compress)
    return
  } catch {
    Write-Output (@{ ok = $false; supported = $true; error = $_.Exception.Message } | ConvertTo-Json -Compress)
    return
  }
}

function Get-CurrentWifiStatus {
  $radio = Get-WifiRadioInfo
  if (-not $radio.supported) {
    return @{ supported = $false; enabled = $false; state = 'none'; ssid = ''; signal = 0 }
  }
  if ($radio.state -ne 'on') {
    return @{ supported = $true; enabled = $false; state = 'off'; ssid = ''; signal = 0 }
  }
  $out = netsh wlan show interfaces 2>$null
  $state = 'disconnected'
  $curSsid = ''
  $sig = 0
  if ($out) {
    $text = ($out -join "`n")
    if ($text -match '(?i)状态\s*:\s*已连接' -or $text -match '(?i)State\s*:\s*connected\b' -or ($text -match '已连接' -and $text -notmatch '未连接|已断开')) {
      $state = 'connected'
    }
    if ($state -eq 'connected') {
      foreach ($line in $out) {
        if ($line -match '^\s*SSID\s*:\s*(.+)$') { $curSsid = $Matches[1].Trim() }
        if ($line -match '信号|Signal') {
          $m = [regex]::Match($line, '(\d+)%')
          if ($m.Success) { $sig = [int]$m.Groups[1].Value }
        }
      }
    }
  }
  return @{ supported = $true; enabled = $true; state = $state; ssid = $curSsid; signal = $sig }
}

function Get-SavedProfiles {
  $list = @()
  $pOut = netsh wlan show profiles 2>$null
  foreach ($line in $pOut) {
    if ($line -match '所有用户配置文件|All User Profile\s*:\s*(.+)$') {
      $name = ($line -split ':', 2)[1].Trim()
      if ($name -and -not ($list -contains $name)) {
        $list += $name
      }
    }
  }
  return $list
}

function Get-WifiListJson {
  $status = Get-CurrentWifiStatus
  if (-not $status.supported) {
    $res = @{ ok = $false; supported = $false; enabled = $false; error = '无可用无线网卡' }
    Write-Output ($res | ConvertTo-Json -Compress)
    return
  }
  if (-not $status.enabled) {
    $res = @{ ok = $true; supported = $true; enabled = $false; state = 'off'; currentSsid = ''; currentSignal = 0; networks = @() }
    Write-Output ($res | ConvertTo-Json -Compress -Depth 5)
    return
  }

  $savedProfiles = Get-SavedProfiles
  $networksMap = @{}
  $permDenied = $false

  $netOut = netsh wlan show networks mode=bssid 2>&1
  $curSsid = ''
  $curAuth = ''
  $curSignal = 0

  foreach ($line in $netOut) {
    if ($line -match 'need location permission|位置权限|Access is denied') {
      $permDenied = $true
    }
    if ($line -match '^\s*SSID\s*\d*\s*:\s*(.+)$') {
      if ($curSsid) {
        if (-not $networksMap.ContainsKey($curSsid) -or $curSignal -gt $networksMap[$curSsid].signal) {
          $networksMap[$curSsid] = @{
            ssid      = $curSsid
            signal    = $curSignal
            auth      = $curAuth
            saved     = ($savedProfiles -contains $curSsid)
            connected = ($status.state -eq 'connected' -and $status.ssid -eq $curSsid)
          }
        }
      }
      $curSsid = $Matches[1].Trim()
      $curSignal = 0
      $curAuth = ''
    }
    if ($line -match '身份验证|Authentication\s*:\s*(.+)$') {
      $curAuth = ($line -split ':', 2)[1].Trim()
    }
    if ($line -match '信号|Signal') {
      $m = [regex]::Match($line, '(\d+)%')
      if ($m.Success) {
        $sigVal = [int]$m.Groups[1].Value
        if ($sigVal -gt $curSignal) { $curSignal = $sigVal }
      }
    }
  }
  if ($curSsid) {
    if (-not $networksMap.ContainsKey($curSsid) -or $curSignal -gt $networksMap[$curSsid].signal) {
      $networksMap[$curSsid] = @{
        ssid      = $curSsid
        signal    = $curSignal
        auth      = $curAuth
        saved     = ($savedProfiles -contains $curSsid)
        connected = ($status.state -eq 'connected' -and $status.ssid -eq $curSsid)
      }
    }
  }

  # 把已保存但扫描中没见到的 Wi-Fi 也列入
  foreach ($sp in $savedProfiles) {
    if (-not $networksMap.ContainsKey($sp)) {
      $networksMap[$sp] = @{
        ssid      = $sp
        signal    = if ($status.state -eq 'connected' -and $status.ssid -eq $sp) { $status.signal } else { 0 }
        auth      = 'WPA2-Personal'
        saved     = $true
        connected = ($status.state -eq 'connected' -and $status.ssid -eq $sp)
      }
    }
  }

  $arr = @($networksMap.Values)
  $sorted = @($arr | Sort-Object -Property @{ Expression = { if ($_.connected) { 0 } else { 1 } } }, @{ Expression = { $_.signal }; Descending = $true })

  $obj = [ordered]@{
    ok               = $true
    supported        = $true
    enabled          = $true
    state            = $status.state
    currentSsid      = $status.ssid
    currentSignal    = $status.signal
    permissionDenied = $permDenied
    networks         = @($sorted)
  }
  if ($obj.networks.Count -eq 0) {
    # 避免 ConvertTo-Json 将空数组变空对象
    $json = ($obj | ConvertTo-Json -Compress -Depth 5)
    $json = $json -replace '"networks":\{\}', '"networks":[]'
    Write-Output $json
  } else {
    Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
  }
}

function Connect-Wifi([string]$targetSsid, [string]$pwd) {
  if (-not $targetSsid) {
    Write-Output (@{ ok = $false; error = '未指定 Wi-Fi 名称' } | ConvertTo-Json -Compress)
    return
  }

  $savedProfiles = Get-SavedProfiles
  $isSaved = ($savedProfiles -contains $targetSsid)

  if ($pwd) {
    # 用户提供了密码，生成并导入新 profile
    $xml = @"
<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
    <name>$targetSsid</name>
    <SSIDConfig>
        <SSID>
            <name>$targetSsid</name>
        </SSID>
    </SSIDConfig>
    <connectionType>ESS</connectionType>
    <connectionMode>manual</connectionMode>
    <MSM>
        <security>
            <authEncryption>
                <authentication>WPA2PSK</authentication>
                <encryption>AES</encryption>
                <useOneX>false</useOneX>
            </authEncryption>
            <sharedKey>
                <keyType>passPhrase</keyType>
                <protected>false</protected>
                <keyMaterial>$pwd</keyMaterial>
            </sharedKey>
        </security>
    </MSM>
</WLANProfile>
"@
    $tmp = [System.IO.Path]::GetTempFileName() + ".xml"
    [System.IO.File]::WriteAllText($tmp, $xml, [System.Text.Encoding]::UTF8)
    netsh wlan add profile filename="$tmp" | Out-Null
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  } elseif (-not $isSaved) {
    # 开放未加密网络
    $xmlOpen = @"
<?xml version="1.0"?>
<WLANProfile xmlns="http://www.microsoft.com/networking/WLAN/profile/v1">
    <name>$targetSsid</name>
    <SSIDConfig>
        <SSID>
            <name>$targetSsid</name>
        </SSID>
    </SSIDConfig>
    <connectionType>ESS</connectionType>
    <connectionMode>manual</connectionMode>
    <MSM>
        <security>
            <authEncryption>
                <authentication>open</authentication>
                <encryption>none</encryption>
                <useOneX>false</useOneX>
            </authEncryption>
        </security>
    </MSM>
</WLANProfile>
"@
    $tmp = [System.IO.Path]::GetTempFileName() + ".xml"
    [System.IO.File]::WriteAllText($tmp, $xmlOpen, [System.Text.Encoding]::UTF8)
    netsh wlan add profile filename="$tmp" | Out-Null
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
  }

  # 发起连接
  netsh wlan connect name="$targetSsid" | Out-Null

  # 轮询 3 秒检测是否连接成功
  $connected = $false
  for ($i = 0; $i -lt 6; $i++) {
    Start-Sleep -Milliseconds 500
    $st = Get-CurrentWifiStatus
    if ($st.state -eq 'connected' -and $st.ssid -eq $targetSsid) {
      $connected = $true
      break
    }
  }

  $res = @{
    ok        = $connected
    connected = $connected
    ssid      = $targetSsid
    message   = if ($connected) { '连接成功' } else { '已发出连接请求，正在连接…' }
  }
  Write-Output ($res | ConvertTo-Json -Compress)
}

function Disconnect-Wifi {
  netsh wlan disconnect | Out-Null
  Start-Sleep -Milliseconds 600
  $res = @{ ok = $true; disconnected = $true }
  Write-Output ($res | ConvertTo-Json -Compress)
}

switch ($Action) {
  'list'       { Get-WifiListJson }
  'connect'    { Connect-Wifi $SSID $Password }
  'disconnect' { Disconnect-Wifi }
  'radio'      { Set-WifiRadioState ($Enabled -eq '1') }
  default      { Get-WifiListJson }
}
