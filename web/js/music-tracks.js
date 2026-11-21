import { music } from './music-api.js';
import { songLyrics } from './music-lyrics.js';
import { getTrack } from './library.js';
import { writeBatch } from './store.js';
import { studyKey } from './music-study.js';

/** Create a local practice record only when a song is opened. */
export async function ensureSongTrack(song, signal) {
  const id = studyKey(song);
  const existing = await getTrack(id);
  signal.throwIfAborted();
  if (existing) return existing;
  if (!id.startsWith('netease-')) throw Error('这首本地歌曲已移除');
  const raw = await music('lyrics', { id: song.id }, signal);
  const data = songLyrics(song, raw);
  const now = new Date().toISOString();
  const record = { id, title: song.name, artist: song.artist, lang: 'ja', status: 'ready',
    musicId: song.id, cover: song.cover || '', duration: song.duration, sentences: data.sentences.length,
    words: data.sentences.reduce((n, s) => n + s.words.length, 0), hasWordTiming: data.hasWordTiming,
    audio: { name: song.name, type: 'audio/mpeg', size: 0 }, createdAt: now, updatedAt: now };
  signal.throwIfAborted();
  try {
    await writeBatch({ tracks: [{ key: id, value: record, track: id }],
      data: [{ key: id, value: data, track: id }] }, { persistent: true, addOnly: true });
    return record;
  } catch (error) {
    const created = await getTrack(id);
    if (created) return created;
    throw error;
  }
}
