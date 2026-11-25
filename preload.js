const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('island', {
  // 渲染端通知主进程当前鼠标是否在 UI 区域内（控制窗口穿透）
  setMouseRegion: (overUi) => ipcRenderer.send('ui:mouse-region', overUi),
  // 渲染端测量出的展开高度，主进程据此调整窗口大小
  setIslandHeight: (h) => ipcRenderer.send('ui:height', h),
  setIslandWidth: (w) => ipcRenderer.send('ui:width', w),
  // 渲染端请求弹出右键菜单
  showMenu: () => ipcRenderer.send('ui:menu'),
  // 右键菜单打开/关闭时保持灵动岛展开，避免鼠标移入菜单时闪一下
  onMenuState: (cb) => ipcRenderer.on('island:menu-state', (_e, open) => cb(!!open)),
  // 媒体控制：play|pause|toggle|next|prev
  mediaControl: (cmd) => ipcRenderer.send('ui:media-control', cmd),
  mediaSeek: (seconds) => ipcRenderer.send('ui:media-seek', seconds),
  mediaLoop: (on) => ipcRenderer.send('ui:media-loop', on),
  // 设置窗口
  requestSettings: () => ipcRenderer.send('settings:request'),
  saveSettings: (s) => ipcRenderer.send('settings:save', s),
  onSettings: (cb) => ipcRenderer.on('settings:current', (_e, data) => cb(data)),
  // 主窗口接收设置变更
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, data) => cb(data)),
  // 主进程推送系统监控数据
  onStats: (cb) => ipcRenderer.on('stats', (_e, data) => cb(data)),
  onNet: (cb) => ipcRenderer.on('net', (_e, data) => cb(data)),
  onWeather: (cb) => ipcRenderer.on('weather', (_e, data) => cb(data)),
  getWeather: () => ipcRenderer.send('weather:get'),
  onWeatherStatus: (cb) => ipcRenderer.on('weather:status', (_e, d) => cb(d)),
  diagnoseNetwork: () => ipcRenderer.send('net:diagnose'),
  onNetReport: (cb) => ipcRenderer.on('net:report', (_e, d) => cb(d)),
  scWatch: (on) => ipcRenderer.send('sc:watch', on),
  scStatus: () => ipcRenderer.send('sc:status'),
  scVolume: (v) => ipcRenderer.send('sc:volume', v),
  scMute: (on) => ipcRenderer.send('sc:mute', on),
  scAudio: (id) => ipcRenderer.send('sc:audio', id),
  scWifi: () => ipcRenderer.send('sc:wifi'),
  scBt: (on) => ipcRenderer.send('sc:bt', on),
  onScState: (cb) => ipcRenderer.on('sc:state', (_e, d) => cb(d)),
  // 灵动岛内 Wi-Fi 选择与连接
  getWifiList: () => ipcRenderer.send('wifi:get-list'),
  connectWifi: (p) => ipcRenderer.send('wifi:connect', p),
  disconnectWifi: () => ipcRenderer.send('wifi:disconnect'),
  setWifiRadio: (on) => ipcRenderer.send('wifi:set-radio', !!on),
  openLocationSettings: () => ipcRenderer.send('wifi:open-settings'),
  onWifiList: (cb) => ipcRenderer.on('wifi:list', (_e, d) => cb(d)),
  onWifiConnectResult: (cb) => ipcRenderer.on('wifi:connect-result', (_e, d) => cb(d)),
  onWifiDisconnectResult: (cb) => ipcRenderer.on('wifi:disconnect-result', (_e, d) => cb(d)),
  onWifiRadioResult: (cb) => ipcRenderer.on('wifi:radio-result', (_e, d) => cb(d)),
  onQuotas: (cb) => ipcRenderer.on('quotas', (_e, data) => cb(data)),
  getQuotas: () => ipcRenderer.send('quota:get'),
  refreshQuota: (force) => ipcRenderer.send('quota:refresh', { force: !!force }),
  testQuota: () => ipcRenderer.send('quota:test'),
  onQuotaTest: (cb) => ipcRenderer.on('quota:test-result', (_e, data) => cb(data)),
  loginQuota: (id) => ipcRenderer.send('quota:login', id),
  onQuotaLogin: (cb) => ipcRenderer.on('quota:login-event', (_e, data) => cb(data)),
  onGpuStats: (cb) => ipcRenderer.on('gpu-stats', (_e, data) => cb(data)),  onGpuName: (cb) => ipcRenderer.on('gpu-name', (_e, data) => cb(data)),
  // 系统进程占用（按程序名聚合）
  onProcStats: (cb) => ipcRenderer.on('proc-stats', (_e, data) => cb(data)),
  getProcStats: () => ipcRenderer.send('proc:get'),
  onProcIcons: (cb) => ipcRenderer.on('proc-icons', (_e, data) => cb(data)),
  onMedia: (cb) => ipcRenderer.on('media', (_e, data) => cb(data)),
  onNotify: (cb) => ipcRenderer.on('notify', (_e, data) => cb(data)),
  onDevices: (cb) => ipcRenderer.on('devices', (_e, data) => cb(data)),
  saveLyricOffset: (key, offset) => ipcRenderer.send('lyric:offset-save', { key, offset }),
  getLyricOffset: (key) => ipcRenderer.send('lyric:offset-get', key),
  onLyricOffsetMem: (cb) => ipcRenderer.on('lyric:offset-mem', (_e, d) => cb(d)),
  diagnoseDevices: () => ipcRenderer.send('devices:diagnose'),
  onDiagReady: (cb) => ipcRenderer.on('devices:diag', (_e, p) => cb(p)),
  diagnoseNotify: () => ipcRenderer.send('notify:diagnose'),
  onNotifyDiag: (cb) => ipcRenderer.on('notify:diag', (_e, p) => cb(p)),
  notifyOpen: (payload) => ipcRenderer.send('notify:open', payload),
  onLyric: (cb) => ipcRenderer.on('lyric', (_e, data) => cb(data)),
  // 全屏自动收起：主进程通知渲染端隐藏/恢复界面
  onIslandVisible: (cb) => ipcRenderer.on('island:visible', (_e, v) => cb(v)),
  // 剪贴板历史
  onClipNew: (cb) => ipcRenderer.on('clip:new', (_e, data) => cb(data)),
  onClipList: (cb) => ipcRenderer.on('clip:list', (_e, data) => cb(data)),
  getClips: () => ipcRenderer.send('clip:get'),
  copyClip: (text) => ipcRenderer.send('clip:copy', text),
  clearClips: () => ipcRenderer.send('clip:clear'),
  copyClipVideo: (file) => ipcRenderer.send('clip:copy-video', file),
  saveClipThumb: (key, dataUrl) => ipcRenderer.send('clip:thumb', { key, dataUrl }),
  onClipCleared: (cb) => ipcRenderer.on('clip:cleared', () => cb()),
  copyClipImage: (file) => ipcRenderer.send('clip:copy-image', file),
  onClipCopied: (cb) => ipcRenderer.on('clip:copied', (_e, data) => cb(data)),
});

// 右键快捷菜单（独立透明窗口）
contextBridge.exposeInMainWorld('islandMenu', {
  action: (name, payload) => ipcRenderer.send('menu:action', { name, payload }),
  close: () => ipcRenderer.send('menu:close'),
});
