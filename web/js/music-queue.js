import { music } from './music-api.js';
import { collectionPages, selectCollection } from './music-collection.js';
import { musicPageSize } from './music-list.js';
import { studyKey, studyListRows, studyLists, studyRecords } from './music-study.js';
import { randomId } from './util.js';

const snapshotKey = 'utaloop.playback.queue.v1';
const orderOptions = ['original', 'reverse', 'title', 'artist', 'short', 'long'];
const listNames = { ...studyLists, likes: '喜欢的音乐', playlist: '我的歌单' };
const pageOffset = index => Math.floor(index / musicPageSize) * musicPageSize;
const matches = (song, key) => song && studyKey(song) === key;

export const playbackModes = Object.freeze({
  stop: { label: '播完停止', icon: 'i-order' },
  list: { label: '列表循环', icon: 'i-repeat' },
  single: { label: '单曲循环', icon: 'i-repeat1' },
  shuffle: { label: '随机播放', icon: 'i-shuffle' },
});

export function addPlaybackSource(params, type, id, name, selection) {
  if (!Object.hasOwn(listNames, type) || !selection) return;
  params.set('collection', type);
  params.set('slot', selection.index);
  if (selection.order !== 'original') params.set('order', selection.order);
  if (type === 'playlist') {
    params.set('playlist', id);
    if (name) params.set('listName', name.slice(0, 160));
  }
  if (!selection.songs) return;
  // Reuse the complete list when it is already loaded for search, sorting or
  // local study. Keep only one snapshot in this browser tab.
  try {
    const token = randomId();
    const songs = selection.songs.map(({ id, track, name, artist, cover, duration, unavailable }) =>
      ({ id, track, name, artist, cover, duration, unavailable }));
    sessionStorage.setItem(snapshotKey, JSON.stringify({ token, songs }));
    params.set('queue', token);
  } catch { /* The source URL can reconstruct the list if storage is unavailable. */ }
}

export function playbackSource(params) {
  const type = params.get('collection'), id = params.get('playlist');
  if (params.get('from') !== 'music' || !Object.hasOwn(listNames, type)
      || (type === 'playlist' && !/^\d{1,20}$/.test(id || ''))) return null;
  const order = params.get('order');
  const index = Number(params.get('slot') ?? -1);
  return { type, id, order: orderOptions.includes(order) ? order : 'original',
    name: (type === 'playlist' && params.get('listName')?.slice(0, 160)) || listNames[type],
    index: Number.isSafeInteger(index) && index >= 0 ? index : -1, token: params.get('queue') };
}

function snapshot(token) {
  if (!token) return null;
  try {
    const saved = JSON.parse(sessionStorage.getItem(snapshotKey));
    if (saved?.token === token && Array.isArray(saved.songs)) return saved.songs;
  } catch { /* Fall back to the current collection. */ }
  return null;
}

/** A shuffle bag is consumed without repeats, then refilled without the current song. */
function createQueue(size, position, at) {
  let bag = [];
  return {
    at,
    select(index) { position = index; },
    *candidates(mode) {
      const count = size - Number(position >= 0);
      if (mode === 'list') {
        bag = [];
        for (let step = 1; step <= count; step++) yield (position + step) % size;
        return;
      }
      const attempted = new Set();
      while (attempted.size < count) {
        if (!bag.length) bag = Array.from({ length: size }, (_, index) => index).filter(index => index !== position);
        const pick = Math.floor(Math.random() * bag.length);
        const index = bag[pick];
        bag[pick] = bag.at(-1);
        bag.pop();
        if (index === position || attempted.has(index)) continue;
        attempted.add(index);
        yield index;
      }
    },
  };
}

export async function openMusicQueue(source, selected, signal) {
  const input = source.type === 'playlist' ? { id: source.id } : {};
  const pages = collectionPages((offset, limit, requestSignal) =>
    music(source.type, { ...input, offset, limit }, requestSignal));
  const index = source.index;
  let songs = snapshot(source.token);
  if (!songs && Object.hasOwn(studyLists, source.type)) {
    songs = selectCollection(studyListRows(await studyRecords(), source.type), '', source.order);
  }
  if (!songs && source.order === 'original' && index >= 0) {
    const offset = pageOffset(index);
    const anchor = await pages.page(offset, signal);
    if (matches(anchor.items[index - offset], selected)) {
      return createQueue(anchor.total, index, async (i, requestSignal) => {
        const start = pageOffset(i);
        const page = await pages.page(start, requestSignal);
        if (page.total !== anchor.total) throw Error('歌单刚刚发生变化，请返回歌单重新选歌。');
        return page.items[i - start];
      });
    }
  }
  songs ||= selectCollection(await pages.all(signal), '', source.order);
  const position = matches(songs[index], selected) ? index : songs.findIndex(song => matches(song, selected));
  return createQueue(songs.length, position, i => songs[i]);
}
