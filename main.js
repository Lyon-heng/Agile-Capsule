const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen, shell, net, clipboard } = require('electron');
const path = require('path');
const si = require('systeminformation');
const os = require('os');
const { execFile, spawn, spawnSync } = require('child_process');
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');

try { app.setAppUserModelId('com.agilecapsule.desktop'); } catch (e) { }

// SMTC AppId -> 友好名称（含官方客户端与第三方/开源/非官方播放器）
const APP_NAMES = {
  cloudmusic: '网易云音乐',
  qqmusic: 'QQ音乐',
  qqmusicpc: 'QQ音乐',
  kugou: '酷狗音乐',
  kuwo: '酷我音乐',
  migu: '咪咕音乐',
  soda: '汽水音乐',
  sodamusic: '汽水音乐',
  yesplaymusic: 'YesPlayMusic',
  'lx-music': '洛雪音乐',
  lxmusic: '洛雪音乐',
  musicfree: 'MusicFree',
  listen1: 'Listen 1',
  saltplayer: '椒盐音乐',
  hyplayer: 'HyPlayer',
  cider: 'Cider',
  musicbee: 'MusicBee',
  spotify: 'Spotify',
  itunes: 'Apple Music',
  'appleinc.music': 'Apple Music',
  zunemusic: 'Groove 音乐',
  mediaplayer: 'Windows 媒体播放器',
  foobar2000: 'foobar2000',
  aimp: 'AIMP',
  potplayer: 'PotPlayer',
  vlc: 'VLC',
  dopamine: 'Dopamine',
  tahoe: 'Tahoe 音乐',
  transubplayer: 'TransubPlayer',
  gpplayer: 'Gpplayer',
  feeluown: 'FeelUOwn',
  moosync: 'Moosync',
  mineradio: 'Mineradio',
  folia: 'Folia',
  'folia-major': 'Folia',
  'top.izuna.foliamajor': 'Folia',
  foliamajor: 'Folia',
  bilibili: '哔哩哔哩',
  msedge: 'Edge 浏览器',
  chrome: 'Chrome 浏览器',
  firefox: 'Firefox 浏览器',
  '360se': '360浏览器',
  wps: 'WPS',
  video: '视频播放器',
  music: '音乐播放器',
};

function friendlyAppName(id) {
  if (!id) return '音乐播放器';
  let key = id.split('!')[0].replace(/\.exe$/i, '');
  key = key.split('\\').pop().toLowerCase();
  for (const [k, name] of Object.entries(APP_NAMES)) {
    if (key.includes(k)) return name;
  }
  // 启发式友好名称处理：如 my-cool-player -> My Cool Player
  const clean = key.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return clean || '本地音乐播放器';
}

// ---------- 网易云 elog 只读进度解析（参考 Daozai 项目做法） ----------
// 网易云不上报 SMTC 时间轴，但会把播放事件写进 cloudmusic.elog（异或混淆）
const NET_EASE_ELOG = path.join(process.env.LOCALAPPDATA || '', 'NetEase', 'CloudMusic', 'cloudmusic.elog');
let elogOffset = 0;
let elogCarry = '';
let elogTimer = null;
// elog 多进程写入会乱序，因此按 songId 建索引，当前歌曲以播放状态事件的 songKey 为准
const neSongs = new Map();  // id -> { title, artist, album, cover, duration }
const neState = { currentId: null, position: 0, playing: false, at: 0, ready: false };

// 封面地址规范化：https + 256px（仅接受网易云 CDN 域名）
function normalizeCover(url) {
  try {
    if (!url || url.length > 4096) return '';
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return '';
    if (u.hostname !== 'music.126.net' && !u.hostname.endsWith('.music.126.net')) return '';
    u.protocol = 'https:';
    u.search = '?param=256y256';
    u.hash = '';
    return u.toString();
  } catch (e) {
    return '';
  }
}

function decodeElog(buf) {
  const out = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    const high = b >> 4;
    const low = b & 15;
    out[i] = (((high ^ ((low + 8) & 15)) << 4) | ((b >> 6) << 2) | ((~high) & 3)) & 0xff;
  }
  return out;
}

function currentSong() {
  return neState.currentId ? neSongs.get(neState.currentId) : null;
}

function neDuration() {
  const s = currentSong();
  return s && s.duration > 0 ? s.duration : 0;
}

function nePosition(now) {
  let p = neState.position + (neState.playing ? (now - neState.at) / 1000 : 0);
  const d = neDuration();
  if (d > 0) p = Math.min(p, d);
  return p;
}

// songKey 形如 "82360_J35WY7"，前缀即歌曲 id
function songIdFromKey(key) {
  if (!key) return null;
  const m = String(key).match(/^(\d+)_/);
  return m ? m[1] : null;
}

// 事件参数可能是「JSON + 逗号附加字段」，按括号配平截取首个完整对象
function parseJsonPrefix(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

function elogHandleEvent(ev, args, atMs) {
  const now = atMs || Date.now();
  if (ev === 'native播放state') {
    const parts = args.split(',');
    const st = parseInt(parts[0], 10);
    const key = (parts[1] || '').replace(/"/g, '').trim();
    if (st === 1 || st === 2) {
      const id = songIdFromKey(key);
      if (id && neState.currentId !== id) {
        neState.currentId = id;
        neState.position = 0;
      }
      neState.position = nePosition(now);
      neState.playing = st === 1;
      neState.at = now;
      neState.ready = true;
    }
    return;
  }
  if (ev === 'resume') {
    neState.playing = true;
    neState.at = now;
    return;
  }
  if (ev === 'setPlayingPosition' || ev === 'seekEnd') {
    const p = parseFloat(args.split(',')[0]);
    if (isFinite(p) && p >= 0) { neState.position = p; neState.at = now; neState.ready = true; }
    return;
  }
  if (ev.startsWith('native播放资源load完成')) {
    const j = parseJsonPrefix(args);
    if (j && j.songId && neState.currentId !== String(j.songId)) {
      neState.currentId = String(j.songId);
    }
    neState.position = 0;
    neState.playing = true;
    neState.at = now;
    neState.ready = true;
    return;
  }
  if (ev === 'pause') {
    neState.position = nePosition(now);
    neState.playing = false;
    neState.at = now;
    return;
  }
  if (ev === 'checkPlayPrivilege' || ev === 'playOneTrackInPlayingList') {
    const j = parseJsonPrefix(args);
    if (j && j.id) {
      const id = String(j.id);
      const cur = neSongs.get(id) || {};
      if (j.name) cur.title = j.name;
      if (Array.isArray(j.artists) && j.artists.length) {
        cur.artist = j.artists.map((a) => (a && a.name) || '').filter(Boolean).join('/');
      }
      if (j.album) {
        if (j.album.name) cur.album = j.album.name;
        if (j.album.picUrl) {
          const c = normalizeCover(j.album.picUrl);
          if (c) cur.cover = c;
        }
      }
      if (typeof j.duration === 'number' && j.duration > 0) cur.duration = j.duration / 1000;
      neSongs.set(id, cur);
      if (!neState.currentId) { neState.currentId = id; neState.at = now; }
      if (neSongs.size > 300) {
        const keys = [...neSongs.keys()];
        for (const k of keys.slice(0, keys.length - 200)) neSongs.delete(k);
      }
    }
    return;
  }
  if (ev === 'exitApp') {
    neSongs.clear();
    neState.currentId = null;
    neState.position = 0;
    neState.playing = false;
    neState.ready = false;
  }
}

function readNeteaseElog() {
  try {
    const st = fs.statSync(NET_EASE_ELOG);
    if (st.size < elogOffset) elogOffset = 0;
    if (!elogOffset) elogOffset = Math.max(0, st.size - 8 * 1024 * 1024); // 首次全量扫描（上限 8MB）
    if (st.size <= elogOffset) return;
    const len = Math.min(st.size - elogOffset, 8 * 1024 * 1024);
    const fd = fs.openSync(NET_EASE_ELOG, 'r');
    const buf = Buffer.allocUnsafe(len);
    fs.readSync(fd, buf, 0, len, elogOffset);
    fs.closeSync(fd);
    elogOffset += len;
    // elogOffset 从中间开始时，丢弃首个不完整行
    elogCarry += decodeElog(buf).toString('utf8');
    const lines = elogCarry.split('\n');
    elogCarry = lines.pop() || '';
    if (elogCarry.length > 65536) elogCarry = '';
    for (const line of lines) {
      const i = line.indexOf('【playing】,');
      if (i < 0) continue;
      const ts = line.match(/\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]/);
      const atMs = ts ? new Date(ts[1].replace(' ', 'T')).getTime() : Date.now();
      const rest = line.slice(i + 10);
      const mm = rest.match(/^"([^"]+)",?([\s\S]*)$/);
      if (!mm) continue;
      elogHandleEvent(mm[1], mm[2], isFinite(atMs) ? atMs : Date.now());
    }
  } catch (e) { /* 文件不存在或读取失败：忽略 */ }
}


function isVideoMedia(m) {
  if (!m || !m.title) return false;
  const t = String(m.title).toLowerCase();
  const app = String(m.app || '').toLowerCase();
  
  // 1. 纯视频播放器与视频应用
  const videoApps = ['zunevideo', 'potplayer', 'vlc', 'mpc-hc', 'mpc-be', 'kmplayer', 'iqiyi', 'youku', 'tencentvideo', 'qqlive', 'mgtv', 'bilibili'];
  for (const va of videoApps) {
    if (app.includes(va)) return true;
  }

  // 2. 视频扩展名
  if (/\.(mp4|mkv|avi|flv|rmvb|wmv|mov|ts|m2ts|webm|vob|iso|rm|f4v|mpg|mpeg|m4v|3gp|asf)(\s|$|\?|#)/i.test(t)) {
    return true;
  }

  // 3. 视频压制 / 分辨率 / 集数标签
  if (/\b(1080p|720p|2160p|4k|bluray|hdtv|web-dl|web-rip|bdrip|remux|x264|x265|hevc)\b|第\s*\d+\s*[集话期]|\b(ep|s\d+e)\d+\b/i.test(t)) {
    return true;
  }

  // 4. 超长时长且无歌手 (大于 900 秒即 15 分钟)
  if (m.duration && m.duration > 900 && (!m.artist || !m.artist.trim())) {
    return true;
  }

  // 5. 浏览器播放视频网站
  if (['msedge', 'chrome', 'firefox', 'brave', 'opera', '360se'].some(b => app.includes(b))) {
    if (/( - 哔哩哔哩| - bilibili| - youtube| - 优酷| - 爱奇艺| - 腾讯视频| - 西瓜视频| - 抖音| - 快手)/i.test(t) || (!m.artist && !m.album)) {
      return true;
    }
  }

  return false;
}

function neteaseSnapshot() {
  const s = currentSong();
  if (!neState.ready || !s || !s.duration) return null;
  const now = Date.now();
  return {
    songId: neState.currentId,
    title: s.title || '',
    artist: s.artist || '',
    album: s.album || '',
    duration: Math.round(s.duration),
    position: Math.round(nePosition(now)),
    playing: neState.playing,
    cover: s.cover || '',
  };
}

// ---------- 多音源歌词与封面引擎 (QQ音乐 / 网易云音乐 / 酷狗音乐 / LRCLIB) ----------
const lyricCache = new Map(); // songKey -> { lines, source, coverUrl }
let lyricInflightKey = null;

function parseLrc(lrcText) {
  const lines = [];
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
  // LRC 规范：[offset:+/-毫秒]，正值表示歌词应提前显示
  let offsetSec = 0;
  const om = String(lrcText).match(/\[offset:\s*([+-]?\d+)\]/i);
  if (om) offsetSec = parseInt(om[1], 10) / 1000;
  for (const raw of String(lrcText || '').split('\n')) {
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!text) continue;
    re.lastIndex = 0;
    let mm;
    const times = [];
    while ((mm = re.exec(raw))) {
      const min = parseInt(mm[1], 10);
      const sec = parseInt(mm[2], 10);
      const ms = mm[3] ? parseInt(mm[3].padEnd(3, '0').slice(0, 3), 10) : 0;
      times.push(min * 60 + sec + ms / 1000);
    }
    for (const t of times) lines.push({ t: Math.max(0, t - offsetSec), text });
  }
  lines.sort((a, b) => a.t - b.t);
  return lines;
}

