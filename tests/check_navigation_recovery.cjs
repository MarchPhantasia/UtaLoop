/** Run against an isolated UtaLoop web server: node tests/check_navigation_recovery.cjs [playwright-module] [base-url] */
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:13876';
const origin = new URL(base).origin;
const library = base + '/music.html#learning';
const id = 'netease-99110001';
const deferred = () => {
  let release;
  const promise = new Promise(resolve => { release = resolve; });
  return { promise, release };
};

async function setup(browser, callbacks = {}) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 780 }, reducedMotion: 'reduce' });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.abort();
    if (!url.pathname.startsWith('/music/')) return route.continue();
    const action = url.pathname.split('/').at(-1);
    const reply = await callbacks[action]?.(route.request());
    if (reply) return route.fulfill(reply).catch(() => {});
    const data = action === 'retention' ? 'long' : action === 'account' ? { uid: 1, name: '测试账号' }
      : action === 'lyrics' ? { lrc: '[00:00.00]練習\n[00:08.00]歌う' } : null;
    await route.fulfill({ json: { data } }).catch(() => {});
  });
  const page = await context.newPage();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, errors };
}

async function seed(page, { ready = true, count = 1 } = {}) {
  await page.evaluate(async ({ id, ready, count }) => {
    const { put } = await import('/js/store.js');
    for (let i = 0; i < count; i++) {
      const musicId = Number(id.slice(8)) + i;
      const track = 'netease-' + musicId;
      await put('study', track, { track, id: String(musicId), name: '練習曲 ' + (i + 1),
        duration: 12, state: 'learning', marked: count - i });
    }
    if (!ready) return;
    const duration = 12, sampleRate = 8000;
    const bytes = new Uint8Array(44 + 2 * sampleRate * duration), view = new DataView(bytes.buffer);
    for (const [start, text] of [[0, 'RIFF'], [8, 'WAVEfmt '], [36, 'data']]) {
      for (let i = 0; i < text.length; i++) bytes[start + i] = text.charCodeAt(i);
    }
    view.setUint32(4, bytes.length - 8, true); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    view.setUint32(40, bytes.length - 44, true);
    const musicId = id.slice(8), name = '練習曲 1';
    await put('tracks', id, { id, title: name, musicId, lang: 'ja', status: 'ready', duration,
      audio: { name: 'practice.wav', type: 'audio/wav' } });
    await put('audio', id, new Blob([bytes], { type: 'audio/wav' }));
    const { songLyrics } = await import('/js/music-lyrics.js');
    await put('data', id, songLyrics({ id: musicId, name, duration },
      { lrc: '[00:00.00]練習\n[00:08.00]歌う' }));
  }, { id, ready, count });
}

function testAudio(request) {
  const rate = 8000;
  const bytes = Buffer.alloc(44 + rate * 2 * 20);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8); bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(bytes.length - 44, 40);
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range || '');
  if (range) {
    const start = Number(range[1]), end = Math.min(bytes.length - 1, Number(range[2] || bytes.length - 1));
    return { status: 206, contentType: 'audio/wav', headers: {
      'Accept-Ranges': 'bytes', 'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length,
    }, body: bytes.subarray(start, end + 1) };
  }
  return { contentType: 'audio/wav', body: bytes };
}

