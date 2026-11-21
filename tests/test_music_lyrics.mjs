import assert from 'node:assert/strict';
import test from 'node:test';
import { songLyrics, alignTokens, applyReadings, setSungReading, sungReadingTargets, upgradeSongLyrics } from '../web/js/music-lyrics.js';
import { Track } from '../web/js/track.js';

test('rounded translation times cannot steal exact matches or cross an ambiguous boundary', () => {
  const raw = { lrc: '[00:01]空\n[00:02]海\n[00:02.4]風\n[00:04]夜',
    tlyric: '[00:00.96]天空\n[00:01.98]重复\n[00:02]海洋\n[00:02.20]不确定\n[00:05]未对应' };
  assert.deepEqual(songLyrics(song, raw).sentences.map(s => s.translation), ['天空', '海洋', '', '']);
});

test('matches translated LRC to a shifted word-timed original through the original line text', () => {
  const raw = { lrc: '[00:01]空\n[00:03]海', tlyric: '[00:01]天空\n[00:03]海洋',
    yrc: '[1600,300](1600,300,0)空\n[3600,500](3600,500,0)海' };
  const rows = songLyrics(song, raw).sentences;
  assert.deepEqual(rows.map(s => [s.start, s.translation]), [[1.6, '天空'], [3.6, '海洋']]);
});

const song = { id: 9, name: '練習', duration: 8 };
test('LRC retains original layers, repeated timestamps and audio duration without invented word timing', () => {
  const raw = { lrc: '[00:01.25][00:04]雨音', tlyric: '[00:01.250]雨声', romalrc: '[00:04]amaoto' };
  const track = songLyrics(song, raw);
  assert.deepEqual(track.sentences.map(s => [s.start, s.end, s.translation, s.sourceRoman]),
    [[1.25, 4, '雨声', ''], [4, 8, '', 'amaoto']]);
  assert.equal(track.sourceLyrics, raw);
  assert.equal(track.hasWordTiming, false);
});
test('AI edits preserve text, translation and only source-supported timestamps', () => {
  const raw = { yrc: '[1200,800](1200,300,0)雨(1500,500,0)音', tlyric: '[00:01.2]雨声' };
  const [row] = songLyrics(song, raw).sentences;
  const merged = applyReadings(row, [{ text: '雨音', read: 'あまおと' }]);
  assert.deepEqual(merged.words, [{ text: '雨音', read: 'あまおと', roman: 'amaoto', start: 1.2, end: 2 }]);
  assert.equal(merged.translation, '雨声');
  const split = applyReadings(merged, [{ text: '雨', read: 'あま' }, { text: '音', read: 'おと' }]);
  assert.equal(split.words[1].start, 1.5);
  assert.throws(() => applyReadings(row, [{ text: '雨', read: 'あめ' }]));
  assert.throws(() => applyReadings(row, [{ text: '雨音', read: 'wrong' }]));
});

test('lyric review keeps dictionary tags when it changes the word boundaries', () => {
  const [row] = songLyrics(song, {
    yrc: '[1000,1400](1000,300,0)花(1300,100,0)が(1400,350,0)咲い(1750,150,0)て(1900,300,0)い(2200,200,0)た',
    tlyric: '[00:01]花开着',
  }).sentences;
  const dictionary = alignTokens(row, [
    { text: '花', read: 'はな', pos: 'noun' }, { text: 'が', pos: 'particle' },
    { text: '咲いていた', read: 'さいていた', pos: 'verb', parts: [
      { text: '咲い', pos: 'verb' }, { text: 'て', pos: 'particle' },
      { text: 'い', pos: 'verb' }, { text: 'た', pos: 'aux' },
    ] },
  ], 'dictionary');
  const edited = applyReadings(dictionary, [
    { text: '花', read: 'はな', pos: 'verb' }, { text: 'が', read: '' },
    { text: '咲いて', read: 'さいて' }, { text: 'いた', read: '' },
  ]);
  assert.deepEqual(edited.words.map(({ text, pos, start, end }) => [text, pos, start, end]), [
    ['花', 'noun', 1, 1.3], ['が', 'particle', 1.3, 1.4], ['咲いて', 'verb', 1.4, 1.9], ['いた', 'verb', 1.9, 2.4],
  ]);
  assert.equal(edited.translation, row.translation);
});

