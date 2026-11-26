const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { sessionStore, lifetime } = require('./session-store.cjs');
const { applyCookies, sdkCookies } = require('./provider-cookies.cjs');
const { createDesktopAudio } = require('./audio-cache.cjs');

// Private loopback service. The Web server forwards only same-origin JSON requests.
const qrLifetime = 5 * 60_000;
const pageSize = 30;
const year = 365 * 86400_000;
const week = 7 * 86400_000;
const cookieFlags = '; HttpOnly; SameSite=Strict; Path=/music';
const sourceLevels = new Set(['standard', 'higher', 'exhigh', 'lossless', 'hires']);
const fullSource = item => typeof item?.url === 'string' && !!item.url && !item.freeTrialInfo;
const cacheActions = new Set(['/cache-info', '/cache-limit', '/cache-clear']);
const mediaPath = /^\/media\/([a-f0-9]{36})$/;
const browserKey = req => (req.headers.cookie || '').match(/(?:^|;\s*)uta_session=([\w-]+)/)?.[1];

class MusicRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requirePlaylistAccount(session) {
  if (!session.uid) throw new MusicRequestError(401, '请先确认网易云音乐登录状态');
}

function retention(mode) {
  if (!['session', '30d', 'long'].includes(mode)) throw Error('请选择有效的登录保存期限');
  return mode;
}

function setRetention(key, session, mode, vault, res, now) {
  const until = now + (mode === 'long' ? year : lifetime);
  if (mode === 'session') vault.remove(key);
  else vault.save(key, session.cookie, until, mode);
  Object.assign(session, { mode, until, saved: true, dirty: false });
  const maxAge = mode === 'session' ? '' : '; Max-Age=' + (until - now) / 1000;
  res.setHeader('Set-Cookie', 'uta_session=' + key + cookieFlags + maxAge);
}

function coverOf(item) {
  for (const value of [item?.coverImgUrl, item?.al?.picUrl, item?.album?.picUrl, item?.picUrl,
    item?.al?.blurPicUrl, item?.album?.blurPicUrl, item?.blurPicUrl, item?.img1v1Url, item?.avatar, item?.cover]) {
    if (typeof value !== 'string' || !value) continue;
    try {
      const url = new URL(value.startsWith('//') ? 'https:' + value : value);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.music.126.net') ||
          url.username || url.password || url.port || url.pathname === '/') continue;
      url.protocol = 'https:'; url.hash = '';
      url.searchParams.set('param', '480y480');
      return url.href;
    } catch { /* Try the next artwork field. */ }
  }
  return '';
}

function songs(rows = []) {
  return rows.map(s => ({ id: s.id, name: s.name, artist: (s.ar || s.artists || [])
    .map(a => a.name).join(' / '), cover: coverOf(s), duration: (s.dt || s.duration || 0) / 1000 }));
}

function artistCard(artist) {
  const aliases = [artist.trans, artist.alias, artist.alia, artist.transNames].flat()
    .filter(name => typeof name === 'string' && name.trim() && name !== artist.name);
  return { id: artist.id, name: artist.name, alias: [...new Set(aliases)].slice(0, 3).join(' · '), cover: coverOf(artist) };
}

function rememberLikedPlaylist(session, playlists) {
  const liked = playlists?.find(p => p.id && Number(p.specialType) === 5
    && String(p.userId ?? p.creator?.userId) === String(session.uid));
  if (liked) session.likesPlaylist = { id: String(liked.id), cover: coverOf(liked) };
  return session.likesPlaylist;
}