function fetchNetworkText(url, options = {}) {
  return new Promise((resolve) => {
    try {
      const isHttps = url.startsWith('https:');
      const mod = isHttps ? https : http;
      const headers = Object.assign({
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': '*/*',
      }, options.headers || {});
      const req = mod.get(url, {
        headers,
        timeout: options.timeout || 6000,
        family: 4,
      }, (res) => {
        if (res.statusCode < 200 || res.statusCode >= 400) {
          res.resume();
          return resolve(null);
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.on('error', () => resolve(null));
    } catch (e) {
      resolve(null);
    }
  });
}

async function fetchNetworkJson(url, options = {}) {
  const text = await fetchNetworkText(url, options);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

// 1. QQ音乐音源
async function queryQQMusic(query) {
  try {
    const sUrl = `https://c.y.qq.com/soso/fcgi-bin/client_search_cp?w=${encodeURIComponent(query)}&format=json&n=3`;
    const sj = await fetchNetworkJson(sUrl, { headers: { 'Referer': 'https://y.qq.com/' } });
    const list = sj && sj.data && sj.data.song && sj.data.song.list;
    if (!list || !list.length) return null;
    const item = list[0];
    const songmid = item.songmid;
    if (!songmid) return null;

    const lyrUrl = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(songmid)}&format=json&nobase64=1`;
    const lyrJson = await fetchNetworkJson(lyrUrl, { headers: { 'Referer': 'https://y.qq.com/' } });
    if (!lyrJson || !lyrJson.lyric) return null;

    let lrc = lyrJson.lyric;
    if (!lrc.includes('[') && lrc.length > 20) {
      try { lrc = Buffer.from(lrc, 'base64').toString('utf8'); } catch (e) {}
    }
    const coverUrl = item.albummid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${item.albummid}.jpg` : null;
    return { lrc, coverUrl, source: 'QQ音乐' };
  } catch (e) {
    return null;
  }
}

// 2. 网易云音乐音源
async function queryNetease(query, songId) {
  try {
    let sid = songId;
    let coverUrl = null;
    if (!sid) {
      const sUrl = `https://music.163.com/api/search/get?s=${encodeURIComponent(query)}&type=1&limit=3`;
      const sj = await fetchNetworkJson(sUrl);
      const list = sj && sj.result && sj.result.songs;
      if (!list || !list.length) return null;
      sid = list[0].id;
      if (list[0].album && list[0].album.picUrl) {
        coverUrl = normalizeCover(list[0].album.picUrl);
      }
    }
    if (!sid) return null;
    if (!coverUrl) {
      try {
        const dUrl = `https://music.163.com/api/song/detail/?id=${sid}&ids=[${sid}]`;
        const dj = await fetchNetworkJson(dUrl);
        const pic = dj && dj.songs && dj.songs[0] && dj.songs[0].album && dj.songs[0].album.picUrl;
        if (pic) coverUrl = normalizeCover(pic);
      } catch (e2) {}
    }
    const lyrUrl = `https://music.163.com/api/song/lyric?id=${encodeURIComponent(sid)}&lv=1&kv=1&tv=-1`;
    const lj = await fetchNetworkJson(lyrUrl);
    const lrc = lj && lj.lrc && lj.lrc.lyric;
    if (!lrc) return null;
    return { lrc, coverUrl, source: '网易云音乐' };
  } catch (e) {
    return null;
  }
}

// 3. 酷狗音乐音源
async function queryKugou(query) {
  try {
    const sUrl = `http://mobilecdn.kugou.com/api/v3/search/song?format=json&keyword=${encodeURIComponent(query)}&page=1&pagesize=3`;
    const sj = await fetchNetworkJson(sUrl);
    const list = sj && sj.data && sj.data.info;
    if (!list || !list.length) return null;
    const song = list[0];
    const hash = song.hash;
    if (!hash) return null;

    const candUrl = `http://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword=&duration=&hash=${encodeURIComponent(hash)}`;
    const candJson = await fetchNetworkJson(candUrl);
    const cands = candJson && candJson.candidates;
    if (!cands || !cands.length) return null;
    const c0 = cands[0];

    const downUrl = `http://lyrics.kugou.com/download?ver=1&client=pc&id=${encodeURIComponent(c0.id)}&accesskey=${encodeURIComponent(c0.accesskey)}&fmt=lrc&charset=utf8`;
    const dj = await fetchNetworkJson(downUrl);
    if (!dj || !dj.content) return null;

    let lrc = Buffer.from(dj.content, 'base64').toString('utf8');
    let coverUrl = null;
    try {
      const infoUrl = `http://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash=${encodeURIComponent(hash)}`;
      const ij = await fetchNetworkJson(infoUrl);
      if (ij && ij.imgUrl) {
        coverUrl = ij.imgUrl.replace('{size}', '240');
      }
    } catch (e) {}

    return { lrc, coverUrl, source: '酷狗音乐' };
  } catch (e) {
    return null;
  }
}

// 4. LRCLIB 全球开源歌词库
async function queryLrclib(title, artist) {
  try {
    const url = `https://lrclib.net/api/get?track_name=${encodeURIComponent(title)}&artist_name=${encodeURIComponent(artist || '')}`;
    const lj = await fetchNetworkJson(url, { headers: { 'User-Agent': 'AgileCapsule/1.0' } });
    if (!lj) return null;
    const lrc = lj.syncedLyrics || lj.plainLyrics;
    if (!lrc) return null;
    return { lrc, coverUrl: null, source: 'LRCLIB' };
  } catch (e) {
    return null;
  }
}

function cleanSongQuery(rawTitle, rawArtist) {
  let title = (rawTitle || '').trim();
  let artist = (rawArtist || '').trim();

  if (!artist && title.includes(' - ')) {
    const parts = title.split(' - ');
    if (parts.length >= 2) {
      title = parts[0].trim();
      artist = parts.slice(1).join(' - ').trim();
    }
  }

  title = title
    .replace(/\.(mp3|flac|wav|m4a|ogg|aac|ape|webm|wma)$/i, '')
    .replace(/\[(?:320k|128k|flac|sq|hq|无损|官方|MV|现场版|Live|重温经典|动态歌词)[^\]]*\]/gi, '')
    .replace(/\((?:320k|128k|flac|sq|hq|无损|官方|MV|现场版|Live|高音质)[^\)]*\)/gi, '')
    .replace(/【(?:无损|首发|经典|官方|MV|Live|高清)[^】]*】/g, '')
    .trim();

  artist = artist
    .replace(/\.(mp3|flac|wav|m4a)$/i, '')
    .trim();

  const query = `${title} ${artist}`.trim();
  return { title, artist, query };
}

async function fetchMultiSourceLyric(m, force) {
  if (!m || !m.title) return;
  const clean = cleanSongQuery(m.title, m.artist);
  if (!clean.title) return;

  const songKey = String(m.songId || (clean.title + ' - ' + clean.artist)).toLowerCase();

  // 命中缓存
  if (!force && lyricCache.has(songKey)) {
    const cached = lyricCache.get(songKey);
    if (win && !win.isDestroyed()) {
      win.webContents.send('lyric', {
        songId: songKey,
        lines: cached.lines,
        source: cached.source,
        coverUrl: cached.coverUrl,
      });
      if (!m.art && !m.artUrl && cached.coverUrl) {
        m.artUrl = cached.coverUrl;
        win.webContents.send('media', m);
      }
    }
    return;
  }

  lyricInflightKey = songKey;

  // 优先级策略
  const appLower = String(m.app || '').toLowerCase();
  const sourceFns = [];

  if (appLower.includes('qqmusic')) {
    sourceFns.push(() => queryQQMusic(clean.query));
    sourceFns.push(() => queryNetease(clean.query, m.songId));
    sourceFns.push(() => queryKugou(clean.query));
    sourceFns.push(() => queryLrclib(clean.title, clean.artist));
  } else if (appLower.includes('kugou')) {
    sourceFns.push(() => queryKugou(clean.query));
    sourceFns.push(() => queryQQMusic(clean.query));
    sourceFns.push(() => queryNetease(clean.query, m.songId));
    sourceFns.push(() => queryLrclib(clean.title, clean.artist));
  } else if (appLower.includes('cloudmusic')) {
    sourceFns.push(() => queryNetease(clean.query, m.songId));
    sourceFns.push(() => queryQQMusic(clean.query));
    sourceFns.push(() => queryKugou(clean.query));
    sourceFns.push(() => queryLrclib(clean.title, clean.artist));
  } else if (appLower.includes('spotify') || appLower.includes('itunes') || appLower.includes('appleinc')) {
    sourceFns.push(() => queryLrclib(clean.title, clean.artist));
    sourceFns.push(() => queryQQMusic(clean.query));
    sourceFns.push(() => queryNetease(clean.query, m.songId));
    sourceFns.push(() => queryKugou(clean.query));
  } else {
    sourceFns.push(() => queryQQMusic(clean.query));
    sourceFns.push(() => queryNetease(clean.query, m.songId));
    sourceFns.push(() => queryKugou(clean.query));
    sourceFns.push(() => queryLrclib(clean.title, clean.artist));
  }

  let matched = null;
  for (const fn of sourceFns) {
    if (lyricInflightKey !== songKey) return;
    try {
      const res = await fn();
      if (res && res.lrc && res.lrc.trim().length > 10) {
        matched = res;
        break;
      }
    } catch (e) {}
  }

  if (lyricInflightKey !== songKey) return;

  if (matched && matched.lrc) {
    const lines = parseLrc(matched.lrc);
    const item = { lines, source: matched.source, coverUrl: matched.coverUrl };
    lyricCache.set(songKey, item);
    if (lyricCache.size > 150) {
      const keys = [...lyricCache.keys()];
      for (const k of keys.slice(0, keys.length - 80)) lyricCache.delete(k);
    }
    if (win && !win.isDestroyed()) {
      win.webContents.send('lyric', {
        songId: songKey,
        lines,
        source: matched.source,
        coverUrl: matched.coverUrl,
      });
      if (!m.art && !m.artUrl && matched.coverUrl) {
        m.artUrl = matched.coverUrl;
        win.webContents.send('media', m);
      }
    }
  } else {
    lyricCache.set(songKey, { lines: [], source: null, coverUrl: null });
    if (win && !win.isDestroyed()) {
      win.webContents.send('lyric', { songId: songKey, lines: [], source: null, coverUrl: null });
    }
  }
}

function fetchLyric(songId, force) {
  if (songId) fetchMultiSourceLyric({ songId, title: String(songId) }, force);
}

// ---------- SMTC 媒体监控 ----------
let mediaProc = null;
function logMonitorEvent(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'monitor.log'),
      new Date().toTimeString().slice(0, 8) + ' ' + msg + '\n');
  } catch (e) { }
}
let mediaBuf = '';
let lastMediaLine = '';
let lastMediaSource = 'smtc'; // smtc | wintitle，决定控制按钮的命令路径
let lastWintitleApp = null;   // 当前降级显示的应用进程名
// 虚拟暂停状态：wintitle 模式下窗口标题不随暂停变化，以按钮操作为准
let virtualPausedByApp = {};
let lastWintitleSong = {};
// 播放状态防抖：部分播放器（如 Folia）切歌/缓冲时会瞬时上报 Paused，
// 直接透传会让灵动岛刚显示“播放中”又跳回“已暂停”。连续 3 次才认定暂停。
const mediaStatusHold = {};
function stabilizeMediaStatus(m) {
  if (!m || !m.app || !m.status || m.status === 'None') return m;
  if (m.source === 'wintitle') return m;   // 标题模式的暂停状态来自用户操作，不需要防抖
  const st = mediaStatusHold[m.app];
  if (!st) {
    mediaStatusHold[m.app] = { status: m.status, title: m.title || '', hold: 0 };
    return m;
  }
  if ((m.title || '') !== (st.title || '')) {
    st.status = m.status; st.title = m.title || ''; st.hold = 0;
    return m;
  }
  if (m.status === st.status) { st.hold = 0; return m; }
  if (m.status === 'Paused' && st.status === 'Playing') {
    const dur = Number(m.duration) || 0;
    const pos = Number(m.position) || 0;
    const nearEnd = dur > 5 && pos >= dur - 2;
    if (!nearEnd) {
      st.hold = (st.hold || 0) + 1;
      if (st.hold <= 2) { m.status = 'Playing'; return m; }
    }
  }
  st.status = m.status; st.hold = 0;
  return m;
}

function startMediaMonitor() {
  try {
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'smtc-monitor.ps1')
      : path.join(__dirname, 'media', 'smtc-monitor.ps1');
    mediaProc = spawn(PS_EXE,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
      { windowsHide: true }
    );
    mediaProc.stdout.on('data', (chunk) => {
      mediaBuf += chunk.toString('utf8');
      let idx;
      while ((idx = mediaBuf.indexOf('\n')) >= 0) {
        let line = mediaBuf.slice(0, idx).trim();
        mediaBuf = mediaBuf.slice(idx + 1);
        if (!line) continue;
        try {
          // 网易云窗口在托盘关闭时 monitor 报 None：用 elog 状态兜底显示
          if (line.indexOf('"status":"None"') >= 0) {
            const nePlay = neteaseSnapshot();
            if (nePlay && nePlay.title) {
              line = JSON.stringify({
                app: 'cloudmusic',
                title: nePlay.title,
                artist: nePlay.artist || '',
                album: nePlay.album || '',
                status: nePlay.playing ? 'Playing' : 'Paused',
                duration: nePlay.duration,
                position: nePlay.position,
                art: null,
                artUrl: nePlay.cover || null,
                source: 'wintitle',
                canSeek: false,
                playerRunning: true,
              });
            }
          }
          const m = JSON.parse(line);
          m.appName = friendlyAppName(m.app);
          lastMediaSource = m.source || (m.app ? 'smtc' : lastMediaSource);
          // 视频播放过滤：避免播放视频时灵动岛跳出音乐提示
          if (isVideoMedia(m)) {
            m.status = 'None';
            m.title = '';
            m.artist = '';
            m.album = '';
            m.playerRunning = false;
          }

          // 网易云：用 elog 真实进度补全（时长/位置/播放状态）
          let neReal = null;
          if (m.app === 'cloudmusic') {
            neReal = neteaseSnapshot();
            if (neReal) {
              m.duration = neReal.duration;
              m.position = neReal.position;
              m.status = neReal.playing ? 'Playing' : 'Paused';
              m.canSeek = false;
              if (!m.art && neReal.cover) m.artUrl = neReal.cover;
              m.songId = neReal.songId;
            }
          }
          // 全平台多音源智能歌词与封面匹配（支持 QQ音乐、网易云音乐、酷狗音乐、LRCLIB等）
          if (m.title && m.status !== 'None') {
            const clean = cleanSongQuery(m.title, m.artist);
            const songKey = String(m.songId || (clean.title + ' - ' + clean.artist)).toLowerCase();
            if (!m.art && !m.artUrl && lyricCache.has(songKey)) {
              const cached = lyricCache.get(songKey);
              if (cached && cached.coverUrl) {
                m.artUrl = cached.coverUrl;
              }
            }
            fetchMultiSourceLyric(m);
          }
          // wintitle 模式：标题不随暂停变化，应用虚拟暂停状态（有 elog 真实状态时不使用）
          if (m.source === 'wintitle' && m.app) {
            lastWintitleApp = m.app;
            if (neReal) {
              // 真实状态优先，不同步虚拟状态
              lastWintitleSong[m.app] = m.title;
              virtualPausedByApp[m.app] = false;
            } else if (lastWintitleSong[m.app] !== m.title) {
              // 换歌 → 重置为播放中
              lastWintitleSong[m.app] = m.title;
              virtualPausedByApp[m.app] = false;
            } else if (virtualPausedByApp[m.app]) {
              m.status = 'Paused';
            }
          } else if (m.source === 'smtc' || !m.app) {
            // 来源切回 SMTC 或无播放 → 清空虚拟状态
            virtualPausedByApp = {};
            lastWintitleSong = {};
            if (!m.app) lastWintitleApp = null;
          }
          stabilizeMediaStatus(m);
          maybeLoopRewind(m);
          if (process.env.WINISLAND_MEDIA_LOG || process.env.WINISLAND_SHOT) {
            try {
              fs.appendFileSync(path.join(app.getPath('userData'), 'merged.log'),
                new Date().toLocaleTimeString() + ' ' + JSON.stringify({ t: m.title, d: m.duration, p: m.position, s: m.status, artUrl: (m.artUrl || '').slice(0, 80) }) + '\n');
            } catch (e3) { /* 忽略 */ }
          }
          // 媒体会话日志（仅记录变化，诊断网易云等客户端 SMTC 注册情况）
          try {
            if (line !== lastMediaLine) {
              lastMediaLine = line;              const logPath = path.join(app.getPath('userData'), 'media-debug.log');
              if (!fs.existsSync(logPath) || fs.statSync(logPath).size > 1024 * 1024) {
                fs.writeFileSync(logPath, '=== ' + new Date().toISOString() + ' ===\n');
              }
              fs.appendFileSync(logPath, new Date().toLocaleTimeString() + ' ' + line + '\n');
            }
          } catch (e2) { /* 日志失败不影响 */ }
          // 部分播放器把 URL 当标题上报（可能无协议前缀），解码为文件名
          if (m.title && (/^(https?:)?\/\//i.test(m.title) || /^[\w.-]+\.[a-z]{2,}\//i.test(m.title))) {
            try {
              const base = decodeURIComponent(m.title.split(/[?#]/)[0].split('/').pop());
              m.title = base.replace(/\.(mp3|mp4|m4a|wav|flac|aac|ogg|webm)$/i, '') || m.appName || '未知曲目';
            } catch (e2) { /* 保留原标题 */ }
          }
          if (process.env.WINISLAND_SHOT) console.log('MEDIA:', line.slice(0, 150));
          lastMediaMsg = m;
          if (win && !win.isDestroyed()) win.webContents.send('media', m);
        } catch (e) { /* 忽略非 JSON 行 */ }
      }
    });
    mediaProc.stderr.on('data', () => {});
    mediaProc.on('error', (e) => {
      logMonitorEvent('media spawn error: ' + (e && e.message));
    });
    mediaProc.on('exit', (code) => {
      logMonitorEvent('media monitor exited code=' + code);
      mediaProc = null;
      if (!app.isQuitting) setTimeout(() => { if (!mediaProc) startMediaMonitor(); }, 3000);
    });  } catch (e) { /* 监控失败不影响主体 */ }
}

let win = null;
let tray = null;
let statsTimer = null;
let gpuTimer = null;

// ---------- 全屏自动隐藏：前台全屏时收起灵动岛，鼠标贴到屏幕顶部再探头 ----------
let fsWatchProc = null;
let fsHidden = false;      // 当前是否因全屏而收起
let fsPeek = false;        // 收起状态下是否因为鼠标贴顶而临时显示
let fsCursorTimer = null;
let fsScopeRunning = '';   // 当前监听进程使用的判定范围

function fullscreenScriptPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'fullscreen-watch.ps1')
    : path.join(__dirname, 'media', 'fullscreen-watch.ps1');
}

function startFullscreenWatch() {
  if (fsWatchProc || !appSettings.hideOnFullscreen) return;
  fsScopeRunning = appSettings.fsScope === 'full' ? 'full' : 'max';
  let logFile = '';
  try {
    logFile = path.join(app.getPath('userData'), 'fullscreen-watch.log');
    fs.writeFileSync(logFile, '=== 全屏监听启动 ' + new Date().toLocaleString() + ' ===\n', 'utf8');
  } catch (e) { logFile = ''; }
  const fsLog = (s) => {
    if (!logFile) return;
    try {
      if (fs.statSync(logFile).size > 256 * 1024) return;
      fs.appendFileSync(logFile, new Date().toLocaleTimeString() + ' ' + s + '\n');
    } catch (e) { /* 忽略 */ }
  };
  try {
    fsWatchProc = spawn(PS_EXE,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fullscreenScriptPath(),
        '-Scope', appSettings.fsScope === 'full' ? 'full' : 'max'],
      { windowsHide: true });
  } catch (e) { fsWatchProc = null; fsLog('spawn失败: ' + e.message); return; }
  let buf = '';
  fsWatchProc.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      fsLog(line);
      if (line.startsWith('FS 1')) setFullscreenHidden(true);
      else if (line.startsWith('FS 0')) setFullscreenHidden(false);
    }
  });
  fsWatchProc.stderr.on('data', (d) => fsLog('[err] ' + d.toString('utf8').trim()));
  fsWatchProc.on('exit', (code) => {
    fsWatchProc = null;
    fsLog('进程退出 code=' + code);
    // 异常退出时兜底重启，避免全屏检测失效后灵动岛一直不回来
    if (app.isQuitting || !appSettings.hideOnFullscreen) return;
    setTimeout(() => { startFullscreenWatch(); }, 5000);
  });
  fsWatchProc.on('error', (e) => { fsWatchProc = null; fsLog('error: ' + e.message); });
}

function stopFullscreenWatch() {
  if (fsWatchProc) {
    try { fsWatchProc.kill(); } catch (e) { /* 忽略 */ }
    fsWatchProc = null;
  }
  setFullscreenHidden(false);
}

// 透明窗口上 setOpacity 未必生效，所以窗口透明度和渲染端 CSS 一起切换，双保险
function setIslandVisible(visible, interactive) {
  if (!win || win.isDestroyed()) return;
  try { win.setOpacity(visible ? 1 : 0); } catch (e) { /* 忽略 */ }
  try { win.webContents.send('island:visible', visible); } catch (e) { /* 忽略 */ }
  if (!visible) win.setIgnoreMouseEvents(true, { forward: true });
  else win.setIgnoreMouseEvents(!interactive, { forward: true });
}

function setFullscreenHidden(hidden) {
  if (!win || win.isDestroyed()) return;
  if (hidden === fsHidden) return;
  fsHidden = hidden;
  fsPeek = false;
  if (hidden) {
    setIslandVisible(false, false);
    startCursorWatch();
  } else {
    stopCursorWatch();
    setIslandVisible(true, false);
  }
}

function hidePeek() {
  if (!win || win.isDestroyed() || !fsPeek) return;
  fsPeek = false;
  setIslandVisible(false, false);
}

// 收起状态下轮询全局鼠标位置：贴到屏幕顶部就探头，离开就收回
function startCursorWatch() {
  if (fsCursorTimer) return;
  fsCursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !fsHidden) return;
    if (!win.isVisible()) return;
    const p = screen.getCursorScreenPoint();
    const b = win.getBounds();
    const d = screen.getDisplayNearestPoint(p);
    const inX = p.x >= b.x - 80 && p.x <= b.x + b.width + 80;
    const atTop = p.y <= d.bounds.y + 4 && inX;
    if (!fsPeek && atTop) {
      fsPeek = true;
      setIslandVisible(true, true);
    } else if (fsPeek && (p.y > b.y + b.height + 4 || !inX)) {
      hidePeek();
    }
  }, 100);
}

function stopCursorWatch() {
  if (fsCursorTimer) {
    clearInterval(fsCursorTimer);
    fsCursorTimer = null;
  }
}

// 全局未捕获异常兜底，防止静默闪退
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

// 单实例锁：重复启动时唤起已有窗口
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      win.show();
      setIslandVisible(true, true);
      win.focus();
      try {
        win.webContents.executeJavaScript("document.getElementById('island')?.classList.add('expanded');");
      } catch (e) { }
    }
  });
}

// ---------- GPU 采集：自动挑出真正的显卡（跳过虚拟/远程显示适配器），优先 nvidia-smi ----------
// 有些电脑（装过远程桌面/投屏/虚拟机）第一块显卡是虚拟显示适配器，
// 直接取 controllers[0] 会显示成 "GameViewer Virtual Display Adapter" 这类假设备
const GPU_VIRTUAL_RE = /virtual|remote|basic display|basic render|mirror|indirect|spacedesk|parsec|todesk|sunlogin|gameviewer|anydesk|splashtop|teamviewer|rustdesk|displaylink|usb display|phone link|android|vmware|virtualbox|hyper-v|向日葵|远控/i;
const GPU_NVIDIA_RE = /nvidia|geforce|rtx|gtx|quadro|tesla/i;
const GPU_AMD_RE = /radeon|\bamd\b|\bati\b|rx \d|vega|navi/i;
const GPU_INTEL_RE = /\bintel\b|\barc\b|iris|uhd graphics|hd graphics/i;

let gpuInfo = { method: null, name: '', index: 0, nvidiaIndex: null, temp: null };

function runCmd(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? null : stdout.trim());
    });
  });
}

// nvidia-smi 不一定在 PATH 里（笔记本/精简安装常见），按常见路径兜底
function nvidiaSmiPaths() {
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const sys = process.env.SystemRoot || 'C:\\Windows';
  return [
    'nvidia-smi',
    path.join(pf, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    path.join(sys, 'System32', 'nvidia-smi.exe'),
  ];
}

async function runNvidiaSmi(args) {
  for (const exe of nvidiaSmiPaths()) {
    const out = await runCmd(exe, args);
    if (out) return out;
  }
  return null;
}

function scoreGpu(c) {
  const n = (c.model || '').toLowerCase();
  let s = 0;
  if (GPU_VIRTUAL_RE.test(n)) s -= 100;          // 虚拟显示适配器永远排最后
  if (GPU_NVIDIA_RE.test(n)) s += 60;
  else if (GPU_AMD_RE.test(n)) s += 55;
  else if (GPU_INTEL_RE.test(n)) s += 20;
  if (c.bus === 'PCI') s += 8;                    // 真显卡基本都挂 PCI
  if (c.vram > 0) s += 6;
  s += Math.min((c.vram || 0) / 1024, 20);         // 显存越大越可能是独显
  return s;
}

async function detectGpu() {
  let controllers = [];
  try {
    const g = await si.graphics();
    controllers = (g.controllers || [])
      .map((c, i) => ({
        index: i,
        model: String(c.model || '').trim(),
        vendor: String(c.vendor || '').trim(),
        vram: Number(c.vram) || 0,
        bus: String(c.bus || ''),
      }))
      .filter((c) => c.model);
  } catch (e) { controllers = []; }

  const real = controllers.filter((c) => !GPU_VIRTUAL_RE.test(c.model));
  const pool = (real.length ? real : controllers).slice().sort((a, b) => scoreGpu(b) - scoreGpu(a) || a.index - b.index);
  const primary = pool[0] || null;

  gpuInfo.name = primary ? primary.model : '';
  gpuInfo.index = primary ? primary.index : 0;
  gpuInfo.nvidiaIndex = null;
  gpuInfo.method = null;

  if (primary && GPU_NVIDIA_RE.test(primary.model)) {
    // nvidia-smi 的序号和 si 列表下标不是一回事，按型号名匹配
    const out = await runNvidiaSmi(['--query-gpu=index,name', '--format=csv,noheader']);
    if (out) {
      const rows = out.split('\n').map((l) => l.split(',').map((s) => s.trim())).filter((r) => r.length >= 2);
      const want = primary.model.toLowerCase().replace(/\s+/g, ' ');
      const hit = rows.find((r) => {
        const n = r[1].toLowerCase().replace(/\s+/g, ' ');
        return n === want || n.includes(want) || want.includes(n);
      }) || (rows.length === 1 ? rows[0] : null);
      if (hit) {
        gpuInfo.nvidiaIndex = parseInt(hit[0], 10) || 0;
        gpuInfo.method = 'nvidia';
      }
    }
  }
  if (!gpuInfo.method && (await gpuViaCounter()) !== null) gpuInfo.method = 'counter';
  return gpuInfo;
}

async function gpuViaCounter() {
  // 每个进程都会有一条计数器样本，直接求和会成倍虚高（实测 601 条）。
  // 这里按 luid/phys/eng/engtype 归并取同一引擎的最大值，再取全部引擎的最大值 —— 与任务管理器口径一致
  const out = await runCmd('powershell', [
    '-NoProfile', '-Command',
    "$s = (Get-Counter '\\GPU Engine(*)\\Utilization Percentage' -ErrorAction Stop).CounterSamples; " +
    "$m = @{}; foreach ($x in $s) { $k = ($x.InstanceName -replace '^pid_\\d+_', ''); " +
    "if (-not $m.ContainsKey($k) -or $m[$k] -lt $x.CookedValue) { $m[$k] = $x.CookedValue } }; " +
    "if ($m.Count -eq 0) { 0 } else { ($m.Values | Measure-Object -Maximum).Maximum }",
  ]);
  if (out === null) return null;
  const v = parseFloat(out);
  return isNaN(v) ? null : v;
}

async function readGpu() {
  if (gpuInfo.method === 'nvidia') {
    const idx = gpuInfo.nvidiaIndex == null ? 0 : gpuInfo.nvidiaIndex;
    const out = await runNvidiaSmi([
      '-i', String(idx),
      '--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total',
      '--format=csv,noheader,nounits',
    ]);
    if (!out) return null;
    const [util, temp, mUsed, mTotal] = out.split('\n')[0].split(',').map((s) => parseFloat(s.trim()));
    return { util: util || 0, temp: temp > 0 ? temp : null, memUsed: mUsed, memTotal: mTotal };
  }
  if (gpuInfo.method === 'counter') {
    const util = await gpuViaCounter();
    return util === null ? null : { util: Math.min(util, 100), temp: null, memUsed: null, memTotal: null };
  }
  return null;
}

// ---------- 网速监控：常驻 typeperf（避免 si.networkStats 每次spawn子进程的高开销） ----------
// ---------- 消息通知监控（微信/QQ） ----------
let notifyProc = null;
let notifyBuf = '';
let toastAccess = 'unknown';   // 系统通知访问权限：Allowed / Denied / Unspecified

function isMessagingApp(n) {
  const s = `${n.aumid || ''} ${n.app || ''} ${n.cls || ''} ${n.title || ''}`.toLowerCase();
  if (/tencent\.wechat|weixin|wechat/.test(s)) return 'wechat';
  if (/tencent\.qq|qqexmail|tim|qqnt/.test(s)) return 'qq';
  if (/微信/.test(s)) return 'wechat';
  if (/^qq|qq$|qq音乐/.test(s)) return 'qq';
  return null;
}

// ---------- 系统控制（音量 / 输出设备 / Wi-Fi / 蓝牙） ----------
let scTimer = null;
let lastScState = null;

function runSysControl(action, value, cb) {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'system-control.ps1')
    : path.join(__dirname, 'media', 'system-control.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action];
  if (value !== undefined && value !== null && value !== '') args.push('-Value', String(value));
  execFile(PS_EXE, args, { windowsHide: true, timeout: 25000 },
    (err, stdout, stderr) => {
      if (err || !stdout) {
        if (err) console.error('[sysControl] exec error:', err.message, stderr);
        return cb && cb(null);
      }
      try {
        const data = JSON.parse(stdout.trim().split('\n').pop());
        // 音量/静音动作只返回 volume+muted，不能覆盖掉设备列表/Wi-Fi/蓝牙，
        // 否则拖动音量时界面会瞬间显示“未检测到输出设备”
        const merged = Object.assign({}, lastScState || {}, data);
        lastScState = merged;
        if (win && !win.isDestroyed()) {
          try { win.webContents.send('sc:state', merged); } catch (e) { /* 忽略 */ }
        }
        if (cb) cb(merged);
      } catch (e) {
        console.error('[sysControl] parse error:', e.message, stdout);
        if (cb) cb(null);
      }
    });
}

function startScWatch() {
  if (scTimer) return;
  runSysControl('status');
  scTimer = setInterval(() => runSysControl('status'), 2800);
}

function stopScWatch() {
  if (scTimer) { clearInterval(scTimer); scTimer = null; }
}

// 无线外设电量（蓝牙鼠标/键盘/耳机，读 PnP 电池属性）
let devBattTimer = null;
let devBattBusy = false;
let lastDevices = [];
let lastHidError = '';

// 依次探测可用的解释器，必须能 import hid 才算可用
function pythonCandidates() {
  const base = process.env.LOCALAPPDATA || '';
  const local = path.join(base, 'Programs', 'Python');
  const list = [];
  for (const v of ['Python314', 'Python313', 'Python312', 'Python311', 'Python310']) {
    list.push({ exe: path.join(local, v, 'python.exe'), pre: [] });
  }
  for (const dir of ['C:\\Python314', 'C:\\Python313', 'C:\\Python312', 'C:\\Anaconda3', 'C:\\Anaconda', 'C:\\Miniconda3']) {
    list.push({ exe: path.join(dir, 'python.exe'), pre: [] });
  }
  list.push({ exe: 'py.exe', pre: ['-3'] });
  list.push({ exe: 'python.exe', pre: [] });
  return list;
}

function probeHid(exe, pre) {
  try {
    const r = spawnSync(exe, [...pre, '-c', 'import hid;print("OK")'], {
      windowsHide: true, timeout: 12000, encoding: 'utf8',
    });
    return r.status === 0 && /OK/.test(r.stdout || '');
  } catch (e) { return false; }
}

let pyPick;   // undefined=未探测；null=无可用；{exe,pre}=可用
function resolveHidPython() {
  if (pyPick !== undefined) return pyPick;
  pyPick = null;
  const cands = pythonCandidates().filter((c) => c.exe === 'python.exe' || c.exe === 'py.exe' || fs.existsSync(c.exe));
  for (const c of cands) {
    if (probeHid(c.exe, c.pre)) { pyPick = c; return pyPick; }
  }
  return pyPick;
}

// 没有解释器带 hid 时，后台补装（不能阻塞主进程）
let hidBootstrapping = false;
function bootstrapHidAsync() {
  if (hidBootstrapping) return;
  hidBootstrapping = true;
  const cands = pythonCandidates().filter((c) => c.exe === 'python.exe' || c.exe === 'py.exe' || fs.existsSync(c.exe));
  const next = () => {
    const c = cands.shift();
    if (!c) { hidBootstrapping = false; return; }
    execFile(c.exe, [...c.pre, '-m', 'pip', 'install', 'hidapi', '--disable-pip-version-check', '-q'],
      { windowsHide: true, timeout: 180000 },
      (err) => {
        if (!err && probeHid(c.exe, c.pre)) {
          pyPick = c;
          hidBootstrapping = false;
          setTimeout(pollDeviceBattery, 1200);
          return;
        }
        next();
      });
  };
  next();
}

function runBleProbe(cb) {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'devices-battery.ps1')
    : path.join(__dirname, 'media', 'devices-battery.ps1');
  execFile(PS_EXE,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, timeout: 25000 },
    (err, stdout) => {
      if (err || !stdout) return cb([]);
      try {
        const data = JSON.parse(stdout.trim().split('\n').pop());
        cb(Array.isArray(data.devices) ? data.devices : []);
      } catch (e) { cb([]); }
    });
}