test('opening older reviewed lyrics can restore tags from their original word ranges offline', () => {
  const data = songLyrics(song, { yrc: '[1000,1000](1000,550,0)二(1550,450,0)階', tlyric: '[00:01]二楼' });
  const original = data.sentences[0];
  const edited = applyReadings(original, [{ text: '二階', read: 'にかい' }]);
  const corrected = setSungReading(edited, sungReadingTargets(edited)[0], 'ふたかい');
  const saved = { ...corrected, sourceWords: [{ text: '二', pos: 'num' }, { text: '階', pos: 'suffix' }] };
  const updated = upgradeSongLyrics({ ...data, sourceAlignmentVersion: 6, sentences: [saved] });
  assert.deepEqual(updated.sentences, [{ ...saved, words: [{ ...corrected.words[0], pos: 'num' }] }]);
  assert.deepEqual(updated.posLegend.num, { label: '数词' });
  assert.equal(upgradeSongLyrics(updated), updated);
});

test('inline readings and grouped loanwords keep their source ranges and aligned romaji', () => {
  const raw = {
    yrc: '[1000,2000](1000,250,0)明(1250,250,0)日(1500,100,0)（(1600,100,0)あ(1700,100,0)し(1800,100,0)た(1900,100,0)）(2000,300,0)は(2300,200,0)キ(2500,100,0)ャ(2600,400,0)ット',
    lrc: '[00:00.5]明日はキャット', tlyric: '[00:00.5]明天', romalrc: '[00:00.5]a shi ta wa kya tto',
  };
  const [cue] = songLyrics(song, raw).sentences;
  assert.equal(cue.text, '明日はキャット');
  assert.equal(cue.sourceRoman, 'a shi ta wa kya tto');
  assert.equal(cue.translation, '明天');
  assert.deepEqual(cue.words, [
    { text: '明日', read: 'あした', roman: 'ashita', start: 1, end: 2 },
    { text: 'は', roman: 'wa', start: 2, end: 2.3 },
    { text: 'キャット', roman: 'kyatto', start: 2.3, end: 3 },
  ]);
  const fragments = [
    { text: 'キャ', roman: 'kya', start: 2.3, end: 2.6 },
    { text: 'ット', roman: 'tto', start: 2.6, end: 3 },
  ];
  assert.deepEqual(cue.sourceWords.slice(-2), fragments);
  const reviewed = applyReadings(cue, [
    { text: '明日', read: 'あした' }, { text: 'は', read: '' }, { text: 'キャ', read: '' }, { text: 'ット', read: '' },
  ]);
  assert.deepEqual(reviewed.words.slice(-2).map(({ text, start, end }) => ({ text, start, end })),
    fragments.map(({ text, start, end }) => ({ text, start, end })));
});

test('untimed lyrics retain Latin words and follow the supplied kana pronunciation', () => {
  const raw = { lrc: '[00:01]雨(あめ)へ flavor', romalrc: '[00:01]ame e flavor' };
  const [cue] = songLyrics(song, raw).sentences;
  assert.equal(cue.text, '雨へ flavor');
  assert.equal(cue.wordTiming, false);
  assert.deepEqual(cue.words.filter(w => w.pos !== 'punct'), [
    { text: '雨', read: 'あめ', roman: 'ame' }, { text: 'へ', roman: 'e' }, { text: 'flavor' },
  ]);
  assert.equal(songLyrics(song, { lrc: '[00:01]雨（chorus）' }).sentences[0].text, '雨（chorus）');
});

test('untimed kana use lexical boundaries without merging adjacent loanwords', () => {
  const [line, next] = songLyrics(song, {
    lrc: '[00:01]ヒッチコックとサスペンスドラマ\n[00:04]どこかドラマチックに',
    romalrc: '[00:01]hi t chi ko k ku to sa su pe n su do ra ma\n[00:04]do ko ka do ra ma chi k ku ni',
    tlyric: '[00:01]悬疑剧',
  }).sentences;
  assert.deepEqual(line.words, [
    { text: 'ヒッチコック', roman: 'hitchikokku' }, { text: 'と', roman: 'to' },
    { text: 'サスペンス', roman: 'sasupensu' }, { text: 'ドラマ', roman: 'dorama' },
  ]);
  assert.deepEqual(next.words.map(({ text, roman }) => [text, roman]), [
    ['どこか', 'dokoka'], ['ドラマチック', 'doramachikku'], ['に', 'ni'],
  ]);
  assert.equal(line.translation, '悬疑剧');
  assert.equal(line.wordTiming, false);
});

