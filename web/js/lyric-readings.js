const HAN = /\p{Script=Han}/u;
const KANA = /^[ぁ-ゖー]+$/u;
const JAPANESE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
const HAS_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;
const NUMBER = /^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)(?:\.[0-9]+)?$/u;
const DIGIT = /[0-9０-９]/u;
const DIGIT_READINGS = [
  ['ぜろ', 'れい', 'まる'], ['いち', 'わん'], ['に', 'つー'], ['さん', 'すりー'], ['よん', 'し', 'よ', 'ふぉー'],
  ['ご', 'ふぁいぶ'], ['ろく', 'しっくす'], ['なな', 'しち', 'せぶん'], ['はち', 'えいと'], ['きゅう', 'く', 'ないん'],
];
const HUNDREDS = ['', 'ひゃく', 'にひゃく', 'さんびゃく', 'よんひゃく', 'ごひゃく', 'ろっぴゃく', 'ななひゃく', 'はっぴゃく', 'きゅうひゃく'];
const THOUSANDS = ['', 'せん', 'にせん', 'さんぜん', 'よんせん', 'ごせん', 'ろくせん', 'ななせん', 'はっせん', 'きゅうせん'];
// These counters can change the pronunciation at the number boundary.
const VARIABLE_COUNTER = /^(?:つ(?!ぎ)|[かカヶ箇]月|人|日|月|時|分|本|匹|杯|個|回|階|歳|才|冊|足|件|点|拍|度|曲)/u;
const HAN_WITH_KANA = /^([ぁ-ゖァ-ヺーｦ-ﾟ]*)(\p{Script=Han}+)([ぁ-ゖァ-ヺーｦ-ﾟ]*)$/u;
const KANA_ROMAN = new Map(`
  あ:a い:i う:u え:e お:o か:ka き:ki く:ku け:ke こ:ko
  が:ga ぎ:gi ぐ:gu げ:ge ご:go さ:sa し:shi す:su せ:se そ:so
  ざ:za じ:ji ず:zu ぜ:ze ぞ:zo た:ta ち:chi つ:tsu て:te と:to
  だ:da ぢ:ji づ:zu で:de ど:do な:na に:ni ぬ:nu ね:ne の:no
  は:ha ひ:hi ふ:fu へ:he ほ:ho ば:ba び:bi ぶ:bu べ:be ぼ:bo
  ぱ:pa ぴ:pi ぷ:pu ぺ:pe ぽ:po ま:ma み:mi む:mu め:me も:mo
  や:ya ゆ:yu よ:yo ら:ra り:ri る:ru れ:re ろ:ro
  わ:wa ゐ:i ゑ:e を:o ん:n ゔ:vu ゕ:ka ゖ:ke
  ぁ:a ぃ:i ぅ:u ぇ:e ぉ:o ゃ:ya ゅ:yu ょ:yo ゎ:wa
  きゃ:kya きゅ:kyu きょ:kyo きぇ:kye ぎゃ:gya ぎゅ:gyu ぎょ:gyo ぎぇ:gye
  しゃ:sha しゅ:shu しょ:sho しぇ:she しぃ:shi じゃ:ja じゅ:ju じょ:jo じぇ:je じぃ:ji
  ちゃ:cha ちゅ:chu ちょ:cho ちぇ:che ぢゃ:ja ぢゅ:ju ぢょ:jo
  にゃ:nya にゅ:nyu にょ:nyo にぇ:nye ひゃ:hya ひゅ:hyu ひょ:hyo ひぇ:hye
  びゃ:bya びゅ:byu びょ:byo びぇ:bye ぴゃ:pya ぴゅ:pyu ぴょ:pyo ぴぇ:pye
  みゃ:mya みゅ:myu みょ:myo みぇ:mye りゃ:rya りゅ:ryu りょ:ryo りぇ:rye
  ふぁ:fa ふぃ:fi ふぇ:fe ふぉ:fo ふゅ:fyu ふゃ:fya
  ゔぁ:va ゔぃ:vi ゔぇ:ve ゔぉ:vo ゔゅ:vyu いぇ:ye
  つぁ:tsa つぃ:tsi つぇ:tse つぉ:tso てぃ:ti とぅ:tu てゅ:tyu
  でぃ:di どぅ:du でゅ:dyu うぃ:wi うぇ:we うぉ:wo すぃ:si ずぃ:zi
  くゎ:kwa くぁ:kwa くぃ:kwi くぇ:kwe くぉ:kwo
  ぐゎ:gwa ぐぁ:gwa ぐぃ:gwi ぐぇ:gwe ぐぉ:gwo
`.trim().split(/\s+/u).map(entry => entry.split(':')));