function runHidProbe(cb, debug) {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'devices_hid_battery.py')
    : path.join(__dirname, 'media', 'devices_hid_battery.py');
  if (!fs.existsSync(script)) { lastHidError = 'script-missing'; return cb([]); }
  const pick = resolveHidPython();
  if (!pick) { lastHidError = 'no-python-hid'; bootstrapHidAsync(); return cb([]); }
  const args = [...pick.pre, '-X', 'utf8', script].concat(debug ? ['--debug'] : []);
  execFile(pick.exe, args, {
    windowsHide: true, timeout: 25000,
    // 中文 Windows 上 Python 默认按 GBK 写 stdout，会让中文设备名变成乱码
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  },
    (err, stdout, stderr) => {
      if (debug) {
        try {
          const logPath = path.join(app.getPath('userData'), 'peripheral-diagnostic.txt');
          const head = [
            '=== Agile Capsule 外设电量诊断 ===',
            '时间: ' + new Date().toLocaleString(),
            'Python: ' + pick.exe + ' ' + pick.pre.join(' '),
            '上次 HID 通道状态: ' + (lastHidError || 'ok'),
            '',
            '[HID 探测 stdout]',
            stdout || '(空)',
            '',
            '[HID 探测 stderr / 原始报文]',
            stderr || '(空)',
            '',
          ].join('\n');
          fs.writeFileSync(logPath, head, 'utf8');
          runBleProbe((ble) => {
            try {
              fs.appendFileSync(logPath, '[蓝牙通道结果]\n' + JSON.stringify(ble, null, 2) + '\n');
            } catch (e) { /* 忽略 */ }
            if (win && !win.isDestroyed()) win.webContents.send('devices:diag', logPath);
          });
        } catch (e) { /* 忽略 */ }
      }
      if (err || !stdout) { lastHidError = err ? String(err.message || err) : 'empty'; return cb([]); }
      try {
        const data = JSON.parse(stdout.trim().split('\n').pop());
        if (data && data.ok === false) {
          lastHidError = data.reason || 'probe-failed';
          return cb([]);
        }
        lastHidError = '';
        cb(Array.isArray(data.devices) ? data.devices : []);
      } catch (e) { lastHidError = 'json-parse'; cb([]); }
    });
}

function mergeDevices(ble, hid) {
  const out = [];
  const seen = new Set();
  for (const d of [...hid, ...ble]) {
    if (!d || !d.level) continue;
    const key = String(d.name || '').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: d.id || '',
      name: d.name || '未知设备',
      kind: d.kind || 'other',
      level: Math.round(d.level),
      charging: !!d.charging,
      conn: d.conn || 'BT',
      protocol: d.protocol || '',
      stale: !!d.stale,
    });
  }
  out.sort((a, b) => a.level - b.level);
  return out.slice(0, 6);
}

// 接收器通常只报 "USB Receiver"，真实型号来自 HID++。设备休眠时读不到，
// 所以把读到过的型号按 设备ID 长期记住，之后即使只拿到兜底名也能显示真名
const GENERIC_NAME_RE = /(无线设备|未知设备|usb receiver|receiver)/i;

function devNameCachePath() {
  return path.join(app.getPath('userData'), 'peripheral-names.json');
}

let devNames;
function loadDevNames() {
  if (!devNames) {
    try {
      const raw = JSON.parse(fs.readFileSync(devNameCachePath(), 'utf8'));
      devNames = raw && typeof raw === 'object' ? raw : {};
    } catch (e) { devNames = {}; }
  }
  return devNames;
}

function applyDevNames(list) {
  const names = loadDevNames();
  let dirty = false;
  for (const d of list) {
    const key = d.id || (d.conn === 'BT' ? 'bt:' + String(d.name || '').toLowerCase() : '');
    if (!key) continue;
    const known = names[key];
    const knownName = typeof known === 'string' ? known : (known && known.name) || '';
    const knownKind = typeof known === 'object' && known ? known.kind : '';
    if (knownName && (!d.name || GENERIC_NAME_RE.test(d.name))) d.name = knownName;
    if (knownKind && (!d.kind || d.kind === 'other')) d.kind = knownKind;
    if (d.name && !GENERIC_NAME_RE.test(d.name)) {
      const next = { name: d.name, kind: d.kind || 'other' };
      if (!known || known.name !== next.name || known.kind !== next.kind) {
        names[key] = next;
        dirty = true;
      }
    }
  }
  if (dirty) {
    try { fs.writeFileSync(devNameCachePath(), JSON.stringify(names), 'utf8'); } catch (e) { /* 忽略 */ }
  }
  return list;
}

// 接收器/蓝牙设备闲时会休眠，读数会短暂为空 —— 用上次有效值兜底
function devBattCachePath() {
  return path.join(app.getPath('userData'), 'peripheral-cache.json');
}

function loadDevBattCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(devBattCachePath(), 'utf8'));
    if (!raw || !Array.isArray(raw.devices)) return null;
    const now = Date.now();
    // 逐设备判断新鲜度：一只鼠标休眠不该把另一只刚读到的新数据一起丢掉
    const fresh = raw.devices.filter((d) => now - (d.ts || raw.ts || 0) <= 30 * 60 * 1000);
    return fresh.length ? fresh : null;
  } catch (e) { return null; }
}

function saveDevBattCache(list) {
  try {
    const now = Date.now();
    const devices = list.map((d) => ({ ...d, ts: d.stale ? (d.ts || now) : now }));
    fs.writeFileSync(devBattCachePath(), JSON.stringify({ ts: now, devices }), 'utf8');
  } catch (e) { /* 忽略 */ }
}

// 休眠的那只鼠标用上次读数补齐，卡片不会直接消失（标记 stale，界面上提示休眠）
function fillFromCache(live) {
  const cached = loadDevBattCache();
  if (!cached || !cached.length) return live;
  const have = new Set(live.map((d) => d.id || d.name));
  const out = live.slice();
  for (const c of cached) {
    const key = c.id || c.name;
    if (have.has(key)) continue;
    out.push({ ...c, stale: true });
  }
  out.sort((a, b) => a.level - b.level);
  return out.slice(0, 6);
}

let devBattRetry = null;
let devBattRetryLeft = 6;

function scheduleDevBattRetry() {
  if (devBattRetry || devBattRetryLeft <= 0) return;
  devBattRetryLeft -= 1;
  // 无线设备闲时会休眠，读数拿不到时短周期重试，用户一动鼠标就能补上
  devBattRetry = setTimeout(() => { devBattRetry = null; pollDeviceBattery(); }, 8000);
}

function pollDeviceBattery() {
  if (devBattBusy) return;
  devBattBusy = true;
  let pending = 2;
  let ble = [];
  let hid = [];
  const done = () => {
    if (--pending > 0) return;
    devBattBusy = false;
    let merged = mergeDevices(ble, hid);
    applyDevNames(merged);
    merged = fillFromCache(merged);
    if (merged.some((d) => !d.stale)) {
      devBattRetryLeft = 6;
      saveDevBattCache(merged);
    } else {
      scheduleDevBattRetry();
    }
    lastDevices = merged;
    if (win && !win.isDestroyed()) win.webContents.send('devices', lastDevices);
  };
  runBleProbe((list) => { ble = list; done(); });
  runHidProbe((list) => { hid = list; done(); });
}

// 微信头像缓存（PrintWindow 抓取会话列表头像，被遮挡也能抓到）
function avatarFileFor(conv) {
  try {
    const hash = crypto.createHash('md5').update(String(conv), 'utf8').digest('hex');
    const f = path.join(app.getPath('userData'), 'avatars', hash + '.png');
    return fs.existsSync(f) ? f : null;
  } catch (e) { return null; }
}
let avatarTimer = null;
let avatarBusy = false;
function refreshAvatars() {
  if (avatarBusy) return;
  avatarBusy = true;
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'wechat-avatars.ps1')
    : path.join(__dirname, 'media', 'wechat-avatars.ps1');
  execFile(PS_EXE,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-All'],
    { windowsHide: true, timeout: 60000 },
    () => { avatarBusy = false; });
}

// 微信会话列表监听（跨版本：读取会话列表的未读数与最新消息预览）
let wxProc = null;
let wxBuf = '';
let wxBase = null;   // Map: 会话名 -> 上次未读数
let lastWxState = '';

function parseSessionRow(raw) {
  const parts = String(raw || '').split(' | ').map((s) => s.trim()).filter(Boolean);
  const conv = parts.shift() || '';
  let unread = 0;
  let time = '';
  const mids = [];
  for (const p of parts) {
    const u = p.match(/^\[(\d+)条\]$/);
    if (u) { unread = parseInt(u[1], 10); continue; }
    if (/^(\d{1,2}:\d{2}|昨天.*|星期.*|\d{1,2}\/\d{1,2}|\d{4}\/\d{1,2}\/\d{1,2})$/.test(p)) { time = p; continue; }
    if (p === '消息免打扰' || p === '草稿' || p === '已置顶' || p === '[草稿]') continue;
    mids.push(p);
  }
  let text = mids.join(' ');
  let sender = '';
  const m = text.match(/^([^:：]{1,14})[:：]\s*([\s\S]*)$/);
  if (m && m[2]) { sender = m[1]; text = m[2]; }
  return { conv, unread, time, sender, text };
}

const WX_STATE_TEXT = {
  'minimized': '微信已最小化，暂时读不到会话列表',
  'nouia': '微信界面不开放辅助功能（新版限制），读不到会话列表',
  'no-window': '找不到微信主窗口（可能已退出）',
};

function logWxState(state) {
  try {
    const f = path.join(app.getPath('userData'), 'notify-debug.log');
    fs.appendFileSync(f, new Date().toLocaleTimeString() + ' [wx-state] ' + state +
      (WX_STATE_TEXT[state] ? ' · ' + WX_STATE_TEXT[state] : '') + '\n');
  } catch (e) { /* 忽略 */ }
}

function handleSessionsFrame(f) {
  if (!f) return;
  if (f.type === 'wxsessions-state') {
    if (f.state !== lastWxState) {
      lastWxState = f.state;
      logWxState(f.state);
    }
    return;
  }
  if (f.type !== 'wxsessions' || !Array.isArray(f.rows)) return;
  if (lastWxState !== 'ok') lastWxState = 'ok';
  const rows = f.rows.map((r) => parseSessionRow(r.raw || r.key || '')).filter((r) => r.conv);
  if (!rows.length) return;
  if (!wxBase) {
    wxBase = new Map(rows.map((r) => [r.conv, r.unread]));
    return;                       // 首帧只建立基线，不补发历史
  }
  for (const r of rows) {
    const prev = wxBase.has(r.conv) ? wxBase.get(r.conv) : 0;
    if (r.unread > prev) {
      const body = (r.sender ? r.sender + ': ' : '') + (r.text || '新消息');
      try {
        const dbg = path.join(app.getPath('userData'), 'notify-debug.log');
        fs.appendFileSync(dbg, new Date().toLocaleTimeString() + ' [wx-session] ' + r.conv + ' (' + r.unread + ') => ' + body + '\n');
      } catch (e) { /* 忽略 */ }
      if (win && !win.isDestroyed()) {
        win.webContents.send('notify', {
          app: 'wechat', appName: '微信', source: 'session',
          title: r.conv, body, sender: r.sender, ts: Date.now(),
          avatar: avatarFileFor(r.conv),
        });
      }
    }
    wxBase.set(r.conv, r.unread);
  }
  if (wxBase.size > 60) {
    const keep = new Set(rows.map((r) => r.conv));
    for (const k of [...wxBase.keys()]) if (!keep.has(k)) wxBase.delete(k);
  }
}

function startWechatWatch() {
  const respawnWx = () => {
    if (app.isQuitting) return;
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'wechat-sessions.ps1')
      : path.join(__dirname, 'media', 'wechat-sessions.ps1');
    try {
      wxProc = spawn(PS_EXE,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-IntervalMs', '700'],
        { windowsHide: true });
      wxBuf = '';
      wxProc.stdout.on('data', (c) => {
        wxBuf += c.toString();
        let idx;
        while ((idx = wxBuf.indexOf('\n')) >= 0) {
          const line = wxBuf.slice(0, idx).trim();
          wxBuf = wxBuf.slice(idx + 1);
          if (!line.startsWith('{')) continue;
          let f;
          try { f = JSON.parse(line); } catch (e) { continue; }
          handleSessionsFrame(f);
        }
      });
      wxProc.stderr.on('data', () => {});
      wxProc.on('exit', () => { wxBase = null; setTimeout(respawnWx, 3000); });
    } catch (e) {
      setTimeout(respawnWx, 6000);
    }
  };
  respawnWx();
}

// 点击通知卡片「查看」：打开微信并定位到该会话
ipcMain.on('notify:open', (_e, payload) => {
  if (!payload || !payload.conv) return;
  if (payload.app && payload.app !== 'wechat') return;
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'wechat-open.ps1')
    : path.join(__dirname, 'media', 'wechat-open.ps1');
  execFile(PS_EXE,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Conv', String(payload.conv)],
    { windowsHide: true, timeout: 20000 },
    (err, stdout) => {
      try {
        const log = path.join(app.getPath('userData'), 'notify-debug.log');
        fs.appendFileSync(log, new Date().toLocaleTimeString() + ' [open] ' + payload.conv + ' => ' + String(stdout || '').trim() + '\n');
      } catch (e) { /* 忽略 */ }
    });
});

ipcMain.on('sc:watch', (_e, on) => {
  if (on) {
    if (lastScState && win && !win.isDestroyed()) {
      try { win.webContents.send('sc:state', lastScState); } catch (e) { /* 忽略 */ }
    }
    startScWatch();
  } else {
    stopScWatch();
  }
});
ipcMain.on('sc:status', () => runSysControl('status'));
// 音量调节防抖与单实例任务队列
let pendingVolume = null;
let isSettingVolume = false;

function applyVolume(vol) {
  pendingVolume = vol;
  if (isSettingVolume) return;

  function step() {
    if (pendingVolume === null) {
      isSettingVolume = false;
      return;
    }
    const current = pendingVolume;
    pendingVolume = null;
    isSettingVolume = true;

    runSysControl('volume', current, (data) => {
      if (pendingVolume !== null) {
        step();
      } else {
        isSettingVolume = false;
      }
    });
  }
  step();
}

ipcMain.on('sc:volume', (_e, v) => {
  const vol = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  applyVolume(vol);
});
ipcMain.on('sc:mute', (_e, on) => runSysControl('mute', on ? '1' : '0'));
ipcMain.on('sc:audio', (_e, id) => runSysControl('audio', String(id || '')));
ipcMain.on('sc:wifi', async () => {
  try {
    await shell.openExternal('ms-availablenetworks:');
  } catch (err) {
    runSysControl('wifi');
  }
});
ipcMain.on('sc:bt', (_e, on) => runSysControl('bt', on ? '1' : '0'));

// ---------- 灵动岛内 Wi-Fi 选择与连接 ----------
function runWifiControl(action, params = {}, cb) {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'wifi-control.ps1')
    : path.join(__dirname, 'media', 'wifi-control.ps1');
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action];
  if (params.ssid) args.push('-SSID', String(params.ssid));
  if (params.password) args.push('-Password', String(params.password));
  if (params.enabled !== undefined) args.push('-Enabled', String(params.enabled));
  execFile(PS_EXE, args, { windowsHide: true, timeout: 25000 }, (err, stdout, stderr) => {
    if (err || !stdout) {
      if (err) console.error('[wifiControl] error:', err.message, stderr);
      return cb && cb({ ok: false, error: err ? err.message : '执行失败' });
    }
    try {
      const data = JSON.parse(stdout.trim().split('\n').pop());
      if (cb) cb(data);
    } catch (e) {
      console.error('[wifiControl] parse error:', e.message, stdout);
      if (cb) cb({ ok: false, error: '解析结果失败' });
    }
  });
}

ipcMain.on('wifi:get-list', (event) => {
  runWifiControl('list', {}, (data) => {
    try { event.sender.send('wifi:list', data); } catch (e) { }
  });
});

ipcMain.on('wifi:connect', (event, payload) => {
  const { ssid, password } = payload || {};
  runWifiControl('connect', { ssid, password }, (data) => {
    try { event.sender.send('wifi:connect-result', data); } catch (e) { }
    runSysControl('status');
  });
});

ipcMain.on('wifi:disconnect', (event) => {
  runWifiControl('disconnect', {}, (data) => {
    try { event.sender.send('wifi:disconnect-result', data); } catch (e) { }
    runSysControl('status');
  });
});

ipcMain.on('wifi:set-radio', (event, on) => {
  runWifiControl('radio', { enabled: on ? '1' : '0' }, (data) => {
    try { event.sender.send('wifi:radio-result', data); } catch (e) { }
    setTimeout(() => runSysControl('status'), 350);
  });
});

ipcMain.on('wifi:open-settings', () => {
  try { shell.openExternal('ms-settings:privacy-location'); } catch (e) { }
});

ipcMain.on('net:diagnose', async (e) => {
  try {
    const first = await diagnoseNetwork();
    let fixed = null;
    let after = first;
    if (!first.ok) {
      fixed = await repairAndProbe();
      after = await diagnoseNetwork();
    }
    const summary = {
      ...after,
      repaired: !!(fixed && fixed.ok),
      originalReason: first.reason,
    };
    try { e.sender.send('net:report', summary); } catch (err) { /* 忽略 */ }
  } catch (err) { /* 忽略 */ }
});