test('timed loanwords keep provider fragments when a lexical boundary has no timestamp', () => {
  const [row] = songLyrics(song, {
    yrc: '[1000,1200](1000,220,0)サス(1220,620,0)ペンスド(1840,360,0)ラマ',
  }).sentences;
  assert.deepEqual(row.words.map(({ text, start, end }) => [text, start, end]), [
    ['サス', 1, 1.22], ['ペンスド', 1.22, 1.84], ['ラマ', 1.84, 2.2],
  ]);
  assert.equal(row.sourceWords, undefined);
});

test('cached raw lines gain whole words while reviewed boundaries stay authoritative', () => {
  const data = songLyrics(song, { lrc: '[00:01]サスペンス\n[00:03]トマト', tlyric: '[00:01]悬疑' });
  const [one, two] = data.sentences;
  const { sourceWords, ...row } = one;
  const raw = { ...row, words: sourceWords };
  const reviewed = { ...two, annotation: 'review', words: two.sourceWords };
  const old = { ...data, sourceAlignmentVersion: 7, sentences: [raw, reviewed] };
  const migrated = upgradeSongLyrics(old);
  assert.deepEqual(migrated.sentences[0], one);
  assert.equal(migrated.sentences[1], reviewed);
  assert.equal(upgradeSongLyrics(migrated), migrated);
});

test('digits in timed Japanese lyrics receive kana and roman without changing their ranges or translations', () => {
  const data = songLyrics(song, {
    yrc: '[1000,1000](1000,350,0)また(1350,250,0)1(1600,400,0)から\n[3000,1000](3000,300,0)０(3300,700,0)から',
    romalrc: '[00:03]ze ro ka ra', tlyric: '[00:01]再从一开始\n[00:03]从零开始',
  });
  const [one, zero] = data.sentences;
  assert.deepEqual([one.text, one.translation, one.wordTiming], ['また1から', '再从一开始', true]);
  assert.deepEqual(one.words[1], { text: '1', start: 1.35, end: 1.6, read: 'いち', pron: 'いち', roman: 'ichi' });
  assert.deepEqual(zero.words[0], { text: '０', start: 3, end: 3.3, read: 'ぜろ', pron: 'ぜろ', roman: 'zero' });
  assert.equal(zero.sourceRoman, 'ze ro ka ra');
});

test('numeric readings use source evidence, or regular Japanese numbers when the context allows it', () => {
  const rows = songLyrics(song, {
    lrc: '[00:01]0から\n[00:02]１（ワン）から\n[00:03]３００から\n[00:04]また3.14\n[00:05]Love 4 U\n[00:06]１人で\n[00:07]1から\n[00:08]A1の歌\n[00:09]走过1座山\n[00:10]1から',
    romalrc: '[00:01]reikara\n[00:02]ichikara\n[00:07]one kara\n[00:10]wa n ka ra',
  }).sentences;
  const labels = word => [word.read || '', word.roman || ''];
  assert.deepEqual(labels(rows[0].words[0]), ['れい', 'rei']);
  assert.equal(rows[1].text, '１から');
  assert.deepEqual(labels(rows[1].words[0]), ['ワン', 'wan']);
  assert.deepEqual(labels(rows[2].words[0]), ['さんびゃく', 'sanbyaku']);
  assert.deepEqual(labels(rows[3].words.at(-1)), ['さんてんいちよん', 'santenichiyon']);
  for (const index of [4, 5, 6, 7, 8]) {
    assert.deepEqual(labels(rows[index].words.find(word => /[0-9０-９]/u.test(word.text))), ['', '']);
  }
  assert.deepEqual(labels(rows[9].words[0]), ['わん', 'wan']);
});

test('a timed Latin identifier or one digit of a split number is not given an isolated reading', () => {
  const [row] = songLyrics(song, {
    yrc: '[1000,2000](1000,500,0)型番(1500,250,0)A(1750,250,0)1(2000,200,0)を(2200,250,0)1(2450,250,0)2(2700,300,0)から',
  }).sentences;
  assert.deepEqual(row.words.filter(word => /^[0-9]$/u.test(word.text)).map(word => word.read), [undefined, undefined, undefined]);
});

