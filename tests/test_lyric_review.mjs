import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../web/js/config.js';
import { setSungReading, songLyrics, sungReadingTargets } from '../web/js/music-lyrics.js';
import { createFakeIndexedDB } from './idb_fake.mjs';

globalThis.indexedDB = createFakeIndexedDB();
globalThis.addEventListener = () => {};
globalThis.document = Object.assign(new EventTarget(), { hidden: false });
const { get, writeBatch } = await import('../web/js/store.js');
const { annotateLyricDictionary, backfillLyricPos, lyricReviewPackage, lyricReviewTrack, parseLyricReview,
  reviewLyricsWithModel, saveLyricReview } = await import('../web/js/lyric-review.js');

async function seed(id) {
  const data = songLyrics({ id, name: '校对测试', duration: 8 }, {
    yrc: '[1000,1100](1000,500,0)幸福(1500,100,0) (1600,500,0)な\n[3000,900](3000,250,0)会(3250,650,0)える',
    tlyric: '[00:01]幸福的\n[00:03]能够见面', romalrc: '[00:01]ko u fu ku na',
  });
  const row = data.sentences[0];
  data.sentences[0] = setSungReading(row, sungReadingTargets(row)[0], 'しあわせ');
  await writeBatch({ data: [{ key: data.id, value: data }] });
  return data;
}

const happy = [{ text: '幸福', read: 'こうふく' }, { text: ' ', read: '' }, { text: 'な', read: '' }];
const meet = [{ text: '会える', read: 'あえる' }];

test('a portable review can be edited and reimported without changing timing, translations, or confirmed readings', async () => {
  const data = await seed(1);
  const track = lyricReviewTrack(data.id, data);
  const draft = lyricReviewPackage([track]);
  assert.deepEqual(parseLyricReview(draft), []);
  assert.equal(Object.hasOwn(track, 'sourceLyrics'), false);
  assert.deepEqual(track.lines[0].tokens[0], { text: '幸福', read: 'しあわせ', roman: 'shiawase', confirmed: true });
  track.lines[0].reviewedTokens = happy;
  track.lines[1].reviewedTokens = meet;
  const [review] = parseLyricReview(JSON.parse(JSON.stringify(draft)));
  assert.equal(await saveLyricReview(review.id, review.lines), 2);
  assert.equal(await saveLyricReview(review.id, review.lines), 0);
  const result = await get('data', data.id);
  assert.equal(result.sentences[0].words[0].read, 'しあわせ');
  assert.equal(result.sentences[0].words[0].roman, 'shiawase');
  assert.equal(result.sentences[0].sourceRoman, data.sentences[0].sourceRoman);
  const row = result.sentences[1];
  assert.equal(row.translation, '能够见面');
  assert.deepEqual(row.words.map(({ start, end }) => [start, end]), [[3, 3.9]]);
  assert.deepEqual(row.words[0].lyricParts, [{ text: '会', read: 'あ', roman: 'a' }, { text: 'える', roman: 'eru' }]);
  assert.equal(row.annotation, 'review');
});

test('corrupt or stale review data is rejected before it can overwrite any row in the song', async () => {
  const data = await seed(2);
  const track = lyricReviewTrack(data.id, data);
  track.lines[0].reviewedTokens = happy;
  track.lines[1].reviewedTokens = [{ text: '会う', read: 'あう' }];
  const draft = lyricReviewPackage([track]);
  assert.throws(() => parseLyricReview(draft), /第 2 行/);
  track.lines[1].reviewedTokens = meet;
  track.lines[1].startMs++;
  const [review] = parseLyricReview(draft);
  await assert.rejects(saveLyricReview(review.id, review.lines), /时间轴已更新/);
  const unchanged = await get('data', data.id);
  assert.deepEqual(unchanged.sentences, data.sentences);
});

test('dictionary batches skip checked reviews and preserve the source spacing', async t => {
  const data = await seed(3);
  data.sentences[1].annotation = 'review';
  data.sentences[1].lyricPosChecked = true;
  await writeBatch({ data: [{ key: data.id, value: data }] });
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    const { segments } = JSON.parse(await body.text());
    assert.deepEqual(segments.map(row => row.text), ['幸福 な']);
    return Response.json({ track: { sentences: [{ text: '幸福 な', words: [
      { text: '幸福', read: 'こうふく', pos: 'noun' }, { text: 'な', pos: 'particle' },
    ] }] } });
  });
  assert.equal(await annotateLyricDictionary(data.id, data, { missingOnly: true }), 1);
  const result = await get('data', data.id);
  assert.equal(result.sentences[0].words.map(w => w.text).join(''), '幸福 な');
  assert.equal(result.sentences[0].words[0].read, 'しあわせ');
  assert.deepEqual(result.sentences[1], data.sentences[1]);
  assert.equal(await annotateLyricDictionary(data.id, result, { missingOnly: true }), 0);
  assert.equal(fetch.mock.callCount(), 1);
});

