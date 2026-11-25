param(
  [Parameter(Mandatory = $true)][string]$Action,
  [string]$Value = ''
)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceEnumerator {
  int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection ppDevices);
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
  int GetDevice(string pwstrId, out IMMDevice ppDevice);
  int RegisterEndpointNotificationCallback(IntPtr pClient);
  int UnregisterEndpointNotificationCallback(IntPtr pClient);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDeviceCollection {
  int GetCount(out int pcDevices);
  int Item(int nDevice, out IMMDevice ppDevice);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMMDevice {
  int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
  int OpenPropertyStore(int stgmAccess, out IPropertyStore ppProperties);
  int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
  int GetState(out int pdwState);
}

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  int GetCount(out int cProps);
  int GetAt(int iProp, out PROPERTYKEY pkey);
  int GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public int pid; }

[StructLayout(LayoutKind.Explicit)]
public struct PROPVARIANT {
  [FieldOffset(0)] public short vt;
  [FieldOffset(8)] public IntPtr pointerValue;
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
public class MMDeviceEnumeratorComObject { }

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IAudioEndpointVolume {
  int NotImpl1(); int NotImpl2();
  int GetChannelCount(out int pnChannelCount);
  int SetMasterVolumeLevel(float fLevelDB, Guid pguidEventContext);
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int GetMasterVolumeLevel(out float pfLevelDB);
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int SetChannelVolumeLevel(uint nChannel, float fLevelDB, Guid pguidEventContext);
  int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, Guid pguidEventContext);
  int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
  int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
  int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
  int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
}

