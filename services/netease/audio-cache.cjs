const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const MiB = 1024 * 1024;
const defaultLimit = 2 * 1024;
const formats = { mp3: 'audio/mpeg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac',
  wav: 'audio/wav', ogg: 'audio/ogg', opus: 'audio/ogg' };
const cachedName = /^uta-([a-f0-9]{64})\.(mp3|flac|m4a|aac|wav|ogg|opus)$/;
const partialName = /^uta-[a-f0-9]{64}-[a-f0-9]{16}\.part$/;
const validLimit = n => Number.isSafeInteger(n) && n >= 0 && Number.isSafeInteger(n * MiB);

function ownDirectory(directory) {
  try { fs.mkdirSync(directory); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  // Refuse symlinks and junctions so clearing cache stays inside the install directory.
  if (!fs.lstatSync(directory).isDirectory()) throw Error('歌曲缓存目录不可用');
}

function remove(file) {
  try { fs.unlinkSync(file); return true; } catch (error) { return error.code === 'ENOENT'; }
}

function openCache(directory, now) {
  ownDirectory(path.dirname(directory));
  ownDirectory(directory);
  const probe = path.join(directory, 'uta-' + '0'.repeat(64) + '-' + randomBytes(8).toString('hex') + '.part');
  fs.writeFileSync(probe, '', { flag: 'wx' });
  if (!remove(probe)) throw Error('歌曲缓存目录不可写');
  const prefs = path.join(path.dirname(directory), 'song-cache.json');
  let limitMiB = defaultLimit, generation = 0;
  try {
    const data = JSON.parse(fs.readFileSync(prefs, 'utf8'));
    if (validLimit(data?.limitMiB)) limitMiB = data.limitMiB;
  } catch { /* Use the default if preferences are missing or invalid. */ }

  const entries = new Map(), writes = new Map();
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith('.delete') || !cachedName.test(name.slice(0, -7))) continue;
    const marker = path.join(directory, name);
    if (!fs.lstatSync(marker).isFile()) continue;
    if (!remove(path.join(directory, name.slice(0, -7))) || !remove(marker)) {
      throw Error('无法完成上次待清理的歌曲缓存');
    }
  }
  for (const name of fs.readdirSync(directory)) {
    const match = cachedName.exec(name);
    if (!match && !partialName.test(name)) continue;
    const file = path.join(directory, name), stat = fs.lstatSync(file);
    if (!stat.isFile()) continue;
    if (!match || !stat.size) {
      if (!remove(file)) throw Error('无法清理上次未完成的歌曲缓存');
      continue;
    }
    const existing = entries.get(match[1]);
    if (existing && !remove(existing.file)) throw Error('无法清理重复的歌曲缓存');
    entries.set(match[1], { key: match[1], file, mime: formats[match[2]], size: stat.size, usedAt: stat.mtimeMs, readers: 0 });
  }

  function evict(entry) {
    entry.removeWhenIdle = true;
    if (!entry.readers && remove(entry.file)) {
      if (entry.marked) remove(entry.file + '.delete');
      return entries.delete(entry.key);
    }
    if (!entry.marked) {
      try { fs.writeFileSync(entry.file + '.delete', '', { flag: 'wx' }); entry.marked = true; }
      catch (error) { entry.marked = error.code === 'EEXIST'; }
    }
    return false;
  }
  function reserved() {
    let total = 0;
    for (const entry of entries.values()) total += entry.size;
    for (const write of writes.values()) total += write.size;
    return total;
  }
  function makeRoom(extra, evictPlaying = false) {
    const capacity = limitMiB * MiB;
    let used = reserved() + extra;
    if (used <= capacity) return true;
    const candidates = [...entries.values()].sort((a, b) => a.usedAt - b.usedAt);
    const available = candidates.reduce((bytes, entry) => bytes + (entry.readers ? 0 : entry.size), 0);
    if (extra && used - available > capacity) return false;
    for (const entry of candidates) {
      if (used <= capacity) break;
      if (!entry.readers && evict(entry)) used -= entry.size;
    }
    if (evictPlaying && used > capacity) {
      let afterRelease = used;
      for (const entry of candidates) {
        if (!entry.readers) continue;
        evict(entry);
        afterRelease -= entry.size;
        if (afterRelease <= capacity) break;
      }
    }
    return used <= capacity;
  }
  makeRoom(0);

  function info() {
    let usedBytes = 0, pendingBytes = 0, songs = 0;
    for (const entry of entries.values()) {
      if (entry.removeWhenIdle) { evict(entry); if (!entries.has(entry.key)) continue; pendingBytes += entry.size; }
      else songs++;
      usedBytes += entry.size;
    }
    for (const write of writes.values()) {
      usedBytes += write.written;
      if (write.discarded) pendingBytes += write.written;
    }
    return { available: true, directory, limitMiB, usedBytes, pendingBytes, songs };
  }

  function take(key) {
    const item = entries.get(key);
    if (!item || item.removeWhenIdle || !limitMiB) return null;
    try {
      const stat = fs.lstatSync(item.file);
      if (!stat.isFile()) { entries.delete(key); return null; }
      if (stat.size !== item.size) { evict(item); return null; }
    } catch (error) {
      if (error.code === 'ENOENT') entries.delete(key);
      return null;
    }
    if (now() - item.usedAt >= 1000) {
      item.usedAt = now();
      try { fs.utimesSync(item.file, item.usedAt / 1000, item.usedAt / 1000); } catch { /* A hit can still be served. */ }
    }
    item.readers++;
    return { item, release() {
      item.readers--;
      if (item.removeWhenIdle) evict(item);
    } };
  }

  function begin(key, size, format, observedGeneration) {
    if (observedGeneration !== generation || !Number.isSafeInteger(size) || size <= 0 || size > limitMiB * MiB
        || entries.has(key) || writes.has(key) || !makeRoom(size)) return null;
    const file = path.join(directory, 'uta-' + key + '-' + randomBytes(8).toString('hex') + '.part');
    const write = { file, key, size, format, written: 0, handle: fs.promises.open(file, 'wx').catch(() => null) };
    writes.set(key, write);
    return write;
  }

  function discard(write) {
    if (write.cleanup) return write.cleanup;
    if (writes.get(write.key) !== write) return;
    write.discarded = true;
    write.cleanup = (async () => {
      const handle = await write.handle;
      if (handle) await handle.close().catch(() => {});
      if (!handle || remove(write.file)) writes.delete(write.key);
    })().finally(() => { write.cleanup = null; });
    return write.cleanup;
  }

  async function append(write, chunk) {
    if (write.discarded) return;
    const handle = await write.handle;
    if (write.discarded) return;
    if (!handle || write.written + chunk.length > write.size) { await discard(write); return; }
    try { await handle.writeFile(chunk); write.written += chunk.length; }
    catch { await discard(write); }
  }

  async function complete(write) {
    if (write.discarded || write.written !== write.size) return discard(write);
    try {
      await (await write.handle).close();
      if (write.discarded) return discard(write);
      const file = path.join(directory, 'uta-' + write.key + '.' + write.format);
      fs.renameSync(write.file, file);
      writes.delete(write.key);
      entries.set(write.key, { key: write.key, file, size: write.size, mime: formats[write.format], usedAt: now(), readers: 0 });
    } catch { await discard(write); }
  }

  async function clear() {
    generation++;
    for (const entry of entries.values()) evict(entry);
    await Promise.all([...writes.values()].map(discard));
    return info();
  }
  async function setLimit(value) {
    if (!validLimit(value)) throw Error('请输入有效的容量上限（MB）');
    if (value === limitMiB) return info();
    const temporary = prefs + '-' + randomBytes(8).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify({ limitMiB: value }), { flag: 'wx' });
      fs.renameSync(temporary, prefs);
    } catch { throw Error('无法保存歌曲缓存设置，请检查安装目录的写入权限'); }
    finally { remove(temporary); }
    const reduced = value < limitMiB;
    limitMiB = value;
    if (reduced) {
      if (value === 0) return clear();
      generation++;
      await Promise.all([...writes.values()].map(discard));
      makeRoom(0, true);
    }
    return info();
  }

  return { info, clear, setLimit, take, begin, append, complete, discard,
    get generation() { return generation; }, get enabled() { return limitMiB > 0; } };
}

