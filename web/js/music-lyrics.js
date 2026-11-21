import { alignDictionaryReadings, alignReviewedReadings, backfillLyricNumbers, isKanaPair, isLyricKana,
  keepSongReadings, needsLyricReading, withLyricRoman, withSungReading } from './lyric-readings.js';
import { inheritLyricPos, isReviewedLyric, lyricPos, withLyricPosLegend } from './lyric-pos.js';

export const LYRIC_ALIGNMENT_VERSION = 8;
const RETIMED_TRACK = 'netease-2025482215';
const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter('ja', { granularity: 'word' }) : null;
const katakana = /^[ァ-ヺーｦ-ﾟ]+$/u;
const inlineReadings = /(\p{Script=Han}+|(?<![\p{Script=Latin}0-9０-９]|[0-9０-９][,.，．])[0-9０-９]+(?:[,.，．][0-9０-９]+)*(?:つ|\p{Script=Han}+)?)(?:（([ぁ-ゖァ-ヺーｦ-ﾟ]+)）|\(([ぁ-ゖァ-ヺーｦ-ﾟ]+)\))/gu;

function lrc(text = '') {
  const rows = [];
  const offset = Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1] || 0);
  for (const line of text.split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    const last = tags.at(-1);
    if (!last) continue;
    const value = line.slice(last.index + last[0].length).trim();
    for (const [, min, sec, frac = ''] of tags) {
      rows.push({ start: Math.max(0, (+min * 60 + +sec) * 1000 + Number(frac.padEnd(3, '0')) - offset), text: value });
    }
  }
  return rows.sort((a, b) => a.start - b.start);
}

function yrc(text = '') {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const head = line.match(/^\[(\d+),(\d+)\]/);
    if (!head) continue;
    const words = [...line.matchAll(/\((\d+),(\d+),\d+\)(.*?)(?=\(\d+,\d+,\d+\)|$)/g)]
      .map(([, t, d, value]) => ({ start: +t / 1000, end: (+t + +d) / 1000, text: value }));
    if (words.length) rows.push({ start: +head[1], end: +head[1] + +head[2], words,
      text: words.map(w => w.text).join('') });
  }
  return rows.sort((a, b) => a.start - b.start);
}

function layer(raw) {
  const rows = yrc(raw);
  return rows.length ? rows : lrc(raw);
}

// Reserve exact matches first. A rounded timestamp can only fill its nearest
// unambiguous cue, and each translated line is used at most once.
function matchLayer(cues, source) {
  const values = new Array(cues.length).fill('');
  const byTime = new Map(cues.map((cue, i) => [cue.start, i]));
  const remaining = [];
  for (const row of source) {
    const i = byTime.get(row.start);
    if (i === undefined) remaining.push(row);
    else if (row.text) values[i] = row.text;
  }
  let right = 0;
  for (const row of remaining) {
    while (right < cues.length && cues[right].start < row.start) right++;
    const leftGap = row.start - (cues[right - 1]?.start ?? -Infinity);
    const rightGap = (cues[right]?.start ?? Infinity) - row.start;
    if (leftGap === rightGap || Math.min(leftGap, rightGap) > 250) continue;
    const i = leftGap < rightGap ? right - 1 : right;
    if (!values[i]) values[i] = row.text;
  }
  return values;
}

export function sourceLayers(rows, raw) {
  const original = lrc(raw.lrc);
  function align(precise, legacy) {
    const result = matchLayer(rows, layer(precise));
    const fallback = matchLayer(rows, layer(legacy));
    const originalValues = matchLayer(original, layer(legacy));
    // The two original tracks can be shifted. Repeated choruses retain order.
    const normalize = text => text.replace(inlineReadings, '$1').replace(/\s+/gu, '');
    const sameLines = original.filter(row => row.text).length === rows.filter(row => row.text).length;
    const nonempty = original.map((r, i) => ({ ...r, value: originalValues[i] })).filter(r => r.text);
    let at = 0;
    return rows.map((row, i) => {
      const other = row.text ? nonempty[at++] : null;
      const same = sameLines && other && normalize(other.text) === normalize(row.text);
      return result[i] || (same && other.value) || fallback[i] || '';
    });
  }
  return { translations: align(raw.ytlrc, raw.tlyric), roman: align(raw.yromalrc, raw.romalrc) };
}

