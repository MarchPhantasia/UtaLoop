import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import serverModule from '../services/netease/server.cjs';
import storage from '../services/netease/session-store.cjs';

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'utaloop-login-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function fixture(t, secret = 'MUSIC_U=synthetic; deviceId=local') {
  const dir = tempStore(t);
  let server, base, browser = '';
  let clock = Date.now();
  const api = {
    login_qr_key: () => ({ body: { data: { unikey: 'sample' } } }),
    login_qr_create: () => ({ body: { data: { qrimg: 'fixture-image' } } }),
    login_qr_check: () => ({ body: { code: 803, cookie: secret } }),
    login_status: ({ cookie }) => ({ body: { data: { profile: cookie.MUSIC_U === 'synthetic' ? { nickname: 'test', userId: 7 } : null } } })
  };
  async function restart() {
    if (server) await new Promise(resolve => server.close(resolve));
    server = serverModule.createMusicServer(api, storage.sessionStore(dir), () => clock);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
  }
  async function call(action, cookie = browser, input = {}, expectedStatus = 200) {
    const response = await fetch(base + '/' + action, {
      method: 'POST', headers: { 'X-UtaLoop': '1', Cookie: cookie }, body: JSON.stringify(input)
    });
    assert.equal(response.status, expectedStatus);
    const header = response.headers.get('Set-Cookie');
    if (header) browser = header.split(';')[0];
    return { result: (await response.json()).data, header };
  }
  t.after(async () => { if (server?.listening) await new Promise(resolve => server.close(resolve)); });
  await restart();
  return { dir, api, restart, call, secret, advance: ms => { clock += ms; },
    browser: () => browser, key: () => browser.split('=')[1] };
}