function providerAudio(url) {
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port
    && (url.hostname === 'music.126.net' || url.hostname.endsWith('.music.126.net'));
}

function mediaFormat(response, url) {
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  const extension = url.pathname.split('.').at(-1).toLowerCase();
  if (Object.hasOwn(formats, extension) && (!mime || mime.startsWith('audio/') || mime === 'application/octet-stream')) return extension;
  if (mime === 'audio/x-flac') return 'flac';
  return Object.keys(formats).find(ext => formats[ext] === mime);
}

function startEnd(range, size) {
  if (!range) return { start: 0, end: size - 1 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
  return start < size && start <= end ? { start, end } : null;
}

async function serveFile(req, res, item) {
  const range = startEnd(req.headers.range, item.size);
  if (!range) { res.writeHead(416, { 'Content-Range': 'bytes */' + item.size, 'Content-Length': 0 }).end(); return; }
  const { start, end } = range;
  const headers = { 'Content-Length': end - start + 1, 'Content-Type': item.mime };
  if (req.headers.range) headers['Content-Range'] = `bytes ${start}-${end}/${item.size}`;
  res.writeHead(req.headers.range ? 206 : 200, headers);
  if (req.method === 'HEAD') res.end();
  else await pipeline(fs.createReadStream(item.file, { start, end }), res);
}

function createDesktopAudio(installPath, { fetchSource = fetch, now = Date.now } = {}) {
  if (!path.isAbsolute(installPath)) throw Error('歌曲缓存需要绝对安装路径');
  const directory = path.join(fs.realpathSync(installPath), 'cache', 'audio');
  let store;
  const tickets = new Map();
  const getStore = () => {
    if (store !== undefined) return store;
    try { store = openCache(directory, now); } catch { store = null; }
    return store;
  };

  function issue(url, song, level, digest, sessionKey) {
    if (!providerAudio(url)) return url.href;
    const audio = getStore();
    if (!audio?.enabled) return url.href;
    for (const [token, ticket] of tickets) if (ticket.expires <= now()) tickets.delete(token);
    while (tickets.size >= 512) tickets.delete(tickets.keys().next().value);
    const token = randomBytes(18).toString('hex');
    const identity = typeof digest === 'string' && /^[a-f0-9]{32}$/i.test(digest) ? digest.toLowerCase() : url.origin + url.pathname;
    const key = createHash('sha256').update(JSON.stringify([song, level, identity])).digest('hex');
    tickets.set(token, { key, url, sessionKey, generation: audio.generation, expires: now() + 60 * 60_000 });
    return '/music/media/' + token;
  }

  async function serve(req, res, token, sessionKey) {
    const ticket = tickets.get(token);
    if (!ticket || ticket.expires <= now() || ticket.sessionKey !== sessionKey) { res.writeHead(404).end(); return; }
    const storage = getStore();
    const hit = storage.take(ticket.key);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (hit) {
      try { await serveFile(req, res, hit.item); } finally { hit.release(); }
      return;
    }
    const abort = new AbortController();
    res.once('close', () => { if (!res.writableFinished) abort.abort(); });
    const request = { method: req.method, redirect: 'manual', signal: abort.signal,
      headers: { 'Accept-Encoding': 'identity', ...(req.headers.range ? { Range: req.headers.range } : {}) } };
    let upstream;
    try { upstream = await fetchSource(ticket.url, request); } catch { /* Normal streaming remains available. */ }
    if (upstream?.status === 416) {
      const range = upstream.headers.get('content-range');
      await upstream.body?.cancel().catch(() => {});
      if (range && /^bytes \*\/\d+$/.test(range)) res.setHeader('Content-Range', range);
      res.writeHead(416, { 'Content-Length': 0 }).end();
      return;
    }
    const format = upstream && mediaFormat(upstream, ticket.url);
    const encoding = upstream?.headers.get('content-encoding')?.toLowerCase();
    if (!upstream || ![200, 206].includes(upstream.status) || !format || (encoding && encoding !== 'identity')) {
      await upstream?.body?.cancel().catch(() => {});
      if (!res.destroyed) res.writeHead(302, { Location: ticket.url.href, 'Content-Length': 0 }).end();
      return;
    }
    const headers = { 'content-type': formats[format] };
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers.get(name);
      if (value) headers[name] = value;
    }
    res.writeHead(upstream.status, headers);
    if (!upstream.body || req.method === 'HEAD') { res.end(); return; }
    const size = Number(headers['content-length']);
    const whole = upstream.status === 200 || (upstream.status === 206
      && headers['content-range'] === `bytes 0-${size - 1}/${size}`);
    const write = whole ? storage.begin(ticket.key, size, format, ticket.generation) : null;
    const body = Readable.fromWeb(upstream.body);
    if (!write) { await pipeline(body, res); return; }
    try {
      await pipeline(body, async function* (source) {
        for await (const chunk of source) {
          await storage.append(write, chunk);
          yield chunk;
        }
      }, res);
    } finally {
      // The browser can reissue a Range request even after the complete audio reached disk.
      await storage.complete(write);
    }
  }

  async function settings(action, limitMiB) {
    const audio = getStore();
    if (!audio) return { available: false, directory };
    if (action === '/cache-clear') return audio.clear();
    if (action === '/cache-limit') return audio.setLimit(limitMiB);
    return audio.info();
  }
  return { issue, serve, settings, revoke(sessionKey) {
    if (sessionKey) for (const [token, ticket] of tickets) if (ticket.sessionKey === sessionKey) tickets.delete(token);
  } };
}

module.exports = { createDesktopAudio };
