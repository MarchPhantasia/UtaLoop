/** Versioned, local-only user-data backups. File contents never enter this format. */
import { CACHE_STORES, snapshot, writeBatch } from './store.js';
import { DEFAULTS, endpointOf, providerIdValid, REASONING_LEVELS } from './config.js';
import { VIDEO_RANGES } from './video-config.js';
import { validateFavorite, favoriteId } from './favorites.js';
import { flushPositions } from './library.js';
import { MUSIC_QUALITY_KEY, MUSIC_QUALITIES } from './music-api.js';
import { SONG_VOLUME_KEY } from './song-controls.js';
import { playbackModes } from './music-queue.js';

export const BACKUP_FORMAT = 'linguatrack.user-data';
export const BACKUP_VERSION = 3;
// Released layouts are fixed, even if the live database adds stores later.
const STORES_V1 = ['tracks', 'data', 'tr', 'word', 'chat', 'kv'];
const STORES_V2 = [...STORES_V1, 'favorites'];
const STORES_V3 = [...STORES_V2, 'study'];
export const BACKUP_STORES = STORES_V3;
const BACKUP_LAYOUTS = new Map([[1, STORES_V1], [2, STORES_V2], [3, STORES_V3]]);
export const GLOBAL_KEYS = ['linguatrack.config.v1', 'linguatrack.settings.v1', 'linguatrack.langs.v1'];
const MUSIC_KEYS = [MUSIC_QUALITY_KEY, SONG_VOLUME_KEY];
const TRACK_PREFIX = 'linguatrack.track.';
const CREDENTIAL_FIELDS = ['apiKey', 'apiToken', 'asrApiKey'];
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const musicId = value => (typeof value === 'number' && Number.isSafeInteger(value) && value > 0)
  || (typeof value === 'string' && /^\d{1,20}$/.test(value));
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fail = (message) => { throw new Error('备份无效：' + message); };
const require = (ok, message) => { if (!ok) fail(message); };
const finite = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const filename = (value) => String(value || '').split(/[\\/]/).pop();
const allowedKey = (key, version) => GLOBAL_KEYS.includes(key) || (version >= 3 && MUSIC_KEYS.includes(key))
  || (key.startsWith(TRACK_PREFIX) && ID.test(key.slice(TRACK_PREFIX.length)));

function parseJSON(text) {
  try {
    return JSON.parse(text, (key, value) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('包含不支持的对象属性');
      return value;
    });
  } catch (err) {
    if (err.message.startsWith('备份无效：')) throw err;
    fail('JSON 格式损坏');
  }
}

export function readLocalData() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && allowedKey(key, BACKUP_VERSION)) out[key] = localStorage.getItem(key);
  }
  return out;
}

function validateLang(lang) {
  require(object(lang) && typeof lang.code === 'string' && !!lang.code, '缺少语言信息');
  for (const k of ['name', 'nameEn', 'native', 'script', 'engine', 'detail']) {
    require(lang[k] === undefined || typeof lang[k] === 'string', '语言字段类型错误');
  }
  require(lang.layers === undefined || (object(lang.layers)
    && Object.values(lang.layers).every((v) => typeof v === 'string')), '语言层信息错误');
  for (const k of ['features', 'layerOrder']) {
    require(lang[k] === undefined || (Array.isArray(lang[k])
      && lang[k].every((v) => typeof v === 'string')), '语言功能列表错误');
  }
}