const kanaKey = text => text.trim().normalize('NFKC').replace(/[ァ-ヶ]/g,
  c => String.fromCharCode(c.charCodeAt(0) - 0x60));
export { kanaKey as normalizeLyricKana };
const latinKey = text => text.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
const variants = { は: 'wa', へ: 'e', を: 'wo', し: 'si', ち: 'ti', つ: 'tu', ふ: 'hu', じ: 'zi', ん: 'm' };
const kanaByRoman = new Map();
for (const [kana, roman] of KANA_ROMAN) {
  if (/^[ぁぃぅぇぉゃゅょゎゕゖゐゑ]/u.test(kana)) continue;
  kanaByRoman.set(roman, kanaByRoman.has(roman) ? '' : kana);
}

export const isLyricKana = text => KANA.test(kanaKey(text));
export const isLyricNumber = text => DIGIT.test(text) && NUMBER.test(text.trim().normalize('NFKC'));
export const needsLyricReading = text => HAN.test(text) || isLyricNumber(text) || /^\s*[0-9０-９]+\s*つ\s*$/u.test(text);
export function isKanaPair(left, right) {
  const pair = kanaKey(left + right);
  return left.length === 1 && right.length === 1 && pair.length === 2 && KANA_ROMAN.has(pair);
}

function pronunciation(word) {
  const text = kanaKey(word.text);
  if (KANA.test(text)) return text;
  const read = kanaKey(word.pron || word.read || '');
  if (!KANA.test(read) || !needsLyricReading(text)) return '';
  const suffix = text.match(/[ぁ-ゖー]+$/u)?.[0] || '';
  return read.endsWith(suffix) ? read : read + suffix;
}

function syllable(text, at) {
  return KANA_ROMAN.get(text.slice(at, at + 2)) || KANA_ROMAN.get(text[at]) || '';
}

function spellKana(text, before, next) {
  let roman = '';
  for (let i = 0; i < text.length; i++) {
    const pair = KANA_ROMAN.get(text.slice(i, i + 2));
    if (pair && i + 1 < text.length) {
      roman += pair; i++;
    } else if (text[i] === 'っ') {
      const after = syllable(text, i + 1) || syllable(next, 0);
      if (/^[^aeiou]/.test(after)) roman += after.startsWith('ch') ? 't' : after[0];
    } else if (text[i] === 'ー') {
      roman += (before + roman).match(/[aeiou](?=[^aeiou]*$)/)?.[0] || '';
    } else {
      roman += KANA_ROMAN.get(text[i]) || '';
    }
  }
  return roman;
}

function cardinalReading(digits) {
  const block = value => {
    const [thousands, hundreds, tens, ones] = [...value.padStart(4, '0')].map(Number);
    const ten = tens ? (tens === 1 ? '' : DIGIT_READINGS[tens][0]) + 'じゅう' : '';
    return THOUSANDS[thousands] + HUNDREDS[hundreds] + ten + (ones ? DIGIT_READINGS[ones][0] : '');
  };
  const high = digits.slice(0, -4), low = digits.slice(-4);
  return (high ? block(high) + 'まん' : '') + block(low);
}

function numeralOptions(text) {
  const [whole, fraction] = text.trim().normalize('NFKC').replaceAll(',', '').split('.');
  if (fraction == null && whole.length === 1) return DIGIT_READINGS[Number(whole)];
  if (whole.length > 8 || fraction?.length > 8) return [];
  const digits = value => [...value].map(digit => DIGIT_READINGS[Number(digit)][0]).join('');
  const cardinal = whole.startsWith('0') ? digits(whole) : cardinalReading(whole);
  return fraction ? [cardinal + 'てん' + digits(fraction)] : [...new Set([cardinal, digits(whole)])];
}