ipcMain.on('weather:get', (e) => {
  if (weatherData) {
    try { e.sender.send('weather', weatherData); } catch (err) { /* 忽略 */ }
  } else {
    fetchWeather();
  }
});

ipcMain.on('devices:diagnose', () => {
  runHidProbe(() => {}, true);
});

// 消息通知诊断：不同微信版本界面差异极大，这里把"为什么收不到"直接写进报告
function buildNotifyReport(d) {
  const lines = [];
  lines.push('=== 灵动岛 消息通知诊断 ===');
  lines.push('时间: ' + new Date().toLocaleString());
  lines.push('系统: ' + (d.os || '-'));
  lines.push('');

  const wxs = Array.isArray(d.wechat) ? d.wechat.filter(Boolean) : [];
  const wx = wxs[0];
  if (wx) {
    lines.push('微信: ' + wx.name + ' ' + (wx.version || '-'));
    lines.push('  路径: ' + (wx.path || '-'));
    lines.push('  主窗口类: ' + (wx.cls || '-'));
    const u = wx.uiaNodes;
    lines.push('  界面 UIA 节点数: ' + u + (u >= 0 && u <= 3 ? '   （自绘界面，读不到会话列表/弹窗文字）' : ''));
  } else {
    lines.push('微信: 未运行');
  }
  const qq = (Array.isArray(d.qq) ? d.qq : [])[0];
  if (qq) lines.push('QQ: ' + qq.name + ' ' + (qq.version || '-') + '  UIA 节点数: ' + qq.uiaNodes);

  lines.push('');
  lines.push('系统通知权限: ' + (d.toastAccess || '-'));
  lines.push('通知中心现有消息: ' + (d.toastCount || 0) + ' 条');
  if (Array.isArray(d.recentToasts) && d.recentToasts.length) {
    for (const t of d.recentToasts.slice(0, 5)) {
      lines.push('  - ' + (t.app || '') + ' | ' + (t.aumid || '') + ' | ' + (t.texts || []).join(' / '));
    }
  }
  lines.push('全局通知开关: ' + (d.globalToastsEnabled || '-'));

  lines.push('');
  lines.push('结论:');
  if (wx && wx.uiaNodes >= 0 && wx.uiaNodes <= 3) {
    lines.push('  · 微信 4.x 是 Qt 自绘界面，灵动岛读不到它的会话/弹窗，只能走 Windows 系统通知。');
    lines.push('  · 请打开 微信 → 设置 → 消息通知 → 勾选「接收新消息通知」；');
    lines.push('    再到 Windows → 设置 → 系统 → 通知 → 微信 → 允许通知 / 显示横幅。');
  }
  if ((d.toastAccess || '') !== 'Allowed') {
    lines.push('  · 系统通知访问权限未授予（' + (d.toastAccess || '-') + '），消息内容读不到；请在系统提示里允许。');
  }
  if (!d.toastCount) {
    lines.push('  · 通知中心当前 0 条：说明微信没有向系统推送通知，先按上面两步开一下开关。');
  }
  return lines.join('\n');
}

ipcMain.on('notify:diagnose', () => {
  const script = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'notify-diag.ps1')
    : path.join(__dirname, 'media', 'notify-diag.ps1');
  execFile(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, timeout: 30000 },
    (err, stdout) => {
      let data = null;
      try { data = JSON.parse(String(stdout || '').trim().split('\n').pop()); } catch (e) { data = null; }
      const file = path.join(app.getPath('userData'), 'notify-diag.txt');
      const body = data
        ? buildNotifyReport(data)
        : '=== 灵动岛 消息通知诊断 ===\n诊断脚本执行失败: ' + (err ? err.message : '无输出') + '\n\n原始输出:\n' + String(stdout || '');
      try { fs.writeFileSync(file, body, 'utf8'); } catch (e) { /* 忽略 */ }
      if (win && !win.isDestroyed()) win.webContents.send('notify:diag', file);
      try { shell.showItemInFolder(file); } catch (e) { /* 忽略 */ }
    });
});

function startNotifyWatch() {
  const unsub = () => {};
  const respawn = () => {
    if (app.isQuitting) return;
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'notify-watch.ps1')
      : path.join(__dirname, 'media', 'notify-watch.ps1');
    try {
      notifyProc = spawn(PS_EXE,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-IntervalMs', '1200'],
        { windowsHide: true });
      notifyBuf = '';
      notifyProc.stdout.on('data', (c) => {
        notifyBuf += c.toString();
        let idx;
        while ((idx = notifyBuf.indexOf('\n')) >= 0) {
          const line = notifyBuf.slice(0, idx).trim();
          notifyBuf = notifyBuf.slice(idx + 1);
          if (!line.startsWith('{')) continue;
          let n;
          try { n = JSON.parse(line); } catch (e) { continue; }
          if (n && n.type === 'access') {
            // 系统通知访问权限状态（微信 4.x 只能靠这个通道）
            toastAccess = n.status || 'unknown';
            try {
              const dbg = path.join(app.getPath('userData'), 'notify-debug.log');
              fs.appendFileSync(dbg, new Date().toLocaleTimeString() + ' [toast-access] ' + toastAccess + '\n');
            } catch (e) { /* 忽略 */ }
            continue;
          }
          try {
            const dbg = path.join(app.getPath('userData'), 'notify-debug.log');
            if (fs.existsSync(dbg) && fs.statSync(dbg).size > 512 * 1024) fs.unlinkSync(dbg);
            fs.appendFileSync(dbg, new Date().toLocaleTimeString() + ' ' + line + '\n');
          } catch (e) { /* 忽略 */ }
          if (n && n.type === 'flash') {
            const exe = String(n.exe || '').toLowerCase();
            const kind = exe.indexOf('wechat') >= 0 || exe.indexOf('weixin') >= 0 ? 'wechat' : 'qq';
            try {
              const dbg = path.join(app.getPath('userData'), 'notify-debug.log');
              fs.appendFileSync(dbg, new Date().toLocaleTimeString() + ' [flash] ' + exe + '\n');
            } catch (e) { /* 忽略 */ }
            if (win && !win.isDestroyed()) {
              win.webContents.send('notify', {
                app: kind,
                appName: kind === 'wechat' ? '微信' : 'QQ',
                source: 'flash',
                title: kind === 'wechat' ? '微信' : 'QQ',
                body: '收到一条新消息',
                ts: n.ts || Date.now(),
              });
            }
            continue;
          }
          const kind = isMessagingApp(n);
          if (!kind) continue;
          const texts = Array.isArray(n.texts) ? n.texts.filter(Boolean) : [];
          if (!texts.length) continue;
          const payload = {
            app: kind,
            appName: kind === 'wechat' ? '微信' : 'QQ',
            source: n.type,
            title: n.title || texts[0] || '',   // 会话/发送人
            body: texts.slice(1).join(' ') || texts[0] || '',
            ts: n.ts || Date.now(),
          };
          if (win && !win.isDestroyed()) win.webContents.send('notify', payload);
        }
      });
      notifyProc.stderr.on('data', () => {});
      notifyProc.on('exit', () => { setTimeout(respawn, 4000); });
    } catch (e) {
      setTimeout(respawn, 8000);
    }
  };
  respawn();
  startWechatWatch();
  startWechatOcr();
}

// 微信 4.x 自绘界面读不到文字时，截弹窗做 OCR（Windows 自带中文识别）
let wxOcrProc = null;
function startWechatOcr() {
  const respawnOcr = () => {
    if (app.isQuitting) return;
    const script = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', 'wechat-ocr.ps1')
      : path.join(__dirname, 'media', 'wechat-ocr.ps1');
    try {
      wxOcrProc = spawn(PS_EXE,
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-IntervalMs', '600'],
        { windowsHide: true });
      let buf = '';
      wxOcrProc.stdout.on('data', (c) => {
        buf += c.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('{')) continue;
          let n;
          try { n = JSON.parse(line); } catch (e) { continue; }
          if (!n || n.type !== 'wxpopup') continue;
          const lines = Array.isArray(n.texts) ? n.texts.filter(Boolean) : [];
          if (!lines.length) continue;
          let title = lines[0];
          let body = lines.slice(1).join(' ');
          const m = title.match(/^([^：:]{1,20})[：:]\s*([\s\S]+)$/);
          if (m) { title = m[1]; body = (m[2] + (body ? ' ' + body : '')).trim(); }
          try {
            const dbg = path.join(app.getPath('userData'), 'notify-debug.log');
            fs.appendFileSync(dbg, new Date().toLocaleTimeString() + ' [wx-ocr] ' + lines.join(' / ') + '\n');
          } catch (e) { /* 忽略 */ }
          if (win && !win.isDestroyed()) {
            win.webContents.send('notify', {
              app: 'wechat', appName: '微信', source: 'ocr',
              title, body, ts: n.ts || Date.now(),
            });
          }
        }
      });
      wxOcrProc.stderr.on('data', () => {});
      wxOcrProc.on('exit', () => { wxOcrProc = null; setTimeout(respawnOcr, 5000); });
    } catch (e) {
      setTimeout(respawnOcr, 8000);
    }
  };
  respawnOcr();
}

// ---------- 天气：Open-Meteo（免费、无需 API Key，商业用途除外） ----------
let weatherTimer = null;
let weatherData = null;
let geoCache = null;

const WMO_TEXT = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '阵雨', 81: '强阵雨', 82: '暴阵雨', 85: '阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
};

// ---------- 网络体检 + 自动修复（每台机器网络环境不同，加载天气前先自检） ----------
const dnsMod = require('dns');
const netMod = require('net');
let directSession = null;
let lastNetReport = null;

function getDirectSession() {
  try {
    if (!directSession) {
      directSession = session.fromPartition('island-direct-net');
      directSession.setProxy({ mode: 'direct' });
    }
    return directSession;
  } catch (e) { return null; }
}

function tcpProbe(host, port, timeout) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = new netMod.Socket();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (e) { /* 忽略 */ }
      resolve({ ok, ms: Date.now() - t0 });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    try { sock.connect(port, host); } catch (e) { finish(false); }
  });
}

function dnsProbe(host, family) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    dnsMod.lookup(host, { family }, (err, addr) => {
      resolve({ ok: !err && !!addr, addr: addr || '', ms: Date.now() - t0, code: err ? err.code : '' });
    });
  });
}

// 走 Chromium 网络栈的 HTTPS 探测（可指定 session，用于测试直连是否可用）
function httpProbe(url, timeout, ses) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (ok, status) => {
      if (done) return;
      done = true;
      resolve({ ok, ms: Date.now() - t0, status: status || 0 });
    };
    try {
      const req = net.request({ url, method: 'HEAD', ...(ses ? { session: ses } : {}) });
      req.on('response', (res) => { res.on('data', () => {}); res.on('end', () => finish(res.statusCode > 0 && res.statusCode < 500, res.statusCode)); });
      req.on('error', () => finish(false));
      setTimeout(() => { if (!done) { try { req.abort(); } catch (e) { /* 忽略 */ } finish(false); } }, timeout);
      req.end();
    } catch (e) { finish(false); }
  });
}

async function diagnoseNetwork(host) {
  const target = host || 'geocoding-api.open-meteo.com';
  const [v4, v6, tcp] = await Promise.all([
    dnsProbe(target, 4),
    dnsProbe(target, 6),
    tcpProbe(target, 443, 4000),
  ]);
  const http = await httpProbe('https://' + target + '/', 6000);
  const report = {
    host: target,
    dnsV4: v4,
    dnsV6: v6,
    tcp,
    http,
    ok: http.ok,
    ts: Date.now(),
  };
  // 归因
  if (http.ok) report.reason = 'ok';
  else if (!v4.ok && !v6.ok) report.reason = 'dns-fail';
  else if (!v4.ok && v6.ok) report.reason = 'ipv6-only';
  else if (!tcp.ok) report.reason = 'tcp-blocked';
  else report.reason = 'https-fail';
  lastNetReport = report;
  wxLog('网络体检: ' + report.reason + ' v4=' + v4.ok + '/' + v4.ms + 'ms v6=' + v6.ok + '/' + v6.ms + 'ms tcp=' + tcp.ok + '/' + tcp.ms + 'ms http=' + http.ok + '/' + http.ms + 'ms');
  return report;
}

// 自动修复：换直连会话重试 + 多次退避重试
async function repairAndProbe(host) {
  const target = host || 'geocoding-api.open-meteo.com';
  const ses = getDirectSession();
  if (ses) {
    const direct = await httpProbe('https://' + target + '/', 6000, ses);
    wxLog('修复尝试: 直连会话 http=' + direct.ok + ' ' + direct.ms + 'ms');
    if (direct.ok) return { ok: true, via: 'direct' };
  }
  for (let i = 0; i < 2; i++) {
    await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    const again = await httpProbe('https://' + target + '/', 7000);
    wxLog('修复尝试: 重试#' + (i + 1) + ' http=' + again.ok);
    if (again.ok) return { ok: true, via: 'retry' };
  }
  return { ok: false, via: '' };
}

// 加载天气前调用：确保网络可用，不可用则尝试修复
async function ensureNetwork() {
  const first = await diagnoseNetwork();
  if (first.ok) return first;
  sendWeatherStatus({ phase: 'repairing', reason: first.reason });
  const fixed = await repairAndProbe();
  const after = await diagnoseNetwork();
  if (after.ok) {
    sendWeatherStatus({ phase: 'fixed', reason: first.reason, via: fixed.via });
  } else {
    sendWeatherStatus({ phase: 'fail', reason: after.reason });
  }
  return after;
}

function sendWeatherStatus(payload) {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('weather:status', payload); } catch (e) { /* 忽略 */ }
  }
}

// 内置常用城市坐标：geocoding 不可用时兜底，保证天气仍能显示
const CITY_FALLBACK = {
  '北京': [39.9042, 116.4074], '上海': [31.2304, 121.4737], '广州': [23.1291, 113.2644],
  '深圳': [22.5431, 114.0579], '中山': [22.5231, 113.3791], '珠海': [22.2707, 113.5767],
  '东莞': [23.0207, 113.7518], '佛山': [23.0218, 113.1219], '杭州': [30.2741, 120.1551],
  '南京': [32.0603, 118.7969], '苏州': [31.2989, 120.5853], '成都': [30.5728, 104.0668],
  '重庆': [29.5630, 106.5516], '武汉': [30.5928, 114.3055], '西安': [34.3416, 108.9398],
  '长沙': [28.2282, 112.9388], '郑州': [34.7466, 113.6253], '青岛': [36.0671, 120.3826],
  '济南': [36.6512, 117.1201], '天津': [39.3434, 117.3616], '沈阳': [41.8057, 123.4315],
  '大连': [38.9140, 121.6147], '哈尔滨': [45.8038, 126.5349], '长春': [43.8171, 125.3235],
  '石家庄': [38.0428, 114.5149], '太原': [37.8706, 112.5489], '合肥': [31.8206, 117.2272],
  '福州': [26.0745, 119.2965], '厦门': [24.4798, 118.0894], '南昌': [28.6820, 115.8579],
  '昆明': [25.0389, 102.7183], '贵阳': [26.6470, 106.6302], '南宁': [22.8170, 108.3665],
  '海口': [20.0444, 110.1999], '兰州': [36.0611, 103.8343], '西宁': [36.6171, 101.7782],
  '银川': [38.4872, 106.2309], '乌鲁木齐': [43.8256, 87.6168], '呼和浩特': [40.8424, 111.7490],
  '拉萨': [29.6520, 91.1721], '香港': [22.3193, 114.1694], '澳门': [22.1987, 113.5439],
  '台北': [25.0330, 121.5654], '宁波': [29.8683, 121.5440], '温州': [27.9938, 120.6994],
  '无锡': [31.4912, 120.3119], '常州': [31.8107, 119.9740], '徐州': [34.2058, 117.2840],
};

function httpsGetJson(url) {
  // 优先走 Electron 的 Chromium 网络栈：能正确处理 IPv4/IPv6 回退与系统代理，
  // 部分机器上 Node 自带的 https 会 ETIMEDOUT（IPv6 不通时不回退）
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const fallbackNode = () => {
      try {
        const req = https.get(url, {
          timeout: 8000,
          family: 4,
          headers: { 'User-Agent': 'AgileCapsule/1.0' },
        }, (res) => {
          if (res.statusCode !== 200) { res.resume(); done(null); return; }
          let raw = '';
          res.setEncoding('utf8');
          res.on('data', (c) => { raw += c; });
          res.on('end', () => { try { done(JSON.parse(raw)); } catch (e) { done(null); } });
        });
        req.on('timeout', () => { req.destroy(); done(null); });
        req.on('error', () => done(null));
      } catch (e) { done(null); }
    };
    try {
      const req = net.request({ url, method: 'GET' });
      req.setHeader('User-Agent', 'AgileCapsule/1.0');
      req.on('response', (res) => {
        if (res.statusCode !== 200) {
          res.on('data', () => {});
          res.on('end', () => done(null));
          return;
        }
        let chunks = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          try { done(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { done(null); }
        });
      });
      req.on('error', () => fallbackNode());
      setTimeout(() => { if (!settled) { try { req.abort(); } catch (e) {} fallbackNode(); } }, 9000);
      req.end();
    } catch (e) {
      fallbackNode();
    }
  });
}

// 城市名 → 经纬度（Open-Meteo 自带的地理编码，支持中文）
async function resolveCity(city) {
  const name = String(city || '').trim() || '北京';
  if (geoCache && geoCache.city === name) return geoCache;
  const j = await httpsGetJson('https://geocoding-api.open-meteo.com/v1/search?count=1&language=zh&format=json&name=' + encodeURIComponent(name));
  const r = j && j.results && j.results[0];
  if (!r) {
    const fb = CITY_FALLBACK[String(name).replace(/市$/, '')];
    if (fb) {
      wxLog('geocoding 不可用，使用内置坐标: ' + name);
      geoCache = { city: name, lat: fb[0], lon: fb[1], name };
      return geoCache;
    }
    return null;
  }
  geoCache = { city: name, lat: r.latitude, lon: r.longitude, name: r.name };
  return geoCache;
}

function wxLog(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'weather-debug.log');
    if (fs.existsSync(f) && fs.statSync(f).size > 200000) fs.writeFileSync(f, '');
    fs.appendFileSync(f, new Date().toLocaleTimeString() + ' ' + msg + '\n');
  } catch (e) { /* 忽略 */ }
}

async function fetchWeather() {
  try {
    sendWeatherStatus({ phase: 'checking' });
    const net = await ensureNetwork();
    if (!net.ok) { wxLog('网络不可用，跳过本次天气'); return; }
    const loc = await resolveCity(appSettings.weatherCity);
    if (!loc) { wxLog('geocode 失败: ' + JSON.stringify(appSettings.weatherCity)); return; }
    wxLog('定位成功: ' + loc.name + ' ' + loc.lat + ',' + loc.lon);
    const url = 'https://api.open-meteo.com/v1/forecast?latitude=' + loc.lat + '&longitude=' + loc.lon +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&hourly=temperature_2m&forecast_hours=30' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min' +
      '&timezone=auto&forecast_days=5';
    const j = await httpsGetJson(url);
    if (!j || !j.current) { wxLog('forecast 返回空'); return; }
    const cur = j.current;
    const day = j.daily || {};
    const hourly = j.hourly || {};
    const hTimes = Array.isArray(hourly.time) ? hourly.time : [];
    const hTemps = Array.isArray(hourly.temperature_2m) ? hourly.temperature_2m : [];
    // 从当前整点开始取未来 30 小时，供“接下来”逐时条使用
    const nowHour = parseInt(String(cur.time).slice(11, 13), 10);
    const series = hTimes.slice(0, 24).map((t, i) => ({
      t: String(t).slice(11, 16),
      v: hTemps[i],
      past: false,
    })).filter((s) => typeof s.v === 'number');

    const dTime = Array.isArray(day.time) ? day.time : [];
    const dCode = Array.isArray(day.weather_code) ? day.weather_code : [];
    const dMax = Array.isArray(day.temperature_2m_max) ? day.temperature_2m_max : [];
    const dMin = Array.isArray(day.temperature_2m_min) ? day.temperature_2m_min : [];
    const days = dTime.slice(0, 5).map((dt, i) => ({
      date: dt,
      code: dCode[i],
      high: typeof dMax[i] === 'number' ? Math.round(dMax[i]) : null,
      low: typeof dMin[i] === 'number' ? Math.round(dMin[i]) : null,
    }));

    weatherData = {
      city: loc.name,
      temp: Math.round(cur.temperature_2m),
      feels: Math.round(cur.apparent_temperature),
      humidity: Math.round(cur.relative_humidity_2m),
      wind: Math.round(cur.wind_speed_10m),
      code: cur.weather_code,
      text: WMO_TEXT[cur.weather_code] || '未知',
      high: Array.isArray(day.temperature_2m_max) ? Math.round(day.temperature_2m_max[0]) : null,
      low: Array.isArray(day.temperature_2m_min) ? Math.round(day.temperature_2m_min[0]) : null,
      nowHour,
      series,
      days,
      ts: Date.now(),
    };
    wxLog('成功: ' + weatherData.city + ' ' + weatherData.temp + '° ' + weatherData.text);
    if (win && !win.isDestroyed()) win.webContents.send('weather', weatherData);
  } catch (e) { wxLog('异常: ' + e.message); }
}

function startWeatherWatch() {
  if (weatherTimer) return;
  fetchWeather();
  weatherTimer = setInterval(fetchWeather, 15 * 60 * 1000);
}