function validateLocal(key, text, version) {
  require(allowedKey(key, version) && typeof text === 'string', '配置键或值不受支持');
  if (key === MUSIC_QUALITY_KEY) {
    require(Object.hasOwn(MUSIC_QUALITIES, text), '歌曲音质设置错误');
    return;
  }
  const value = parseJSON(text);
  if (key === SONG_VOLUME_KEY) {
    require(object(value) && finite(value.gain) && value.gain <= 1 && typeof value.muted === 'boolean', '歌曲音量设置错误');
    return;
  }
  if (key === GLOBAL_KEYS[2]) {
    require(Array.isArray(value), '语言目录必须是数组');
    value.forEach(validateLang);
    return;
  }
  require(object(value), '配置必须是对象');
  if (key === GLOBAL_KEYS[0]) {
    for (const [k, def] of Object.entries(DEFAULTS)) {
      if (value[k] === undefined) continue;
      if (typeof def === 'string') require(typeof value[k] === 'string', '配置字段 ' + k + ' 类型错误');
      if (typeof def === 'number') require(finite(value[k]), '配置字段 ' + k + ' 必须是有效数值');
    }
    for (const k of ['batchSize', 'concurrency', 'maxTokens', 'timeout']) {
      require(value[k] === undefined || value[k] > 0, '配置字段 ' + k + ' 必须大于零');
    }
    if (value.providers !== undefined) {
      require(Array.isArray(value.providers), '模型服务商格式错误');
      const ids = new Set();
      for (const provider of value.providers) {
        require(object(provider) && providerIdValid(provider.id) && !ids.has(provider.id)
          && ['name', 'baseUrl', 'model'].every((key) => typeof provider[key] === 'string')
          && (provider.apiKey === undefined || typeof provider.apiKey === 'string')
          && REASONING_LEVELS.some(([level]) => level === provider.reasoningEffort), '模型服务商配置错误');
        ids.add(provider.id);
      }
      require(!value.activeProviderId || ids.has(value.activeProviderId), '当前模型服务商不存在');
    }
    require(value.prompts === undefined || (object(value.prompts)
      && Object.values(value.prompts).every((v) => typeof v === 'string')), '提示词格式错误');
    if (value.langs !== undefined) {
      require(object(value.langs), '语言配置格式错误');
      for (const bag of Object.values(value.langs)) validateFlags(bag);
    }
  } else if (key === GLOBAL_KEYS[1]) {
    if (value.video !== undefined) validateVideo(value.video);
    if (value.captionSizes !== undefined) {
      require(object(value.captionSizes), '系统字幕字号格式错误');
      const [min, max] = VIDEO_RANGES.captionSize;
      for (const [code, size] of Object.entries(value.captionSizes)) {
        require(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(code), '系统字幕字号语言代码错误');
        require(Number.isInteger(size) && size >= min && size <= max, '系统字幕字号数值错误');
      }
    }
    require(value.theme === undefined || ['auto', 'light', 'dark'].includes(value.theme), '主题错误');
    require(value.rate === undefined || (finite(value.rate) && value.rate > 0), '播放速度错误');
    require(value.size === undefined || finite(value.size) || ['s', 'm', 'l'].includes(value.size), '字号错误');
    validateFonts(value);
    if (value.fonts !== undefined) {
      require(object(value.fonts), '语言字号格式错误');
      for (const [code, fonts] of Object.entries(value.fonts)) {
        require(/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(code), '字号语言代码错误');
        validateFonts(fonts);
      }
    }
    require(value.track === undefined || typeof value.track === 'string', '上次打开的曲目错误');
    require(version < 3 || value.songPlayMode === undefined || (typeof value.songPlayMode === 'string'
      && Object.hasOwn(playbackModes, value.songPlayMode)), '歌曲播放模式错误');
  } else {
    validateFlags(value);
    if (value.fonts !== undefined) validateFonts(value.fonts);
    if (value.video !== undefined) validateVideo(value.video);
    require(value.lang === undefined || typeof value.lang === 'string', '译文语言错误');
  }
}

function validateVideo(v) {
  require(object(v), '视频配置格式错误');
  require(v.fit === undefined || ['contain', 'cover'].includes(v.fit), '视频画面适配错误');
  for (const key of ['subtitles', 'muted']) {
    require(v[key] === undefined || [0, 1, false, true].includes(v[key]), '视频开关错误');
  }
  for (const [key, [min, max]] of Object.entries(VIDEO_RANGES)) {
    require(v[key] === undefined || (finite(v[key]) && v[key] >= min && v[key] <= max), '视频配置数值错误');
  }
}