[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPolicyConfig {
  int GetMixFormat(string pszDeviceName, IntPtr ppFormat);
  int GetDeviceFormat(string pszDeviceName, bool bDefault, IntPtr ppFormat);
  int ResetDeviceFormat(string pszDeviceName);
  int SetDeviceFormat(string pszDeviceName, IntPtr pEndpointFormat, IntPtr mixFormat);
  int GetProcessingPeriod(string pszDeviceName, bool bDefault, IntPtr pmftDefaultPeriod, IntPtr pmftMinimumPeriod);
  int SetProcessingPeriod(string pszDeviceName, IntPtr pmftPeriod);
  int GetShareMode(string pszDeviceName, IntPtr pMode);
  int SetShareMode(string pszDeviceName, IntPtr mode);
  int GetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
  int SetPropertyValue(string pszDeviceName, bool bFxStore, IntPtr key, IntPtr pv);
  int SetDefaultEndpoint(string pszDeviceName, int role);
  int SetEndpointVisibility(string pszDeviceName, bool bVisible);
}

[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
public class CPolicyConfigClient { }

public class SysAudio {
  static IMMDeviceEnumerator Enum() {
    return (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
  }

  public static float GetVolume() {
    IMMDevice dev; Enum().GetDefaultAudioEndpoint(0, 1, out dev);
    object o; Guid iid = typeof(IAudioEndpointVolume).GUID;
    dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    float v; ((IAudioEndpointVolume)o).GetMasterVolumeLevelScalar(out v);
    return v;
  }

  public static bool GetMute() {
    IMMDevice dev; Enum().GetDefaultAudioEndpoint(0, 1, out dev);
    object o; Guid iid = typeof(IAudioEndpointVolume).GUID;
    dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    bool m; ((IAudioEndpointVolume)o).GetMute(out m);
    return m;
  }

  public static void SetVolume(float v) {
    IMMDevice dev; Enum().GetDefaultAudioEndpoint(0, 1, out dev);
    object o; Guid iid = typeof(IAudioEndpointVolume).GUID;
    dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    ((IAudioEndpointVolume)o).SetMasterVolumeLevelScalar(v, Guid.Empty);
  }

  public static void SetMute(bool m) {
    IMMDevice dev; Enum().GetDefaultAudioEndpoint(0, 1, out dev);
    object o; Guid iid = typeof(IAudioEndpointVolume).GUID;
    dev.Activate(ref iid, 23, IntPtr.Zero, out o);
    ((IAudioEndpointVolume)o).SetMute(m, Guid.Empty);
  }

  public static string GetDefaultId() {
    IMMDevice dev; Enum().GetDefaultAudioEndpoint(0, 1, out dev);
    string id; dev.GetId(out id);
    return id;
  }

  public static List<string> ListRender() {
    var list = new List<string>();
    IMMDeviceCollection col;
    Enum().EnumAudioEndpoints(0, 1, out col);
    int n; col.GetCount(out n);
    var pkey = new PROPERTYKEY();
    pkey.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
    pkey.pid = 14;
    for (int i = 0; i < n; i++) {
      IMMDevice d; col.Item(i, out d);
      string id; d.GetId(out id);
      string name = "";
      IPropertyStore ps;
      if (d.OpenPropertyStore(0, out ps) == 0) {
        PROPVARIANT pv;
        if (ps.GetValue(ref pkey, out pv) == 0 && pv.pointerValue != IntPtr.Zero) {
          name = Marshal.PtrToStringUni(pv.pointerValue);
        }
      }
      list.Add(id + "\u0001" + name);
    }
    return list;
  }

  public static bool SetDefault(string id) {
    try {
      var pc = (IPolicyConfig)(new CPolicyConfigClient());
      pc.SetDefaultEndpoint(id, 0);
      pc.SetDefaultEndpoint(id, 1);
      pc.SetDefaultEndpoint(id, 2);
      return true;
    } catch { return false; }
  }
}
"@

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

function Get-WifiInfo {
  $radio = Get-WifiRadioInfo
  if (-not $radio.supported) {
    return @{ supported = $false; enabled = $false; state = 'none'; ssid = ''; signal = 0 }
  }
  if ($radio.state -ne 'on') {
    return @{ supported = $true; enabled = $false; state = 'off'; ssid = ''; signal = 0 }
  }
  $out = netsh wlan show interfaces 2>$null
  $state = 'disconnected'
  $ssid = ''
  $sig = 0
  if ($out) {
    $text = ($out -join "`n")
    if ($text -match '(?i)状态\s*:\s*已连接' -or $text -match '(?i)State\s*:\s*connected\b' -or ($text -match '已连接' -and $text -notmatch '未连接|已断开')) {
      $state = 'connected'
    }
    if ($state -eq 'connected') {
      foreach ($line in $out) {
        if ($line -match '^\s*SSID\s*:\s*(.+)$') { $ssid = $Matches[1].Trim() }
        if ($line -match '信号|Signal') {
          $m = [regex]::Match($line, '(\d+)%')
          if ($m.Success) { $sig = [int]$m.Groups[1].Value }
        }
      }
    }
  }
  return @{ supported = $true; enabled = $true; state = $state; ssid = $ssid; signal = $sig }
}

function Get-BtInfo {
  $radios = @()
  try {
    $null = [Windows.Devices.Radios.Radio, Windows.Devices.Radios, ContentType = WindowsRuntime]
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $op = [Windows.Devices.Radios.Radio]::GetRadiosAsync()
    $task = $asTask.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]).Invoke($null, @($op))
    $task.Wait(2500) | Out-Null
    $radios = $task.Result
  } catch { $radios = @() }
  if (-not $radios -or $radios.Count -eq 0) { return @{ supported = $false; state = 'none' } }
  foreach ($r in $radios) {
    if ($r.Kind -eq [Windows.Devices.Radios.RadioKind]::Bluetooth) {
      return @{ supported = $true; state = ([string]$r.State).ToLower(); name = $r.Name }
    }
  }
  return @{ supported = $false; state = 'none' }
}

function Set-BtState([bool]$On) {
  try {
    $null = [Windows.Devices.Radios.Radio, Windows.Devices.Radios, ContentType = WindowsRuntime]
    $asTaskAct = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $op = [Windows.Devices.Radios.Radio]::GetRadiosAsync()
    $task = $asTaskAct.MakeGenericMethod([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]]).Invoke($null, @($op))
    $task.Wait(2500) | Out-Null
    foreach ($r in $task.Result) {
      if ($r.Kind -eq [Windows.Devices.Radios.RadioKind]::Bluetooth) {
        $st = if ($On) { [Windows.Devices.Radios.RadioState]::On } else { [Windows.Devices.Radios.RadioState]::Off }
        $aop = $r.SetStateAsync($st)
        $t2 = $asTaskAct.MakeGenericMethod([Windows.Devices.Radios.RadioAccessStatus]).Invoke($null, @($aop))
        $t2.Wait(3000) | Out-Null
        return $true
      }
    }
  } catch { }
  return $false
}