// ---------- Agent 额度（参考 BrimDeck：优先自动读本机登录态，不强制填 Key） ----------
let quotaTimer = null;

function readJsonFileSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

// 外网走 Chromium 网络栈：自动沿用系统代理（Clash / v2ray 等），否则 chatgpt.com 这类站点直连必超时
function isLocalHost(hostname) {
  return hostname === 'localhost' || hostname === '::1' || hostname === '[::1]' || /^127\./.test(hostname);
}

function requestJsonViaNet(url, o) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      req = net.request({ url, method: o.method || 'GET', redirect: 'follow', useSessionCookies: false });
    } catch (e) { finish(null); return; }
    const headers = Object.assign({ 'User-Agent': 'AgileCapsule/1.0', Accept: 'application/json' }, o.headers || {});
    Object.keys(headers).forEach((k) => {
      const v = headers[k];
      if (v == null || v === '') return;
      try { req.setHeader(k, v); } catch (e) { /* 忽略非法头 */ }
    });
    const timer = setTimeout(() => {
      try { req.abort(); } catch (e) { /* 忽略 */ }
      finish({ status: 0, json: null });
    }, o.timeout || 6000);
    req.on('response', (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c.toString('utf8'); });
      res.on('end', () => {
        clearTimeout(timer);
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { json = null; }
        finish({ status: res.statusCode, json });
      });
      res.on('error', () => { clearTimeout(timer); finish({ status: 0, json: null }); });
    });
    req.on('error', () => { clearTimeout(timer); finish({ status: 0, json: null }); });
    if (o.body) req.write(o.body);
    req.end();
  });
}

// http/https 通用的 JSON 请求
function requestJson(url, opt) {
  const o = opt || {};
  let u;
  try { u = new URL(url); } catch (e) { return Promise.resolve(null); }
  // 本机服务（Antigravity language server）直连，避免代理绕一圈
  if (!isLocalHost(u.hostname)) {
    try { return requestJsonViaNet(url, o); } catch (e) { /* 退回直连 */ }
  }
  return new Promise((resolve) => {
    const lib = u.protocol === 'http:' ? require('http') : https;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + (u.search || ''),
      method: o.method || 'GET',
      timeout: o.timeout || 6000,
      headers: Object.assign({ 'User-Agent': 'AgileCapsule/1.0', Accept: 'application/json' }, o.headers || {}),
      rejectUnauthorized: o.rejectUnauthorized !== false,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { json = null; }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, json: null }); });
    req.on('error', () => resolve({ status: 0, json: null }));
    if (o.body) req.write(o.body);
    req.end();
  });
}

function numOf(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function resetText(v) {
  if (v == null) return '';
  let ms = null;
  if (typeof v === 'number') ms = v > 1e12 ? v : v * 1000;
  else if (typeof v === 'string') { const t = Date.parse(v); if (!isNaN(t)) ms = t; }
  if (ms == null) return '';
  const diff = ms - Date.now();
  if (diff <= 0) return '即将重置';
  const h = Math.floor(diff / 3600000);
  const m = Math.round((diff % 3600000) / 60000);
  if (h >= 24) return Math.floor(h / 24) + ' 天 ' + (h % 24) + ' 小时后重置';
  return h > 0 ? h + ' 小时 ' + m + ' 分后重置' : m + ' 分后重置';
}

// 设置页贴的 token 可能带 Bearer，也可能是一整段 JSON
function pickToken(raw, jsonPath) {
  const v = String(raw || '').trim();
  if (!v) return '';
  if (v.startsWith('{')) {
    try {
      const got = jsonPath(JSON.parse(v));
      return typeof got === 'string' ? got.trim() : '';
    } catch (e) { return ''; }
  }
  return v.replace(/^Bearer\s+/i, '').trim();
}

// --- Claude Code ---
function claudeToken() {
  const fromSetting = pickToken(appSettings.claudeToken, (j) => j && j.claudeAiOauth && j.claudeAiOauth.accessToken);
  if (fromSetting) return fromSetting;
  const j = readJsonFileSafe(path.join(os.homedir(), '.claude', '.credentials.json'));
  const t = j && j.claudeAiOauth && j.claudeAiOauth.accessToken;
  return typeof t === 'string' && t ? t : '';
}

async function quotaClaude() {
  const token = claudeToken();
  const base = { id: 'claude', name: 'Claude Code' };
  if (!token) return Object.assign(base, { ok: false, status: '未登录 · 设置里可粘贴 token' });
  const r = await requestJson('https://api.anthropic.com/api/oauth/usage', {
    headers: { Authorization: 'Bearer ' + token, 'anthropic-beta': 'oauth-2025-04-20' },
  });
  if (!r || r.status !== 200 || !r.json) {
    return Object.assign(base, { ok: false, status: r && r.status ? '查询失败 HTTP ' + r.status : '网络不可达' });
  }
  const d = r.json;
  const quotas = [];
  const push = (label, pct, reset) => {
    const v = numOf(pct);
    if (v == null || v < 0 || quotas.some((q) => q.label === label)) return;
    quotas.push({ label, pct: v, reset });
  };
  push('5 小时', d.five_hour && d.five_hour.utilization, d.five_hour && d.five_hour.resets_at);
  push('每周', d.seven_day && d.seven_day.utilization, d.seven_day && d.seven_day.resets_at);
  for (const lim of (Array.isArray(d.limits) ? d.limits : [])) {
    const kind = String(lim.kind || '');
    const scope = lim.scope || {};
    const name = (scope.model && scope.model.display_name) || (scope.surface && scope.surface.display_name) || '';
    if (kind === 'session') push('5 小时', lim.percent, lim.resets_at);
    else if (kind === 'weekly_all') push('每周', lim.percent, lim.resets_at);
    else if (name) push(name + (String(lim.group || '') === 'weekly' || kind === 'weekly_scoped' ? ' 每周' : ''), lim.percent, lim.resets_at);
  }
  push('Opus 每周', d.seven_day_opus && d.seven_day_opus.utilization, d.seven_day_opus && d.seven_day_opus.resets_at);
  push('Sonnet 每周', d.seven_day_sonnet && d.seven_day_sonnet.utilization, d.seven_day_sonnet && d.seven_day_sonnet.resets_at);
  if (!quotas.length) return Object.assign(base, { ok: false, status: '返回里没有额度字段' });
  return Object.assign(base, { ok: true, quotas });
}

// --- Codex / ChatGPT ---
function codexAuth() {
  const sToken = pickToken(appSettings.codexToken, (j) => j && j.tokens && j.tokens.access_token);
  const sAccount = String(appSettings.codexAccountId || '').trim();
  if (sToken) return { token: sToken, account: sAccount };
  const j = readJsonFileSafe(path.join(os.homedir(), '.codex', 'auth.json'));
  const t = j && j.tokens;
  if (!t || typeof t.access_token !== 'string' || !t.access_token) return null;
  return { token: t.access_token, account: t.account_id || '' };
}

async function quotaCodex() {
  const base = { id: 'codex', name: 'Codex / ChatGPT' };
  const a = codexAuth();
  if (!a) return Object.assign(base, { ok: false, status: '未登录 · 设置里可粘贴 token' });
  const r = await requestJson('https://chatgpt.com/backend-api/wham/usage', {
    headers: { Authorization: 'Bearer ' + a.token, 'chatgpt-account-id': a.account || '', 'OAI-Language': 'zh-CN' },
  });
  if (!r || r.status !== 200 || !r.json) {
    return Object.assign(base, { ok: false, status: r && r.status ? '查询失败 HTTP ' + r.status : '网络不可达（chatgpt.com，检查系统代理）' });
  }
  const d = r.json;
  const rl = d.rate_limit || d.rate_limits || {};
  const quotas = [];
  const read = (w, fallback) => {
    if (!w) return;
    const used = numOf(w.used_percent);
    if (used == null) return;
    const secs = numOf(w.limit_window_seconds);
    const mins = secs ? Math.round(secs / 60) : null;
    let label;
    if (mins === 300) label = '5 小时';
    else if (mins === 1440) label = '每日';
    else if (mins === 10080) label = '每周';
    else if (mins && mins >= 1440 && mins % 1440 === 0) label = (mins / 1440) + ' 天';
    else label = mins ? mins + ' 分钟' : fallback;
    let reset = w.reset_at || w.resets_at;
    if (!reset && numOf(w.reset_after_seconds) != null) reset = Date.now() + numOf(w.reset_after_seconds) * 1000;
    quotas.push({ label, pct: Math.min(Math.max(used, 0), 100), reset });
  };
  read(rl.primary_window, '主要额度');
  read(rl.secondary_window, '次要额度');
  if (!quotas.length) return Object.assign(base, { ok: false, status: '返回结构未知' });
  const plan = String(d.plan_type || '');
  return Object.assign(base, { ok: true, quotas, plan: plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : '' });
}

// --- Cursor（state.vscdb 里的 cursorAuth/accessToken） ---
function cursorTokenFromDb() {
  const db = path.join(process.env.APPDATA || os.homedir(), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (!fs.existsSync(db)) return { installed: false, token: '' };
  const code = "import sqlite3,sys;c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);r=c.execute(\"SELECT value FROM ItemTable WHERE key='cursorAuth/accessToken' LIMIT 1\").fetchone();print(r[0] if r else '')";
  for (const exe of ['python', 'py']) {
    try {
      const out = spawnSync(exe, ['-c', code, db], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const t = String(out.stdout || '').trim();
      if (t) return { installed: true, token: t.startsWith('v10') ? '' : t };
      if (out.status === 0) return { installed: true, token: '' };
    } catch (e) { /* 换下一个解释器 */ }
  }
  return { installed: true, token: '' };
}

async function quotaCursor() {
  const base = { id: 'cursor', name: 'Cursor' };
  const manual = pickToken(appSettings.cursorToken, (j) => j && (j.accessToken || (j.cursorAuth && j.cursorAuth.accessToken)));
  let token = manual;
  let installed = true;
  if (!token) {
    const got = cursorTokenFromDb();
    installed = got.installed;
    token = got.token;
  }
  if (!token) {
    return Object.assign(base, { ok: false, status: installed ? '未登录或被加密 · 设置里可粘贴 token' : '未安装' });
  }
  const r = await requestJson('https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
    body: '{}',
  });
  if (!r || r.status !== 200 || !r.json) {
    return Object.assign(base, { ok: false, status: r && r.status ? '查询失败 HTTP ' + r.status : '网络不可达' });
  }
  const d = r.json;
  const plan = (d.planUsage && typeof d.planUsage === 'object') ? d.planUsage : ((d.individualUsage && d.individualUsage.plan) || {});
  const reset = d.billingCycleEnd;
  const quotas = [];
  const unified = d.isUnified === true;
  if (unified) {
    const used = numOf(plan.totalPercentUsed);
    if (used != null) quotas.push({ label: '账期', pct: Math.min(Math.max(used, 0), 100), reset });
  } else {
    const auto = numOf(plan.autoPercentUsed);
    const api = numOf(plan.apiPercentUsed);
    if (auto != null) quotas.push({ label: 'Cursor 模型', pct: Math.min(Math.max(auto, 0), 100), reset });
    if (api != null) quotas.push({ label: '其他模型', pct: Math.min(Math.max(api, 0), 100), reset });
    if (!quotas.length) {
      const total = numOf(plan.totalPercentUsed);
      if (total != null) quotas.push({ label: '账期', pct: Math.min(Math.max(total, 0), 100), reset });
    }
  }
  if (!quotas.length) return Object.assign(base, { ok: false, status: '返回结构未知' });
  return Object.assign(base, { ok: true, quotas });
}

// --- Antigravity（本地 language server，读 hub_*.json 拿端口和 csrf） ---
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }
}

async function quotaAntigravity() {
  const base = { id: 'antigravity', name: 'Antigravity' };
  const daemon = path.join(os.homedir(), '.gemini', 'antigravity', 'daemon');
  let files = [];
  try { files = fs.readdirSync(daemon).filter((f) => /^hub_.*\.json$/i.test(f)); } catch (e) { files = []; }
  if (!files.length) {
    const installed = fs.existsSync(path.join(os.homedir(), '.gemini', 'antigravity'));
    return Object.assign(base, { ok: false, status: installed ? '本地服务未就绪（打开 Antigravity 后自动刷新）' : '未安装' });
  }
  for (const f of files) {
    const j = readJsonFileSafe(path.join(daemon, f));
    if (!j) continue;
    const pid = numOf(j.pid);
    const port = numOf(j.httpPort);
    const token = j.csrfToken;
    if (!pid || !port || !token || !pidAlive(pid)) continue;
    const url = 'http://127.0.0.1:' + port + '/exa.language_server_pb.LanguageServerService/GetUserStatus';
    const r = await requestJson(url, {
      method: 'POST',
      timeout: 3000,
      headers: { 'x-codeium-csrf-token': token, 'Connect-Protocol-Version': '1', 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!r || r.status !== 200 || !r.json) continue;
    const d = r.json;
    // 新版（lsVersion 2.3x）返回 { userStatus: { planStatus, cascadeModelConfigData } }；
    // 老版 codeium 风格是 { response: { groups: [{ buckets: [...] }] } }，两种都兼容。
    const us = d.userStatus || (d.response && d.response.userStatus) || null;
    const groups = (d.response && d.response.groups) || d.groups || [];
    const quotas = [];
    let plan = '';
    if (us) {
      const ps = us.planStatus || {};
      const info = ps.planInfo || {};
      plan = String(info.planName || us.userTier || '');
      const addCredits = (label, avail, total) => {
        const a = numOf(avail);
        const t = numOf(total);
        if (a == null || !t || t <= 0) return;
        quotas.push({ label, pct: (1 - Math.min(Math.max(a / t, 0), 1)) * 100, reset: null });
      };
      addCredits('Prompt', ps.availablePromptCredits, info.monthlyPromptCredits);
      addCredits('Flow', ps.availableFlowCredits, info.monthlyFlowCredits);
      // 模型配额同一个剩余比例只留一条，免得 10 个模型刷满界面
      const models = (us.cascadeModelConfigData && us.cascadeModelConfigData.clientModelConfigs) || [];
      const seen = {};
      for (const m of models) {
        const q = m.quotaInfo || {};
        const frac = numOf(q.remainingFraction);
        if (frac == null) continue;
        const key = String(frac) + '|' + String(q.resetTime || '');
        if (seen[key]) continue;
        seen[key] = true;
        quotas.push({
          label: '模型额度',
          pct: (1 - Math.min(Math.max(frac, 0), 1)) * 100,
          reset: q.resetTime,
        });
      }
    }
    for (const g of groups) {
      const groupName = String(g.displayName || '');
      for (const b of (g.buckets || [])) {
        const frac = numOf(b.remainingFraction);
        if (frac == null || b.disabled === true) continue;
        const id = String(b.bucketId || '');
        let win = String(b.window || '').toLowerCase();
        if (!win) win = /-5h$/i.test(id) ? '5h' : /-weekly$/i.test(id) ? 'weekly' : '';
        const period = win === '5h' ? '5 小时' : (win === 'daily' || win === '1d') ? '每日' : (win === 'weekly' || win === '7d') ? '每周' : '';
        const group = /argon/i.test(id) ? 'Argon' : /^gemini-/i.test(id) ? 'Gemini' : /^3p-/i.test(id) ? 'Claude' : groupName;
        quotas.push({
          label: (group ? group + ' ' : '') + (period || String(b.displayName || id || '额度')),
          pct: (1 - Math.min(Math.max(frac, 0), 1)) * 100,
          reset: b.resetTime,
        });
      }
    }
    if (!quotas.length) continue;
    return Object.assign(base, { ok: true, quotas, plan });
  }
  return Object.assign(base, { ok: false, status: '本地服务暂不可用' });
}

// --- DeepSeek 余额 ---
async function quotaDeepseek() {
  const base = { id: 'deepseek', name: 'DeepSeek' };
  const key = String(appSettings.deepseekKey || '').trim();
  if (!key) return Object.assign(base, { ok: false, status: '设置里填 API Key 后可查余额' });
  const r = await requestJson('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + key } });
  if (!r || r.status !== 200 || !r.json) {
    return Object.assign(base, { ok: false, status: r && r.status ? '查询失败 HTTP ' + r.status : '网络不可达' });
  }
  const info = (r.json.balance_infos || [])[0] || {};
  const total = numOf(info.total_balance);
  if (total == null) return Object.assign(base, { ok: false, status: '返回里没有余额字段' });
  const cur = info.currency === 'USD' ? '$' : '¥';
  return Object.assign(base, {
    ok: true,
    balance: cur + total.toFixed(2),
    detail: '赠送 ' + cur + (numOf(info.granted_balance) || 0).toFixed(2) + ' · 充值 ' + cur + (numOf(info.topped_up_balance) || 0).toFixed(2),
  });
}

// --- OpenRouter 额度 ---
async function quotaOpenrouter() {
  const base = { id: 'openrouter', name: 'OpenRouter' };
  const key = String(appSettings.openrouterKey || '').trim();
  if (!key) return Object.assign(base, { ok: false, status: '设置里填 API Key 后可查额度' });
  const r = await requestJson('https://openrouter.ai/api/v1/auth/key', { headers: { Authorization: 'Bearer ' + key } });
  if (!r || r.status !== 200 || !r.json || !r.json.data) {
    return Object.assign(base, { ok: false, status: r && r.status ? '查询失败 HTTP ' + r.status : '网络不可达' });
  }
  const d = r.json.data;
  const usage = numOf(d.usage) || 0;
  const limit = numOf(d.limit);
  if (limit == null) return Object.assign(base, { ok: true, balance: '$' + usage.toFixed(2), detail: '累计已用（无上限）' });
  return Object.assign(base, {
    ok: true,
    quotas: [{ label: '额度', pct: limit > 0 ? (usage / limit) * 100 : 0, reset: null }],
    detail: '$' + usage.toFixed(2) + ' / $' + limit.toFixed(2),
  });
}

// ---------- 额度快照：跨关机保留，下次打开时先显示，再静默校准 ----------
// 成功查到一次就写入 quota-cache.json，不再按 12 小时过期；重新开机先还原上次结果，
// 随后只做一次校准。校准失败时继续保留旧快照，并标记为「上次」。

function quotaCachePath() {
  return path.join(app.getPath('userData'), 'quota-cache.json');
}

let quotaCache = { items: {} };   // { items: { codex: { at, ok, data } } }

function loadQuotaCache() {
  const j = readJsonFileSafe(quotaCachePath());
  quotaCache = { items: (j && j.items) || {} };
  return quotaCache;
}

function saveQuotaCache() {
  try {
    const fp = quotaCachePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(quotaCache), 'utf8');
  } catch (e) { /* 写不进去不阻塞 */ }
}

// 成功的结果一直保存；失败的保留旧的成功记录，等下次校准再更新
function rememberQuota(list, at) {
  for (const q of list) {
    if (!q || !q.id) continue;
    if (q.ok) {
      const data = Object.assign({}, q);
      delete data.stale;
      delete data.staleAt;
      quotaCache.items[q.id] = { at, ok: true, data };
    }
  }
  saveQuotaCache();
}

function withQuotaCache(list) {
  return list.map((q) => {
    if (!q || q.ok) return q;
    const c = q && quotaCache.items[q.id];
    if (!c || !c.ok || !c.data) return q;
    return Object.assign({}, c.data, { stale: true, staleAt: c.at });
  });
}

function cachedQuotaList() {
  const order = ['claude', 'codex', 'cursor', 'antigravity', 'deepseek', 'openrouter'];
  const out = [];
  for (const [id, c] of Object.entries(quotaCache.items || {})) {
    if (!c || !c.ok || !c.data) continue;
    out.push(Object.assign({}, c.data, { stale: true, staleAt: c.at }));
  }
  out.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  return out;
}

let lastQuotaList = null;
let lastQuotaFetch = 0;
let quotaFetching = false;
const QUOTA_REFRESH_GAP = 10 * 60 * 1000;   // 同一次运行里，页面来回切换不反复校准

async function fetchAllQuotas() {
  if (quotaFetching) return lastQuotaList || cachedQuotaList();
  quotaFetching = true;
  lastQuotaFetch = Date.now();
  try {
    const live = await Promise.all([
      quotaClaude(), quotaCodex(), quotaCursor(), quotaAntigravity(),
      quotaDeepseek(), quotaOpenrouter(),
    ]);
    rememberQuota(live, lastQuotaFetch);
    const list = withQuotaCache(live);
    lastQuotaList = list;
    if (win && !win.isDestroyed()) win.webContents.send('quotas', list);
    return list;
  } finally {
    quotaFetching = false;
  }
}

ipcMain.on('quota:test', async (e) => {
  const list = await fetchAllQuotas();
  try { e.sender.send('quota:test-result', list); } catch (err) { /* 忽略 */ }
});

// 渲染端启动/展开时先拿缓存，再按需刷新
ipcMain.on('quota:get', (e) => {
  const list = lastQuotaList || cachedQuotaList();
  if (!list.length) return;
  try { e.sender.send('quotas', list); } catch (err) { /* 忽略 */ }
});

ipcMain.on('quota:refresh', async (e, opts) => {
  const force = !!(opts && opts.force);
  if (!force && Date.now() - lastQuotaFetch < QUOTA_REFRESH_GAP) {
    if (lastQuotaList) {
      try { e.sender.send('quotas', lastQuotaList); } catch (err) { /* 忽略 */ }
    }
    return;
  }
  await fetchAllQuotas();
});

// ---------- 剪贴板历史：复制文字后在岛上冒一张小卡，也能回剪贴板页点回来 ----------
const CLIP_KEEP = 30;          // 只留最近 30 条
const CLIP_MAX_CHARS = 20000;  // 单条太长（整份日志/文件内容）不记

let clipItems = [];            // [{ text, at }] 新的在最前
let clipTimer = null;
let pruneTimer = null;
let lastClipText = null;
let lastClipImage = null;
let lastClipFile = null;
let skipClipText = null;       // 我们自己写回剪贴板的内容，别再记一遍

function clipboardPath() {
  return path.join(app.getPath('userData'), 'clipboard.json');
}

function clipImageDir() {
  return path.join(app.getPath('userData'), 'clip-images');
}
function bootEpoch() {
  try { return Date.now() - Math.round(os.uptime() * 1000); } catch (e) { return Date.now(); }
}

const CLIP_TTL_MS = 24 * 60 * 60 * 1000;   // 超过一天自动清除

function validClip(c) {
  if (!c) return false;
  if (c.type === 'image') return c.path && fs.existsSync(c.path);
  if (c.type === 'video') return c.path && fs.existsSync(c.path);
  return typeof c.text === 'string' && c.text.trim();
}

function loadClips() {
  const j = readJsonFileSafe(clipboardPath());
  let items = [];
  let savedBoot = 0;
  if (Array.isArray(j)) {
    items = j;                       // 旧格式：没有 ts / bootAt
  } else if (j && typeof j === 'object') {
    items = Array.isArray(j.items) ? j.items : [];
    savedBoot = Number(j.bootAt) || 0;
  }

  const boot = bootEpoch();
  const rebooted = !savedBoot || Math.abs(boot - savedBoot) > 120000;
  if (rebooted) {
    // 关机重启后清空
    clipItems = [];
    wipeClipImages();
    saveClips();
    clipDebug('检测到重新开机，已清空剪贴板历史');
    return clipItems;
  }

  clipItems = items
    .filter(validClip)
    .filter((c) => c.ts && Date.now() - c.ts < CLIP_TTL_MS)   // 超过一天丢弃
    .slice(0, CLIP_KEEP);
  if (clipItems.length !== items.length) saveClips();
  return clipItems;
}

// 删除所有图片缓存文件
function wipeClipImages() {
  try {
    const dir = clipImageDir();
    if (!fs.existsSync(dir)) return;
    for (const f of fs.readdirSync(dir)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 忽略 */ }
    }
  } catch (e) { /* 忽略 */ }
}

// 定时清理过期条目（每 10 分钟）
function pruneClips() {
  const before = clipItems.length;
  clipItems = clipItems.filter((c) => c.ts && Date.now() - c.ts < CLIP_TTL_MS);
  if (clipItems.length !== before) {
    saveClips();
    cleanupClipImages();
    emitClips();
    clipDebug('过期清理: ' + before + ' → ' + clipItems.length);
  }
}

function saveClips() {
  try {
    fs.writeFileSync(clipboardPath(), JSON.stringify({ bootAt: bootEpoch(), items: clipItems }));
  } catch (e) { /* 忽略 */ }
}

// 剪贴板诊断日志：排障用，只在内容变化时写几行，超过 256KB 自动清空重来
function clipDebug(msg) {
  try {
    const f = path.join(app.getPath('userData'), 'clipboard-debug.log');
    try {
      if (fs.existsSync(f) && fs.statSync(f).size > 262144) fs.writeFileSync(f, '');
    } catch (e) { /* 忽略 */ }
    const t = new Date();
    const ts = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0');
    fs.appendFileSync(f, ts + ' ' + String(msg).slice(0, 400) + '\n');
  } catch (e) { /* 忽略 */ }
}

function clipPreview(text) {
  return String(text).split(/\s+/).filter(Boolean).join(' ');
}

const VIDEO_EXT = /\.(mp4|mov|mkv|avi|webm|wmv|flv|m4v|ts|mpeg|mpg)$/i;
const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|heic)$/i;