function sourceRows(raw) {
  const timed = yrc(raw.yrc);
  return timed.length ? timed : lrc(raw.lrc);
}

// In this release of ここでおあずけ, the second chorus repeats the first at
// +49.778 s (measured on both NetEase audio qualities). Apply the correction
// only to the known bad cue sequence and keep the provider's original text.
function chorusTiming(id, rows) {
  if (id !== RETIMED_TRACK) return null;
  const before = [56_170, 60_880, 82_720, 83_760, 85_540];
  const reference = [6_400, 7_960, 9_970, 13_240, 14_620];
  const offset = 49_778;
  const first = rows.findIndex(row => row.start === before[0]);
  if (first < 0 || before.some((start, i) => rows[first + i]?.start !== start)) return null;
  const byStart = new Map(rows.map(row => [row.start, row]));
  const repairs = new Map();
  const shift = time => (Math.round(time * 1000) + offset) / 1000;
  for (let i = 0; i < before.length; i++) {
    const row = rows[first + i];
    const cue = byStart.get(reference[i]);
    const sung = row.words?.filter(word => word.text.trim());
    const template = cue?.words?.filter(word => word.text.trim());
    if (!template?.length || sung?.length !== template.length ||
        sung.some((word, j) => word.text !== template[j].text)) return null;
    const start = cue.start + offset;
    // The final cue is followed by an instrumental break. Keep it out of the loop.
    const end = i === before.length - 1 ? Math.round(template.at(-1).end * 1000) + offset : cue.end + offset;
    let j = 0;
    const words = row.words.map(({ text }) => {
      if (!text.trim()) return { text };
      const word = template[j++];
      return { text, start: shift(word.start), end: shift(word.end) };
    });
    repairs.set(row.start, { original: row, corrected: { ...row, start, end, words } });
  }
  return repairs;
}

function untimedWords(text) {
  const pieces = segmenter ? [...segmenter.segment(text)].map(piece => piece.segment) : [text];
  return pieces.flatMap(piece => (isLyricKana(piece) ? [...piece] : [piece]).map(text => ({ text })));
}

/** Group display words after the individual sounds have been aligned. For
 * timed lyrics, group katakana words only at existing fragment boundaries. */
function groupKanaWords(words) {
  if (!segmenter || !words || words.length < 2) return words;
  const boundaries = new Map([[0, 0]]);
  let text = '';
  for (const [i, word] of words.entries()) {
    text += word.text;
    boundaries.set(text.length, i + 1);
  }
  const groups = new Map();
  for (const { index, segment, isWordLike } of segmenter.segment(text)) {
    if (!isWordLike || !isLyricKana(segment)) continue;
    const first = boundaries.get(index), next = boundaries.get(index + segment.length);
    if (first == null || next == null || next - first < 2) continue;
    const parts = words.slice(first, next);
    if (parts.some(w => w.read || w.pron || w.readingOverride || w.parts?.length || w.lyricParts?.length ||
      (w.pos && w.pos !== 'other'))) continue;
    const timed = parts.some(w => w.start != null || w.end != null);
    if (timed && (!katakana.test(segment) || parts.some((w, i) =>
      !Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end < w.start ||
      (i > 0 && (w.start < parts[i - 1].start || w.end < parts[i - 1].end))))) continue;
    const roman = parts.map(w => w.roman || '').join('');
    const word = { text: segment, ...(roman ? { roman } : {}),
      ...(timed ? { start: parts[0].start, end: parts.at(-1).end } : {}) };
    groups.set(first, { word, next });
  }
  if (!groups.size) return words;
  const result = [];
  for (let i = 0; i < words.length;) {
    const group = groups.get(i);
    result.push(group?.word || words[i]);
    i = group?.next ?? i + 1;
  }
  return result;
}

/** Reading notes occupy real positions in some YRC files. Collapse them onto
 * their kanji and retain the range covered by the original timed fragments. */