test('dictionary passes keep a complete written number and preserve reliable quantity and numeric readings', () => {
  const [number, count] = songLyrics(song, {
    yrc: '[1000,1200](1000,500,0)12(1500,700,0)から\n[3000,1000](3000,400,0)１人(3400,600,0)で',
  }).sentences;
  const annotated = alignTokens(number, [{ text: '1' }, { text: '2' }, { text: 'から' }], 'dictionary');
  assert.deepEqual(annotated.words[0], { text: '12', read: 'じゅうに', pron: 'じゅうに', roman: 'juuni', start: 1, end: 1.5 });
  const counted = alignTokens(count, [{ text: '１人', read: 'ひとり', roman: 'hitori' }, { text: 'で' }], 'dictionary');
  assert.deepEqual(counted.words[0], { text: '１人', read: 'ひとり', roman: 'hitori', start: 3, end: 3.4 });
});

test('legacy cached lyrics get only missing numeric labels and retain confirmed readings across edits', () => {
  const fresh = songLyrics(song, {
    yrc: '[1000,1000](1000,300,0)空(1300,250,0)0(1550,450,0)から',
    tlyric: '[00:01]从零开始',
  });
  const original = fresh.sentences[0];
  const [sky, zero, rest] = original.words;
  const confirmedSky = setSungReading(original, sungReadingTargets(original)[0], 'そら').words[0];
  const legacy = { ...original, annotation: 'review', words: [confirmedSky,
    { text: zero.text, start: zero.start, end: zero.end }, rest] };
  const old = { ...fresh, sourceAlignmentVersion: 5, sentences: [legacy] };
  const updated = upgradeSongLyrics(old);
  const [row] = updated.sentences;
  assert.deepEqual(row, { ...legacy, words: [confirmedSky, zero, rest] });
  assert.equal(row.words[0], confirmedSky);
  assert.equal(upgradeSongLyrics(updated), updated);
  assert.equal(legacy.words[1].read, undefined);

  const target = sungReadingTargets(row).find(word => word.text === '0');
  const corrected = setSungReading(row, target, 'レイ');
  const edits = [{ text: sky.text, read: 'そら' }, { text: '0', read: 'まる' }, { text: rest.text, read: '' }];
  const reviewed = applyReadings(corrected, edits, 'review');
  assert.deepEqual([reviewed.words[1].read, reviewed.words[1].roman, reviewed.words[1].start, reviewed.words[1].end],
    ['れい', 'rei', 1.3, 1.55]);
  assert.equal(setSungReading(reviewed, target, null).words[1].roman, 'maru');
});

test('dictionary segmentation preserves the sung reading and syllable alignment', () => {
  const raw = {
    yrc: '[1000,700](1000,100,0)最(1100,100,0)后(1200,200,0)（さいご）(1400,100,0)キ(1500,200,0)ス',
    yromalrc: '[00:01]sa i go ki su',
  };
  const [cue] = songLyrics(song, raw).sentences;
  const dict = [{ text: '最后', read: 'さいこう', roman: 'saikou' }, { text: 'キス', roman: 'kisu' }];
  const result = alignTokens(cue, dict, 'dictionary');
  assert.deepEqual(result.words[0], { text: '最后', read: 'さいご', pron: 'さいご', roman: 'saigo', start: 1, end: 1.4 });
  assert.deepEqual(result.words[1].lyricParts.map(({ text, roman }) => [text, roman]), [['キ', 'ki'], ['ス', 'su']]);
  const split = alignTokens(result, [{ text: '最' }, { text: '后' }, dict[1]], 'dictionary');
  assert.equal(split.words[0].text, '最后');
  assert.equal(split.words[0].read, 'さいご');
  assert.equal(split.words[0].end, 1.4);
});