function readClipboardFiles() {
  try {
    const buf = clipboard.readBuffer('FileNameW');
    if (!buf || buf.length < 4) return [];
    const text = buf.toString('utf16le');
    return text.split('\u0000').map((x) => x.trim()).filter(Boolean);
  } catch (e) { return []; }
}

function clipTime() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function pushClipVideo(file, at) {
  const name = path.basename(file);
  const i = clipItems.findIndex((c) => c.type === 'video' && c.path === file);
  if (i === 0) return false;
  if (i > 0) clipItems.splice(i, 1);
  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { /* 忽略 */ }
  clipItems.unshift({ type: 'video', path: file, name, size, at, ts: Date.now() });
  if (clipItems.length > CLIP_KEEP) clipItems.length = CLIP_KEEP;
  saveClips();
  return true;
}

function pushClipImage(file, width, height, at) {
  const i = clipItems.findIndex((c) => c.type === 'image' && c.path === file);
  if (i === 0) return false;
  if (i > 0) clipItems.splice(i, 1);
  clipItems.unshift({ type: 'image', path: file, w: width, h: height, at, ts: Date.now() });
  if (clipItems.length > CLIP_KEEP) clipItems.length = CLIP_KEEP;
  saveClips();
  cleanupClipImages();
  return true;
}

// 只保留历史里引用到的图片文件，避免无限增长
function cleanupClipImages() {
  try {
    const dir = clipImageDir();
    if (!fs.existsSync(dir)) return;
    const keep = new Set(clipItems.filter((c) => c.type === 'image').map((c) => path.basename(c.path)));
    for (const f of fs.readdirSync(dir)) {
      if (!keep.has(f)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch (e) { /* 忽略 */ }
      }
    }
  } catch (e) { /* 忽略 */ }
}

function saveClipImage(image) {
  try {
    const dir = clipImageDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const buf = image.toPNG();
    if (!buf || !buf.length) return null;
    const hash = crypto.createHash('md5').update(buf).digest('hex');
    const file = path.join(dir, hash + '.png');
    if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
    const size = image.getSize();
    return { file, width: size.width, height: size.height };
  } catch (e) {
    clipDebug('保存图片失败: ' + e.message);
    return null;
  }
}

function pushClip(text, at) {
  const i = clipItems.findIndex((c) => c.text === text);
  if (i === 0) return false;
  if (i > 0) clipItems.splice(i, 1);
  clipItems.unshift({ text, at, ts: Date.now() });
  if (clipItems.length > CLIP_KEEP) clipItems.length = CLIP_KEEP;
  saveClips();
  return true;
}

// 密码管理器这类应用会打上「不要进剪贴板历史」的标记，命中就跳过
async function clipboardBlocked() {
  try {
    const ex = await Promise.resolve(clipboard.readBuffer('ExcludeClipboardContentFromMonitorProcessing'));
    if (ex && ex.length) { clipDebug('blocked: Exclude 标记 len=' + ex.length); return true; }
  } catch (e) { /* 没有这个格式 */ }
  try {
    const inc = await Promise.resolve(clipboard.readBuffer('CanIncludeInClipboardHistory'));
    if (inc && inc.length >= 4 && inc.readUInt32LE(0) === 0) { clipDebug('blocked: CanInclude=0'); return true; }
  } catch (e) { /* 没有这个格式 */ }
  return false;
}

function emitClips() {
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('clip:list', clipItems); } catch (e) { /* 忽略 */ }
  }
}

let clipChecking = false;

async function doCheckClipboard() {
  // 剪贴板偶尔会返回非预期内容（比如只有图片/HTML 时），任何异常都不能炸主进程
  try {
    let raw = null;
    try { raw = await Promise.resolve(clipboard.readText()); }
    catch (e) { clipDebug('readText 抛错: ' + e.message); return; }
    if (typeof raw !== 'string' && raw != null) clipDebug('readText 非字符串: ' + Object.prototype.toString.call(raw));
    const text = typeof raw === 'string' ? raw : String(raw == null ? '' : raw);
    if (text === lastClipText && text.trim()) return;
    lastClipText = text;
    clipDebug('变化 len=' + text.length + ' head=' + text.slice(0, 24));
    if (!text.trim()) {
      // 复制的是文件：优先识别视频，其次图片文件
      const files = readClipboardFiles();
      if (files.length) {
        const target = files.find((f) => VIDEO_EXT.test(f)) || files.find((f) => IMAGE_EXT.test(f));
        if (target && fs.existsSync(target)) {
          if (await clipboardBlocked()) return;
          const key = target + '|' + (() => { try { return fs.statSync(target).mtimeMs; } catch (e) { return 0; } })();
          if (key !== lastClipFile) {
            lastClipFile = key;
            if (VIDEO_EXT.test(target)) {
              if (pushClipVideo(target, clipTime())) {
                const pv = { type: 'video', path: target, name: path.basename(target), at: clipTime() };
                clipDebug('已记录视频 ' + path.basename(target));
                if (win && !win.isDestroyed()) {
                  try { win.webContents.send('clip:new', pv); } catch (e) { /* 忽略 */ }
                }
                emitClips();
              }
            } else {
              try {
                const img = nativeImage.createFromPath(target);
                if (img && !img.isEmpty()) {
                  const saved = saveClipImage(img);
                  if (saved && pushClipImage(saved.file, saved.width, saved.height, clipTime())) {
                    const pv = { type: 'image', path: saved.file, w: saved.width, h: saved.height, at: clipTime() };
                    if (win && !win.isDestroyed()) {
                      try { win.webContents.send('clip:new', pv); } catch (e) { /* 忽略 */ }
                    }
                    emitClips();
                  }
                }
              } catch (e) { /* 忽略 */ }
            }
          }
          return;
        }
      }
      // 没有文字时尝试位图
      const img = clipboard.readImage();
      if (img && !img.isEmpty()) {
        if (await clipboardBlocked()) return;
        const saved = saveClipImage(img);
        if (!saved) return;
        if (lastClipImage === saved.file) return;
        lastClipImage = saved.file;
        const at2 = clipTime();
        if (!pushClipImage(saved.file, saved.width, saved.height, at2)) { clipDebug('跳过：与最近一张图片相同'); return; }
        clipDebug('已记录图片 ' + saved.width + 'x' + saved.height);
        const payload2 = { type: 'image', path: saved.file, w: saved.width, h: saved.height, at: at2 };
        if (win && !win.isDestroyed()) {
          try { win.webContents.send('clip:new', payload2); } catch (e) { /* 忽略 */ }
        }
        emitClips();
      }
      return;
    }
    if (skipClipText !== null && text === skipClipText) { skipClipText = null; clipDebug('跳过：自己写回的内容'); return; }
    if (text.length > CLIP_MAX_CHARS) { clipDebug('跳过：超过 ' + CLIP_MAX_CHARS + ' 字'); return; }
    if (await clipboardBlocked()) return;
    const at = clipTime();
    if (!pushClip(text, at)) { clipDebug('跳过：与最近一条相同'); return; }
    clipDebug('已记录，历史 ' + clipItems.length + ' 条');
    const payload = { text, at, preview: clipPreview(text) };
    if (win && !win.isDestroyed()) {
      try { win.webContents.send('clip:new', payload); } catch (e) { /* 忽略 */ }
    }
    emitClips();
  } catch (e) { clipDebug('本轮异常: ' + e.message); }
}

function checkClipboard() {
  if (clipChecking) return;   // 上一轮还没完就不叠加
  clipChecking = true;
  Promise.resolve(doCheckClipboard()).catch(() => {}).then(() => { clipChecking = false; });
}

const CLIP_TEST_SAMPLES = [
  'Agile Capsule 剪贴板测试：这是一段比较长的文字，用来验证小卡的换行、截断与超长链接 https://example.com/very/long/path?with=query 的展示效果',
  '第二段样例，文字短一些',
  '第三段：带换行\n和  多余空格的文本会被压成一行',
];

async function startClipboardWatch() {
  if (clipTimer) return;
  loadClips();
  // 测试用：注入一张图片剪贴板条目
  if (process.env.WINISLAND_CLIP_IMG_TEST) {
    try {
      const src = path.join(__dirname, 'assets', 'dev-cards.png');
      const dir = clipImageDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const dst = path.join(dir, 'test-image.png');
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      pushClipImage(dst, 402, 100, clipTime());
      // 再造一条视频条目（用图片文件占位，仅验证排版）
      const vfile = path.join(dir, 'test-video.mp4');
      if (fs.existsSync(src)) fs.copyFileSync(src, vfile);
      pushClipVideo(vfile, clipTime());
      setTimeout(emitClips, 500);
    } catch (e) { /* 忽略 */ }
  }
  // 测试模式（WINISLAND_CLIP_TEST=1）：沙箱里读不到系统剪贴板，直接注入样例
  if (process.env.WINISLAND_CLIP_TEST) {
    let n = 0;
    clipTimer = setInterval(() => {
      if (n >= CLIP_TEST_SAMPLES.length) return;
      const text = CLIP_TEST_SAMPLES[n++];
      const at = clipTime();
      if (!pushClip(text, at)) return;
      emitClips();
      if (win && !win.isDestroyed()) {
        try { win.webContents.send('clip:new', { text, at, preview: clipPreview(text) }); } catch (e) { /* 忽略 */ }
      }
    }, 2500);
    return;
  }
  try {
    const t0 = await Promise.resolve(clipboard.readText());
    lastClipText = typeof t0 === 'string' ? t0 : String(t0 == null ? '' : t0);
  } catch (e) { lastClipText = ''; }
  clipTimer = setInterval(checkClipboard, 700);
  pruneTimer = setInterval(pruneClips, 10 * 60 * 1000);
  setTimeout(pruneClips, 3000);
}

ipcMain.on('clip:thumb', (e, payload) => {
  try {
    const key = payload && payload.key ? String(payload.key) : '';
    const dataUrl = payload && payload.dataUrl ? String(payload.dataUrl) : '';
    const m = dataUrl.match(/^data:image\/png;base64,(.+)$/);
    if (!key || !m) return;
    const dir = clipImageDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const hash = crypto.createHash('md5').update(key).digest('hex');
    const file = path.join(dir, 'thumb-' + hash + '.png');
    fs.writeFileSync(file, Buffer.from(m[1], 'base64'));
    const item = clipItems.find((c) => c.type === 'video' && c.path === key);
    if (item) {
      item.thumb = file;
      saveClips();
      emitClips();
    }
  } catch (err) { clipDebug('缩略图保存失败: ' + err.message); }
});

ipcMain.on('clip:copy-video', (e, raw) => {
  const file = String(raw == null ? '' : raw);
  if (!file || !fs.existsSync(file)) return;
  const ps = 'Set-Clipboard -Path ' + JSON.stringify(file);
  execFile(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
    { windowsHide: true, timeout: 10000 }, () => {
      try { e.sender.send('clip:copied', { type: 'video', at: clipTime() }); } catch (err) { /* 忽略 */ }
    });
});

ipcMain.on('clip:clear', (e) => {
  clipItems = [];
  saveClips();
  wipeClipImages();
  emitClips();
  lastClipText = null;
  lastClipImage = null;
  clipDebug('用户手动清空');
  try { e.sender.send('clip:cleared'); } catch (err) { /* 忽略 */ }
});

ipcMain.on('clip:get', (e) => {
  try { e.sender.send('clip:list', clipItems); } catch (err) { /* 忽略 */ }
});

ipcMain.on('clip:copy-image', (e, raw) => {
  const file = String(raw == null ? '' : raw);
  if (!file || !fs.existsSync(file)) return;
  try {
    const img = nativeImage.createFromPath(file);
    if (img.isEmpty()) return;
    clipboard.writeImage(img);
    lastClipImage = file;
  } catch (err) { /* 忽略 */ }
  const at = clipTime();
  if (pushClipImage(file, 0, 0, at)) emitClips();
  try { e.sender.send('clip:copied', { type: 'image', at }); } catch (err) { /* 忽略 */ }
});

ipcMain.on('clip:copy', (e, raw) => {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return;
  skipClipText = text;
  lastClipText = text;
  try { clipboard.writeText(text); } catch (err) { /* 忽略 */ }
  const at = clipTime();
  if (pushClip(text, at)) emitClips();
  try { e.sender.send('clip:copied', { text, at }); } catch (err) { /* 忽略 */ }
});

// ---------- 各平台登录：调官方 CLI / 打开对应页面，然后盯凭证文件 ----------
const LOGIN_TARGETS = {
  claude: {
    exe: 'claude',
    args: [],
    cred: () => path.join(os.homedir(), '.claude', '.credentials.json'),
    url: 'https://claude.ai/download',
    hint: '登录完成后自动查询额度',
  },
  codex: {
    exe: 'codex',
    args: ['login'],
    cred: () => path.join(os.homedir(), '.codex', 'auth.json'),
    url: 'https://developers.openai.com/codex/cli/',
    hint: '浏览器里完成 ChatGPT 登录',
  },
  cursor: {
    exe: 'cursor',
    args: [],
    cred: () => path.join(process.env.APPDATA || os.homedir(), 'Cursor', 'User', 'globalStorage', 'state.vscdb'),
    url: 'https://cursor.com/downloads',
    hint: '打开 Cursor 并登录账号',
  },
  antigravity: {
    exe: 'agy',
    args: [],
    cred: () => path.join(os.homedir(), '.gemini', 'antigravity'),
    url: 'https://antigravity.google/',
    hint: '打开 Antigravity 并登录 Google 账号',
  },
  deepseek: { url: 'https://platform.deepseek.com/api_keys', keyPage: true },
  openrouter: { url: 'https://openrouter.ai/keys', keyPage: true },
};

function findExe(name) {
  try {
    const r = spawnSync('where', [name], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || '';
  } catch (e) { return ''; }
}

function fileStamp(p) {
  try { const st = fs.statSync(p); return st.mtimeMs + ':' + st.size; } catch (e) { return ''; }
}

let loginWatch = null;

function watchLoginCredential(id, sender, before) {
  if (loginWatch) { clearInterval(loginWatch); loginWatch = null; }
  const target = LOGIN_TARGETS[id];
  if (!target || !target.cred) return;
  const started = Date.now();
  loginWatch = setInterval(async () => {
    if (Date.now() - started > 5 * 60 * 1000) {   // 5 分钟没动静就收工
      clearInterval(loginWatch);
      loginWatch = null;
      try { sender.send('quota:login-event', { id, state: 'timeout', message: '还没检测到登录，稍后可点「检测连接」重试' }); } catch (e) { /* 忽略 */ }
      return;
    }
    const now = fileStamp(target.cred());
    if (!now || now === before) return;
    clearInterval(loginWatch);
    loginWatch = null;
    try { sender.send('quota:login-event', { id, state: 'done', message: '已登录，正在刷新额度' }); } catch (e) { /* 忽略 */ }
    const list = await fetchAllQuotas();
    try { sender.send('quota:test-result', list); } catch (e) { /* 忽略 */ }
  }, 2000);
}

ipcMain.on('quota:login', (e, id) => {
  const target = LOGIN_TARGETS[id];
  if (!target) return;
  // 纯 Key 的平台：直接打开拿 Key 的页面
  if (target.keyPage) {
    try { shell.openExternal(target.url); } catch (err) { /* 忽略 */ }
    try { e.sender.send('quota:login-event', { id, state: 'page', message: '已打开 Key 页面，复制后粘贴到左侧' }); } catch (err) { /* 忽略 */ }
    return;
  }
  const exe = findExe(target.exe || '');
  try { e.sender.send('quota:login-event', { id, state: 'waiting', message: target.hint || '等待登录完成…' }); } catch (err) { /* 忽略 */ }
  if (!exe) {
    // 没装 CLI/客户端：打开官网，让用户装完再用
    try { shell.openExternal(target.url); } catch (err) { /* 忽略 */ }
    try {
      e.sender.send('quota:login-event', {
        id, state: 'missing',
        message: '本机没装 ' + (target.exe || '') + '，已打开下载页；装好后点「检测连接」',
      });
    } catch (err) { /* 忽略 */ }
    return;
  }
  const before = fileStamp(target.cred());
  try {
    // 开一个可见的终端跑官方登录命令（-k 保留窗口，方便看二维码/提示）
    const line = '"' + exe + '"' + (target.args.length ? ' ' + target.args.join(' ') : '');
    spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/k', line], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  } catch (err) { /* 忽略 */ }
  watchLoginCredential(id, e.sender, before);
});

// 各 Agent 自己的登录/续期会改写凭证文件；文件一变就做一次校准，
// 对应「再次打开 agent 时自动校准」，不再需要手动重新查询。
let quotaCredTimer = null;
let quotaCalTimer = null;
let quotaCredStamp = {};

function quotaCredFiles() {
  return {
    claude: path.join(os.homedir(), '.claude', '.credentials.json'),
    codex: path.join(os.homedir(), '.codex', 'auth.json'),
    antigravity: path.join(os.homedir(), '.gemini', 'antigravity', 'daemon'),
  };
}

function quotaCredSnapshot() {
  const out = {};
  for (const [id, fp] of Object.entries(quotaCredFiles())) out[id] = fileStamp(fp);
  return out;
}

function startQuotaCredWatch() {
  if (quotaCredTimer) return;
  quotaCredStamp = quotaCredSnapshot();
  quotaCredTimer = setInterval(() => {
    const now = quotaCredSnapshot();
    let changed = false;
    for (const id of Object.keys(now)) {
      if (now[id] !== quotaCredStamp[id]) changed = true;
    }
    quotaCredStamp = now;
    if (!changed) return;
    // 等 Agent 把凭证写完再查，避免读到半截文件
    if (quotaCalTimer) clearTimeout(quotaCalTimer);
    quotaCalTimer = setTimeout(() => { fetchAllQuotas(); }, 2500);
  }, 20000);
}

function startQuotaWatch() {
  if (quotaTimer) return;
  // 开机/重开应用先读取上次快照并做一次校准；失败时仍保留旧快照
  fetchAllQuotas();
  startQuotaCredWatch();
  // 额度平时不狂刷：打开岛时按需校准，这里只做 30 分钟兜底
  quotaTimer = setInterval(fetchAllQuotas, 30 * 60 * 1000);
}

let netProc = null;
let latestNet = { rx: 0, tx: 0 };let netCols = null;   // typeperf 的列顺序：数据行只有值，列名只在表头出现一次

// 虚拟/隧道网卡会把 0 流量也累加进来，名字里还常带数字，先把它们排掉
const VIRTUAL_IF_RE = /loopback|isatap|teredo|pseudo|vEthernet|VMware|VirtualBox|Hyper-V|WSL|Bluetooth|WAN Miniport|TAP-|OpenVPN|WireGuard|Microsoft Wi-Fi Direct/i;

function splitCsv(line) {
  return line.split('","').map((s) => s.replace(/^"|"$/g, '').trim());
}

// 表头： "(PDH-CSV 4.0)","\\PC\Network Interface(realtek 2.5GbE)\Bytes Received/sec","...\Bytes Sent/sec"
// 数据行： "11/19/2026 16:27:55.682","2762507.8","65477.9"
// 以前用正则抓所有数字再对半劈，把日期和计数器名里的数字（2.5GbE）都算进去了，读数基本不动
function parseNetHeader(line) {
  const cells = splitCsv(line);
  const cols = [];
  for (let i = 1; i < cells.length; i++) {
    const n = cells[i] || '';
    const isRx = /Bytes Received\/sec/i.test(n);
    const isTx = /Bytes Sent\/sec/i.test(n);
    if (!isRx && !isTx) continue;
    if (VIRTUAL_IF_RE.test(n)) continue;
    cols.push({ i, kind: isRx ? 'rx' : 'tx' });
  }
  return cols;
}

function parseNetRow(line) {
  if (!netCols || !netCols.length) return null;
  const cells = splitCsv(line);
  let rx = 0;
  let tx = 0;
  let hit = false;
  for (const c of netCols) {
    const v = parseFloat(cells[c.i]);
    if (!isFinite(v)) continue;
    if (c.kind === 'rx') rx += v; else tx += v;
    hit = true;
  }
  return hit ? { rx: Math.max(rx, 0), tx: Math.max(tx, 0) } : null;
}

function startNetMonitor() {
  const respawnNet = () => {
    if (app.isQuitting) return;
    try {
      const typeperfExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'typeperf.exe');
      netProc = spawn(typeperfExe, [
        '\\Network Interface(*)\\Bytes Received/sec',
        '\\Network Interface(*)\\Bytes Sent/sec',
        '-si', '1',
      ], { windowsHide: true });
      netProc.on('error', () => {
        netProc = null;
        netCols = null;
        setTimeout(respawnNet, 8000);
      });
      if (!netProc.stdout || !netProc.stderr) return;
      let buf = '';
      netProc.stdout.on('data', (c) => {
        buf += c.toString();
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('"')) continue;
          if (line.startsWith('"(PDH-CSV')) { netCols = parseNetHeader(line); continue; }
          const s = parseNetRow(line);
          if (s) {
            latestNet = s;
            // 网速单独按 1s 推一次，不用等 stats 的周期
            if (win && !win.isDestroyed()) win.webContents.send('net', s);
          }
        }
      });
      netProc.stderr.on('data', () => {});
      netProc.on('exit', () => { netProc = null; netCols = null; setTimeout(respawnNet, 4000); });
    } catch (e) {
      setTimeout(respawnNet, 8000);
    }
  };
  respawnNet();
}

