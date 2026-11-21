/** Browser regression for continuous audio during practice navigation.
 * node tests/check_music_practice.cjs [playwright-module] [base-url]
 */
const assert = require('node:assert/strict');
const { chromium } = require(process.argv[2] || 'playwright');
const base = process.argv[3] || 'http://127.0.0.1:13876';

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1120, height: 824 }, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
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
    await page.evaluate(async cover => {
      const { put } = await import('/js/store.js');
      const { songLyrics } = await import('/js/music-lyrics.js');
      const { setSetting } = await import('/js/settings.js');
      const rate = 8000, duration = 25, bytes = new Uint8Array(44 + rate * duration * 2);
      const view = new DataView(bytes.buffer);
      for (const [at, label] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']]) {
        for (const [i, char] of [...label].entries()) bytes[at + i] = char.charCodeAt(0);
      }
      for (const [at, value] of [[4, bytes.length - 8], [16, 16], [24, rate], [28, rate * 2], [40, bytes.length - 44]]) {
        view.setUint32(at, value, true);
      }
      for (const [at, value] of [[20, 1], [22, 1], [32, 2], [34, 16]]) view.setUint16(at, value, true);
      setSetting('songPlayMode', 'list');
      for (const [index, name] of ['夜の練習', '朝の練習'].entries()) {
        const musicId = 99110001 + index;
        const data = songLyrics({ id: musicId, name, duration }, { lrc: '[00:00]練習\n[00:13]続ける' });
        await put('tracks', data.id, { id: data.id, musicId, title: name, artist: 'テスト歌手', cover,
          lang: 'ja', status: 'ready', duration, audio: { name: 'practice.wav', type: 'audio/wav' } });
        await put('data', data.id, data);
        await put('audio', data.id, new Blob([bytes], { type: 'audio/wav' }));
        await put('study', data.id, { track: data.id, id: musicId, name, cover, duration, state: 'learning', marked: 2 - index });
      }
    }, cover);
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
    console.log('Music continues across practice navigation, with working mini controls, artwork, queue advancement and older practice links.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
