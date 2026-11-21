import assert from 'node:assert/strict';
import test from 'node:test';
import { collectionPages, selectCollection } from '../web/js/music-collection.js';
import { openMusicQueue, playbackSource } from '../web/js/music-queue.js';

test('playlist matching combines song and artist terms with kana and width normalization', () => {
  const rows = [{ name: 'ミライ ２０', artist: 'ＡＢＣ Duo' }, { name: '未来', artist: 'Solo' }, { unavailable: true }];
  assert.deepEqual(selectCollection(rows, 'abc みらい 20', 'original'), rows.slice(0, 1));
  assert.deepEqual(selectCollection(rows, 'missing', 'title'), []);
  assert.deepEqual(selectCollection(rows, '', 'reverse'), [...rows].reverse());
});

test('sorting is stable, numeric, and keeps missing durations and unavailable songs last', () => {
  const rows = [{ name: '曲10', artist: 'B', duration: 10 }, { name: '曲2', artist: 'A', duration: 20 },
    { name: '曲1', artist: 'A', duration: 10 }, { name: '曲3', artist: 'C' }, { unavailable: true }];
  for (const [sort, expected] of Object.entries({ title: [2, 1, 3, 0, 4], artist: [1, 2, 0, 3, 4],
    short: [0, 2, 1, 3, 4], long: [1, 0, 2, 3, 4] })) {
    assert.deepEqual(selectCollection(rows, '', sort), expected.map(i => rows[i]));
  }
  assert.equal(rows[0].name, '曲10');
});

test('indexing the entire collection reuses browsed pages and retries only failed batches', async () => {
  const requests = [], songs = Array.from({ length: 1668 }, (_, i) => ({ name: String(i + 1), artist: 'A' }));
  let fail = true;
  const source = collectionPages(async (offset, limit) => {
    requests.push(offset);
    if (fail && offset === 120) throw Error('network');
    return { items: songs.slice(offset, offset + limit), total: songs.length };
  });
  const signal = new AbortController().signal;
  await source.page(0); await source.page(1620);
  await assert.rejects(source.all(signal, () => {}), /network/);
  fail = false;
  const rows = await source.all(signal, () => {});
  assert.deepEqual(selectCollection(rows, '1668', 'short'), [songs.at(-1)]);
  assert.equal(await source.all(signal, () => {}), rows);
  assert.equal(requests.length, Math.ceil(1668 / 60) + 1);
});

test('list repeat walks across real playlist pages and wraps at the end', async t => {
  const offsets = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, '/music/playlist');
    const { id, offset, limit } = JSON.parse(request.body);
    assert.equal(id, '123');
    offsets.push(offset);
    const total = 1629;
    const items = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => ({ id: offset + i + 1 }));
    return { ok: true, json: async () => ({ data: { items, total } }) };
  });
  const source = playbackSource(new URLSearchParams('from=music&collection=playlist&playlist=123&slot=119'));
  const signal = new AbortController().signal;
  const queue = await openMusicQueue(source, 'netease-120', signal);
  const next = queue.candidates('list').next().value;
  assert.equal((await queue.at(next, signal)).id, 121);
  queue.select(1628);
  const first = queue.candidates('list').next().value;
  assert.equal((await queue.at(first, signal)).id, 1);
  assert.deepEqual(offsets, [60, 120, 0]);
});

test('shuffle draws from the entire list with no repeats within a cycle', async t => {
  t.mock.method(Math, 'random', () => 0.999);
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(url, '/music/likes');
    const { offset, limit } = JSON.parse(request.body);
    const total = 128;
    const items = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => ({ id: offset + i + 1 }));
    return { ok: true, json: async () => ({ data: { items, total } }) };
  });
  const source = playbackSource(new URLSearchParams('from=music&collection=likes&slot=0'));
  const signal = new AbortController().signal;
  const queue = await openMusicQueue(source, 'netease-1', signal);
  const seen = new Set([0]);
  for (let count = 1; count < 128; count++) {
    const next = queue.candidates('shuffle').next().value;
    if (count === 1) assert.equal((await queue.at(next, signal)).id, 128);
    assert.equal(seen.has(next), false);
    seen.add(next);
    queue.select(next);
  }
  assert.equal(seen.size, 128);
  assert.equal(queue.candidates('shuffle').next().value, 127);
});
