/** Browser regression for pitch accuracy and continuous audio during practice navigation.
 * node tests/check_music_practice.cjs [playwright-module] [base-url]
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:13876';
const TEST_TONE_HZ = 440;

function observeLeftOutput() {
  const originalConnect = AudioNode.prototype.connect;
  const splitters = new WeakMap();
  AudioNode.prototype.connect = function (destination, ...args) {
    const context = this.context;
    if (destination === context.destination) {
      if (!splitters.has(context)) {
        const splitter = context.createChannelSplitter(2);
        const analyser = context.createAnalyser();
        analyser.fftSize = 32768;
        analyser.smoothingTimeConstant = 0;
        originalConnect.call(splitter, analyser, 0);
        splitters.set(context, splitter);
        window.readPitchHz = () => {
          const db = new Float32Array(analyser.frequencyBinCount);
          analyser.getFloatFrequencyData(db);
          const binHz = context.sampleRate / analyser.fftSize;
          let peak = Math.ceil(200 / binHz);
          for (let i = peak + 1; i < Math.floor(650 / binHz); i++) {
            if (db[i] > db[peak]) peak = i;
          }
          if (db[peak] < -60) return null;
          const left = db[peak - 1], center = db[peak], right = db[peak + 1];
          const offset = .5 * (left - right) / (left - 2 * center + right);
          return (peak + offset) * binHz;
        };
      }
      originalConnect.call(this, splitters.get(context));
    }
    return originalConnect.call(this, destination, ...args);
  };
}

async function checkHalfSteps(practice) {
  const audio = practice.locator('#audio');
  await practice.locator('#btnSpeed').click();
  for (const [label, semitones] of [['升高半音', 1], ['降低半音', -1]]) {
    await practice.getByRole('button', { name: label }).click();
    const actual = await audio.evaluate(async () => {
      const start = performance.now();
      while (typeof window.readPitchHz !== 'function' && performance.now() - start < 5000) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      // Allow the crossfade and the analyser's 32768-sample window to settle.
      await new Promise(resolve => setTimeout(resolve, 1000));
      return window.readPitchHz?.();
    });
    const expected = TEST_TONE_HZ * 2 ** (semitones / 12);
    const error = 1200 * Math.log2(actual / expected);
    assert.ok(Math.abs(error) <= 4, `${label} should move 100 cents. Measured ${actual} Hz, error ${error.toFixed(2)} cents.`);
    assert.equal(await audio.evaluate(el => el.playbackRate), 1);
    await practice.getByRole('button', { name: '恢复原调' }).click();
  }
  await practice.getByRole('button', { name: '关闭', exact: true }).click();
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 824 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    await page.addInitScript(observeLeftOutput);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const cover = 'https://p1.music.126.net/practice-fixture.png';
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin + url.pathname === cover) return route.fulfill({ contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64') });
      if (url.origin !== new URL(base).origin) return route.abort();
      if (url.pathname.startsWith('/music/')) return route.fulfill({ json: { data: null } });
      return route.continue();
    });
    const libraryURL = base + '/music.html#learning';
    await page.goto(libraryURL);
    await page.evaluate(async ({ cover, frequency }) => {
      const { put } = await import('/js/store.js');
      const { songLyrics } = await import('/js/music-lyrics.js');
      const { setSetting } = await import('/js/settings.js');
      const rate = 48000, duration = 25, bytes = new Uint8Array(44 + rate * duration * 4);
      const view = new DataView(bytes.buffer);
      for (const [at, label] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
        for (const [i, char] of [...label].entries()) bytes[at + i] = char.charCodeAt(0);
      }
      for (const [at, value] of [[4, bytes.length - 8], [16, 16], [24, rate], [28, rate * 4], [40, bytes.length - 44]]) {
        view.setUint32(at, value, true);
      }
      for (const [at, value] of [[20, 1], [22, 2], [32, 4], [34, 16]]) view.setUint16(at, value, true);
      for (let frame = 0; frame < rate * duration; frame++) {
        const phase = 2 * Math.PI * frequency * frame / rate;
        view.setInt16(44 + frame * 4, Math.round(10000 * Math.sin(phase)), true);
        view.setInt16(46 + frame * 4, Math.round(10000 * Math.sin(.75 * phase)), true);
      }
      setSetting('songPlayMode', 'list');
      setSetting('rate', 1);
      for (const [index, name] of ['夜の練習', '朝の練習'].entries()) {
        const musicId = 99110001 + index;
        const data = songLyrics({ id: musicId, name, duration }, { lrc: '[00:00]練習\n[00:13]続ける' });
        await put('tracks', data.id, { id: data.id, musicId, title: name, artist: 'テスト歌手', cover,
          lang: 'ja', status: 'ready', duration, audio: { name: 'practice.wav', type: 'audio/wav' } });
        await put('data', data.id, data);
        await put('audio', data.id, new Blob([bytes], { type: 'audio/wav' }));
        await put('study', data.id, { track: data.id, id: musicId, name, cover, duration, state: 'learning', marked: 2 - index });
      }
    }, { cover, frequency: TEST_TONE_HZ });
    await page.reload();
    const selected = page.locator('.song-open').filter({ hasText: '夜の練習' });
    await selected.click();
    await page.waitForURL(url => url.searchParams.get('track') === 'netease-99110001');
    const practice = page.frameLocator('#music-practice-frame');
    await page.waitForFunction(() => {
      const audio = document.querySelector('iframe')?.contentDocument?.getElementById('audio');
      return audio?.readyState >= 1 && document.title.startsWith('夜の練習');
    });
    await practice.locator('#btnPlay').click();
    await page.waitForFunction(() => {
      const audio = document.querySelector('iframe')?.contentDocument?.getElementById('audio');
      return audio && !audio.paused && audio.currentTime > .1;
    });
    await checkHalfSteps(practice);
    await page.evaluate(() => {
      const audio = document.querySelector('iframe').contentDocument.getElementById('audio');
      window.practiceCheck = { audio, start: audio.currentTime, pauses: 0, seeks: 0 };
      audio.addEventListener('pause', () => practiceCheck.pauses++);
      audio.addEventListener('seeking', () => practiceCheck.seeks++);
    });
    await practice.getByRole('button', { name: '返回选歌列表' }).click();
    await page.waitForURL(libraryURL);
    const mini = page.getByRole('complementary', { name: '迷你播放器' });
    await mini.getByText('夜の練習', { exact: true }).waitFor();
    await page.waitForFunction(() => {
      const frame = document.querySelector('iframe');
      const cover = document.querySelector('#music-mini-cover');
      return frame.hidden && cover.naturalWidth > 0 && practiceCheck.audio.currentTime > practiceCheck.start + .2;
    });
    assert.deepEqual(await page.evaluate(() => ({ pauses: practiceCheck.pauses, seeks: practiceCheck.seeks,
      same: practiceCheck.audio === document.querySelector('iframe').contentDocument.getElementById('audio') })),
    { pauses: 0, seeks: 0, same: true });

    await mini.getByRole('button', { name: '暂停音乐' }).click();
    await mini.getByRole('button', { name: '播放音乐' }).waitFor();
    await mini.getByRole('button', { name: '播放音乐' }).click();
    await mini.getByRole('button', { name: '暂停音乐' }).waitFor();
    await mini.getByRole('button', { name: /回到练唱/ }).click();
    await practice.locator('#songName').filter({ hasText: '夜の練習' }).waitFor();
    await page.goBack();
    await page.waitForURL(libraryURL);
    await mini.getByRole('button', { name: '暂停音乐' }).waitFor();
    assert(await page.evaluate(() => practiceCheck.audio === document.querySelector('iframe').contentDocument.getElementById('audio')));

    await page.evaluate(() => { practiceCheck.audio.currentTime = practiceCheck.audio.duration - .2; });
    await mini.getByText('朝の練習', { exact: true }).waitFor();
    await mini.getByRole('button', { name: '暂停音乐' }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await mini.evaluate(el => {
      const bounds = el.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
    }));
    await page.goForward();
    await page.waitForURL(url => url.searchParams.get('track') === 'netease-99110002');
    await practice.locator('#songName').filter({ hasText: '朝の練習' }).waitFor();
    assert(await page.evaluate(() => practiceCheck.audio === document.querySelector('iframe').contentDocument.getElementById('audio')));

    await page.goto(base + '/player.html?from=music&track=netease-99110001&collection=learning');
    await page.waitForURL(url => url.pathname.endsWith('/music.html') && url.hash === '#learning');
    await practice.locator('#songName').filter({ hasText: '夜の練習' }).waitFor();
    await practice.getByRole('button', { name: '返回选歌列表' }).click();
    await page.waitForURL(libraryURL);
    assert.deepEqual(errors, []);
    console.log('Half-step accuracy, continuous playback, mini controls, artwork, queue advancement and older practice links passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