async function handle(api, action, input, session, desktopAudio, key) {
  async function call(method, args = {}) {
    const sent = session.cookie || '';
    let response;
    try {
      response = await api[method]({ ...args, cookie: sdkCookies(sent) });
    } catch (error) {
      if (error?.status === 429) throw new MusicRequestError(429, '请求过多，请稍后重试');
      throw error;
    }
    const { body, cookie } = response;
    if (body?.code === 429) throw new MusicRequestError(429, '请求过多，请稍后重试');
    if (body.code && body.code !== 200 && method !== 'login_qr_check') throw Error('音乐服务暂时无法完成请求');
    if (sent && session.saved) {
      const updated = applyCookies(session.cookie, sent, cookie);
      if (updated !== session.cookie) { session.cookie = updated; session.dirty = true; }
    }
    return body;
  }
  const offset = Math.max(0, Number.parseInt(input.offset, 10) || 0);
  const limit = Math.min(100, Math.max(1, Number.parseInt(input.limit, 10) || pageSize));
  const id = String(input.id || '');
  async function trackPage(ids) {
    const slice = ids.slice(offset, offset + limit);
    const rows = slice.length ? (await call('song_detail', { ids: slice.join(',') })).songs : [];
    if (!Array.isArray(rows)) throw Error('暂时无法读取歌单曲目，请重试');
    const found = songs(rows);
    const byId = new Map(found.map(song => [String(song.id), song]));
    return { total: ids.length, items: slice.map(id => byId.get(String(id)) || { id, unavailable: true }) };
  }
  async function likedPlaylist() {
    requirePlaylistAccount(session);
    if (session.likesPlaylist) return session.likesPlaylist;
    const { playlist } = await call('user_playlist', { uid: session.uid, limit: pageSize, offset: 0 });
    return rememberLikedPlaylist(session, playlist);
  }
  async function readPlaylist(id, fallbackCover = '') {
    const { playlist } = await call('playlist_detail', { id });
    if (!Array.isArray(playlist?.trackIds)) throw Error('暂时无法读取歌单原序，请重试');
    return { id, name: playlist.name, cover: coverOf(playlist) || fallbackCover, ids: playlist.trackIds.map(track => track.id) };
  }
  async function playlistPage({ id, name, cover, ids }) {
    return { ...await trackPage(ids), playlist: { id, name, cover } };
  }
  switch (action) {
    case 'qr': {
      const { data } = await call('login_qr_key');
      session.key = data.unikey;
      return (await call('login_qr_create', { key: session.key, qrimg: true })).data.qrimg;
    }
    case 'poll': {
      if (session.cookie && !session.key) return 803;
      if (!session.key) return 800;
      const checkedKey = session.key;
      const result = await call('login_qr_check', { key: checkedKey });
      if (checkedKey !== session.key) return session.cookie && !session.key ? 803 : 800;
      if (result.code === 803 && result.cookie) {
        session.cookie = result.cookie;
        session.saved = false;
        delete session.likes;
        delete session.likesPlaylist;
        delete session.playlist;
        delete session.uid;
        delete session.key;
      }
      return result.code;
    }
    case 'account': {
      if (!session.cookie) return null;
      let body;
      const sent = session.cookie;
      let response;
      try { response = await api.login_status({ cookie: sdkCookies(sent) }); }
      catch (error) {
        if (error?.body?.code === 301 && sent === session.cookie) return null;
        throw error;
      }
      if (session.cookie !== sent) throw Error('登录凭证刚刚更新，请重试');
      body = response.body;
      if (body?.code === 301 || body?.data?.code === 301) return null;
      if ((body?.code != null && body.code !== 200) || (body?.data?.code != null && body.data.code !== 200)
          || !Object.hasOwn(body?.data || {}, 'profile')) throw Error('暂时无法确认登录状态，请稍后重试');
      const profile = body.data.profile;
      if (profile) {
        const updated = applyCookies(sent, sent, response.cookie);
        if (updated !== sent) { session.cookie = updated; session.dirty = true; }
      }
      session.uid = profile?.userId;
      return profile ? { name: profile.nickname, uid: profile.userId } : null;
    }
    case 'search': {
      if (input.kind === 'artist-songs') {
        if (!/^[1-9]\d{0,19}$/.test(id)) throw new MusicRequestError(400, '无效的歌手编号');
        const profile = input.includeArtist === true && !offset
          ? call('artist_detail', { id }).then(({ data }) => data?.artist && artistCard(data.artist)).catch(() => null)
          : null;
        const [catalogue, artist] = await Promise.all([call('artist_songs', { id, limit, offset }), profile]);
        const items = songs(catalogue.songs);
        const total = Number.isInteger(catalogue.total) && catalogue.total >= 0 ? catalogue.total : undefined;
        return { items, total, more: catalogue.more ?? items.length === limit, artist };
      }
      const findArtists = input.kind === 'artist';
      const result = (await call('cloudsearch', { keywords: String(input.query || '').slice(0, 128),
        type: findArtists ? 100 : 1, limit, offset })).result;
      const items = findArtists ? (result?.artists || []).map(artistCard) : songs(result?.songs);
      const count = findArtists ? result?.artistCount : result?.songCount;
      return { items, more: items.length === limit && (count == null || offset + limit < count) };
    }
    case 'likes': {
      requirePlaylistAccount(session);
      if (!offset || !session.likes) {
        const liked = await likedPlaylist();
        if (!liked) throw Error('暂时找不到「喜欢的音乐」歌单，请重试');
        session.likes = await readPlaylist(liked.id, liked.cover);
      }
      return playlistPage(session.likes);
    }
    case 'folders': {
      requirePlaylistAccount(session);
      const result = await call('user_playlist', { uid: session.uid, limit, offset });
      if (!Array.isArray(result.playlist)) throw Error('暂时无法读取歌单列表，请重试');
      rememberLikedPlaylist(session, result.playlist);
      return { more: !!result.more, items: result.playlist.filter(p => p.creator?.userId === session.uid)
        .map(p => ({ id: p.id, name: p.name, artist: p.trackCount + ' 首', cover: coverOf(p) })) };
    }
  }
  if (action === 'artwork') {
    if (input.kind === 'likes') {
      return (await likedPlaylist())?.cover || '';
    }
    if (input.kind === 'playlist' && /^\d+$/.test(id)) {
      return coverOf((await call('playlist_detail', { id })).playlist);
    }
    const ids = Array.isArray(input.ids) ? [...new Set(input.ids.map(String))] : [id];
    if (!ids.length || ids.length > 32 || !ids.every(key => /^\d{1,20}$/.test(key))) throw Error('无效的歌曲编号');
    const rows = (await call('song_detail', { ids: ids.join(',') })).songs || [];
    const covers = {}, missing = new Map();
    for (const song of rows) {
      const cover = coverOf(song), album = song.al?.id || song.album?.id;
      if (cover) covers[song.id] = cover;
      else if (album) {
        if (!missing.has(album)) missing.set(album, []);
        missing.get(album).push(song.id);
      }
    }
    const albums = [...missing];
    for (let i = 0; i < albums.length; i += 4) {
      await Promise.all(albums.slice(i, i + 4).map(async ([album, songs]) => {
        try {
          const cover = coverOf((await call('album', { id: album })).album);
          if (cover) for (const song of songs) covers[song] = cover;
        } catch { /* Other albums in this batch can still return artwork. */ }
      }));
    }
    return Array.isArray(input.ids) ? covers : covers[id] || '';
  }
  if (!/^\d+$/.test(id)) throw new MusicRequestError(400, '无效的歌曲或歌单');
  if (action === 'playlist') {
    if (!offset || session.playlist?.id !== id) session.playlist = await readPlaylist(id);
    return playlistPage(session.playlist);
  }
  if (action === 'lyrics') {
    const data = await call('lyric_new', { id });
    return Object.fromEntries(['lrc', 'yrc', 'tlyric', 'romalrc', 'ytlrc', 'yromalrc']
      .map(k => [k, data[k]?.lyric || '']));
  }
  if (action === 'source') {
    const hasLevel = Object.hasOwn(input, 'level');
    if (hasLevel && !sourceLevels.has(input.level)) throw new MusicRequestError(400, '请选择有效的播放音质');
    // The embedded SDK skips the CLI's device-key setup. Use its web transport for these streams.
    const atLevel = async (method, args) => {
      const { data } = await call(method, { id, ...args });
      if (!Array.isArray(data)) throw Error('暂时无法取得音源，请重试');
      return data[0];
    };
    const stream = level => atLevel('song_url_v1', { level, crypto: 'weapi', unblock: false });
    // Older pages still expect a plain URL and request the original MP3 bitrate.
    let item = hasLevel ? await stream(input.level) : await atLevel('song_url', { br: 128000 });
    const fallback = hasLevel && input.level !== 'standard' && !fullSource(item);
    if (fallback) item = await stream('standard');
    if (!fullSource(item)) throw new MusicRequestError(403, '当前账号无法播放这首歌的完整音轨');
    const url = new URL(item.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('音源地址无效');
    if (!hasLevel) return url.href;
    const level = sourceLevels.has(item.level) ? item.level : null;
    return { url: desktopAudio?.issue(url, id, level || (fallback ? 'standard' : input.level), item.md5, key) ?? url.href, level, fallback };
  }
  throw Error('未知操作');
}

function createMusicServer(api, vault = sessionStore(), now = Date.now, desktopAudio = null, bridge = '1') {
  const sessions = new Map();
  function prune() {
    for (const [key, s] of sessions) if (s.until <= now()) sessions.delete(key);
    try { vault.prune(); } catch { console.warn('暂时无法清理过期登录记录'); }
  }
  prune();
  const cleanup = setInterval(prune, 3600_000).unref();
  const server = http.createServer((req, res) => serve(req, res, sessions, vault, api, now, desktopAudio, bridge));
  server.once('close', () => clearInterval(cleanup));
  return server;
}

async function serve(req, res, sessions, vault, api, now, desktopAudio, bridge) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.headers.host !== '127.0.0.1:' + req.socket.localPort || req.headers['x-utaloop'] !== bridge) {
    res.writeHead(403).end('{}'); return;
  }
  const media = mediaPath.exec(req.url);
  if (media && (req.method === 'GET' || req.method === 'HEAD')) {
    if (!desktopAudio) { res.writeHead(404).end(); return; }
    try { await desktopAudio.serve(req, res, media[1], browserKey(req)); }
    catch {
      if (!res.headersSent && !res.destroyed) res.writeHead(502).end();
      else res.destroy();
    }
    return;
  }
  if (req.method !== 'POST') { res.writeHead(403).end('{}'); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 4096) throw Error('请求过长');
    }
    const input = JSON.parse(body);
    if (cacheActions.has(req.url)) {
      const data = await desktopAudio?.settings(req.url, input.limitMiB) ?? null;
      res.end(JSON.stringify({ data })); return;
    }
    let key = browserKey(req);
    let session = sessions.get(key);
    if (req.url === '/logout') {
      vault.remove(key);
      sessions.delete(key);
      desktopAudio?.revoke(key);
      res.setHeader('Set-Cookie', 'uta_session=; HttpOnly; SameSite=Strict; Path=/music; Max-Age=0');
      res.end('{"data":null}'); return;
    }
    if (!session || session.until <= now()) {
      sessions.delete(key);
      session = vault.load(key);
      if (session && session.until > now()) { session.saved = true; sessions.set(key, session); }
      else session = {};
    }
    if (req.url === '/retention') {
      if (Object.hasOwn(input, 'mode')) {
        const mode = retention(input.mode);
        if (session.saved && mode !== session.mode) setRetention(key, session, mode, vault, res, now());
        else if (session.until && !session.saved) session.mode = mode;
      }
      res.end(JSON.stringify({ data: session.saved ? session.mode : null })); return;
    }
    if (req.url === '/qr') {
      if (session.saved) throw Error('此设备已有登录，请先退出当前账号');
      session.mode = retention(input.mode ?? '30d');
    }
    if (!session.cookie && !session.until) {
      if (req.url === '/qr') {
        key = randomBytes(32).toString('base64url');
        session.until = now() + qrLifetime;
        sessions.set(key, session);
        res.setHeader('Set-Cookie', 'uta_session=' + key + '; HttpOnly; SameSite=Strict; Path=/music; Max-Age=300');
      }
    }
    const data = await handle(api, req.url.slice(1), input, session, desktopAudio, key);
    if (sessions.get(key) === session && session.until > now()) {
      if (session.saved && (!session.cookie || (req.url === '/account' && !data))) {
        vault.remove(key);
        sessions.delete(key);
        desktopAudio?.revoke(key);
        res.setHeader('Set-Cookie', 'uta_session=' + cookieFlags + '; Max-Age=0');
      } else if ((req.url === '/poll' && data === 803 && session.cookie && !session.saved) ||
          (session.saved && session.mode === 'long' && session.until <= now() + year - week)) {
        setRetention(key, session, session.mode, vault, res, now());
      } else if (session.dirty) {
        if (session.mode !== 'session') vault.save(key, session.cookie, session.until, session.mode);
        session.dirty = false;
      }
    }
    res.end(JSON.stringify({ data }));
  } catch (err) {
    res.writeHead(err instanceof MusicRequestError ? err.status : 502)
      .end(JSON.stringify({ error: /^[\u3400-\u9fff]/.test(err.message || '') ? err.message : '音乐服务请求失败，请重试' }));
  }
}
module.exports = { createMusicServer };
if (require.main === module) {
  // The SDK logs its entire response (including Set-Cookie) on request errors.
  const log = console.log.bind(console);
  console.log = (first, ...rest) => first === '[ERR]' ? log('网易云请求失败') : log(first, ...rest);
  const { desktopVault, desktopAudio } = desktopServices();
  const token = process.env.UTALOOP_DESKTOP_TOKEN;
  if (token && (!desktopAudio || !/^[a-f0-9]{64}$/.test(token))) throw Error('桌面启动配置无效');
  const server = createMusicServer(require('@neteasecloudmusicapienhanced/api'), desktopVault, Date.now, desktopAudio, token || '1');
  server.listen(token ? 0 : 3012, '127.0.0.1', () => {
    if (token) console.log('UTALOOP_MUSIC_READY ' + server.address().port);
    else console.log('UtaLoop 音乐服务已启动');
  });
  if (token) {
    process.stdin.resume();
    process.stdin.once('end', () => process.exit(0));
  }
}

function desktopServices() {
  const installPath = process.env.UTALOOP_DESKTOP_ROOT;
  if (!installPath) return {};
  const fs = require('node:fs'), path = require('node:path');
  const privatePath = process.env.UTALOOP_DESKTOP_PRIVATE;
  if (!path.isAbsolute(installPath) || !privatePath || !path.isAbsolute(privatePath)) {
    throw Error('桌面模式需要安装目录和 Windows 文档下的凭证目录');
  }
  const install = fs.realpathSync(installPath);
  const relative = path.relative(install, fs.existsSync(privatePath) ? fs.realpathSync(privatePath) : path.resolve(privatePath));
  if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
    throw Error('凭证目录需要独立于安装目录');
  }
  return { desktopVault: sessionStore(path.join(privatePath, 'sessions')), desktopAudio: createDesktopAudio(install) };
}
