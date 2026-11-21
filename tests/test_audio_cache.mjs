import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import cacheModule from '../services/netease/audio-cache.cjs';
import serverModule from '../services/netease/server.cjs';
import sessionModule from '../services/netease/session-store.cjs';

const MB = 1024 * 1024;
const loopback = { 'X-UtaLoop': '1' };

async function withCache(t) {
  const tmp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(tmp, 'utaloop-audio-cache-'));
  const install = path.join(root, 'installed'), privateDir = path.join(root, 'private');
  const directory = path.join(install, 'cache', 'audio');
  fs.mkdirSync(install);
  let server, base;
  let clock = Date.now();
  const upstreamCalls = [], media = new Map();
  let authorized = true;
  const api = { song_url_v1: ({ id, level }) => ({ body: { data: [{
    url: 'https://m7.music.126.net/' + id + '.mp3', level,
    ...(authorized ? {} : { freeTrialInfo: { end: 30 } })
  }] } }) };
  const fetchSource = async (url, request) => {
    const id = url.pathname.split('/').at(-1).split('.')[0];
    upstreamCalls.push(id);
    const song = media.get(id);
    if (typeof song === 'function') return song(request);
    return new Response(request.method === 'HEAD' ? null : song,
      { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': song.length } });
  };
  async function stop() {
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  t.after(async () => {
    await stop();
    const relative = path.relative(tmp, fs.realpathSync(root));
    if (!/^utaloop-audio-cache-[^\\/]+$/.test(relative)) throw Error('Unexpected test directory');
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function restart(enabled = true) {
    await stop();
    const now = () => clock;
    const desktop = enabled ? cacheModule.createDesktopAudio(install, { fetchSource, now }) : null;
    server = serverModule.createMusicServer(api, sessionModule.sessionStore(privateDir), now, desktop);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = 'http://127.0.0.1:' + server.address().port;
  }
  async function post(action, input = {}, status = 200, cookie = '') {
    const response = await fetch(base + '/' + action, {
      method: 'POST', headers: { ...loopback, Cookie: cookie }, body: JSON.stringify(input)
    });
    const json = await response.json();
    assert.equal(response.status, status, json.error);
    return json.data;
  }
  const issue = async (id, level = 'standard', cookie = '') =>
    (await post('source', { id, level }, 200, cookie)).url.replace(/^\/music/, '');
  const get = (resource, headers) => fetch(base + resource, { headers: { ...loopback, ...headers }, redirect: 'manual' });
  const read = async (id, headers) => {
    const response = await get(await issue(id), headers);
    assert.equal(response.status, headers?.Range ? 206 : 200);
    return Buffer.from(await response.arrayBuffer());
  };
  const info = () => post('cache-info');
  async function waitFor(predicate) {
    for (let i = 0; i < 200; i++) {
      const state = await info();
      if (predicate(state)) return state;
      await delay(10);
    }
    assert.fail('Cache did not reach expected state: ' + JSON.stringify(await info()));
  }
  await restart();
  return { root, privateDir, directory, media, upstreamCalls, restart, post, get, issue, read, info, waitFor,
    tick: () => { clock += 2000; }, revokeAccess: () => { authorized = false; } };
}

test('managed audio obeys its limit, evicts least-recently played songs, and preserves the limit after restarting', async t => {
  const h = await withCache(t);
  assert.equal((await h.info()).limitMiB, 2048);
  await h.post('cache-limit', { limitMiB: 1 });
  const size = 400 * 1024;
  for (let id = 1; id <= 3; id++) h.media.set(String(id), Buffer.alloc(size, id));
  h.tick();
  assert.equal((await h.read(1))[0], 1);
  await h.waitFor(state => state.songs === 1);
  h.tick();
  await h.read(2);
  await h.waitFor(state => state.songs === 2);
  h.tick();
  const hit = await h.get(await h.issue(1), { Range: 'bytes=16-31' });
  assert.equal(hit.status, 206);
  assert.equal(hit.headers.get('content-range'), `bytes 16-31/${size}`);
  assert.deepEqual(Buffer.from(await hit.arrayBuffer()), Buffer.alloc(16, 1));
  await h.read(3);
  await h.waitFor(state => state.songs === 2);
  assert.equal((await h.info()).usedBytes, 2 * size);
  assert.deepEqual(h.upstreamCalls, ['1', '2', '3']);
  await h.restart();
  assert.equal((await h.info()).limitMiB, 1);
  await h.read(1);
  await h.read(3);
  assert.deepEqual(h.upstreamCalls, ['1', '2', '3']);
  await h.read(2);
  await h.waitFor(state => state.songs === 2);
  assert.deepEqual(h.upstreamCalls, ['1', '2', '3', '2']);
  h.revokeAccess();
  await h.post('source', { id: 2, level: 'standard' }, 502);
});

test('reducing the limit trims existing songs and a single oversized song still streams', async t => {
  const h = await withCache(t);
  const size = 700 * 1024;
  for (const id of ['1', '2']) h.media.set(id, Buffer.alloc(size));
  h.media.set('3', Buffer.alloc(2 * MB, 3));
  await h.post('cache-limit', { limitMiB: 2 });
  h.tick(); await h.read(1); await h.waitFor(state => state.songs === 1);
  h.tick(); await h.read(2); await h.waitFor(state => state.songs === 2);
  const lowered = await h.post('cache-limit', { limitMiB: 1 });
  assert.equal(lowered.usedBytes, size);
  await h.read(2);
  assert.equal((await h.read(3)).length, 2 * MB);
  assert.equal((await h.info()).usedBytes, size);
  assert.deepEqual(h.upstreamCalls, ['1', '2', '3']);
  const off = await h.post('cache-limit', { limitMiB: 0 });
  assert.equal(off.usedBytes, 0);
  assert.equal(await h.issue(2), 'https://m7.music.126.net/2.mp3');
});

test('partial ranges are not cached, and clearing an in-progress download leaves the playback stream intact', async t => {
  const h = await withCache(t);
  await h.post('cache-limit', { limitMiB: 1 });
  const size = 750 * 1024;
  h.media.set('2', Buffer.alloc(size, 2));
  let finish;
  const remaining = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  h.media.set('1', request => {
    if (request.headers.Range === 'bytes=2-5') {
      return new Response(Buffer.alloc(4, 1), { status: 206,
        headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': 4, 'Content-Range': `bytes 2-5/${size}` } });
    }
    const body = new ReadableStream({
      start(controller) { controller.enqueue(Buffer.alloc(size / 2, 1)); },
      async pull(controller) { await remaining; controller.enqueue(Buffer.alloc(size / 2, 1)); controller.close(); }
    });
    return new Response(body, { headers: { 'Content-Type': 'audio/mpeg', 'Content-Length': size } });
  });
  assert.deepEqual(await h.read(1, { Range: 'bytes=2-5' }), Buffer.alloc(4, 1));
  assert.equal((await h.info()).usedBytes, 0);
  const playing = await h.get(await h.issue(1));
  const firstHalf = await h.waitFor(state => state.usedBytes > 0);
  assert.ok(firstHalf.usedBytes < size);
  assert.equal((await h.read(2)).length, size);
  assert.equal((await h.info()).songs, 0, 'reserved bytes prevent a concurrent download exceeding the cap');
  const nowEmpty = await h.post('cache-clear');
  assert.equal(nowEmpty.usedBytes, 0);
  finish();
  assert.equal((await playing.arrayBuffer()).byteLength, size);
  assert.deepEqual(fs.readdirSync(h.directory), []);
});

test('clearing only manages audio cache, and a reader finishes before its cached file is removed', async t => {
  const h = await withCache(t);
  await h.info();
  await h.post('cache-limit', { limitMiB: 32 });
  const size = 24 * MB;
  h.media.set('1', Buffer.alloc(size, 12));
  await h.read(1);
  await h.waitFor(state => state.songs === 1);
  const retained = [path.join(h.privateDir, 'synthetic.session'), path.join(h.root, 'imported.mp3'),
    path.join(h.root, 'learning.json'), path.join(path.dirname(h.directory), 'covers', 'artwork.jpg'),
    path.join(h.directory, 'custom-copy.mp3')];
  for (const file of retained) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'fixture');
  }
  const playing = await h.get(await h.issue(1));
  assert.equal(playing.status, 200);
  const clearing = await h.post('cache-clear');
  assert.equal(clearing.pendingBytes, size);
  assert.equal((await playing.arrayBuffer()).byteLength, size);
  await h.waitFor(state => state.usedBytes === 0);
  for (const file of retained) assert.equal(fs.readFileSync(file, 'utf8'), 'fixture');
});

test('plain web returns the original source URL and exposes no disk cache controls', async t => {
  const h = await withCache(t);
  await h.restart(false);
  assert.equal(await h.info(), null);
  assert.equal(await h.issue(42), 'https://m7.music.126.net/42.mp3');
  assert.equal(fs.existsSync(h.directory), false);
});

test('restart finishes interrupted cleanup for managed files only', async t => {
  const h = await withCache(t);
  await h.info();
  const full = 'uta-' + 'a'.repeat(64) + '.mp3';
  const partial = 'uta-' + 'b'.repeat(64) + '-' + 'a'.repeat(16) + '.part';
  for (const file of [full, full + '.delete', partial, 'notes.delete']) fs.writeFileSync(path.join(h.directory, file), 'fixture');
  await h.restart();
  assert.equal((await h.info()).usedBytes, 0);
  assert.deepEqual(fs.readdirSync(h.directory), ['notes.delete']);
});