function annotatedWords(row, roman) {
  let offset = 0;
  const parts = (row.words || untimedWords(row.text)).filter(word => word.text).map(word => {
    const from = offset;
    offset += word.text.length;
    return { word, from, to: offset };
  });
  const words = [];
  function appendText(from, to) {
    for (const part of parts) {
      const left = Math.max(from, part.from), right = Math.min(to, part.to);
      if (left >= right) continue;
      words.push(left === part.from && right === part.to ? part.word : { text: row.text.slice(left, right) });
    }
  }
  let cursor = 0;
  for (const match of row.text.matchAll(inlineReadings)) {
    const from = match.index, to = from + match[0].length;
    appendText(cursor, from);
    const start = parts.find(part => part.from === from)?.word.start;
    const end = parts.find(part => part.to === to)?.word.end;
    const word = { text: match[1], read: match[2] ?? match[3] };
    words.push(start != null && end != null ? { ...word, start, end } : word);
    cursor = to;
  }
  appendText(cursor, row.text.length);

  const units = [];
  for (const word of words) {
    const last = units.at(-1);
    // Small kana share one Roman syllable with the preceding kana.
    if (last && isKanaPair(last.text, word.text)) {
      const text = last.text + word.text;
      units[units.length - 1] = last.start != null && word.end != null
        ? { text, start: last.start, end: word.end } : { text };
    } else {
      units.push(/^[\s\p{P}]+$/u.test(word.text) ? { ...word, pos: 'punct' } : word);
    }
  }
  return withLyricRoman(units, roman);
}

function lyricText(row, roman) {
  const sourceWords = annotatedWords(row, roman);
  const words = groupKanaWords(sourceWords);
  return { text: words.map(word => word.text).join(''), words,
    wordTiming: words.some(word => word.start != null && word.pos !== 'punct'),
    ...(words === sourceWords ? {} : { sourceWords }) };
}

export function songLyrics(song, raw) {
  const id = 'netease-' + song.id;
  const rows = sourceRows(raw);
  const { translations, roman } = sourceLayers(rows, raw);
  const repairs = chorusTiming(id, rows);
  const sentences = rows.map((row, i) => {
    const timed = repairs?.get(row.start)?.corrected ?? row;
    return {
      ...lyricText(timed, roman[i]), start: timed.start / 1000,
      end: Math.max(timed.start / 1000, (timed.end ?? rows[i + 1]?.start ?? song.duration * 1000) / 1000),
      translation: translations[i], translationLang: 'zh-CN', sourceRoman: roman[i],
    };
  }).filter(s => s.text);
  return { id, title: song.name, language: 'ja', audio: { duration: song.duration },
    hasWordTiming: sentences.some(s => s.wordTiming), sourceAlignmentVersion: LYRIC_ALIGNMENT_VERSION, sourceLyrics: raw, sentences };
}

function upgradeSourceRows(data) {
  if (data.sourceAlignmentVersion >= 3 ||
      (data.sourceAlignmentVersion >= 2 && data.id !== RETIMED_TRACK)) return data.sentences;
  const raw = data.sourceLyrics, rows = sourceRows(raw);
  const repairs = chorusTiming(data.id, rows);
  const layers = data.sourceAlignmentVersion >= 2 ? null : sourceLayers(rows, raw);
  const cueKey = (start, text) => start + '\0' + text;
  const byCue = new Map(rows.map((row, i) => [cueKey(row.start, row.text), i]));
  // Retime the passage together, so an independently edited cue cannot leave
  // the surrounding cues out of order.
  const canRetime = repairs && [...repairs.values()].every(({ original: row }) =>
    data.sentences.some(s => s.text === row.text && Math.round(s.start * 1000) === row.start &&
      Math.round(s.end * 1000) === row.end));
  return data.sentences.map(s => {
    const i = byCue.get(cueKey(Math.round(s.start * 1000), s.text));
    if (i === undefined) return s;
    const row = rows[i];
    let next = s;
    if (layers) {
      const sourceRoman = s.sourceRoman || layers.roman[i];
      const hasAnalysis = s.annotation || s.words?.some(word => word.read || word.roman || word.pron || word.pos);
      next = { ...s, sourceRoman };
      if (!next.translation && !Object.hasOwn(s.translations || {}, 'zh-CN') && layers.translations[i]) {
        next.translation = layers.translations[i]; next.translationLang = 'zh-CN';
      }
      Object.assign(next, hasAnalysis ? { words: withLyricRoman(s.words || [], sourceRoman) } : lyricText(row, sourceRoman));
    }
    const corrected = canRetime && repairs.get(row.start)?.corrected;
    if (!corrected) return next;
    const sourceWords = annotatedWords(corrected, next.sourceRoman);
    return { ...next, ...alignWordTimes(next.words ?? sourceWords, sourceWords),
      start: corrected.start / 1000, end: corrected.end / 1000,
      ...(s.sourceWords ? { sourceWords } : {}) };
  });
}