function numberCandidates(words, sourceRoman) {
  if (!words.some(word => DIGIT.test(word.text))) return [];
  const line = words.map(word => word.text).join('');
  if (!JAPANESE.test(line) && (!sourceRoman || /[^0-9０-９\s\p{P}]/u.test(line))) return [];
  const japanese = HAS_KANA.test(line) || words.some(word => isLyricKana(word.read || ''));
  let offset = 0;
  return words.map(word => {
    const from = offset;
    offset += word.text.length;
    if (word.readingOverride || pronunciation(word) || !isLyricNumber(word.text)) return null;
    const before = line.slice(0, from) + word.text.match(/^\s*/u)[0];
    const after = word.text.match(/\s*$/u)[0] + line.slice(offset);
    // A timed fragment may be the digit inside an ID or part of a longer number.
    const attached = /(?:\p{Script=Latin}[-._/]?|[0-9０-９][,.，．/:／：-]?)$/u.test(before) ||
      /^(?:[-._/]?\p{Script=Latin}|[,.，．/:／：-]?[0-9０-９])/u.test(after);
    if (attached) return null;
    const options = numeralOptions(word.text).map(read => [spellKana(read, '', ''), read]);
    if (!options.length) return null;
    const existing = options.find(([roman]) => roman === latinKey(word.roman || ''))?.[1];
    const nearbyLatin = /\p{Script=Latin}\s*$/u.test(before) || /^\s*\p{Script=Latin}/u.test(after);
    const fallback = japanese && !nearbyLatin && !VARIABLE_COUNTER.test(after.trimStart()) ? options[0][1] : '';
    return { defaultRead: existing || fallback,
      options: new Map(options.sort(([a], [b]) => b.length - a.length)) };
  });
}

// Boundaries must fall between complete source syllables. Reject ambiguous
// spellings such as "o", which could stand for either お or を.
function sourceKana(sourceRoman, start, end) {
  let offset = 0, read = '';
  for (const unit of sourceRoman.trim().split(/\s+/u)) {
    const from = offset;
    offset += latinKey(unit).length;
    if (offset <= start) continue;
    if (from >= end) break;
    const kana = /^[a-z]+$/i.test(unit) && kanaByRoman.get(unit.toLowerCase());
    if (!kana || from < start || offset > end) return '';
    read += kana;
  }
  return read;
}

function nanikaCandidate(words, index) {
  const word = words[index];
  if (word.pron || word.readingOverride) return null;
  const split = word.text === '何' && words[index + 1]?.text === 'か';
  if (!split && word.text !== '何か') return null;
  // 何か is an indefinite pronoun here. Counters such as 何か月 are excluded.
  const particle = words[index + (split ? 2 : 1)]?.text;
  if (particle !== 'を' && particle !== 'が') return null;
  return { read: split ? 'なに' : 'なにか', roman: split ? 'nani' : 'nanika',
    phrases: particle === 'が' ? ['nanikaga'] : ['nanikao', 'nanikawo'] };
}

/** Prefer the source spelling when it matches the sung units. Unknown readings
 * only take the remaining source phonetics if exactly one word can own them. */