test('saved UniDic-lite readings use surface inflections and ruby over the kanji', () => {
  const w = { text: '会えぬなら', read: 'あえるぬだ', roman: 'aenunara', start: 1, end: 2, lemma: '会える', parts: [
    { text: '会え', read: 'あえる', roman: 'ae' }, { text: 'ぬ', roman: 'nu' }, { text: 'なら', roman: 'nara' },
  ] };
  const came = { text: '来て', read: 'くるて', roman: 'kite', parts: [
    { text: '来', read: 'くる', roman: 'ki', lemma: '来る', conj: '連用形' }, { text: 'て', roman: 'te' },
  ] };
  const saved = { annotation: 'dictionary', text: w.text, start: 1, end: 2, wordTiming: true,
    sourceRoman: 'a e nu na ra', translation: '如果不能相见的话', words: [w] };
  const ai = { ...saved, annotation: 'ai' };
  const data = { sourceLyrics: {}, sourceAlignmentVersion: 3, sentences: [
    saved, { annotation: 'dictionary', text: came.text, words: [came] }, ai,
  ] };
  const updated = upgradeSongLyrics(data);
  const [first, second, manual] = updated.sentences;
  assert.equal(first.translation, saved.translation);
  assert.equal(first.sourceRoman, saved.sourceRoman);
  assert.deepEqual(first.words[0], { ...w, read: 'あえぬなら',
    parts: [{ ...w.parts[0], read: 'あえ' }, ...w.parts.slice(1)],
    lyricParts: [{ text: '会', read: 'あ', roman: 'a' }, { text: 'えぬなら', roman: 'enunara' }],
  });
  assert.equal(second.words[0].read, 'きて');
  assert.equal(second.words[0].parts[0].read, 'き');
  assert.equal(manual, ai);
  assert.equal(saved.words[0].read, 'あえるぬだ');
  assert.equal(upgradeSongLyrics(updated), updated);
});

test('only an unambiguous source reading between aligned words can override a dictionary reading', () => {
  const words = [
    { text: '君', read: 'きみ', roman: 'kimi' }, { text: 'の', roman: 'no' },
    { text: '側', read: 'がわ', roman: 'gawa' }, { text: 'で', roman: 'de' },
  ];
  const raw = { lrc: '[00:01]君の側で', romalrc: '[00:01]ki mi no so ba de' };
  const [cue] = songLyrics(song, raw).sentences;
  const { words: corrected } = alignTokens(cue, words, 'dictionary');
  assert.deepEqual(corrected[2], { text: '側', read: 'そば', roman: 'soba', pron: 'そば' });
  const unclear = alignTokens({ ...cue, sourceRoman: 'ki mi no o de' }, words, 'dictionary');
  assert.equal(unclear.words[2].read, 'がわ');
  const [atEnd] = songLyrics(song, { lrc: '[00:01]君の側', romalrc: '[00:01]ki mi no so ba' }).sentences;
  const unbounded = alignTokens(atEnd, words.slice(0, 3), 'dictionary');
  assert.equal(unbounded.words[2].read, 'がわ');
});

test('the indefinite pronoun 何か matches the source syllables without rewriting counters or explicit readings', () => {
  const dict = [{ text: '何', read: 'なん', roman: 'nan' }, { text: 'か', roman: 'ka' },
    { text: 'を', roman: 'o' }, { text: '探す', read: 'さがす', roman: 'sagasu' }];
  const raw = { yrc: '[1000,1600](1000,400,0)何(1400,100,0)か(1500,100,0)を(1600,1000,0)探す',
    romalrc: '[00:01]na ni ka wo sa ga su', tlyric: '[00:01]找点什么' };
  const data = songLyrics(song, raw);
  const [cue] = data.sentences;
  const aligned = alignTokens(cue, dict, 'dictionary');
  assert.deepEqual(aligned.words[0], { text: '何', read: 'なに', pron: 'なに', roman: 'nani', start: 1, end: 1.4 });
  assert.equal(aligned.words[1].start, 1.4);
  assert.equal(aligned.sourceRoman, cue.sourceRoman);
  assert.equal(aligned.translation, '找点什么');

  const fused = alignTokens(cue, [{ text: '何か', read: 'なんか', roman: 'nanka' }, ...dict.slice(2)], 'dictionary');
  assert.deepEqual(fused.words[0].lyricParts, [{ text: '何', read: 'なに', roman: 'nani' }, { text: 'か', roman: 'ka' }]);
  assert.deepEqual([fused.words[0].start, fused.words[0].end], [1, 1.5]);

  const noSource = alignTokens({ ...cue, sourceRoman: '' }, dict, 'dictionary');
  assert.equal(noSource.words[0].read, 'なに');
  const abbreviated = alignTokens({ ...cue, sourceRoman: 'na n ka wo sa ga su' }, dict, 'dictionary');
  assert.equal(abbreviated.words[0].read, 'なん');
  const [explicit] = songLyrics(song, { lrc: '[00:01]何（なん）かを探す', romalrc: raw.romalrc }).sentences;
  assert.equal(alignTokens(explicit, dict, 'dictionary').words[0].read, 'なん');
  const [counter] = songLyrics(song, { lrc: '[00:01]何か月' }).sentences;
  assert.equal(alignTokens(counter, [dict[0], dict[1], { text: '月', read: 'げつ' }], 'dictionary').words[0].read, 'なん');

  const oldCue = { ...aligned, words: [{ ...cue.words[0], ...dict[0] }, ...aligned.words.slice(1)] };
  const upgraded = upgradeSongLyrics({ ...data, sourceAlignmentVersion: 4, sentences: [oldCue] });
  assert.deepEqual(upgraded.sentences[0].words, aligned.words);
  const local = setSungReading(oldCue, sungReadingTargets(oldCue)[0], 'なん');
  const confirmed = upgradeSongLyrics({ ...data, sourceAlignmentVersion: 4, sentences: [local] });
  assert.equal(confirmed.sentences[0].words[0].read, 'なん');
});

