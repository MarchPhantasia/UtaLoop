import { isLyricNumber } from './lyric-readings.js';

// Match the compact labels used by the dictionary and the reader palette.
const labels = {
  noun: '名词', propn: '专有名词', pron: '代词', num: '数词', verb: '动词', adj: '形容词',
  adjn: '形容动词', adv: '副词', adnom: '连体词', det: '限定词', conj: '连词', interj: '感叹词',
  particle: '助词', prep: '介词', aux: '助动词', prefix: '前缀', suffix: '后缀', fill: '填充语',
};
export const LYRIC_POS_TAGS = Object.keys(labels);
const japanese = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const punctuation = /^[\s\p{P}]+$/u;
const functionWords = new Set(['particle', 'prep', 'aux', 'prefix', 'suffix']);
const modifiers = new Set(['adv', 'adnom', 'det']);

export function lyricPos(value) {
  const tag = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return Object.hasOwn(labels, tag) ? tag : '';
}

export const isReviewedLyric = row => row.annotation === 'ai' || row.annotation === 'review';
const missingPos = word => !lyricPos(word.pos) && word.pos !== 'punct' && !punctuation.test(word.text);
export function needsLyricPos(row) {
  return isReviewedLyric(row) && !row.lyricPosChecked && row.words?.some(word =>
    missingPos(word) && (japanese.test(word.text) || isLyricNumber(word.text)));
}

const joined = words => words.map(word => word.text).join('');

function ranges(words, offset = 0) {
  return words.map(word => {
    const start = offset;
    offset += word.text.length;
    return { start, end: offset, word };
  });
}

function groupPos(covered) {
  const tags = new Set(covered.filter(({ word }) => !punctuation.test(word.text)).map(({ word }) => lyricPos(word.pos)));
  if (tags.has('')) return '';
  if (tags.size === 1) return [...tags][0];
  const content = [...tags].filter(tag => !functionWords.has(tag));
  const heads = content.filter(tag => !modifiers.has(tag));
  const candidates = heads.length ? heads : content;
  return candidates.length === 1 ? candidates[0] : '';
}

/** Fill missing tags at lyric character ranges. Conflicting or partial overlaps
 * stay neutral. The reviewed word, reading, and timestamps stay intact. */
export function inheritLyricPos(words, reference) {
  if (!reference?.length || !words?.some(missingPos) || joined(words) !== joined(reference)) return words;
  const whole = ranges(reference);
  const parts = whole.flatMap(span => {
    const { word, start } = span;
    return word.parts?.length && joined(word.parts) === word.text ? ranges(word.parts, start) : [span];
  });
  const exact = (spans, start, end) => lyricPos(spans.find(span => span.start === start && span.end === end)?.word.pos);
  let changed = false;
  const result = ranges(words).map(({ word, start, end }) => {
    if (!missingPos(word)) return word;
    let pos = exact(whole, start, end) || exact(parts, start, end);
    if (!pos) {
      const covered = parts.filter(span => span.start < end && start < span.end);
      if (covered[0]?.start === start && covered.at(-1)?.end === end) pos = groupPos(covered);
    }
    if (!pos) return word;
    changed = true;
    return { ...word, pos };
  });
  return changed ? result : words;
}

export function withLyricPosLegend(data) {
  const posLegend = { ...data.posLegend };
  let changed = false;
  for (const row of data.sentences) {
    for (const word of row.words || []) {
      const tag = lyricPos(word.pos);
      if (!tag || Object.hasOwn(posLegend, tag)) continue;
      posLegend[tag] = { label: labels[tag] };
      changed = true;
    }
  }
  return changed ? { ...data, posLegend } : data;
}