/** Update cached provider lyrics while keeping reviewed words, translations,
 * and existing timing corrections. */
export function upgradeSongLyrics(data) {
  if (!data?.sourceLyrics || !Array.isArray(data.sentences) || data.sourceAlignmentVersion >= LYRIC_ALIGNMENT_VERSION) return data;
  const sentences = upgradeSourceRows(data).map(s => {
    let words = s.words;
    if (!(data.sourceAlignmentVersion >= 5) && s.annotation === 'dictionary' && words?.length) {
      words = alignDictionaryReadings(words, s.sourceRoman);
    } else if (!(data.sourceAlignmentVersion >= 6)) words = backfillLyricNumbers(words, s.sourceRoman);
    if (isReviewedLyric(s)) words = inheritLyricPos(words, s.sourceWords);
    if (!s.annotation && s.analyzed !== true && words?.map(word => word.text).join('') === s.text) {
      const grouped = groupKanaWords(words);
      if (grouped !== words) return { ...s, words: grouped, sourceWords: s.sourceWords || words };
    }
    return words === s.words ? s : { ...s, words };
  });
  return withLyricPosLegend({ ...data, sourceAlignmentVersion: LYRIC_ALIGNMENT_VERSION, sentences,
    hasWordTiming: sentences.some(s => s.wordTiming) });
}

export function validateReadingTokens(text, tokens) {
  if (!Array.isArray(tokens) || !tokens.length || tokens.some(t => !t || typeof t.text !== 'string' || !t.text
      || typeof t.read !== 'string' || (t.read && !isLyricKana(t.read)))
      || tokens.map(t => t.text).join('') !== text) throw Error('校对结果改动了原词或假名格式无效');
}

export function applyReadings(sentence, tokens, annotation = 'ai') {
  validateReadingTokens(sentence.text, tokens);
  const previous = new Map();
  let offset = 0;
  for (const word of sentence.words) {
    const automatic = word.readingOverride?.original;
    if (!automatic || automatic.length === 1) previous.set(offset, automatic?.[0] ?? word);
    offset += word.text.length;
  }
  offset = 0;
  const revised = tokens.map(({ text, read, pos }) => {
    const existing = previous.get(offset);
    offset += text.length;
    if (/^[\s\p{P}]+$/u.test(text)) return { text, read: '', pos: 'punct' };
    read = needsLyricReading(text) ? read.trim().normalize('NFKC') : '';
    pos = lyricPos(pos);
    if (existing?.text !== text) return pos ? { text, read, pos } : { text, read };
    const tagged = pos && !lyricPos(existing.pos) ? { ...existing, pos } : existing;
    if (!read || (read === tagged.read && (!tagged.pron || read === tagged.pron))) return tagged;
    const { pron: _pron, roman: _roman, lyricParts: _lyricParts, ...word } = tagged;
    return { ...word, read };
  });
  const tagged = inheritLyricPos(inheritLyricPos(revised, sentence.words), sentence.sourceWords);
  const next = alignTokens(sentence, tagged, annotation);
  if (next.words !== sentence.words) delete next.lyricPosChecked;
  return next;
}