// ---------- 主循环：CPU / 内存 / 磁盘 / 网络（低占用策略） ----------
// CPU/内存用 os 模块本地计算（零开销），磁盘容量缓存 60s，
// 网速走常驻 typeperf，间隔 3s，防重入
let prevDiskIo = null;
let prevCpus = null;
let statsBusy = false;
let fsCache = null;
let fsCacheTime = 0;

// CPU 型号识别（不同电脑自动适配）：os.cpus 优先，取不到再用 systeminformation
let cpuInfoCache = null;
let cpuInfoPromise = null;

function cleanCpuName(raw) {
  return String(raw || '')
    .replace(/\((R|TM|C)\)/gi, '')
    .replace(/\b(CPU|Processor)\b/gi, '')
    .replace(/\d+-Core/gi, '')
    .replace(/with Radeon.*$/i, '')
    .replace(/@.*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getCpuInfo() {
  if (cpuInfoCache) return cpuInfoCache;
  if (!cpuInfoPromise) {
    cpuInfoPromise = (async () => {
      let cores = 0;
      let model = '';
      try {
        const list = os.cpus();
        cores = list.length;
        model = (list[0] && list[0].model) || '';
      } catch (e) { /* 忽略 */ }
      if (!model) {
        try {
          const c = await si.cpu();
          const brand = String(c.brand || '').trim();
          const man = String(c.manufacturer || '').trim();
          model = brand && man && !brand.toLowerCase().startsWith(man.toLowerCase())
            ? `${man} ${brand}` : (brand || man);
          cores = c.cores || cores;
        } catch (e) { /* 忽略 */ }
      }
      cpuInfoCache = { model: cleanCpuName(model), cores };
      return cpuInfoCache;
    })();
  }
  return cpuInfoPromise;
}

function cpuLoadLocal() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  cpus.forEach((c, i) => {
    const t = c.times;
    const p = prevCpus ? prevCpus[i] && prevCpus[i].times : null;
    if (p) {
      idle += t.idle - p.idle;
      total += (t.user - p.user) + (t.nice - p.nice) + (t.sys - p.sys)
             + (t.idle - p.idle) + (t.irq - p.irq);
    }
  });
  prevCpus = cpus;
  return total > 0 ? Math.round((1 - idle / total) * 100) : 0;
}

function getDrivesCached() {
  const now = Date.now();
  if (fsCache && now - fsCacheTime < 60000) return Promise.resolve(fsCache);
  return si.fsSize().then((fsSize) => {
    fsCache = fsSize;
    fsCacheTime = now;
    return fsSize;
  });
}

async function collectStats() {
  if (statsBusy) return;
  statsBusy = true;
  try {
    const cpuLoad = cpuLoadLocal();
    const cpuInfo = await getCpuInfo();
    const [mem, disksIo, fsSize] = await Promise.all([
      si.mem(),
      si.disksIO(),
      getDrivesCached(),
    ]);

    let diskIoSec = null;
    if (disksIo && typeof disksIo.rIO === 'number') {
      if (prevDiskIo) {
        const dr = disksIo.rIO - prevDiskIo.rIO;
        const dw = disksIo.wIO - prevDiskIo.wIO;
        diskIoSec = { read: dr, write: dw }; // ops per interval，渲染端换算
      }
      prevDiskIo = { rIO: disksIo.rIO, wIO: disksIo.wIO };
    }

    // 磁盘固定显示 C 盘（排除网络/虚拟盘符）
    const localDrives = fsSize.filter((d) => /^[A-Z]:$/i.test(d.mount));
    const cDrive = localDrives.find((d) => d.mount.toUpperCase() === 'C:') || localDrives[0];
    const drives = cDrive ? [{
      mount: cDrive.mount.toUpperCase(),
      usePercent: Math.round(cDrive.use),
      usedGb: (cDrive.used / 1024 ** 3).toFixed(0),
      totalGb: (cDrive.size / 1024 ** 3).toFixed(0),
    }] : [];

    const netStats = latestNet;

    if (win && !win.isDestroyed()) {
      win.webContents.send('stats', {
        cpu: { load: cpuLoad, cores: cpuInfo.cores || os.cpus().length, model: cpuInfo.model },
        mem: {
          percent: Math.round(((mem.total - mem.available) / mem.total) * 100),
          usedGb: ((mem.total - mem.available) / 1024 ** 3).toFixed(1),
          totalGb: (mem.total / 1024 ** 3).toFixed(1),
        },
        disk: { drives, io: diskIoSec },
        net: netStats,
      });
    }
  } catch (e) {
    console.error('collectStats error:', e.message);
  } finally {
    statsBusy = false;
  }
}

let gpuDetectAt = 0;

async function collectGpu() {
  // 采集方式没探到时（比如启动瞬间显卡驱动还没就绪）每隔 60s 重探一次
  if (!gpuInfo.method && Date.now() - gpuDetectAt > 60000) {
    gpuDetectAt = Date.now();
    await detectGpu();
    sendGpuName();
  }
  const gpu = await readGpu();
  if (win && !win.isDestroyed() && gpu) {
    // 名称随每次数据一起下发，避免只在启动时发一次、渲染端还没挂上监听就丢了
    win.webContents.send('gpu-stats', { ...gpu, name: gpuInfo.name || '' });
  }
}

async function sendGpuName() {
  try {
    const name = gpuInfo.name;
    if (name && win && !win.isDestroyed()) win.webContents.send('gpu-name', name);
  } catch (e) { /* ignore */ }
}

// ---------- 窗口 ----------
function positionWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  const width = 420;
  const height = 340;
  return {
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y,
  };
}

// 屏幕分辨率/显示器变化后重新水平居中（含 DPI 缩放）
function recenterWindow() {
  if (!win || win.isDestroyed()) return;
  try {
    const d = screen.getPrimaryDisplay();
    const wa = d.workArea;
    const [w] = win.getSize();
    const x = Math.round(wa.x + Math.max(0, (wa.width - w) / 2));
    const y = Math.round(wa.y);
    win.setPosition(x, y, false);
  } catch (e) { /* 忽略 */ }
}

function watchDisplays() {
  try {
    const { powerMonitor } = require('electron');
    powerMonitor.on('resume', () => setTimeout(recenterWindow, 1500));
    powerMonitor.on('unlock-screen', () => setTimeout(recenterWindow, 1200));
    screen.on('display-metrics-changed', () => recenterWindow());
    screen.on('display-added', () => recenterWindow());
    screen.on('display-removed', () => recenterWindow());
  } catch (e) { /* 忽略 */ }
}

function createWindow() {
  const { width, height, x, y } = positionWindow();
  win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.on('did-finish-load', () => {
    // 渲染端可能晚于状态变化才加载完，这里补一次当前可见性
    try { win.webContents.send('island:visible', !fsHidden || fsPeek); } catch (e) { /* 忽略 */ }
    // 额度结果也一样：先用上次的顶上，避免刚启动那几秒空白
    const cachedQuotas = lastQuotaList || cachedQuotaList();
    if (cachedQuotas.length) {
      try { win.webContents.send('quotas', cachedQuotas); } catch (e) { /* 忽略 */ }
    }
  });
  win.once('ready-to-show', () => {
    recenterWindow();
    win.show();
    win.webContents.send('settings:changed', appSettings);
    // 显示器布局/DPI 可能延迟稳定，稍后再校准一次
    setTimeout(recenterWindow, 800);
    setTimeout(recenterWindow, 2500);
  });
  watchDisplays();
  win.setIgnoreMouseEvents(true, { forward: true });
  // 关闭 → 隐藏到托盘（后台常驻），从托盘菜单退出
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });

  // 调试模式：输出渲染进程 console
  if (process.env.WINISLAND_SHOT) {
    win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }

  win.on('closed', () => { win = null; });
}

// ---------- 系统托盘（后台常驻） ----------
function createTray() {
  try {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 32, height: 32 });
    tray = new Tray(icon);
    tray.setToolTip('Agile Capsule 灵动岛（点击显示/隐藏）');
    const menu = Menu.buildFromTemplate([
      { label: '显示 / 隐藏 (Ctrl+Alt+I)', click: () => toggleVisible() },
      { label: '设置', click: () => openSettingsWindow() },
      { type: 'separator' },
      { label: '开机自启', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }) },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuitting = true; app.quit(); } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => toggleVisible());
  } catch (e) {
    // 托盘失败不阻塞主流程
  }
}

function toggleVisible() {
  if (!win) return;
  if (win.isVisible()) {
    win.hide();
  } else {
    recenterWindow();
    win.show();
  }
}

// ---------- 设置 ----------
const DEFAULT_SETTINGS = {
  autostart: false,
  interval: 3000,
  showNet: true,
  netStyle: 'chips',
  showMusic: true,
  showNotify: true,
  notifyDuration: 30,
  hwTheme: 'A',
  shellStyle: 'island',
  showMetrics: { cpu: true, mem: true, gpu: true, disk: true },
  batteryInterval: 60000,
  fontFamily: 'system',
  weatherLayout: 'classic',
  weatherScale: 'm',
  lyricOffset: 0,
  lyricAutoCorrect: true,
  lyricOffsets: {},
  eqStyle: 'bars',
  eqColor: 'ocean',
  opacity: 1,
  islandWidth: 210,      // 折叠态宽度（px）
  hideOnFullscreen: true,
  fsScope: 'max',        // 'full' 仅真全屏 / 'max' 最大化也算
  weatherCity: '北京',
  deepseekKey: '',
  openrouterKey: '',
  claudeToken: '',
  codexToken: '',
  codexAccountId: '',
  cursorToken: '',
};
let appSettings = { ...DEFAULT_SETTINGS };
let settingsWin = null;
let menuWin = null;

// 调试：用环境变量强制覆盖天气布局/尺寸（不影响持久化设置）
function applyWxEnvOverride() {
  if (process.env.WINISLAND_WX_LAYOUT) appSettings.weatherLayout = process.env.WINISLAND_WX_LAYOUT;
  if (process.env.WINISLAND_WX_SCALE) appSettings.weatherScale = process.env.WINISLAND_WX_SCALE;
  if (process.env.WINISLAND_EQ_STYLE) appSettings.eqStyle = process.env.WINISLAND_EQ_STYLE;
  if (process.env.WINISLAND_EQ_COLOR) appSettings.eqColor = process.env.WINISLAND_EQ_COLOR;
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// One-time migration from the old product name so users keep their settings.
function migrateLegacyData() {
  try {
    const legacyDir = path.join(app.getPath('appData'), 'win-island');
    const currentDir = app.getPath('userData');
    if (currentDir === legacyDir) return;
    if (!fs.existsSync(currentDir)) fs.mkdirSync(currentDir, { recursive: true });
    for (const name of ['settings.json', 'peripheral-names.json', 'peripheral-cache.json']) {
      const from = path.join(legacyDir, name);
      const to = path.join(currentDir, name);
      if (fs.existsSync(from) && !fs.existsSync(to)) fs.copyFileSync(from, to);
    }
  } catch (e) { /* migration must never block startup */ }
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw);
    appSettings = { ...DEFAULT_SETTINGS, ...parsed, showMetrics: { ...DEFAULT_SETTINGS.showMetrics, ...(parsed.showMetrics || {}) } };
  } catch (e) {
    appSettings = { ...DEFAULT_SETTINGS };
  }
  return appSettings;
}

const TOKEN_KEYS = ['claudeToken', 'codexToken', 'codexAccountId', 'cursorToken', 'deepseekKey', 'openrouterKey'];

function saveSettings(s) {
  const incoming = { ...s };
  // 没动过凭证输入框时不要把已记住的 token 抹掉（设置页刚打开就保存的常见坑）
  if (!incoming.tokensEdited) {
    for (const k of TOKEN_KEYS) {
      if (!String(incoming[k] == null ? '' : incoming[k]).trim() && appSettings[k]) incoming[k] = appSettings[k];
    }
  }
  delete incoming.tokensEdited;
  appSettings = { ...DEFAULT_SETTINGS, ...incoming, showMetrics: { ...DEFAULT_SETTINGS.showMetrics, ...(incoming.showMetrics || {}) } };
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(appSettings, null, 2));
  } catch (e) { /* 写入失败不阻塞 */ }
  applySettings();
}

function applySettings() {
  // 开机自启
  app.setLoginItemSettings({ openAtLogin: !!appSettings.autostart });
  // 监控间隔重启
  if (statsTimer) { clearInterval(statsTimer); statsTimer = setInterval(collectStats, appSettings.interval); }
  // 全屏自动隐藏开关
  if (appSettings.hideOnFullscreen) {
    const want = appSettings.fsScope === 'full' ? 'full' : 'max';
    if (fsWatchProc && fsScopeRunning !== want) stopFullscreenWatch();  // 判定范围变了要重启监听
    startFullscreenWatch();
  } else {
    stopFullscreenWatch();
  }
  // 城市变了立刻重查天气
  if (geoCache && geoCache.city !== String(appSettings.weatherCity || '').trim()) geoCache = null;
  if (weatherTimer) fetchWeather();
  // 额度 Key 变了立刻重查
  if (quotaTimer) fetchAllQuotas();
  // 推送到主窗口渲染端
  if (win && !win.isDestroyed()) {
    win.webContents.send('settings:changed', appSettings);
  }
}

function openSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 800,
    height: 620,
    resizable: false,
    title: 'Agile Capsule 设置',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'renderer', 'settings.html'));
  settingsWin.webContents.on('did-finish-load', () => {
    // 打开设置就把上次查到的额度结果贴出来，不用再点一次「检测连接」
    const list = lastQuotaList || cachedQuotaList();
    if (!list.length) return;
    setTimeout(() => {
      if (!settingsWin || settingsWin.isDestroyed()) return;
      try { settingsWin.webContents.send('quota:test-result', list); } catch (e) { /* 忽略 */ }
    }, 400);
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

ipcMain.on('settings:request', () => {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:current', { ...appSettings, autostart: app.getLoginItemSettings().openAtLogin });
  }
});

ipcMain.on('settings:save', (_e, s) => {
  saveSettings(s);
  if (devBattTimer) {
    clearInterval(devBattTimer);
    devBattTimer = setInterval(pollDeviceBattery, appSettings.batteryInterval || 60000);
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.webContents.send('settings:current', { ...appSettings, autostart: app.getLoginItemSettings().openAtLogin });
  }
});

// ---------- 右键快捷菜单（自绘 UI，独立透明窗口） ----------
let menuStateOpen = false;

function notifyMenuState(open) {
  if (!win || win.isDestroyed() || menuStateOpen === open) return;
  menuStateOpen = open;
  try { win.webContents.send('island:menu-state', open); } catch (e) { /* 忽略 */ }
}

function closeMenuWindow() {
  if (menuWin && !menuWin.isDestroyed()) menuWin.destroy();
  menuWin = null;
  notifyMenuState(false);
}

function showContextMenu() {
  if (!win || win.isDestroyed()) return;
  closeMenuWindow();
  const W = 188;
  const H = 126;
  const point = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(point).workArea;
  let x = Math.round(point.x) - 8;
  let y = Math.round(point.y) - 8;
  if (x + W > area.x + area.width - 2) x = area.x + area.width - W - 2;
  if (y + H > area.y + area.height - 2) y = Math.round(point.y) - H + 8;
  x = Math.max(area.x + 2, x);
  y = Math.max(area.y + 2, y);

  menuWin = new BrowserWindow({
    width: W,
    height: H,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  menuWin.setAlwaysOnTop(true, 'pop-up-menu');
  notifyMenuState(true);
  menuWin.loadFile(path.join(__dirname, 'renderer', 'menu.html'), {
    query: { auto: app.getLoginItemSettings().openAtLogin ? '1' : '0' },
  });
  menuWin.once('ready-to-show', () => {
    if (!menuWin || menuWin.isDestroyed()) return;
    menuWin.show();
    menuWin.focus();
  });
  menuWin.on('closed', () => {
    menuWin = null;
    notifyMenuState(false);
  });
}

ipcMain.on('menu:action', (_e, msg) => {
  const name = msg && msg.name;
  if (name === 'settings') {
    closeMenuWindow();
    openSettingsWindow();
    return;
  }
  if (name === 'autostart') {
    app.setLoginItemSettings({ openAtLogin: !!(msg && msg.payload) });
    closeMenuWindow();
    return;
  }
  if (name === 'quit') {
    closeMenuWindow();
    app.quit();
  }
});

ipcMain.on('menu:close', () => closeMenuWindow());

// ---------- 右键菜单入口 ----------
ipcMain.on('ui:menu', () => {
  showContextMenu();
});

ipcMain.on('ui:mouse-region', (_e, overUi) => {
  if (!win || win.isDestroyed()) return;
  // 全屏收起状态下窗口不接受鼠标，只有探头时才交还给渲染端
  if (fsHidden && !fsPeek) return;
  if (overUi) {
    win.setIgnoreMouseEvents(false);
  } else {
    win.setIgnoreMouseEvents(true, { forward: true });
  }
});

// 面板高度自适应：渲染端量出当前页内容高度，这里把窗口跟着缩/放
ipcMain.on('ui:height', (_e, h) => {
  if (!win || win.isDestroyed()) return;
  const islandH = Math.round(Number(h) || 0);
  if (islandH < 40) return;
  const wa = screen.getPrimaryDisplay().workArea;
  // 浮动灵动岛：上方 6px 外边距 + 少量阴影余量；MacBook 刘海贴顶铺满，不加余量
  const pad = appSettings.shellStyle === 'notch' ? 0 : 14;
  const height = Math.min(islandH + pad, wa.height);
  const b = win.getBounds();
  if (Math.abs(b.height - height) < 2) return;
  win.setBounds({ x: b.x, y: b.y, width: b.width, height }, false);
});

// 歌词偏移：按歌曲记忆自动校准结果（最多 300 首）
ipcMain.on('lyric:offset-save', (_e, payload) => {
  try {
    if (!payload || !payload.key) return;
    const key = String(payload.key).slice(0, 140);
    const val = Math.max(-1.5, Math.min(1.5, Number(payload.offset) || 0));
    appSettings.lyricOffsets = appSettings.lyricOffsets || {};
    appSettings.lyricOffsets[key] = Math.round(val * 100) / 100;
    const keys = Object.keys(appSettings.lyricOffsets);
    if (keys.length > 300) delete appSettings.lyricOffsets[keys[0]];
    try { fs.writeFileSync(settingsPath(), JSON.stringify(appSettings, null, 2)); } catch (e) { /* 忽略 */ }
  } catch (e) { /* 忽略 */ }
});

ipcMain.on('lyric:offset-get', (e, key) => {
  try {
    const map = appSettings.lyricOffsets || {};
    const v = map[String(key)] || 0;
    e.sender.send('lyric:offset-mem', { key: String(key), offset: Number(v) || 0 });
  } catch (err) { /* 忽略 */ }
});

ipcMain.on('ui:width', (_e, w) => {
  if (!win || win.isDestroyed()) return;
  const width = Math.min(Math.max(Math.round(Number(w) || 420), 360), 900);
  const wa = screen.getPrimaryDisplay().workArea;
  const b = win.getBounds();
  if (Math.abs(b.width - width) < 2) return;
  // 保持水平居中
  const x = Math.round(wa.x + Math.max(0, (wa.width - width) / 2));
  win.setBounds({ x, y: b.y, width, height: b.height }, false);
});

// 媒体控制按钮：play|pause|toggle|next|prev
function logMediaControl(cmd) {
  try {
    const logPath = path.join(app.getPath('userData'), 'media-control.log');
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size > 512 * 1024) {
      fs.writeFileSync(logPath, '=== ' + new Date().toISOString() + ' ===\n');
    }
    const appId = (lastMediaMsg && lastMediaMsg.app) || '-';
    const title = (lastMediaMsg && lastMediaMsg.title) || '-';
    fs.appendFileSync(logPath, new Date().toLocaleTimeString() + ' cmd=' + cmd +
      ' src=' + lastMediaSource + ' app=' + appId + ' title=' + title + '\n');
  } catch (e) { /* 日志失败不影响控制 */ }
}

// 常驻媒体控制服务：只启动一次 PowerShell，后续指令走 stdin，
// 避免每次点击都要等 1.5~2.5s 的 PowerShell 启动，导致连续点击指令乱序/反跳
const PS_EXE = (() => {
  const p = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try { if (fs.existsSync(p)) return p; } catch (e) { }
  return 'powershell.exe';
})();

function mediaScriptPath(name) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked', 'media', name)
    : path.join(__dirname, 'media', name);
}

let mediaServer = null;
function ensureMediaServer() {
  if (mediaServer && mediaServer.exitCode === null && !mediaServer.killed) return mediaServer;
  const script = mediaScriptPath('media-control-server.ps1');
  mediaServer = spawn(PS_EXE,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
    { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
  mediaServer.on('error', () => { mediaServer = null; });
  mediaServer.on('exit', () => { mediaServer = null; });
  if (mediaServer.stdin) mediaServer.stdin.on('error', () => { });
  return mediaServer;
}

function sendMediaCommand(payload) {
  try {
    const proc = ensureMediaServer();
    if (!proc || !proc.stdin || proc.stdin.destroyed) return false;
    proc.stdin.write(JSON.stringify(payload) + '\n');
    return true;
  } catch (e) {
    return false;
  }
}

// ---------- 进程占用监控（常驻 PowerShell，每 2s 输出一行 JSON）----------
let procMonitor = null;
let procMonitorStopping = false;
let lastProcStats = null;
const procIconCache = {};      // name -> dataURL
const procIconPending = new Set();
let lastProcIcons = {};

function sendProcIcons(map) {
  if (!map || !Object.keys(map).length) return;
  Object.assign(lastProcIcons, map);
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('proc-icons', map); } catch (e) { /* 忽略 */ }
  }
}

// 进程图标只取一次：用 Electron 自带的文件图标接口，按 exe 路径缓存成 dataURL
function resolveProcIcons(d) {
  const todo = [];
  for (const list of [d.topCpu, d.topMem]) {
    for (const r of (list || [])) {
      if (!r || !r.name || !r.path) continue;
      if (procIconCache[r.name] !== undefined) continue;
      if (procIconPending.has(r.name)) continue;
      procIconPending.add(r.name);
      todo.push(r);
    }
  }
  if (!todo.length) return;
  const fresh = {};
  Promise.all(todo.map((r) => app.getFileIcon(r.path, { size: 'normal' })
    .then((img) => {
      const url = img && !img.isEmpty() ? img.toDataURL() : '';
      if (url) { procIconCache[r.name] = url; fresh[r.name] = url; }
    })
    .catch(() => { /* 无权限/无图标 */ })
    .finally(() => procIconPending.delete(r.name))
  )).then(() => sendProcIcons(fresh));
}

function ensureProcMonitor() {
  if (procMonitor && procMonitor.exitCode === null && !procMonitor.killed) return procMonitor;
  const script = mediaScriptPath('process-monitor.ps1');
  const proc = spawn(PS_EXE,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-ParentPid', String(process.pid)],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  procMonitor = proc;
  let buf = '';
  try { proc.stdout.setEncoding('utf8'); } catch (e) { /* 忽略 */ }
  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 300000) buf = buf.slice(-100000);   // 异常输出时防止无限增长
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const s = line.trim();
      if (!s || s[0] !== '{') continue;
      try {
        const d = JSON.parse(s);
        if (!d || (!Array.isArray(d.topCpu) && !Array.isArray(d.topMem))) continue;
        lastProcStats = d;
        if (win && !win.isDestroyed()) {
          try { win.webContents.send('proc-stats', d); } catch (e) { /* 忽略 */ }
        }
        resolveProcIcons(d);
      } catch (e) { /* 半行/脏输出直接跳过 */ }
    }
  });
  proc.on('error', () => { if (procMonitor === proc) procMonitor = null; });
  proc.on('exit', () => {
    if (procMonitor === proc) procMonitor = null;
    if (!procMonitorStopping && !app.isQuitting) setTimeout(() => ensureProcMonitor(), 3000);
  });
  return proc;
}

ipcMain.on('proc:get', () => {
  if (lastProcStats && win && !win.isDestroyed()) {
    try { win.webContents.send('proc-stats', lastProcStats); } catch (e) { /* 忽略 */ }
  }
  if (Object.keys(lastProcIcons).length) {
    try { win.webContents.send('proc-icons', lastProcIcons); } catch (e) { /* 忽略 */ }
  }
});

function legacyMediaControl(cmd, extraEnv) {
  const script = mediaScriptPath('media-control.ps1');
  const env = {
    ...process.env,
    WINISLAND_MEDIA_SOURCE: lastMediaSource,
    WINISLAND_MEDIA_APP: (lastMediaMsg && lastMediaMsg.app) || '',
    ...(extraEnv || {}),
  };
  execFile(PS_EXE,
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Cmd', cmd],
    { windowsHide: true, timeout: 10000, env },
    () => { });
}

function sendControlRaw(cmd) {
  logMediaControl(cmd);
  const sent = sendMediaCommand({
    cmd,
    source: lastMediaSource,
    app: (lastMediaMsg && lastMediaMsg.app) || '',
  });
  if (!sent) legacyMediaControl(cmd);
  scheduleRefresh();
}

ipcMain.on('ui:media-control', (_e, cmd) => {
  if (!['play', 'pause', 'toggle', 'next', 'prev'].includes(cmd)) return;
  const hasRealState = lastWintitleApp === 'cloudmusic' && !!neteaseSnapshot();
  // 无真实状态时使用虚拟暂停（标题模式）
  if (lastMediaSource === 'wintitle' && lastWintitleApp && !hasRealState) {
    if (cmd === 'toggle' || cmd === 'play' || cmd === 'pause') {
      const cur = !!virtualPausedByApp[lastWintitleApp];
      const want = cmd === 'toggle' ? !cur : cmd === 'pause';
      // 已经是目标状态就不要再发一次多媒体键，否则会“播放→暂停”地反跳
      if (cmd !== 'toggle' && want === cur) return;
      virtualPausedByApp[lastWintitleApp] = want;
    } else if (cmd === 'next' || cmd === 'prev') {
      virtualPausedByApp[lastWintitleApp] = false;
    }
  }
  sendControlRaw(cmd);
});

// 单曲循环：接近结尾自动回 0
function maybeLoopRewind(m) {
  if (!loopOnce || m.source !== 'smtc' || !m.duration || m.duration <= 5) return;
  if (m.status !== 'Playing') return;
  if ((m.position || 0) >= m.duration - 2 && Date.now() - lastRewindAt > 6000) {
    lastRewindAt = Date.now();
    runMediaControl('rewind');
  }
}

// 媒体跳转（秒）
ipcMain.on('ui:media-seek', (_e, seconds) => {
  const sec = Math.max(0, Number(seconds) || 0);
  runMediaControl('seek', { WINISLAND_SEEK_SEC: String(sec) });
});

// 单曲循环开关：接近结尾时自动回到 0 秒
let loopOnce = false;
let lastRewindAt = 0;
ipcMain.on('ui:media-loop', (_e, on) => { loopOnce = !!on; });

// 每次媒体事件合并后的最新数据（控制后用于即时刷新界面）
let lastMediaMsg = null;

// 控制动作后立即用最新 elog 状态刷新界面，避免等 2s 监控推送造成"点了没反应"
// 注意：只有网易云能从 elog 立刻读到真实状态；其它播放器复用 lastMediaMsg 旧消息，
// 会把点击“播放”之前的“已暂停”状态又推回界面（表现为刚点播放就自动跳回暂停）。
function refreshMediaNow() {
  readNeteaseElog();
  if (!lastMediaMsg || lastMediaMsg.app !== 'cloudmusic') return;
  const ne = neteaseSnapshot();
  if (!ne) return;   // elog 还没更新时不回推，交给 SMTC 监控推送
  const m = { ...lastMediaMsg };
  m.status = ne.playing ? 'Playing' : 'Paused';
  m.duration = ne.duration;
  m.position = ne.position;
  if (!m.art && ne.cover) m.artUrl = ne.cover;
  if (!m.title && ne.title) m.title = ne.title;
  if (!m.artist && ne.artist) m.artist = ne.artist;
  if (win && !win.isDestroyed()) win.webContents.send('media', m);
}

function scheduleRefresh() {
  [0, 350, 800, 1400].forEach((d) => setTimeout(refreshMediaNow, d));
}

function runMediaControl(cmd, extraEnv) {
  logMediaControl(cmd);
  const seek = extraEnv && extraEnv.WINISLAND_SEEK_SEC ? Number(extraEnv.WINISLAND_SEEK_SEC) : 0;
  const sent = sendMediaCommand({
    cmd,
    source: lastMediaSource,
    app: (lastMediaMsg && lastMediaMsg.app) || '',
    seek,
  });
  if (!sent) legacyMediaControl(cmd, extraEnv);
}

app.whenReady().then(async () => {
  migrateLegacyData();
  loadSettings();
  applyWxEnvOverride();
  loadQuotaCache();   // 先读上次的额度结果，开机/重启后不用重新识别
  await detectGpu();
  getCpuInfo().catch(() => {});   // 提前识别本机 CPU 型号，首页 CPU 栏不再显示线程数
  createWindow();
  createTray();
  startFullscreenWatch();

  statsTimer = setInterval(collectStats, appSettings.interval);
  gpuTimer = setInterval(collectGpu, 10000);
  collectStats();
  collectGpu();
  sendGpuName();
  startMediaMonitor();
  ensureMediaServer();   // 预热常驻媒体控制进程，点击时无需再等 PowerShell 启动
  ensureProcMonitor();   // 常驻进程占用采样（硬件页右侧列表）
  startNetMonitor();
  startWeatherWatch();
  startQuotaWatch();
  startClipboardWatch();
  startNotifyWatch();
  setTimeout(refreshAvatars, 5000);
  setTimeout(pollDeviceBattery, 3000);
  setTimeout(() => runSysControl('status'), 2500);
  devBattTimer = setInterval(pollDeviceBattery, appSettings.batteryInterval || 60000);
  avatarTimer = setInterval(refreshAvatars, 120000);
  if (process.env.WINISLAND_TEST_NOTIFY) {
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        win.webContents.send('notify', {
          app: 'wechat', appName: '微信', source: 'test',
          title: '别让我吃处决', body: '大肥鱼: 晚上一起吃饭吗？我在楼下等你', ts: Date.now(),
          avatar: avatarFileFor('别让我吃处决'),
        });
      }
    }, 8000);
  }
  readNeteaseElog();
  elogTimer = setInterval(readNeteaseElog, 1000);

  // 调试：设置 WINISLAND_SHOT=<path> 时，启动后自动展开并截图保存
  // WINISLAND_TEST_TOGGLE=1 时先点一次暂停按钮再截图（验证虚拟状态）
  if (process.env.WINISLAND_SHOT) {
    setTimeout(async () => {
      try {
        if (!process.env.WINISLAND_NO_EXPAND) {
          await win.webContents.executeJavaScript(
            "document.getElementById('island').classList.add('expanded')"
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
        if (process.env.WINISLAND_TEST_TOGGLE) {
          await win.webContents.executeJavaScript(
            "document.getElementById('btnToggle').click()"
          );
        }
        if (process.env.WINISLAND_TEST_MUSIC) {
          await win.webContents.executeJavaScript(
            "document.getElementById('arrowNext').click()"
          );
        }
        if (process.env.WINISLAND_TEST_CLOSEX) {
          const wxDims = await win.webContents.executeJavaScript(`(() => {
            const isl = document.getElementById('island');
            const pg = document.getElementById('pageWeather');
            const pn = document.querySelector('.panel');
            return JSON.stringify({
              win: window.innerWidth,
              island: Math.round(isl.getBoundingClientRect().width),
              islandScroll: isl.scrollWidth,
              panel: pn ? pn.clientWidth : -1,
              panelScroll: pn ? pn.scrollWidth : -1,
              page: pg ? Math.round(pg.getBoundingClientRect().width) : -1,
              pageScroll: pg ? pg.scrollWidth : -1,
              zoom: getComputedStyle(pg).zoom,
            });
          })()`);
          console.log('WXDIMS ' + wxDims);

          await win.webContents.executeJavaScript(
            "document.getElementById('arrowNext').click();document.getElementById('arrowNext').click()"
          );
          await new Promise((r) => setTimeout(r, 2500));
        }
        if (process.env.WINISLAND_TEST_WEATHER) {
          await win.webContents.executeJavaScript(
            "document.getElementById('arrowNext').click();document.getElementById('arrowNext').click()"
          );
          await new Promise((r) => setTimeout(r, 900));
          const wxDims = await win.webContents.executeJavaScript(`(() => {
            const isl = document.getElementById('island');
            const pg = document.getElementById('pageWeather');
            const pn = document.querySelector('.panel');
            return JSON.stringify({
              win: window.innerWidth,
              island: Math.round(isl.getBoundingClientRect().width),
              islandScroll: isl.scrollWidth,
              panel: pn ? pn.clientWidth : -1,
              panelScroll: pn ? pn.scrollWidth : -1,
              page: pg ? Math.round(pg.getBoundingClientRect().width) : -1,
              pageScroll: pg ? pg.scrollWidth : -1,
              zoom: getComputedStyle(pg).zoom,
              minW: getComputedStyle(pg).minWidth,
            });
          })()`);
          console.log('WXDIMS ' + wxDims);
        }
        if (process.env.WINISLAND_TEST_CTRL) {
          await win.webContents.executeJavaScript("document.getElementById('arrowNext').click()");
          await new Promise((r) => setTimeout(r, 2600));
        }
        if (process.env.WINISLAND_TEST_WHEEL) {
          await win.webContents.executeJavaScript(`(() => {
            const isl = document.getElementById('island');
            const r = isl.getBoundingClientRect();
            const opts = { deltaY: 120, bubbles: true, cancelable: true,
              clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
            isl.dispatchEvent(new WheelEvent('wheel', opts));
            return document.querySelector('.page.active') ? document.querySelector('.page.active').id : 'none';
          })()`).then((x) => console.log('WHEEL_PAGE', x));
        }
        if (process.env.WINISLAND_TEST_CLIP) {
          await win.webContents.executeJavaScript(
            "for(let i=0;i<6;i++) document.getElementById('arrowNext').click()"
          );
        }
        if (process.env.WINISLAND_TEST_DEV) {
          await win.webContents.executeJavaScript(
            "document.getElementById('arrowNext').click();document.getElementById('arrowNext').click()"
          );
        }
        if (process.env.WINISLAND_TEST_DEV_DATA) {
          const mock = [
            { name: 'MX Master 3S', kind: 'mouse', level: 89, charging: false, conn: '2.4G', protocol: 'HID++2.0' },
            { name: 'Keychron Q1 Pro', kind: 'keyboard', level: 47, charging: true, conn: 'BT', protocol: 'BLE' },
            { name: 'WH-1000XM5', kind: 'headset', level: 15, charging: false, conn: 'BT', protocol: 'BLE' },
          ];
          win.webContents.send('devices', mock);
        }
        if (process.env.WINISLAND_TEST_SETTINGS) {
          openSettingsWindow();
          await new Promise((r) => setTimeout(r, 1600));
          if (process.env.WINISLAND_SETTINGS_PAGE) {
            await settingsWin.webContents.executeJavaScript(
              "document.querySelector('nav button[data-page=\"" + process.env.WINISLAND_SETTINGS_PAGE + "\"]').click()"
            );
            await settingsWin.webContents.executeJavaScript(
              "var sc=document.querySelector('.scroll'); if(sc) sc.scrollTop = sc.scrollHeight"
            );
            if (process.env.WINISLAND_SETTINGS_CLICK) {
              await settingsWin.webContents.executeJavaScript(
                "var el=document.querySelector('" + process.env.WINISLAND_SETTINGS_CLICK + "'); if(el) el.click();"
              );
              await new Promise((r) => setTimeout(r, 300));
            }
            await new Promise((r) => setTimeout(r, 400));
          }
          const img2 = await settingsWin.webContents.capturePage();
          require('fs').writeFileSync(
            process.env.WINISLAND_SHOT.replace('.png', '-settings.png'),
            img2.toPNG()
          );
          settingsWin.close();
        }
        if (process.env.WINISLAND_DEBUG_DOM) {
          const info = await win.webContents.executeJavaScript(`(() => {
            const l = document.getElementById('clipList');
            const p = document.querySelector('.panel');
            const isl = document.getElementById('island');
            return JSON.stringify({
              clips: l ? l.children.length : -1,
              listHTML: l ? l.innerHTML.slice(0, 200) : '',
              panelH: p ? p.offsetHeight : -1,
              islandH: isl ? isl.offsetHeight : -1,
              scrollH: p ? p.scrollHeight : -1,
            });
          })()`);
          console.log('DOMINFO', info);
        }
        if (process.env.WINISLAND_SHOT_TALL) {
          win.setSize(480, 620);
          await win.webContents.executeJavaScript("document.getElementById('island').style.maxHeight='none'");
          await new Promise((r) => setTimeout(r, 600));
        }
        if (process.env.WINISLAND_TEST_EQ) {
          await win.webContents.executeJavaScript(`(() => {
            const isl = document.getElementById('island');
            isl.classList.remove('expanded');
            window.__eqDemo = true;
            const pill = document.getElementById('pill');
            pill.classList.add('music-on');
            document.getElementById('musicMiniText').textContent = '正在播放 · 测试曲目';
            return 1;
          })()`);
          await new Promise((r) => setTimeout(r, 700));
        }
        await new Promise((r) => setTimeout(r, 3000));
        const img = await win.webContents.capturePage();
        require('fs').writeFileSync(process.env.WINISLAND_SHOT, img.toPNG());
        console.log('SHOT_SAVED');
      } catch (e) {
        console.error('shot fail:', e.message);
      }
      app.quit();
    }, 8000);
  }

  globalShortcutRegister();
});

function globalShortcutRegister() {
  const { globalShortcut } = require('electron');
  globalShortcut.register('Control+Alt+I', toggleVisible);
}

app.on('window-all-closed', () => {
  // 托盘常驻：窗口全部关闭也不退出（退出走托盘菜单）
  if (mediaProc) mediaProc.kill();
  if (netProc) netProc.kill();
  if (app.isQuitting) app.quit();
});

app.on('before-quit', () => {
  app.isQuitting = true;  // 允许窗口真正关闭
  if (mediaProc) mediaProc.kill();
  if (netProc) netProc.kill();
  if (mediaServer) { try { mediaServer.stdin.end(); mediaServer.kill(); } catch (e) { } mediaServer = null; }
  procMonitorStopping = true;
  if (procMonitor) { try { procMonitor.kill(); } catch (e) { } procMonitor = null; }
  if (notifyProc) notifyProc.kill();
  if (wxProc) wxProc.kill();
  if (avatarTimer) clearInterval(avatarTimer);
  if (pruneTimer) clearInterval(pruneTimer);
  if (devBattTimer) clearInterval(devBattTimer);
  if (elogTimer) clearInterval(elogTimer);
});

