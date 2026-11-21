import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createSongMenu } from '../web/js/music-song-menu.js';

const html = readFileSync(new URL('../web/music.html', import.meta.url), 'utf8');

function fixture(t, onMark, onOpen = () => {}) {
  const { window } = new JSDOM(html);
  const { document } = window;
  t.after(() => window.close());
  const viewport = document.getElementById('viewport');
  const results = document.getElementById('results');
  document.getElementById('detail').hidden = false;
  const popup = document.getElementById('song-popup');
  const buttons = ['one', 'two'].map(key => {
    const button = document.createElement('button');
    button.dataset.key = key;
    results.append(button);
    return button;
  });
  const menu = createSongMenu(popup, { viewport, results, getStudy: song => song, onMark, onOpen, onError: () => {} });
  const option = value => popup.querySelector('button[value="' + value + '"]');
  const key = value => document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: value, bubbles: true }));
  return { document, viewport, popup, buttons, menu, option, key };
}

test('song menu keeps focus in context when dismissed or when a virtual row disappears', async t => {
  const { document, viewport, popup, buttons: [anchor], menu, option, key } = fixture(t, async () => {});
  menu.open(anchor, { name: 'Track', state: '' }, { edge: 'first' });
  assert.equal(anchor.getAttribute('aria-expanded'), 'true');
  assert.equal(document.activeElement, option('open'));
  assert.equal(option('').hidden, true);
  assert.equal(option('resume').hidden, true);
  key('ArrowDown');
  assert.equal(document.activeElement, option('learning'));
  key('ArrowDown');
  assert.equal(document.activeElement, option('learned'));
  key('Escape');
  assert.equal(document.activeElement, anchor);
  assert.equal(popup.hidden, true);

  menu.open(anchor, { name: 'Track', state: 'learned' });
  assert.equal(option('learned').getAttribute('aria-checked'), 'true');
  assert.equal(option('').hidden, false);
  anchor.remove();
  await Promise.resolve();
  assert.equal(popup.hidden, true);
  assert.equal(document.activeElement, viewport);
});

test('a save finishing for another song leaves the newly opened menu alone', async t => {
  const save = Promise.withResolvers();
  let calls = 0;
  const { document, popup, buttons: [first, second], menu, option } = fixture(t, () => {
    calls++;
    return save.promise;
  });
  menu.open(first, { name: 'First', state: '' });
  option('learning').click();
  option('learning').click();
  assert.equal(calls, 1);
  menu.open(second, { name: 'Second', state: 'learned' });
  save.resolve();
  await Promise.resolve();
  assert.equal(popup.hidden, false);
  assert.equal(second.getAttribute('aria-expanded'), 'true');
  assert.equal(option('learned').getAttribute('aria-checked'), 'true');
  assert.equal(document.activeElement, option('open'));
});

test('pointer-positioned menus fit at the screen edge and open at a saved checkpoint of zero', t => {
  const visits = [];
  const { document, popup, buttons: [anchor, origin], menu, option } = fixture(t,
    () => assert.fail('Opening the player must not change study state'),
    (song, resume) => visits.push([song.name, resume]));
  Object.defineProperty(document.documentElement, 'clientWidth', { value: 800 });
  Object.defineProperties(popup, { offsetHeight: { value: 200 }, offsetWidth: { value: 200 } });
  menu.open(anchor, { name: 'Track', checkpoint: 0 }, { point: { x: 760, y: 650 }, focusFrom: origin });
  assert.equal(popup.style.left, '560px');
  assert.equal(popup.dataset.side, 'above');
  assert.equal(option('resume').textContent.trim(), '从 0:00 继续');
  option('resume').click();
  assert.deepEqual(visits, [['Track', true]]);
  assert.equal(popup.hidden, true);
  assert.equal(document.activeElement, origin);
});