export function withLyricRoman(words, sourceRoman = '', { dictionary = false } = {}) {
  const numbers = numberCandidates(words, sourceRoman);
  const spoken = words.map(pronunciation);
  let before = '';
  const readings = words.map((word, i) => {
    const spelling = word.roman || spellKana(spoken[i], before, spoken[i + 1] || '');
    before = spelling;
    return spelling;
  });
  const han = words.map(word => HAN.test(word.text));
  const choices = words.map((word, i) => {
    if (numbers[i]) return [...numbers[i].options.keys(), latinKey(word.text)];
    if (han[i] && !readings[i]) return [];
    const spelling = latinKey(readings[i] || word.text);
    const alternate = variants[spoken[i]];
    return alternate && !word.roman ? [spelling, alternate] : [spelling];
  });
  const source = latinKey(sourceRoman || '');
  const contextual = dictionary ? words.map((_, i) => nanikaCandidate(words, i)) : [];
  const corrected = new Map(), numberMatches = new Map();
  let first = 0, last = words.length - 1, left = 0, right = source.length;
  while (source && first <= last) {
    const candidate = contextual[first];
    // Match the whole phrase. The old spelling `nan` is also a prefix of `nani`.
    const supported = candidate?.phrases.some(phrase => source.startsWith(phrase, left));
    const match = supported ? candidate.roman
      : choices[first].find(text => left + text.length <= right && source.startsWith(text, left));
    if (match === undefined) break;
    if (supported) corrected.set(first, candidate);
    if (numbers[first]?.options.has(match)) numberMatches.set(first, numbers[first].options.get(match));
    if (readings[first] && !words[first].roman) readings[first] = match || readings[first];
    left += match.length; first++;
  }
  while (source && last >= first) {
    const match = choices[last].find(text => right - text.length >= left && source.endsWith(text, right));
    if (match === undefined) break;
    if (numbers[last]?.options.has(match)) numberMatches.set(last, numbers[last].options.get(match));
    if (readings[last] && !words[last].roman) readings[last] = match || readings[last];
    right -= match.length; last--;
  }
  let sungReading = '';
  if (first === last && han[first] && left < right) {
    const word = words[first];
    // A provider pronunciation can replace a dictionary guess when the rest
    // of the line agrees on both sides and the missing syllables are explicit.
    if (dictionary && left > 0 && right < source.length && !word.pron && !word.parts?.length &&
        !word.lyricParts?.length && /^\p{Script=Han}+$/u.test(word.text)) {
      sungReading = sourceKana(sourceRoman, left, right);
    }
    if (!readings[first] || sungReading) readings[first] = source.slice(left, right);
  }
  // If the rest of the line aligns, respect a conflicting source spelling by
  // leaving the reading open for calibration.
  const unmatchedNumber = first === last && numbers[first] && /[a-z]/u.test(source.slice(left, right));
  return words.map((word, i) => {
    const number = numberMatches.get(i) || (!(unmatchedNumber && i === first) && numbers[i]?.defaultRead);
    if (number) return withSungReading(word, number, words[i - 1], words[i + 1]);
    const candidate = source ? corrected.get(i) : contextual[i];
    if (candidate) return withSungReading(word, candidate.read, words[i - 1], words[i + 1]);
    if (i === first && sungReading) return { ...word, read: sungReading, pron: sungReading, roman: readings[i] };
    if (!word.read && spoken[i] && isLyricNumber(word.text)) return { ...word, read: spoken[i], roman: readings[i] };
    return readings[i] && readings[i] !== word.roman ? { ...word, roman: readings[i] } : word;
  });
}

export function backfillLyricNumbers(words, sourceRoman) {
  if (!words?.some(word => isLyricNumber(word.text) && (!word.read || !word.roman))) return words;
  const aligned = withLyricRoman(words, sourceRoman);
  const revised = words.map((word, i) => isLyricNumber(word.text) ? aligned[i] : word);
  return revised.some((word, i) => word !== words[i]) ? revised : words;
}

/** Older UniDic-lite replies wrote the base-form kana next to surface romaji.
 * Use the written okurigana and confirm a candidate against that same romaji. */
function recoverDictionaryKana(word, next) {
  const read = kanaKey(word.read || ''), roman = latinKey(word.roman || '');
  if (!KANA.test(read) || !roman || !HAN.test(word.text)) return '';
  if (spellKana(read, '', next) === roman) return read;
  const tail = kanaKey(word.text).match(/[ぁ-ゖー]+$/u)?.[0] || '';
  if (tail) {
    const matches = [];
    for (let i = 1; i <= read.length; i++) {
      const candidate = read.slice(0, i) + tail;
      if (spellKana(candidate, '', next) === roman) matches.push(candidate);
    }
    if (matches.length === 1) return matches[0];
  }
  // Irregular stems such as 来 in 来て can also be recovered from one
  // unambiguous syllable of a known inflected dictionary entry.
  const shape = word.text.match(HAN_WITH_KANA);
  if (!word.conj || !word.lemma || word.lemma === word.text || !shape || shape[1]) return '';
  const suffix = spellKana(tail, '', next);
  const stem = roman.endsWith(suffix) && kanaByRoman.get(roman.slice(0, roman.length - suffix.length));
  return stem && spellKana(stem + tail, '', next) === roman ? stem + tail : '';
}

function repairDictionaryWord(word, next) {
  if (word.pron || !word.read || !word.roman || !HAN.test(word.text)) return word;
  let read = '';
  let parts = word.parts;
  if (parts?.length && parts.map(p => p.text).join('') === word.text) {
    parts = parts.map((part, i) => {
      const after = i + 1 < parts.length ? pronunciation(parts[i + 1]) : next;
      const corrected = recoverDictionaryKana(part, after);
      return corrected && corrected !== part.read ? { ...part, read: corrected } : part;
    });
    const units = parts.map(part => isLyricKana(part.text) ? kanaKey(part.text) : kanaKey(part.read || ''));
    if (units.every(unit => KANA.test(unit))) {
      const candidate = units.join('');
      if (spellKana(candidate, '', next) === latinKey(word.roman)) read = candidate;
    }
  }
  read ||= recoverDictionaryKana(word, next);
  const changedParts = parts?.some((part, i) => part !== word.parts[i]);
  if (!changedParts && (!read || read === word.read)) return word;
  return { ...word, read: read || word.read, ...(changedParts ? { parts } : {}) };
}