function Get-StatusJson {
  $vol = 0; $mute = $false
  try { $vol = [int][Math]::Round(([SysAudio]::GetVolume()) * 100) } catch { }
  try { $mute = [SysAudio]::GetMute() } catch { }
  $defaultId = ''
  try { $defaultId = [SysAudio]::GetDefaultId() } catch { }
  $devices = @()
  try {
    foreach ($line in [SysAudio]::ListRender()) {
      $parts = $line -split [char]1
      if (-not $parts[0]) { continue }
      $devices += [pscustomobject]@{
        id      = $parts[0]
        name    = if ($parts.Count -gt 1 -and $parts[1]) { $parts[1] } else { '未命名设备' }
        default = ($parts[0] -eq $defaultId)
      }
    }
  } catch { }
  $wifi = Get-WifiInfo
  $bt = Get-BtInfo
  $obj = [ordered]@{
    ok      = $true
    volume  = $vol
    muted   = $mute
    devices = $devices
    wifi    = $wifi
    bt      = $bt
    ts      = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
  }
  Write-Output ($obj | ConvertTo-Json -Compress -Depth 5)
}

switch ($Action) {
  'status' { Get-StatusJson }
  'volume' {
    $v = 0.0
    [double]::TryParse($Value, [ref]$v) | Out-Null
    try { [SysAudio]::SetVolume([float]($v / 100.0)) } catch { }
    $vol = 0; $mute = $false
    try { $vol = [int][Math]::Round(([SysAudio]::GetVolume()) * 100) } catch { }
    try { $mute = [SysAudio]::GetMute() } catch { }
    $obj = [ordered]@{
      ok     = $true
      volume = $vol
      muted  = $mute
      ts     = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
    }
    Write-Output ($obj | ConvertTo-Json -Compress)
  }
  'mute' {
    $on = ($Value -eq '1')
    try { [SysAudio]::SetMute($on) } catch { }
    $vol = 0; $mute = $false
    try { $vol = [int][Math]::Round(([SysAudio]::GetVolume()) * 100) } catch { }
    try { $mute = [SysAudio]::GetMute() } catch { }
    $obj = [ordered]@{
      ok     = $true
      volume = $vol
      muted  = $mute
      ts     = [int64]([DateTimeOffset]::Now.ToUnixTimeMilliseconds())
    }
    Write-Output ($obj | ConvertTo-Json -Compress)
  }
  'audio' {
    try { [SysAudio]::SetDefault($Value) | Out-Null } catch { }
    Start-Sleep -Milliseconds 50
    Get-StatusJson
  }
  'wifi' {
    $w = Get-WifiInfo
    if ($w.supported) {
      try {
        Start-Process "explorer.exe" -ArgumentList "ms-availablenetworks:"
      } catch { }
      Start-Sleep -Milliseconds 600
    }
    Get-StatusJson
  }
  'bt' {
    Set-BtState ($Value -eq '1') | Out-Null
    Start-Sleep -Milliseconds 800
    Get-StatusJson
  }
  default { Get-StatusJson }
}