const scenarios = {
  async 'late account check does not cancel the selected song'(browser) {
    const login = deferred(), lyrics = deferred();
    const { context, page, errors } = await setup(browser, { retention: () => login.promise, lyrics: () => lyrics.promise });
    try {
      await page.goto(base + '/music.html');
      await seed(page, { ready: false });
      await page.locator('a[href="#learning"]').click();
      const requested = page.waitForRequest('**/music/lyrics');
      await page.locator('.song-open').filter({ hasText: '練習曲 1' }).click();
      await requested;
      login.release();
      await page.locator('#account-profile').filter({ hasText: '测试账号' }).waitFor();
      lyrics.release();
      await page.waitForURL(url => url.searchParams.get('track') === id);
      await page.frameLocator('#music-practice-frame').locator('#btnBack').waitFor();
      assert.deepEqual(errors, []);
    } finally { login.release(); lyrics.release(); await context.close(); }
  },

  async 'back works with only forward entries in browser history'(browser) {
    const { context, page, errors } = await setup(browser);
    try {
      await page.goto(base + '/player.html?track=missing');
      await page.locator('#readerState').filter({ hasText: '媒体不存在' }).waitFor();
      await page.goto(base + '/index.html');
      await page.goBack();
      await page.locator('#readerState').filter({ hasText: '媒体不存在' }).waitFor();
      assert.ok(await page.evaluate(() => history.length > 1));
      await page.locator('#btnBack').click();
      await page.waitForURL(base + '/index.html');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  },

  async 'standalone player returns to its source list from an unrelated entry'(browser) {
    const { context, page, errors } = await setup(browser);
    try {
      await context.addInitScript(() => { window.LinguaNative = { markReady: async () => {} }; });
      await page.goto(base + '/index.html');
      const source = '#search?query=fixture';
      const params = new URLSearchParams({ from: 'music', track: 'missing', browse: source });
      await page.goto(base + '/player.html?' + params);
      await page.locator('#readerState').filter({ hasText: '媒体不存在' }).waitFor();
      const handled = await page.evaluate(() => !window.dispatchEvent(new Event('native-back', { cancelable: true })));
      assert.equal(handled, true);
      await page.waitForURL(base + '/music.html' + source);
      await page.waitForFunction(() => document.getElementById('query').value === 'fixture');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  },

  async 'restricted history does not block list navigation or sorting'(browser) {
    const { context, page, errors } = await setup(browser);
    try {
      await page.goto(base + '/music.html');
      await page.locator('#account-profile').waitFor();
      await seed(page, { count: 4 });
      await page.evaluate(() => {
        history.replaceState = () => { throw new DOMException('History updates were rate-limited', 'SecurityError'); };
      });
      await page.locator('a[href="#learning"]').click();
      await page.locator('#detail').waitFor();
      await page.locator('.song-open').filter({ hasText: '練習曲 1' }).waitFor();
      await page.locator('#collection-sort summary').click();
      await page.locator('#collection-sort input[value="reverse"]').check();
      await page.waitForFunction(() => document.querySelector('#sort-label')?.textContent === '倒序排列');
      assert.match(await page.locator('.song-open').first().textContent(), /練習曲 4/);
      await page.locator('#back').click();
      await page.locator('#overview').waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  },

  async 'practice return falls back without interrupting the same audio'(browser) {
    const { context, page, errors } = await setup(browser);
    try {
      await page.goto(base + '/music.html');
      await seed(page);
      await page.locator('a[href="#learning"]').click();
      await page.locator('.song-open').filter({ hasText: '練習曲 1' }).click();
      const frame = page.frameLocator('#music-practice-frame');
      await page.waitForFunction(() => document.querySelector('iframe')?.contentDocument?.getElementById('audio')?.readyState >= 1);
      await frame.locator('#btnPlay').click();
      await page.waitForFunction(() => !document.querySelector('iframe')?.contentDocument?.getElementById('audio')?.paused
        && document.querySelector('iframe')?.contentDocument?.getElementById('audio')?.currentTime > 0.1);
      await page.evaluate(() => {
        const audio = document.querySelector('iframe').contentDocument.getElementById('audio');
        window.navigationTest = { audio, back: history.back.bind(history), calls: 0 };
        history.back = () => { navigationTest.calls++; };
      });
      await frame.locator('#btnBack').evaluate(button => { button.click(); button.click(); });
      await page.waitForURL(library);
      const mini = page.getByRole('complementary', { name: '迷你播放器' });
      await mini.getByRole('button', { name: '暂停音乐' }).waitFor();
      assert.deepEqual(await page.evaluate(() => ({
        same: navigationTest.audio === document.querySelector('iframe').contentDocument.getElementById('audio'),
        playing: !navigationTest.audio.paused, attempts: navigationTest.calls,
      })), { same: true, playing: true, attempts: 1 });
      await page.evaluate(() => { history.back = navigationTest.back; });
      await mini.getByRole('button', { name: /回到练唱/ }).click();
      await frame.locator('#songName').waitFor();
      await frame.locator('#btnBack').click();
      await page.waitForURL(library);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  },

  async 'opening a song can retry after a failure and cancels on leaving the list'(browser) {
    const stalled = deferred();
    let attempts = 0;
    const { context, page, errors } = await setup(browser, { lyrics: async () => {
      if (++attempts <= 2) return { status: 503, json: { error: '歌词暂不可用' } };
      if (attempts === 3) await stalled.promise;
    } });
    try {
      await page.goto(base + '/music.html');
      await seed(page, { ready: false });
      await page.locator('a[href="#learning"]').click();
      const song = page.locator('.song-open').filter({ hasText: '練習曲 1' });
      await song.click();
      await page.getByText(/歌词暂不可用/).waitFor();
      const requested = page.waitForRequest('**/music/lyrics');
      await page.getByRole('button', { name: '重试打开歌曲' }).click();
      await requested;
      const aborted = page.waitForEvent('requestfailed', { predicate: request => request.url().endsWith('/music/lyrics') });
      await page.locator('#back').click();
      await page.locator('#overview').waitFor();
      await aborted;
      stalled.release();
      assert.equal(await page.locator('#music-practice-frame').count(), 0);
      await page.locator('a[href="#learning"]').click();
      await song.click();
      await page.waitForURL(url => url.searchParams.get('track') === id);
      assert.deepEqual(errors, []);
    } finally { stalled.release(); await context.close(); }
  },

  async 'a lost audio source can reconnect in place and retain playback progress'(browser) {
    const levels = [];
    const { context, page, errors } = await setup(browser, {
      source: request => {
        levels.push(request.postDataJSON().level);
        if (levels.length <= 2) return { status: 503, json: { error: '音源服务暂不可用' } };
        const filename = levels.length === 3 ? 'expired' : 'source-' + levels.length;
        return { json: { data: { url: '/music/media/' + filename, level: levels.at(-1) } } };
      },
      expired: () => ({ status: 404, body: '' }),
      'source-4': testAudio,
      'source-5': testAudio,
    });
    try {
      await page.goto(base + '/music.html');
      await seed(page, { ready: false });
      await page.evaluate(() => localStorage.setItem('utaloop.music.quality.v1', 'lossless'));
      await page.locator('a[href="#learning"]').click();
      await page.locator('.song-open').filter({ hasText: '練習曲 1' }).click();
      const frame = page.frameLocator('#music-practice-frame');
      const audio = frame.locator('#audio');
      const retry = frame.getByRole('button', { name: '重新加载音源' });
      await retry.waitFor();
      await frame.locator('#viewport').getByText('練習', { exact: true }).waitFor();
      assert.equal(await frame.locator('#btnFiles').isVisible(), false);
      assert.deepEqual(levels, ['lossless', 'lossless']);
      await retry.click();
      await page.waitForFunction(() => {
        const media = document.querySelector('iframe')?.contentDocument?.getElementById('audio');
        return media?.src.endsWith('source-4') && media.readyState >= 1;
      });
      assert.deepEqual(levels, ['lossless', 'lossless', 'lossless', 'standard']);
      await frame.locator('#btnPlay').click();
      await page.waitForFunction(() => {
        const media = document.querySelector('iframe')?.contentDocument?.getElementById('audio');
        return media && !media.paused && media.currentTime > 0.05;
      });
      await audio.evaluate(el => { el.currentTime = 6.5; });
      await page.waitForFunction(() => {
        const media = document.querySelector('iframe')?.contentDocument?.getElementById('audio');
        return media && !media.paused && !media.seeking && media.currentTime > 6.5;
      });
      await audio.evaluate(el => {
        Object.defineProperty(el, 'error', { configurable: true, value: { code: 2 } });
        el.dispatchEvent(new Event('error'));
        delete el.error;
      });
      await retry.waitFor();
      assert.equal(levels.length, 4, 'one automatic stream reload per explicit request');
      await retry.click();
      await page.waitForFunction(() => {
        const media = document.querySelector('iframe')?.contentDocument?.getElementById('audio');
        return media?.src.endsWith('source-5') && !media.paused && media.currentTime > 6.5;
      });
      assert.equal(levels.at(-1), 'lossless');
      assert.equal(await frame.locator('#btnFiles').isVisible(), false);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  },

  async 'a playlist retries only failed pages and keeps visible songs when sorting fails'(browser) {
    const offsets = new Map();
    const songs = Array.from({ length: 122 }, (_, n) =>
      ({ id: n + 1, name: '曲目 ' + (n + 1), artist: '测试歌手', duration: 20 }));
    const { context, page, errors } = await setup(browser, {
      likes: request => {
        const { offset, limit } = request.postDataJSON();
        const attempt = (offsets.get(offset) || 0) + 1;
        offsets.set(offset, attempt);
        if (attempt <= 2) return { status: 502, json: { error: '暂时无法连接歌单' } };
        return { json: { data: { total: songs.length, items: songs.slice(offset, offset + limit) } } };
      },
    });
    try {
      await page.goto(base + '/music.html#likes');
      const viewport = page.locator('#viewport');
      const retry = page.getByRole('button', { name: '重试加载歌曲' });
      const song = n => viewport.getByText('曲目 ' + n, { exact: true });
      await retry.click();
      await song(1).waitFor();
      await viewport.evaluate(el => { el.scrollTop = 60 * 68; });
      await retry.waitFor();
      assert.equal(await viewport.evaluate(el => el.scrollTop), 60 * 68);
      await retry.click();
      await song(61).waitFor();
      assert.deepEqual([...offsets], [[0, 3], [60, 3]]);
      await page.locator('#collection-sort summary').click();
      await page.locator('#collection-sort input[value="reverse"]').check();
      const retrySort = page.getByRole('button', { name: '重试读取歌单' });
      await retrySort.waitFor();
      assert.equal(await song(61).isVisible(), true);
      await retrySort.click();
      await song(122).waitFor();
      assert.deepEqual([...offsets], [[0, 3], [60, 3], [120, 3]]);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  },

  async 'loading more folders retains existing cards and retries the same offset'(browser) {
    const offsets = [];
    const { context, page, errors } = await setup(browser, {
      folders: request => {
        const { offset } = request.postDataJSON();
        offsets.push(offset);
        if (offset && offsets.length < 4) return { status: 503, json: { error: '暂时无法连接歌单' } };
        return { json: { data: { items: [{
          id: offset + 1, name: offset ? '第二页歌单' : '第一页歌单', artist: '1 首',
        }], more: !offset } } };
      },
    });
    try {
      await page.setViewportSize({ width: 390, height: 720 });
      await page.goto(base + '/music.html#folders');
      const existing = page.getByText('第一页歌单', { exact: true });
      await existing.waitFor();
      await page.getByRole('button', { name: '加载更多歌单' }).click();
      const retry = page.getByRole('button', { name: '重试加载歌单' });
      await retry.waitFor();
      assert.equal(await existing.isVisible(), true);
      await retry.click();
      await page.getByText('第二页歌单', { exact: true }).waitFor();
      assert.deepEqual(offsets, [0, 60, 60, 60]);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  },

  async 'practice opens and returns when a history entry cannot be created'(browser) {
    const { context, page, errors } = await setup(browser);
    try {
      await page.goto(base + '/music.html');
      await seed(page);
      await page.locator('a[href="#learning"]').click();
      await page.evaluate(() => { history.pushState = () => {}; });
      await page.locator('.song-open').filter({ hasText: '練習曲 1' }).click();
      const frame = page.frameLocator('#music-practice-frame');
      await frame.locator('#songName').filter({ hasText: '練習曲 1' }).waitFor();
      await frame.locator('#btnBack').click();
      await page.locator('.song-open').filter({ hasText: '練習曲 1' }).waitFor();
      assert.equal(page.url(), library);
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
  },

  async 'the return button works before the player script is available'(browser) {
    const { context, page } = await setup(browser);
    try {
      await page.route('**/js/main.js', route => route.abort());
      await page.goto(base + '/music.html');
      await seed(page);
      await page.locator('a[href="#learning"]').click();
      await page.locator('.song-open').filter({ hasText: '練習曲 1' }).click();
      const player = page.frameLocator('#music-practice-frame');
      await player.locator('#btnBack').click();
      await page.waitForURL(url => url.pathname.endsWith('/index.html'));
      await page.locator('#viewHome').waitFor();
    } finally { await context.close(); }
  },
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const failed = [];
  try {
    for (const [name, scenario] of Object.entries(scenarios)) {
      try { await scenario(browser); console.log('PASS ' + name); }
      catch (error) {
        failed.push(name);
        console.error('FAIL ' + name + '\n' + (error.stack || error.message).split('\n').slice(0, 10).join('\n'));
      }
    }
  } finally { await browser.close(); }
  assert.deepEqual(failed, []);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