function validateFonts(value) {
  require(object(value), '字幕字号格式错误');
  for (const k of ['textSize', 'readSize', 'romanSize', 'trSize']) {
    require(value[k] === undefined || (finite(value[k]) && value[k] > 0), '字幕字号错误');
  }
}

function validateFlags(value) {
  require(object(value), '显示配置格式错误');
  for (const k of ['tr', 'read', 'roman', 'pos', 'card']) {
    require(value[k] === undefined || [0, 1, false, true].includes(value[k]), '显示开关错误');
  }
}

function validateAnalysis(data, id) {
  require(object(data) && data.id === id, '分析结果的曲目 ID 不一致');
  require(data.schemaVersion === 2, '不支持此分析结果版本');
  validateLang(data.lang);
  require(object(data.audio) && finite(data.audio.duration), '分析结果时长错误');
  require(Array.isArray(data.sentences), '缺少句子数组');
  let end = 0;
  const word = (w) => {
    require(object(w) && typeof w.text === 'string' && typeof w.pos === 'string', '单词结构错误');
    for (const k of ['read', 'roman', 'lemma', 'lemmaRoman', 'conj', 'posDetail']) {
      require(w[k] === undefined || typeof w[k] === 'string', '单词字段错误');
    }
  };
  data.sentences.forEach((s, i) => {
    require(object(s) && s.i === i && typeof s.text === 'string'
      && finite(s.start) && finite(s.end) && s.end >= s.start && s.start + 0.000001 >= end
      && Array.isArray(s.words), '句子结构或时间轴错误');
    end = s.end;
    let wordEnd = s.start;
    for (const w of s.words) {
      word(w);
      if (w.start !== undefined || w.end !== undefined) {
        require(finite(w.start) && finite(w.end) && w.end >= w.start
          && w.start + 0.000001 >= wordEnd && w.end <= s.end + 0.000001, '单词时间轴错误');
        wordEnd = w.end;
      }
      if (w.parts !== undefined) {
        require(Array.isArray(w.parts), '语素结构错误');
        w.parts.forEach(word);
      }
    }
  });
}

// NetEase lyrics predate the analysis schema. Their cues and word timestamps
// come from the provider and can overlap. Preserve their original layout.
function validateSongLyrics(data, id) {
  require(object(data) && data.id === id, '歌曲歌词曲目 ID 错误');
  require(data.language === undefined || (typeof data.language === 'string' && !!data.language), '歌曲语言错误');
  if (data.lang !== undefined) validateLang(data.lang);
  require(data.sourceLyrics === undefined || (object(data.sourceLyrics)
    && Object.values(data.sourceLyrics).every((v) => typeof v === 'string')), '歌曲歌词来源错误');
  require(data.sourceAlignmentVersion === undefined
    || (Number.isInteger(data.sourceAlignmentVersion) && data.sourceAlignmentVersion >= 0), '歌曲歌词对齐版本错误');
  require(object(data.audio) && finite(data.audio.duration) && Array.isArray(data.sentences), '歌曲歌词结构错误');
  function words(items) {
    require(Array.isArray(items), '歌曲分词格式错误');
    for (const w of items) {
      require(object(w) && typeof w.text === 'string', '歌曲分词格式错误');
      for (const field of ['read', 'pron', 'roman', 'pos']) {
        require(w[field] === undefined || typeof w[field] === 'string', '歌曲注音字段错误');
      }
      require((w.start == null && w.end == null)
        || (finite(w.start) && finite(w.end) && w.end >= w.start), '歌曲逐词时间轴错误');
      if (w.lyricParts !== undefined) {
        require(Array.isArray(w.lyricParts) && w.lyricParts.every(part => object(part)
          && typeof part.text === 'string' && ['read', 'roman'].every(key =>
            part[key] === undefined || typeof part[key] === 'string')), '歌曲分字注音错误');
      }
    }
  }
  for (const s of data.sentences) {
    require(object(s) && typeof s.text === 'string' && finite(s.start) && finite(s.end) && s.end >= s.start,
      '歌曲歌词行或时间轴错误');
    words(s.words);
    if (s.sourceWords !== undefined) words(s.sourceWords);
  }
}