function alignWordTimes(tokens, sourceWords) {
  const starts = new Map(), ends = new Map();
  let offset = 0;
  for (const w of sourceWords) {
    starts.set(offset, w.start);
    offset += w.text.length;
    ends.set(offset, w.end);
  }
  offset = 0;
  const words = tokens.map(({ start: _start, end: _end, ...token }) => {
    const start = starts.get(offset);
    offset += token.text.length;
    const end = ends.get(offset);
    if (!token.text.trim()) return { ...token, pos: 'punct' };
    return start != null && end != null ? { ...token, start, end } : token;
  });
  return { words, wordTiming: words.some(w => w.start != null && w.pos !== 'punct') };
}

const bareKanji = word => word && !word.read && /^\p{Script=Han}$/u.test(word.text);

export function sungReadingTargets(sentence) {
  const words = sentence.words || [];
  const targets = [];
  let from = 0;
  for (let i = 0; i < words.length;) {
    const word = words[i++];
    let text = word.text;
    if (bareKanji(word)) {
      while (bareKanji(words[i])) text += words[i++].text;
    }
    if (needsLyricReading(text)) targets.push({ from, text, read: word.pron || word.read || '',
      roman: text === word.text ? word.roman || '' : '', custom: !!word.readingOverride });
    from += text.length;
  }
  return targets;
}

function replaceSungReading(words, { from, text }, value) {
  let offset = 0, first = -1;
  for (let i = 0; i < words.length; i++) {
    if (offset === from) first = i;
    offset += words[i].text.length;
    if (offset > from + text.length) break;
    if (first < 0 || offset !== from + text.length) continue;
    const last = i + 1;
    const selected = words.slice(first, last);
    if (selected.map(word => word.text).join('') !== text) return null;
    const existing = selected.length === 1 ? selected[0].readingOverride : null;
    const around = replacement => [...words.slice(0, first), ...replacement, ...words.slice(last)];
    if (value === null) return existing ? around(inheritLyricPos(existing.original, selected)) : null;
    if (!existing && selected.some(word => word.readingOverride)) return null;
    const base = last === first + 1 ? selected[0] : inheritLyricPos([{
      text, start: selected[0].start, end: selected.at(-1).end,
    }], selected)[0];
    const word = withSungReading(base, value, words[first - 1], words[last]);
    return around([{ ...word, readingOverride: { kana: word.read, original: existing?.original || selected } }]);
  }
  return null;
}

function withReadingWords(sentence, words) {
  return { ...sentence, words, wordTiming: !!sentence.wordTiming &&
    words.some(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.pos !== 'punct' && w.text.trim()) };
}

export function setSungReading(sentence, target, value) {
  const words = needsLyricReading(target.text) && replaceSungReading(sentence.words, target, value);
  if (!words) throw new Error('这处歌词已更新，请重新选择词语');
  const next = withReadingWords({ ...sentence, sourceWords: sentence.sourceWords || sentence.words }, words);
  if (words.length !== sentence.words.length) delete next.lyricPosChecked;
  return next;
}

/** Retain a local reading when automatic analysis changes the word boundaries. */
export function retainReadingOverrides(previous, updated) {
  if (previous.text !== updated.text) return updated;
  let words = updated.words, from = 0;
  for (const word of previous.words) {
    if (word.readingOverride) {
      words = replaceSungReading(words, { from, text: word.text }, word.readingOverride.kana);
      // A new token straddles the user's span. Keep the proven boundaries.
      if (!words) return { ...updated, words: previous.words, wordTiming: previous.wordTiming,
        annotation: previous.annotation, analyzed: previous.analyzed };
    }
    from += word.text.length;
  }
  return words === updated.words ? updated : withReadingWords(updated, words);
}

export function alignTokens(sentence, tokens, annotation) {
  const sourceWords = sentence.sourceWords || sentence.words;
  let annotated = tokens;
  if (annotation === 'dictionary') {
    if (Object.hasOwn(sentence, 'sourceRoman')) annotated = keepSongReadings(tokens, sourceWords, sentence.sourceRoman);
    annotated = alignDictionaryReadings(annotated, sentence.sourceRoman);
  } else annotated = alignReviewedReadings(annotated, sentence.sourceRoman);
  const updated = { ...sentence, annotation, sourceWords, analyzed: true, ...alignWordTimes(annotated, sourceWords) };
  return retainReadingOverrides(sentence, updated);
}
