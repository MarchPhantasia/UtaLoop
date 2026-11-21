import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine } from '../web/js/engine.js';

function followEngine() {
  const audio = { currentTime: 0, duration: 30, paused: true };
  const scroller = { scrollTop: 0, clientHeight: 100, scrollHeight: 500 };
  const reader = { activeS: 0, activeW: -1, setProgress() {},
    setActive(s, w) { this.activeS = s; this.activeW = w; },
  };
  const vlist = { h: [100, 100, 100], offsetOf: (i) => i * 100, scrollTargetFor: (i) => i * 100 };
  const engine = new Engine({ audio, scroller, reader, vlist });
  engine.track = { S: 3, N: 0, sStart: [0, 10, 20], sEnd: [10, 20, 30] };
  engine.kick = () => {};
  return engine;
}

test('manual and inertial scrolling defer follow and recenter the current cue even while paused', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = followEngine();
  const changes = [];
  engine.onFollowChange = (on) => changes.push(on);
  engine._target = 500;
  engine.noteUserScroll({ browse: true });
  assert.equal(engine.follow, false);
  assert.equal(engine.followEnabled, true);
  assert.equal(engine._target, -1);
  t.mock.timers.tick(2500);
  engine.scroller.scrollTop = 230;
  engine.onScroll();
  engine.audio.currentTime = 12;
  engine._sync(engine.audio.currentTime);
  t.mock.timers.tick(2599);
  assert.deepEqual(changes, [false]);
  assert.equal(engine._target, -1);
  t.mock.timers.tick(1);
  engine._sync(engine.audio.currentTime);
  assert.equal(engine.follow, true);
  assert.equal(engine.reader.activeS, 1);
  assert.equal(engine._target, 100);
  assert.deepEqual(changes, [false, true]);
});

test('explicitly disabled follow stays off after the browse delay and exiting a line loop', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = followEngine();
  engine.noteUserScroll({ browse: true });
  engine.setFollow(false);
  engine.setRepeat(1);
  engine.setRepeat(0);
  t.mock.timers.tick(3000);
  engine._sync(0);
  assert.equal(engine.follow, false);
  assert.equal(engine._target, -1);
  engine.setFollow(true);
  engine._sync(15);
  assert.equal(engine.follow, true);
  assert.equal(engine._target, 100);
});

test('selecting a lyric leaves browsing and programmatic layout scrolls retain follow', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const engine = followEngine();
  engine.noteUserScroll({ browse: true });
  engine.seekSentence(1);
  assert.equal(engine.follow, true);
  assert.equal(engine.audio.currentTime, 10);
  engine.setScrollTop(100);
  engine.onScroll();
  assert.equal(engine.follow, true);
});

test('a fixed lyric range loops from the first start through the last end and retains both ends when seeking', () => {
  const engine = followEngine();
  engine.setLyricOffset(.2);
  engine.setRepeat(1, 0, 1);
  assert.equal(engine.isRangeLoop, true);
  engine.seekSentence(1);
  assert.equal(engine.audio.currentTime, 10.2);
  assert.equal(engine.loopS, 0);
  assert.equal(engine.loopEndS, 1);
  engine.seekSentence(2);
  assert.equal(engine.audio.currentTime, 10.2);
  engine.seek(27);
  assert.equal(engine.audio.currentTime, .2);
  engine.audio.currentTime = 20.1;
  engine._loops(20.1);
  assert.equal(engine.audio.currentTime, 20.1);
  engine._loops(20.2);
  assert.equal(engine.audio.currentTime, .2);
  engine.setRepeat(0);
  engine.seekSentence(2);
  assert.equal(engine.isRangeLoop, false);
  assert.equal(engine.audio.currentTime, 20.2);
});

test('a subtitle press or seek-bar drag only interrupts current scroll animation', () => {
  const engine = new Engine({});
  engine._target = 500;
  engine.noteUserScroll();
  assert.equal(engine.follow, true);
  assert.equal(engine._target, -1);
});

test('subtitle management suspension prevents late events from restarting the reader', () => {
  const engine = new Engine({});
  engine.setSuspended(true);
  engine.kick(); engine.markScrollDirty();
  assert.equal(engine._raf, 0);
  assert.equal(engine.follow, true);
});

test('hidden presentation parks rendering but keeps loop handling and resumes at the media clock', (t) => {
  let frames = 0;
  const old = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = () => ++frames;
  t.after(() => { if (old) globalThis.requestAnimationFrame = old; else delete globalThis.requestAnimationFrame; });
  const engine = new Engine({ audio: { paused: false, currentTime: 15 } });
  engine.track = {}; engine.presentationHidden = true;
  const calls = [];
  engine._loops = (time) => calls.push(['loop', time]);
  engine._sync = (time) => calls.push(['paint', time]);
  engine._paintSeek = engine._autoScroll = () => {};
  engine._needV = false;
  engine._frame(1000);
  assert.equal(frames, 0); assert.deepEqual(calls, [['loop', 15]]);
  engine.audio.currentTime = 22; engine.backgroundTick();
  assert.deepEqual(calls.at(-1), ['loop', 22]);
  engine.repeat = 1; engine._frame(1100); assert.equal(frames, 1);
  engine.repeat = 0; engine.presentationHidden = false; engine._frame(1200);
  assert.ok(calls.some(([name, time]) => name === 'paint' && time === 22));
});