test('automatic dictionary backfill saves only missing tags and does not rerun for the same review', async t => {
  const data = await seed(19);
  const row = data.sentences[0];
  row.annotation = 'ai';
  await writeBatch({ data: [{ key: data.id, value: data }] });
  const base = 'http://127.0.0.1:13876';
  const fetch = t.mock.method(globalThis, 'fetch', async (url, { body }) => {
    assert.ok(url.startsWith(base + '/api/analyze?'));
    const { segments } = JSON.parse(await body.text());
    assert.deepEqual(segments.map(item => item.text), [row.text]);
    return Response.json({ track: { sentences: [{ text: row.text, words: [
      { text: '幸福', read: 'こうふく', pos: 'noun' }, { text: 'な', pos: 'aux' },
    ] }] } });
  });
  const result = await backfillLyricPos(data.id, data, { base });
  const [one, space, two] = row.words;
  assert.deepEqual(result.sentences, [{ ...row, lyricPosChecked: true, words: [
    { ...one, pos: 'noun' }, space, { ...two, pos: 'aux' },
  ] }, data.sentences[1]]);
  assert.equal(result.posLegend.aux.label, '助动词');
  const [repaired] = result.sentences;
  assert.equal(setSungReading(repaired, sungReadingTargets(repaired)[0], null).words[0].pos, 'noun');
  assert.deepEqual(await get('data', data.id), result);
  assert.equal(await backfillLyricPos(data.id, result, { base }), null);
  assert.equal(fetch.mock.callCount(), 1);
});

test('the configured model reviews in batches, validates results, and leaves saved reviews alone on retry', async t => {
  const data = await seed(4);
  const progress = [];
  const previous = { ...config };
  t.after(() => Object.assign(config, previous));
  Object.assign(config, { baseUrl: '', model: 'example', batchSize: 1 });
  const fetch = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url, 'https://model.example/v1/chat/completions');
    const request = JSON.parse(init.body);
    assert.equal(request.model, 'example');
    const [line] = JSON.parse(request.messages[1].content).lines;
    assert.match(request.messages[0].content, /词性.+pos/u);
    const reviewedTokens = line.index === 0
      ? happy.map((word, i) => ({ ...word, pos: ['noun', 'noun', '粒子 is-cur'][i] }))
      : [{ ...meet[0], pos: 'VERB' }];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ lines: [{ index: line.index, reviewedTokens }] }) } }] });
  });
  await assert.rejects(reviewLyricsWithModel(data.id, data), /设置 → AI 助学/);
  assert.equal(fetch.mock.callCount(), 0);
  config.baseUrl = 'https://model.example/v1';
  assert.equal(await reviewLyricsWithModel(data.id, data, { onProgress: (...part) => progress.push(part) }), 2);
  assert.deepEqual(progress, [[1, 2], [2, 2]]);
  const result = await get('data', data.id);
  assert.equal(result.sentences[0].words[0].read, 'しあわせ');
  assert.deepEqual(result.sentences[0].words.map(word => word.pos), ['noun', 'punct', undefined]);
  assert.equal(result.sentences[1].words[0].pos, 'verb');
  assert.equal(result.posLegend.verb.label, '动词');
  assert.equal(result.sentences[1].words[0].read, 'あえる');
  assert.equal(await reviewLyricsWithModel(data.id, result), 0);
  assert.equal(fetch.mock.callCount(), 2);
});

test('whole-song review reconciles harmless formatting and retries just invalid lyric rows', async t => {
  const data = songLyrics({ id: 6, name: '校对格式', duration: 6 }, {
    lrc: '[00:01]幸福　Ａ！\n[00:02]花が咲く\n[00:03]月を見る\n[00:04]夢を追う',
    tlyric: '[00:01]幸福', romalrc: '[00:01]ko u fu ku A',
  });
  data.sentences[0] = setSungReading(data.sentences[0], sungReadingTargets(data.sentences[0])[0], 'しあわせ');
  data.sentences[3].annotation = 'review';
  await writeBatch({ data: [{ key: data.id, value: data }] });
  const previous = { ...config }, requests = [], progress = [];
  let issues;
  t.after(() => Object.assign(config, previous));
  Object.assign(config, { baseUrl: 'https://model.example/v1', model: 'example', batchSize: 8 });
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(JSON.parse(request.messages[1].content).lines.map(line => line.index));
    const changed = { index: 1, reviewedTokens: [{ text: '花が散る', read: 'はながちる' }] };
    const invalid = { index: 2, reviewedTokens: [{ text: '月を見る', read: 'tsuki' }] };
    const lines = requests.length === 1
      ? [{ index: '0', reviewedTokens: [{ text: '幸福', read: 'コウ フク' }, { text: 'A!', read: 'A' }] }, changed, invalid]
      : [{ index: 1, reviewedTokens: [{ text: '花', read: 'ﾊﾅ' }, { text: 'が', read: null }, { text: '咲く', read: 'さく' }] }, invalid];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ lines }) } }] });
  });
  assert.equal(await reviewLyricsWithModel(data.id, data, {
    onProgress: (...part) => progress.push(part), onUnverified: result => { issues = result; },
  }), 2);
  assert.deepEqual(requests, [[0, 1, 2], [1, 2]]);
  assert.deepEqual(progress, [[1, 1], [1, 1, true]]);
  assert.deepEqual(issues.map(issue => issue.index), [2]);
  const { sentences } = await get('data', data.id);
  assert.equal(sentences[0].words.map(word => word.text).join(''), '幸福　Ａ！');
  assert.equal(sentences[0].words[0].read, 'しあわせ');
  assert.equal(sentences[0].translation, '幸福');
  assert.equal(sentences[0].sourceRoman, data.sentences[0].sourceRoman);
  assert.equal(sentences[1].words[0].read, 'はな');
  assert.deepEqual(sentences.slice(2), data.sentences.slice(2));
});