function validateStudy(row) {
  const value = row.value;
  require(ID.test(row.key) && object(value) && value.track === row.key
    && (!row.track || row.track === row.key)
    && ((typeof value.id === 'string' && ID.test(value.id)) || musicId(value.id))
    && typeof value.name === 'string', '学习记录与曲目关联错误');
  for (const key of ['artist', 'cover']) {
    require(value[key] === undefined || typeof value[key] === 'string', '学习记录格式错误');
  }
  require(value.state === undefined || ['', 'learning', 'learned'].includes(value.state), '学习状态错误');
  for (const key of ['duration', 'marked', 'practiced']) {
    require(value[key] === undefined || finite(value[key]), '学习记录数值错误');
  }
  require(value.checkpoint == null || finite(value.checkpoint), '学习进度错误');
}

/** Validate the entire archive before any persistent writes or preview actions. */
export function validateBackup(backup) {
  require(object(backup) && backup.format === BACKUP_FORMAT, '不是 Lingua 用户数据备份');
  const names = BACKUP_LAYOUTS.get(backup.version);
  require(names, '备份版本不受支持，请更新应用');
  require(typeof backup.exportedAt === 'string' && Number.isFinite(Date.parse(backup.exportedAt)), '导出时间错误');
  require(typeof backup.includesCredentials === 'boolean', '缺少凭据选项');
  require(object(backup.localStorage) && object(backup.stores), '缺少配置或数据');
  for (const [key, text] of Object.entries(backup.localStorage)) validateLocal(key, text, backup.version);
  require(Object.keys(backup.stores).length === names.length
    && Object.keys(backup.stores).every((s) => names.includes(s)), '存储区不受支持');
  for (const name of names) {
    const rows = backup.stores[name];
    require(Array.isArray(rows), '缺少存储区 ' + name);
    const keys = new Set();
    for (const row of rows) {
      require(object(row) && typeof row.key === 'string' && row.key.length > 0
        && !keys.has(row.key) && row.value !== undefined
        && typeof row.track === 'string' && finite(row.at), '记录损坏或键重复：' + name);
      keys.add(row.key);
      if (name === 'favorites') {
        validateFavorite(row.value);
        require(row.value.id === row.key && row.value.track === row.track, '收藏关联错误');
      }
      if (name === 'study') validateStudy(row);
      require(!row.track || (ID.test(row.track)
        && (row.key === row.track || row.key.startsWith(row.track + '|'))), '缓存关联错误');
      if (name === 'tr') require(typeof row.value === 'string', '译文必须是文本');
      if (name === 'chat') require(object(row.value) && Array.isArray(row.value.msgs)
        && row.value.msgs.every((m) => object(m) && ['user', 'assistant', 'system'].includes(m.role)
          && typeof m.content === 'string'), '讲解对话格式错误');
    }
  }
  const tracks = new Map();
  for (const row of backup.stores.tracks) {
    const t = row.value;
    require(object(t) && ID.test(t.id) && t.id === row.key && typeof t.title === 'string'
      && typeof t.lang === 'string' && ['new', 'subtitles', 'ready', 'failed'].includes(t.status), '曲目元数据错误');
    require(t.musicId == null || musicId(t.musicId), '网易云歌曲编号错误');
    for (const kind of ['audio', 'transcript']) {
      const f = t[kind];
      if (kind === 'transcript' && f == null) continue;
      require(object(f) && typeof f.name === 'string' && !!f.name && filename(f.name) === f.name
        && f.name !== '.' && f.name !== '..' && Object.keys(f).length === 1, '文件信息只能包含文件名');
    }
    tracks.set(t.id, t);
  }
  const analyzed = new Set();
  for (const row of backup.stores.data) {
    const track = tracks.get(row.key);
    require(track, '分析结果缺少曲目记录');
    if (musicId(track.musicId) && row.value?.schemaVersion === undefined) validateSongLyrics(row.value, row.key);
    else validateAnalysis(row.value, row.key);
    analyzed.add(row.key);
  }
  for (const { value: t } of backup.stores.tracks) {
    require(!['ready', 'subtitles'].includes(t.status) || analyzed.has(t.id), '已分析曲目缺少分析结果');
  }
  return backup;
}