function placeLyricFurigana(word, next) {
  if (!word.read || !word.roman || word.lyricParts?.length) return word;
  const shape = word.text.match(HAN_WITH_KANA);
  if (!shape || (!shape[1] && !shape[3])) return word;
  const [, prefix, kanji, suffix] = shape;
  const before = kanaKey(prefix), after = kanaKey(suffix), read = pronunciation(word);
  if (!read.startsWith(before) || !read.endsWith(after) || read.length <= before.length + after.length) return word;
  const reading = read.slice(before.length, read.length - after.length);
  const leadRoman = spellKana(before, '', reading);
  const kanjiRoman = spellKana(reading, leadRoman, after || next);
  const tailRoman = spellKana(after, leadRoman + kanjiRoman, next);
  if (leadRoman + kanjiRoman + tailRoman !== latinKey(word.roman)) return word;
  return { ...word, lyricParts: [
    ...(prefix ? [{ text: prefix, roman: leadRoman }] : []),
    { text: kanji, read: reading, roman: kanjiRoman },
    ...(suffix ? [{ text: suffix, roman: tailRoman }] : []),
  ] };
}

export function withSungReading(word, value, previous, following) {
  const read = typeof value === 'string' ? kanaKey(value) : '';
  const next = following ? pronunciation(following) : '';
  const roman = KANA.test(read) && spellKana(read, previous?.roman || '', next);
  if (!roman) throw new Error('请输入唱出来的平假名或片假名');
  const { lyricParts: _labels, ...base } = word;
  return placeLyricFurigana({ ...base, read, pron: read, roman }, next);
}

function withFurigana(words) {
  return words.map((word, i) => placeLyricFurigana(word, words[i + 1] ? pronunciation(words[i + 1]) : ''));
}

export function alignReviewedReadings(words, sourceRoman) {
  return withFurigana(withLyricRoman(words, sourceRoman));
}

export function alignDictionaryReadings(words, sourceRoman) {
  const spoken = words.map(pronunciation);
  const repaired = words.map((word, i) => repairDictionaryWord(word, spoken[i + 1] || ''));
  return withFurigana(withLyricRoman(repaired, sourceRoman, { dictionary: true }));
}

export function keepSongReadings(tokens, sourceWords, sourceRoman) {
  let offset = 0;
  const spans = sourceWords.filter(word => word.text).map(word => {
    const start = offset;
    offset += word.text.length;
    return { start, end: offset, word };
  });
  // A derived numeric reading adds `pron`. Only inline source notes are binding.
  const sourceRead = word => needsLyricReading(word.text) && (!isLyricNumber(word.text) || !word.pron) ? word.read || '' : '';
  const intact = spans.filter(({ word }) => isLyricNumber(word.text) || sourceRead(word));

  const groups = [];
  offset = 0;
  for (const token of tokens) {
    const last = groups.at(-1);
    if (last && intact.some(span => span.start < offset && offset < span.end)) {
      // Keep the source's number and inline readings within their original range.
      groups[groups.length - 1] = { text: last.text + token.text };
    } else groups.push(token);
    offset += token.text.length;
  }

  offset = 0;
  return groups.map(token => {
    const start = offset;
    offset += token.text.length;
    const parts = spans.filter(span => span.start >= start && span.end <= offset);
    if (parts[0]?.start !== start || parts.at(-1)?.end !== offset) return token;
    const words = parts.map(span => span.word);
    if (words.some(w => !isLyricKana(w.text) && !sourceRead(w))) return token;
    const read = words.map(sourceRead).join('');
    const roman = words.every(w => w.roman) ? words.map(w => w.roman).join('') : '';
    const corrected = read ? { ...token, read, pron: words.map(w => sourceRead(w) || w.text).join(''), roman } : token;
    if (words.length === 1 || (!read && !sourceRoman) || !roman) return corrected;
    return { ...corrected, lyricParts: words.map(({ text, read, roman }) => ({ text, read, roman })) };
  });
}