test('local sung reading spans split characters and changes one occurrence only', () => {
  const raw = { yrc: '[1000,1900](1000,100,0)幸(1100,400,0)福(1500,300,0)な(1800,200,0)幸(2000,900,0)福',
    romalrc: '[00:01]ko u fu ku na ko u fu ku', tlyric: '[00:01]幸福' };
  const [cue] = songLyrics(song, raw).sentences;
  const [target, repeated] = sungReadingTargets(cue);
  assert.deepEqual([target.text, target.from, repeated.text, repeated.from], ['幸福', 0, '幸福', 3]);
  const edited = setSungReading(cue, target, ' ｼｱﾜｾ ');
  assert.deepEqual([edited.words[0].text, edited.words[0].read, edited.words[0].roman], ['幸福', 'しあわせ', 'shiawase']);
  assert.deepEqual([edited.words[0].start, edited.words[0].end], [1, 1.5]);
  assert.deepEqual(edited.words.slice(1), cue.words.slice(2));
  assert.equal(edited.sourceRoman, cue.sourceRoman);
  assert.equal(edited.translation, cue.translation);
  assert.equal(edited.wordTiming, true);
  assert.deepEqual(setSungReading(edited, target, null).words, cue.words);
  assert.throws(() => setSungReading(cue, target, 'shiawase'), /平假名/);
  assert.throws(() => setSungReading(cue, { ...target, from: 1 }, 'しあわせ'), /重新选择词语/);
});

test('dictionary and AI passes retain a verified sung reading and restore the updated automatic one', () => {
  const [cue] = songLyrics(song, { yrc: '[1000,900](1000,400,0)幸(1400,200,0)福(1600,300,0)な',
    romalrc: '[00:01]ko u fu ku na' }).sentences;
  const [target] = sungReadingTargets(cue);
  const edited = setSungReading(cue, target, 'しあわせ');
  const tokens = [{ text: '幸福', read: 'こうふく', roman: 'koufuku', pos: 'noun' }, { text: 'な', read: '' }];
  const dictionary = alignTokens(edited, tokens, 'dictionary');
  const ai = applyReadings(edited, tokens.map(({ text, read }) => ({ text, read })));
  for (const updated of [dictionary, ai]) {
    assert.equal(updated.words[0].read, 'しあわせ');
    assert.equal(updated.words[0].roman, 'shiawase');
    assert.equal(updated.words[0].end, 1.6);
    assert.equal(setSungReading(updated, target, null).words[0].roman, 'koufuku');
  }
  const crossed = alignTokens(edited, [{ text: '幸福な', read: 'こうふくな', roman: 'koufukuna' }], 'dictionary');
  assert.deepEqual(crossed.words, edited.words);
});