export const parseBackup = (text) => validateBackup(parseJSON(text));

export async function exportBackup({ includeCredentials = false } = {}) {
  await flushPositions();
  const local = readLocalData();
  if (!includeCredentials && local[GLOBAL_KEYS[0]]) {
    const cfg = parseJSON(local[GLOBAL_KEYS[0]]);
    for (const key of CREDENTIAL_FIELDS) delete cfg[key];
    if (Array.isArray(cfg.providers)) for (const provider of cfg.providers) {
      if (object(provider)) delete provider.apiKey;
    }
    local[GLOBAL_KEYS[0]] = JSON.stringify(cfg);
  }
  const stores = await snapshot(BACKUP_STORES);
  for (const row of stores.tracks) {
    const t = row.value;
    t.audio = { name: filename(t.audio?.name) };
    t.transcript = t.transcript?.name ? { name: filename(t.transcript.name) } : null;
  }
  for (const row of stores.data) {
    row.value.audio = { duration: row.value.audio?.duration || 0 };
  }
  return validateBackup({ format: BACKUP_FORMAT, version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(), includesCredentials: !!includeCredentials,
    localStorage: local, stores });
}

const owner = (row) => row.track || (row.key.includes('|') ? row.key.split('|')[0] : '');
function trackIds(stores, local) {
  const ids = new Set(stores.tracks.map((r) => r.key));
  for (const [name, rows] of Object.entries(stores)) {
    // A song can be added to a study list before its media record exists.
    if (name === 'study') continue;
    for (const row of rows) { const id = owner(row); if (id) ids.add(id); }
  }
  for (const key of Object.keys(local)) if (key.startsWith(TRACK_PREFIX)) ids.add(key.slice(TRACK_PREFIX.length));
  return ids;
}

/** Copy conflicting tracks and remap all position/hash cache keys as one group. */
export function prepareImport(backup, current, local, { restoreConfig = true } = {}) {
  validateBackup(backup);
  const sourceIds = trackIds(backup.stores, backup.localStorage);
  const existingIds = trackIds(current, local);
  const sourceTracks = new Set(backup.stores.tracks.map(row => row.key));
  const studyIds = (stores) => (stores.study || []).map(row => row.key);
  const taken = new Set([...sourceIds, ...existingIds, ...studyIds(backup.stores), ...studyIds(current)]);
  const mapping = new Map();
  for (const id of sourceIds) {
    let next = id, n = 1;
    if (existingIds.has(id)) {
      do { next = id.slice(0, 110) + '-' + (++n); } while (taken.has(next));
    }
    mapping.set(id, next);
    taken.add(next);
  }
  const batches = {};
  let skipped = 0;
  for (const name of BACKUP_STORES) {
    const existing = new Set((current[name] || []).map((r) => r.key));
    batches[name] = [];
    for (const source of backup.stores[name] || []) {
      const row = structuredClone(source);
      const id = ['tracks', 'data', 'study'].includes(name) ? row.key : owner(row);
      const next = name === 'study' && !sourceTracks.has(id) ? id : mapping.get(id);
      if (next) {
        row.key = next + row.key.slice(id.length);
        row.track = next;
      }
      if (existing.has(row.key)) { skipped++; continue; }
      if (name === 'tracks' || name === 'data') row.value.id = row.key;
      if (name === 'favorites') {
        row.value.track = row.track;
        row.value.id = favoriteId(row.value);
        row.key = row.value.id;
      }
      if (name === 'study') {
        row.value.track = row.key;
        if (row.value.id === id) row.value.id = row.key;
      }
      if (name === 'tracks') {
        if (!musicId(row.value.musicId)) row.value.audio = { ...row.value.audio, missing: true };
        if (row.value.transcript) row.value.transcript = { ...row.value.transcript, missing: true };
      }
      batches[name].push(row);
    }
  }
  const changes = new Map();
  if (restoreConfig) {
    const keys = backup.version >= 3 ? [...GLOBAL_KEYS, ...MUSIC_KEYS] : GLOBAL_KEYS;
    for (const key of keys) changes.set(key, backup.localStorage[key] ?? null);
  }
  for (const [key, text] of Object.entries(backup.localStorage)) {
    if (key.startsWith(TRACK_PREFIX)) {
      changes.set(TRACK_PREFIX + mapping.get(key.slice(TRACK_PREFIX.length)), text);
    }
  }
  if (restoreConfig && changes.get(GLOBAL_KEYS[1])) {
    const settings = parseJSON(changes.get(GLOBAL_KEYS[1]));
    settings.track = mapping.get(settings.track) || settings.track || '';
    changes.set(GLOBAL_KEYS[1], JSON.stringify(settings));
  }
  if (restoreConfig && !backup.includesCredentials) {
    const cfg = parseJSON(changes.get(GLOBAL_KEYS[0]) || '{}');
    const old = parseJSON(local[GLOBAL_KEYS[0]] || '{}');
    for (const key of CREDENTIAL_FIELDS) delete cfg[key];
    const base = value => String(value || '').trim().replace(/\/+$/, '');
    for (const [key, address] of [['apiToken', 'apiBase'], ['asrApiKey', 'asrBaseUrl']]) {
      if (typeof old[key] === 'string' && base(cfg[address]) === base(old[address])) cfg[key] = old[key];
    }
    restoreModelKeys(cfg, old);
    changes.set(GLOBAL_KEYS[0], JSON.stringify(cfg));
  }
  return { batches, changes, mapping, skipped,
    copies: backup.stores.tracks.filter((r) => mapping.get(r.key) !== r.key).length };
}