test('login survives a new service instance and logout revokes it across restarts', async t => {
  const { dir, secret, call, restart } = await fixture(t);
  const qr = await call('qr');
  assert.match(qr.header, /Max-Age=300/);
  assert.deepEqual(fs.readdirSync(dir), []);
  const poll = await call('poll');
  assert.equal(poll.result, 803);
  assert.match(poll.header, /HttpOnly.*Max-Age=2592000/);
  assert.ok(!poll.header.includes(secret));
  const [file] = fs.readdirSync(dir);
  assert.ok(!fs.readFileSync(path.join(dir, file)).includes(secret));
  await restart();
  assert.equal((await call('account', '')).result, null);
  assert.equal((await call('account')).result.uid, 7);
  assert.match((await call('logout')).header, /Max-Age=0/);
  await restart();
  assert.equal((await call('account')).result, null);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('long retention rolls with use and switching to memory immediately removes the stored login', async t => {
  const { call, advance, restart, dir, key } = await fixture(t);
  await call('qr', '', { mode: 'long' });
  assert.match((await call('poll')).header, /Max-Age=31536000/);
  assert.equal((await call('retention')).result, 'long');
  const vault = storage.sessionStore(dir), initial = vault.load(key());
  advance(32 * 86400_000);
  vault.prune();
  await restart();
  assert.equal((await call('account')).result.uid, 7);
  assert.ok(vault.load(key()).until > initial.until);
  const changed = await call('retention', undefined, { mode: 'session' });
  assert.doesNotMatch(changed.header, /Max-Age|Expires/i);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal((await call('account')).result.uid, 7);
  await restart();
  assert.equal((await call('account')).result, null);
});

test('memory-only QR can be remembered in place without another scan', async t => {
  const { call, dir, restart } = await fixture(t);
  await call('qr', '', { mode: 'session' });
  assert.doesNotMatch((await call('poll')).header, /Max-Age/);
  assert.deepEqual(fs.readdirSync(dir), []);
  assert.equal((await call('retention', undefined, { mode: 'long' })).result, 'long');
  await restart();
  assert.equal((await call('account')).result.uid, 7);
});

test('provider rotation survives restart, transient failures keep login and fixed expiry, rejection clears it', async t => {
  const { call, api, dir, key, restart, advance } = await fixture(t);
  await call('qr'); await call('poll');
  const vault = storage.sessionStore(dir), initial = vault.load(key());
  advance(8 * 86400_000);
  api.login_status = () => { throw Error('temporary network failure'); };
  await call('account', undefined, {}, 502);
  assert.deepEqual(vault.load(key()), initial);
  api.login_status = ({ cookie }) => {
    assert.deepEqual(cookie, { MUSIC_U: 'synthetic', deviceId: 'local' });
    return { body: { data: { profile: { nickname: 'demo', userId: 1 } } },
      cookie: ['MUSIC_U=new=value; HttpOnly; Path=/', '__csrf=updated; Secure'] };
  };
  await call('account');
  const updated = vault.load(key());
  assert.equal(updated.cookie, 'MUSIC_U=new=value; deviceId=local; __csrf=updated');
  assert.equal(updated.until, initial.until);
  await restart();
  api.login_status = ({ cookie }) => {
    assert.deepEqual(cookie, { MUSIC_U: 'new=value', deviceId: 'local', __csrf: 'updated' });
    return { body: { code: 301 } };
  };
  assert.match((await call('account')).header, /Max-Age=0/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an encrypted record written by the previous version upgrades in place', async t => {
  const { call, dir, secret } = await fixture(t);
  const token = randomBytes(32), key = token.toString('base64url');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', token, nonce);
  const payload = Buffer.concat([cipher.update(JSON.stringify({ cookie: secret, until: Date.now() + storage.lifetime })), cipher.final()]);
  const file = path.join(dir, createHash('sha256').update(key).digest('hex') + '.session');
  fs.writeFileSync(file, Buffer.concat([nonce, cipher.getAuthTag(), payload]));
  const browser = 'uta_session=' + key;
  assert.equal((await call('retention', browser)).result, '30d');
  assert.equal((await call('account', browser)).result.uid, 7);
  assert.equal((await call('retention', browser, { mode: 'long' })).result, 'long');
  assert.equal(storage.sessionStore(dir).load(key).mode, 'long');
});

test('a rollback preserves a session saved by an unsupported future version', async t => {
  const { call, dir, restart } = await fixture(t);
  const key = randomBytes(32).toString('base64url');
  const file = path.join(dir, createHash('sha256').update(key).digest('hex') + '.session');
  const future = Buffer.concat([Buffer.from('UTA3'), Buffer.alloc(100, 3)]);
  fs.writeFileSync(file, future);
  const past = new Date(Date.now() - 2 * storage.lifetime);
  fs.utimesSync(file, past, past);
  await restart(); // Includes the cleanup pass.
  const vault = storage.sessionStore(dir);
  assert.throws(() => vault.load(key), /新版 UtaLoop/);
  const browser = 'uta_session=' + key;
  assert.equal((await call('retention', browser, {}, 502)).header, null);
  assert.deepEqual(fs.readFileSync(file), future);
});

test('a late provider response cannot recreate credentials after logout', async t => {
  const { call, api, dir } = await fixture(t);
  await call('qr'); await call('poll');
  const started = Promise.withResolvers(), pending = Promise.withResolvers();
  api.login_status = () => { started.resolve(); return pending.promise; };
  const account = call('account');
  await started.promise;
  await call('logout');
  pending.resolve({ body: { data: { profile: { nickname: 'demo', userId: 1 } } }, cookie: ['MUSIC_U=late'] });
  assert.equal((await account).header, null);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('ordinary use cannot extend a fixed 30-day login', async t => {
  const { call, advance } = await fixture(t);
  await call('qr'); await call('poll');
  advance(29 * 86400_000);
  assert.equal((await call('account')).header, null);
  advance(86400_000);
  assert.equal((await call('account')).result, null);
});

test('large collections follow playlist order across pages and keep missing track positions', async t => {
  const { call, api } = await fixture(t);
  const ids = Array.from({ length: 1668 }, (_, i) => i + 1);
  [ids[0], ids[16]] = [ids[16], ids[0]];
  let likedIds = ids;
  let folderReads = 0;
  const playlistReads = [];
  api.likelist = () => assert.fail('playlist order must come from the playlist, not the liked IDs endpoint');
  api.user_playlist = () => {
    folderReads++;
    return { body: { playlist: [
      { id: 9, specialType: 5, creator: { userId: 8 } },
      { id: 10, specialType: 0, creator: { userId: 7 } },
      { id: 80, specialType: '5', userId: '7', coverImgUrl: 'https://p1.music.126.net/liked.jpg' },
    ] } };
  };
  api.song_detail = ({ ids }) => ({ body: { songs: ids.split(',').map(Number).reverse()
    .filter(id => id !== 1650).map(id => ({ id, name: 'song ' + id })) } });
  api.playlist_detail = ({ id }) => {
    playlistReads.push(id);
    const trackIds = (id === '80' ? likedIds : ids).map(id => ({ id }));
    return { body: { playlist: { trackIds } } };
  };
  await call('qr'); await call('poll'); await call('account');
  for (const action of ['likes', 'playlist']) {
    const first = (await call(action, undefined, { id: 1, limit: 60 })).result;
    const tail = (await call(action, undefined, { id: 1, limit: 60, offset: 1620 })).result;
    assert.equal(first.total, 1668);
    assert.deepEqual(first.items.map(row => row.id), ids.slice(0, 60));
    assert.deepEqual(tail.items.map(row => row.id), ids.slice(1620));
    assert.equal(tail.items[29].unavailable, true);
    if (action === 'likes') assert.equal(first.playlist.cover, 'https://p1.music.126.net/liked.jpg?param=480y480');
  }
  likedIds = [ids.at(-1), ...ids.slice(0, -1)];
  const refreshed = (await call('likes', undefined, { limit: 1 })).result;
  assert.equal(refreshed.items[0].id, ids.at(-1));
  assert.deepEqual(playlistReads, ['80', '1', '80']);
  assert.equal(folderReads, 1);
});

test('requested source quality reaches NetEase and reports the delivered quality', async t => {
  const { call, api } = await fixture(t);
  const url = 'https://music.126.net/example.mp3?signature=sample';
  api.song_url = ({ id, br }) => {
    assert.equal(id, '42');
    assert.equal(br, 128000);
    return { body: { data: [{ url }] } };
  };
  let requests = 0;
  api.song_url_v1 = ({ id, level, crypto, unblock }) => {
    requests++;
    assert.equal(id, '42');
    assert.equal(level, 'lossless');
    assert.equal(crypto, 'weapi');
    assert.equal(unblock, false);
    return { body: { data: [{ url, level: 'exhigh' }] } };
  };
  assert.equal((await call('source', '', { id: 42 })).result, url);
  assert.deepEqual((await call('source', '', { id: 42, level: 'lossless' })).result,
    { url, level: 'exhigh', fallback: false });
  await call('source', '', { id: 42, level: 'invalid' }, 502);
  assert.equal(requests, 1);
});

test('source can fall back to a complete standard stream but never returns a trial', async t => {
  const { call, api } = await fixture(t);
  const url = 'https://music.126.net/example.mp3';
  let standardAvailable = true;
  const levels = [];
  api.song_url_v1 = ({ level }) => {
    levels.push(level);
    const item = level === 'standard' && standardAvailable ? { url, level } : { url, freeTrialInfo: { end: 30 } };
    return { body: { data: [item] } };
  };
  assert.deepEqual((await call('source', '', { id: 42, level: 'hires' })).result,
    { url, level: 'standard', fallback: true });
  assert.deepEqual(levels, ['hires', 'standard']);
  standardAvailable = false;
  await call('source', '', { id: 42, level: 'standard' }, 502);
  assert.deepEqual(levels, ['hires', 'standard', 'standard']);
});

test('song covers retain their query parameters and missing art shares one lookup per album', async t => {
  const { call, api } = await fixture(t);
  let albums = [];
  api.song_detail = () => ({ body: { songs: [
    { id: 1, al: { picUrl: 'invalid' }, album: { picUrl: '//p1.music.126.net/a.jpg?v=2&param=20y20' } },
    { id: 2, al: { id: 91 } }, { id: 3, al: { id: 91 } }, { id: 4, al: { id: 92 } },
    { id: 5, picUrl: 'https://example.com/foreign.jpg' }
  ] } });
  api.album = ({ id }) => {
    albums.push(id);
    if (id === 92) throw Error('offline');
    return { body: { album: { picUrl: 'http://p2.music.126.net/shared.jpg' } } };
  };
  const result = (await call('artwork', '', { ids: [1, 2, 3, 4, 5] })).result;
  assert.deepEqual(result, { 1: 'https://p1.music.126.net/a.jpg?v=2&param=480y480',
    2: 'https://p2.music.126.net/shared.jpg?param=480y480', 3: 'https://p2.music.126.net/shared.jpg?param=480y480' });
  assert.deepEqual(albums.sort(), [91, 92]);
});

test('playlist headers use their own artwork even when they have no tracks', async t => {
  const { call, api } = await fixture(t);
  api.playlist_detail = () => ({ body: { playlist: { name: 'Empty', trackIds: [],
    coverImgUrl: 'https://p1.music.126.net/empty.jpg' } } });
  const data = (await call('playlist', '', { id: 88 })).result;
  assert.equal(data.total, 0);
  assert.deepEqual(data.playlist, { id: '88', name: 'Empty', cover: 'https://p1.music.126.net/empty.jpg?param=480y480' });
  await call('qr'); await call('poll'); await call('account');
  api.user_playlist = () => ({ body: { playlist: [
    { creator: { userId: 8 }, specialType: 5, coverImgUrl: 'https://p1.music.126.net/other.jpg' },
    { id: 80, creator: { userId: 7 }, specialType: 5, coverImgUrl: 'https://p1.music.126.net/liked.jpg' }
  ] } });
  assert.equal((await call('artwork', undefined, { kind: 'likes' })).result, 'https://p1.music.126.net/liked.jpg?param=480y480');
});

test('artist queries distinguish matching artists from song results and page catalogues by artist ID', async t => {
  const { call, api } = await fixture(t);
  api.cloudsearch = ({ type, keywords, limit, offset }) => {
    assert.equal(keywords, 'ヨルシカ');
    assert.equal(limit, 1);
    assert.equal(offset, 0);
    return { body: { result: type === 1
      ? { songCount: 1, songs: [{ id: 9, name: '春泥棒', ar: [{ name: 'ヨルシカ' }] }] }
      : { artistCount: 2, artists: [{ id: 123, name: 'ヨルシカ', alias: ['Yorushika'], transNames: ['Yorushika'],
        img1v1Url: 'https://p1.music.126.net/portrait.jpg' }] } } };
  };
  let profiles = 0;
  api.artist_detail = ({ id }) => {
    assert.equal(id, '123');
    profiles++;
    return { body: { data: { artist: { id: 123, name: 'ヨルシカ', avatar: 'https://p2.music.126.net/avatar.jpg' } } } };
  };
  api.artist_songs = ({ id, limit, offset }) => {
    assert.equal(id, '123');
    assert.equal(limit, 1);
    return { body: { total: 2, more: offset === 0, songs: [{ id: offset + 1, name: '曲' + (offset + 1) }] } };
  };
  const search = { query: 'ヨルシカ', limit: 1 };
  const artists = (await call('search', '', { ...search, kind: 'artist' })).result;
  assert.deepEqual(artists, { items: [{ id: 123, name: 'ヨルシカ', alias: 'Yorushika',
    cover: 'https://p1.music.126.net/portrait.jpg?param=480y480' }], more: true });
  assert.equal((await call('search', '', search)).result.items[0].artist, 'ヨルシカ');
  const artistSongs = { kind: 'artist-songs', id: 123, includeArtist: true, limit: 1 };
  const first = (await call('search', '', artistSongs)).result;
  const second = (await call('search', '', { ...artistSongs, offset: 1 })).result;
  assert.equal(first.total, 2);
  assert.equal(first.artist.cover, 'https://p2.music.126.net/avatar.jpg?param=480y480');
  assert.equal(second.items[0].id, 2);
  assert.equal(second.more, false);
  assert.equal(profiles, 1);
  await call('search', '', { ...artistSongs, id: '123/not-an-id' }, 502);
});

test('expired or modified credentials cannot be restored', t => {
  const dir = tempStore(t), vault = storage.sessionStore(dir);
  const token = randomBytes(32).toString('base64url');
  vault.save(token, 'sample', Date.now() - 1);
  assert.equal(vault.load(token), null);
  vault.save(token, 'sample', Date.now() + 60000);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  fs.appendFileSync(file, 'x');
  assert.equal(vault.load(token), null);
  assert.deepEqual(fs.readdirSync(dir), []);
});