test('saved provider rows upgrade in place without replacing edits or calibrated words', () => {
  const authored = { text: '私の字幕', start: 3, end: 5, words: [{ text: '私の字幕' }], translation: '自訂' };
  const calibrated = { text: '世界', start: 5, end: 8, annotation: 'ai', words: [{ text: '世界', read: 'せかい', roman: 'sekai' }] };
  const raw = { lrc: '[00:01]雨（あめ）\n[00:03]空\n[00:05]世界', romalrc: '[00:01]a me', tlyric: '[00:01]雨天' };
  const original = { sourceAlignmentVersion: 1, sourceLyrics: raw, sentences: [
    { text: '雨（あめ）', start: 1, end: 3, words: [{ text: '雨（あめ）' }], translations: { 'zh-CN': '' } },
    authored, calibrated,
  ] };
  const updated = upgradeSongLyrics(original);
  assert.equal(updated.sentences[0].text, '雨');
  assert.equal(updated.sentences[0].words[0].read, 'あめ');
  assert.equal(updated.sentences[0].words[0].roman, 'ame');
  assert.equal(updated.sentences[0].translation, undefined);
  assert.equal(updated.sentences[0].translations['zh-CN'], '');
  assert.equal(updated.sentences[1], authored);
  assert.deepEqual(updated.sentences[2].words, calibrated.words);
  assert.equal(updated.sentences[2].annotation, 'ai');
  assert.equal(original.sentences[0].text, '雨（あめ）');
  assert.equal(upgradeSongLyrics(updated), updated);
});

test('the verified second chorus uses the same timings on import and in annotated saved lyrics', () => {
  const names = ['空', '風', '雲', '雨', '光'];
  const reference = [6400, 7960, 9970, 13240, 14620, 21380];
  const issue = [56170, 60880, 82720, 83760, 85540, 92590];
  const yrc = [reference, issue].flatMap(times => names.map((text, i) => {
    const start = times[i], end = times[i + 1], wordEnd = start + 600;
    return `[${start},${end - start}](${start},600,0)${text}(${wordEnd},${end - wordEnd},0) `;
  })).join('\n');
  const raw = { yrc, ytlrc: '[01:25.54]光亮', yromalrc: '[01:25.54]hi ka ri' };
  const release = { id: 2025482215, name: '試聴', duration: 127.56 };
  const fresh = songLyrics(release, raw);
  assert.deepEqual(fresh.sentences.slice(5).map(s => s.start), [56.178, 57.738, 59.748, 63.018, 64.398]);
  const last = fresh.sentences.at(-1);
  assert.equal(last.end, 64.998);
  assert.equal(last.translation, '光亮');
  assert.equal(last.sourceRoman, 'hi ka ri');
  assert.equal(last.words[1].start, undefined);
  assert.equal(fresh.sourceLyrics, raw);

  const uncorrected = songLyrics({ ...release, id: 9 }, raw);
  const saved = { ...uncorrected, id: fresh.id, sourceAlignmentVersion: 2 };
  const analyzed = alignTokens(saved.sentences.at(-1), [{ text: '光', read: 'ひかり', pos: 'noun' }, { text: ' ' }], 'dictionary');
  saved.sentences[9] = { ...analyzed, translation: '我的翻译' };
  const upgraded = upgradeSongLyrics(saved);
  assert.equal(upgraded.sentences[0], saved.sentences[0]);
  assert.equal(upgraded.sentences[9].annotation, 'dictionary');
  assert.equal(upgraded.sentences[9].translation, '我的翻译');
  assert.equal(upgraded.sentences[9].sourceWords[0].start, last.start);
  assert.deepEqual(upgraded.sentences[9].words[0], { ...analyzed.words[0], start: last.start, end: last.end });
  assert.equal(saved.sentences[9].start, 85.54);
  assert.equal(upgradeSongLyrics(upgraded), upgraded);
  const edited = saved.sentences.map((s, i) => i === 7 ? { ...s, end: 83 } : s);
  assert.deepEqual(upgradeSongLyrics({ ...saved, sentences: edited }).sentences, edited);
  const changed = { ...raw, yrc: raw.yrc.replace('[82720,', '[82721,') };
  assert.equal(songLyrics(release, changed).sentences.at(-1).start, 85.54);
});

test('a timed space from older annotations cannot become the active word', () => {
  const words = [{ text: '愛', start: 1, end: 2 }, { text: '　', start: 2, end: 8 }, { text: '愛', start: 8, end: 9 }];
  const track = Track.fromData({ hasWordTiming: true, sentences: [{ start: 1, end: 9, wordTiming: true, words }] });
  assert.deepEqual([...track.wStart], [1, 8]);
  assert.deepEqual([...track.wIdx], [0, 2]);
  const annotated = alignTokens({ words }, [{ text: '愛' }, { text: '　' }, { text: '愛' }], 'dictionary');
  assert.deepEqual(annotated.words[1], { text: '　', pos: 'punct' });
});