function sameModelEndpoint(a, b) {
  if (!a && !b) return true;
  const endpoint = endpointOf(a || '');
  return !!endpoint && endpoint === endpointOf(b || '');
}

function restoreModelKeys(cfg, old) {
  if (!cfg.providers?.length) {
    if (typeof old.apiKey === 'string' && sameModelEndpoint(cfg.baseUrl, old.baseUrl)) cfg.apiKey = old.apiKey;
    return;
  }
  const previousProviders = Array.isArray(old.providers) ? old.providers : [{ ...old, id: 'legacy' }];
  const local = new Map(previousProviders.filter(object).map((p) => [p.id, p]));
  for (const provider of cfg.providers) {
    delete provider.apiKey;
    const previous = local.get(provider.id);
    if (typeof previous?.apiKey === 'string' && sameModelEndpoint(provider.baseUrl, previous.baseUrl))
      provider.apiKey = previous.apiKey;
  }
  const active = cfg.providers.find((p) => p.id === cfg.activeProviderId) || cfg.providers[0];
  if (active.apiKey !== undefined) cfg.apiKey = active.apiKey;
}

export function applyLocalData(changes) {
  const previous = new Map([...changes.keys()].map((key) => [key, localStorage.getItem(key)]));
  const write = (items) => {
    for (const [key, value] of items) {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    }
  };
  const rollback = () => {
    // Remove new, potentially large values first so restoring old values has enough quota.
    for (const key of changes.keys()) localStorage.removeItem(key);
    write(previous);
  };
  try { write(changes); } catch (err) { rollback(); throw err; }
  return rollback;
}

export async function importBackup(backup, options = {}) {
  validateBackup(backup);
  const current = await snapshot(BACKUP_STORES);
  const plan = prepareImport(backup, current, readLocalData(), options);
  await writeBatch(plan.batches, { addOnly: true, persistent: true,
    beforeCommit: () => applyLocalData(plan.changes) });
  return plan;
}

export function backupSummary(backup) {
  return { tracks: backup.stores.tracks.length, analyses: backup.stores.data.length,
    favorites: backup.stores.favorites?.length || 0,
    study: backup.stores.study?.length || 0,
    mediaFiles: backup.stores.tracks.filter(row => !musicId(row.value.musicId)).length,
    llm: CACHE_STORES.reduce((n, name) => n + (backup.stores[name]?.length || 0), 0) };
}