test('a failed format retry still commits the model edits that passed validation', async t => {
  const data = await seed(7);
  const previous = { ...config };
  let issues, attempts = 0;
  t.after(() => Object.assign(config, previous));
  Object.assign(config, { baseUrl: 'https://model.example/v1', model: 'example', batchSize: 8 });
  t.mock.method(globalThis, 'fetch', async () => {
    const response = attempts++ ? {} : { lines: [
      { index: 0, reviewedTokens: happy }, { index: 1, reviewedTokens: [{ text: '会う', read: 'あう' }] },
    ] };
    return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] });
  });
  assert.equal(await reviewLyricsWithModel(data.id, data, { onUnverified: rows => { issues = rows; } }), 1);
  assert.equal(attempts, 2);
  assert.deepEqual(issues.map(issue => issue.index), [1]);
  const saved = await get('data', data.id);
  assert.equal(saved.sentences[0].annotation, 'ai');
  assert.deepEqual(saved.sentences[1], data.sentences[1]);
});

test('model review accepts sung numbers and quantity words while retaining fullwidth lyric text', async t => {
  const data = songLyrics({ id: 18, name: '数の確認', duration: 7 }, {
    yrc: '[1000,1200](1000,400,0)０(1400,800,0)から\n[3000,1000](3000,500,0)２つ(3500,500,0)だけ',
  });
  await writeBatch({ data: [{ key: data.id, value: data }] });
  const previous = { ...config };
  t.after(() => Object.assign(config, previous));
  Object.assign(config, { baseUrl: 'https://model.example/v1', model: 'example', batchSize: 8 });
  const lines = [
    { index: 0, reviewedTokens: [{ text: '0', read: 'レイ' }, { text: 'から', read: '' }] },
    { index: 1, reviewedTokens: [{ text: '2つ', read: 'ふたつ' }, { text: 'だけ', read: '' }] },
  ];
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ choices: [{ message: { content: JSON.stringify({ lines }) } }] }));
  assert.equal(await reviewLyricsWithModel(data.id, data), 2);
  const saved = await get('data', data.id);
  assert.deepEqual(saved.sentences.map(row => row.words[0]).map(({ text, read, roman, start, end }) =>
    [text, read, roman, start, end]), [['０', 'れい', 'rei', 1, 1.4], ['２つ', 'ふたつ', 'futatsu', 3, 3.5]]);
});

test('single-line review gets nearby context and separate source ruby, while writes stay scoped to the target', async t => {
  const data = songLyrics({ id: 5, name: '校对范围', duration: 6 }, {
    lrc: '[00:01]迷っている\n[00:02]何（なに）かを探す\n[00:03]まだ分からない\n[00:04]歩き出す',
    romalrc: '[00:02]na ni ka wo sa ga su',
  });
  await writeBatch({ data: [{ key: data.id, value: data }] });
  const previous = { ...config };
  t.after(() => Object.assign(config, previous));
  Object.assign(config, { baseUrl: 'https://model.example/v1', model: 'example', ctxBefore: 1, ctxAfter: 1,
    prompts: { ...config.prompts, lyricReading: '仅按可靠的日语语境校对' } });

  let lines = [{ index: 0, reviewedTokens: [{ text: '迷っている', read: 'まよっている' }] }];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    const [system, user] = JSON.parse(init.body).messages;
    assert.match(system.content, /仅按可靠的日语语境校对/);
    assert.match(system.content, /只校对 lines 中的 index/);
    const request = JSON.parse(user.content);
    assert.deepEqual(request.context.map(({ index }) => index), [0, 2]);
    assert.deepEqual(request.lines.map(({ index }) => index), [1]);
    assert.deepEqual(request.lines[0].sourceReadings, [{ from: 0, text: '何', read: 'なに' }]);
    assert.equal(request.lines[0].sourceRoman, 'na ni ka wo sa ga su');
    return Response.json({ choices: [{ message: { content: JSON.stringify({ lines }) } }] });
  });
  await assert.rejects(reviewLyricsWithModel(data.id, data, { index: 1 }), /无效或重复/);
  lines = [{ index: 1, reviewedTokens: [{ text: '何かを探す', read: '' }] }];
  await assert.rejects(reviewLyricsWithModel(data.id, data, { index: 1 }), /假名标注不完整/);
  lines = [];
  assert.equal(await reviewLyricsWithModel(data.id, data, { index: 1 }), 0);
  assert.deepEqual((await get('data', data.id)).sentences, data.sentences);
});
