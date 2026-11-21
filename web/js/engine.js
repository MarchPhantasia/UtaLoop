/**
 * 渲染引擎 —— 全应用唯一的 requestAnimationFrame 循环.
 *
 * 每帧只做四件事:
 *   1. 读一次 `audio.currentTime`;
 *   2. 用单调指针 (退化时二分) 在 Float32Array 时间轴上定位句/词;
 *   3. 直接写 className / style.transform 更新高亮与进度条;
 *   4. 同步虚拟列表窗口, 并推进自动滚动的缓动.
 *
 * 不使用 timeupdate 事件, 不经过任何响应式状态; 暂停且静止时循环会自行停车。
 */

import { clamp, fmtTime, locate } from './util.js';

const FOLLOW_ALIGN = 0.30;
const USER_SCROLL_HOLD = 2600; // ms: 手动滚动后暂停自动跟随
const SCROLL_TAU = 150;        // ms: 自动滚动的缓动时间常数
const IDLE_GRACE = 500;
const CUE_EPS = 0.004;         // s: 见 _sync —— 补偿媒体元素的采样点对齐
const SEEK_END_MARGIN = 0.01;

export class Engine {
  constructor(ctx) {
    this.audio = ctx.audio;
    this.reader = ctx.reader;
    this.vlist = ctx.vlist;
    this.scroller = ctx.scroller;
    this.dom = ctx.dom;
    this.track = null;
    this.lyricOffset = 0;
    this.outputDelay = ctx.outputDelay;
    this.lastSeekPosition = 0;

    this.followEnabled = true;
    this.followHeld = false;
    this.suspended = false;
    this.presentationHidden = false;
    this.followAlign = FOLLOW_ALIGN;
    this.repeat = 0;          // 0 关 / 1 歌词区间或单句 / 2 全部
    this.loopS = -1;
    this.rangeEndS = null;
    this.shadow = 'off';      // off | listen | speak
    this.shadowS = -1;
    this.speakUntil = 0;

    this.scrubbing = false;
    this.scrubTime = 0;

    this._sHint = -1;
    this._wHint = -1;
    this._sec = -1;
    this._pct = -1;
    this._railW = 0;
    this._wrote = 0;
    this._userAt = -Infinity;
    this._followTimer = null;
    this._centerActive = false;
    this._target = -1;
    this._needV = true;
    this._lastKick = 0;
    this._raf = 0;
    this._prev = 0;
    this._onFrame = this._frame.bind(this);
  }

  get follow() { return this.followEnabled && !this.followHeld && this._followTimer === null; }
  get isRangeLoop() { return this.repeat === 1 && this.rangeEndS !== null; }
  get loopEndS() { return this.rangeEndS ?? this.loopS; }

  attach(track, lyricOffset = 0) {
    this.track = track;
    this.lyricOffset = lyricOffset;
    this.lastSeekPosition = 0;
    this._sHint = this._wHint = -1;
    this._sec = -1;
    this._pct = -1;
    this._target = -1;
    this._centerActive = false;
    this._userAt = -Infinity;
    if (this._endBrowse()) this.onFollowChange?.(this.follow);
    this._needV = true;
    this.repeat = 0;
    this.loopS = -1;
    this.rangeEndS = null;
    this._syncNativeLoop();
    this.shadow = 'off';
    this.kick();
  }

  /** The current track's sentence data changed; keep playback, repeat and follow state. */
  refreshTrack() {
    this._sHint = this._wHint = -1;
    this.reader.setActive(-1, -1);
    this._needV = true;
    this._target = -1;
    if (this.repeat === 1) this._syncNativeLoop();
    this.kick();
  }

  setLyricOffset(seconds) {
    this.lyricOffset = seconds;
    if (this.repeat === 1) this._syncNativeLoop();
    this.kick();
  }

  toLyricTime(mediaTime) { return mediaTime - this.lyricOffset; }

  toMediaTime(lyricTime) {
    return clamp(lyricTime + this.lyricOffset, 0, this.audio.duration || this.track?.duration || Infinity);
  }

  hasPlayableRange(first, last = first) {
    const tr = this.track;
    return first >= 0 && last >= first && last < tr?.S
      && this.toMediaTime(tr.sEnd[last]) - this.toMediaTime(tr.sStart[first]) > SEEK_END_MARGIN;
  }

  // ------------------------------------------------------------ 循环控制

  kick() {
    if (this.suspended) return;
    this._lastKick = performance.now();
    if (!this._raf) {
      this._prev = this._lastKick;
      this._raf = requestAnimationFrame(this._onFrame);
    }
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  }

  setSuspended(on) {
    this.suspended = on;
    if (on) this.stop(); else this.kick();
  }

  // A native PiP shows the video/cue track, not the reader or its seek bar.
  setPresentationHidden(on) {
    if (this.presentationHidden === on) return;
    this.presentationHidden = on;
    this._needV = true;
    this._sec = this._pct = -1;
    if (on) this._target = -1;
    this.stop();
    this.kick();
  }

  backgroundTick() {
    if (this.presentationHidden && !this.suspended && this.track && !this.scrubbing) {
      this._loops(this.audio.currentTime, performance.now());
    }
  }

  markScrollDirty() { this._needV = true; this.kick(); }

  noteUserScroll({ browse = false } = {}) {
    this._userAt = performance.now();
    this._target = -1;
    this._centerActive = false;
    if (this.suspended || this.followHeld || !this.track?.S || !this.followEnabled || (!browse && this.follow)) return;
    const wasFollowing = this.follow;
    clearTimeout(this._followTimer);
    this._followTimer = setTimeout(() => this.resumeFollow(), USER_SCROLL_HOLD);
    if (wasFollowing) this.onFollowChange?.(false);
  }

  setRailWidth(w) { this._railW = w; this._pct = -1; }

  // ------------------------------------------------------------ 主帧

  _frame(now) {
    const dt = Math.min(64, now - this._prev) || 16.7;
    this._prev = now;
    const audio = this.audio;
    const track = this.track;
    if (!track) { this._raf = 0; return; }

    const t = this.scrubbing ? this.scrubTime : audio.currentTime;

    if (this.presentationHidden) {
      if (!this.scrubbing) this._loops(t, now);
      // Retain loop/shadow timing while PiP is visible; ordinary playback parks rAF.
      this._raf = (!audio.paused && this.repeat === 1) || this.shadow !== 'off' ? requestAnimationFrame(this._onFrame) : 0;
      return;
    }

    // The effect buffers sound. Seek and loop boundaries still use the media clock.
    const delay = this.outputDelay?.() || 0;
    const cueTime = delay && !this.scrubbing && !audio.paused && !audio.seeking
      ? Math.max(Math.min(t, this.lastSeekPosition), t - delay * audio.playbackRate) : t;
    this._sync(cueTime, now);
    this._paintSeek(t);
    this._autoScroll(dt);
    if (this._needV) { this._needV = false; this.vlist.update(false); }
    if (!this.scrubbing) this._loops(t, now);

    const busy = !audio.paused || this._target >= 0 || this._needV ||
                 this.scrubbing || this.shadow !== 'off' ||
                 now - this._lastKick < IDLE_GRACE;
    this._raf = busy ? requestAnimationFrame(this._onFrame) : 0;
  }

  /** 定位当前句/词并写入高亮. */
  _sync(t, now = performance.now()) {
    const tr = this.track;
    /*  定位用的时间往前借几毫秒: 把 currentTime 设成某个词的起点时, 媒体元素会
        对齐到采样点, 落点可能比目标早几微秒 (23.92 → 1054872/44100 =
        23.919999999999998), 不补这一点点, 点词后高亮会停在上一个词上。       */
    const lyricTime = this.toLyricTime(t);
    const tc = lyricTime + CUE_EPS;
    const s = locate(tr.sStart, tr.S, tc, this._sHint);
    this._sHint = s;

    let wj = -1, p = 0;
    if (s >= 0 && tr.N) {
      const k = locate(tr.wStart, tr.N, tc, this._wHint);
      if (k >= 0) {
        this._wHint = k;
        if (tr.wSent[k] === s) {
          wj = tr.wIdx[k];
          const a = tr.wStart[k], b = tr.wEnd[k];
          p = b > a ? clamp((lyricTime - a) / (b - a), 0, 1) : 1;
        }
      }
    }

    const prevS = this.reader.activeS;
    const prevW = this.reader.activeW;
    this.reader.setActive(s, wj);
    this.reader.setProgress(p);
    if (s !== prevS && s >= 0) this._needV = true;
    if (this._centerActive && !this.scrubbing) {
      this._centerActive = false;
      if (tr.S) this._target = this.vlist.scrollTargetFor(Math.max(0, s), this.followAlign);
    } else if (s >= 0 && s !== prevS && this.follow && !this.scrubbing && now - this._userAt >= USER_SCROLL_HOLD) {
      this._follow(s);
    }
    if ((s !== prevS || wj !== prevW) && this.onCursor) this.onCursor(s, wj, s !== prevS);
  }

  /** 进度条: 只写 transform; 时间文字每秒更新一次. */
  _paintSeek(t) {
    const dur = this.audio.duration || this.track.duration || 0;
    const dom = this.dom;
    const p = dur > 0 ? clamp(t / dur, 0, 1) : 0;
    const q = Math.round(p * 2000) / 2000;
    if (q !== this._pct) {
      this._pct = q;
      dom.seekFill.style.transform = `scaleX(${q})`;
      /*  圆点的位移必须写在 `translate` 上, 不能写 transform: 按下时 CSS 给它加了
          `scale: 1.3`, 而独立的 translate/scale 属性排在 transform 之前 ——
          位移一旦写进 transform 就会被那个 1.3 一起放大, 圆点当场跑到填充条
          右边 30% 的位置, 拖起来完全不跟手。translate 排在 scale 前面, 不受影响。 */
      dom.seekThumb.style.translate = `${(q * this._railW).toFixed(2)}px`;
      dom.seek.setAttribute('aria-valuenow', t.toFixed(1));
    }
    const sec = t | 0;
    if (sec !== this._sec) {
      this._sec = sec;
      dom.timeNow.textContent = fmtTime(t);
    }
  }

  // ------------------------------------------------------------ 自动跟随

  /** 只在当前句飘出舒适区时才滚, 避免每句都推动画面. */
  _follow(s) {
    const vl = this.vlist;
    const vh = this.scroller.clientHeight;
    const top = vl.offsetOf(s) - this.scroller.scrollTop;
    const bottom = top + vl.h[s];
    if (top >= vh * 0.12 && (bottom <= vh * 0.74 || top <= vh * 0.30)) return;
    this._target = vl.scrollTargetFor(s, this.followAlign);
  }

  scrollToActive() {
    this._userAt = -Infinity;
    this._centerActive = true;
    this.kick();
  }

  _autoScroll(dt) {
    if (this._target < 0) return;
    const sc = this.scroller;
    const cur = sc.scrollTop;
    const d = this._target - cur;
    if (Math.abs(d) < 0.75) {
      this.setScrollTop(this._target);
      this._target = -1;
      return;
    }
    const step = Math.abs(d) > 3000 ? d : d * (1 - Math.exp(-dt / SCROLL_TAU));
    this.setScrollTop(cur + step);
    this._needV = true;
  }

  setScrollTop(y) {
    const max = this.scroller.scrollHeight - this.scroller.clientHeight;
    const v = clamp(y, 0, Math.max(0, max));
    this._wrote = v;
    this.scroller.scrollTop = v;
  }

  /** scroll 事件回调: 判断是自己写的还是用户拖的. */
  onScroll() {
    const top = this.scroller.scrollTop;
    if (Math.abs(top - this._wrote) > 1) this.noteUserScroll({ browse: true });
    this._wrote = top;
    this.markScrollDirty();
  }

  // ------------------------------------------------------------ 循环 / 跟读

  _loops(t, now) {
    const tr = this.track;
    if (this.shadow !== 'off') { this._shadowStep(t, now); return; }
    if (this.repeat === 1 && this.loopS >= 0 && this.loopEndS < tr.S) {
      if (this.audio.nativeAudio) return; // Native boundary handling keeps looping in the background.
      const start = this.toMediaTime(tr.sStart[this.loopS]), end = this.toMediaTime(tr.sEnd[this.loopEndS]);
      if (end - start > SEEK_END_MARGIN && (t >= end - 0.008 || t < start - 0.2)) this.seek(start);
    }
  }

  _shadowStep(t, now) {
    const tr = this.track;
    const i = this.shadowS;
    if (i < 0 || i >= tr.S) { this.setShadow(false); return; }
    if (this.shadow === 'listen') {
      const end = this.toMediaTime(tr.sEnd[i]);
      if (t >= end - 0.008) {
        this.audio.pause();
        this.seek(end);
        const dur = Math.max(1.2, end - this.toMediaTime(tr.sStart[i]));
        this.speakUntil = now + dur * 1150 + 350;
        this.shadow = 'speak';
        this.onShadowState && this.onShadowState('speak', i, this.speakUntil);
      }
      return;
    }
    if (now >= this.speakUntil) {
      const next = i + 1;
      if (next >= tr.S) { this.setShadow(false); return; }
      this.shadowS = next;
      this.shadow = 'listen';
      this.seek(this.toMediaTime(tr.sStart[next]));
      this.audio.play().catch(() => {});
      this.onShadowState && this.onShadowState('listen', next, 0);
    } else {
      this.onShadowState && this.onShadowState('tick', i, this.speakUntil);
    }
  }

  // ------------------------------------------------------------ 对外操作

  seek(t) {
    if (this.isRangeLoop && this.hasPlayableRange(this.loopS, this.loopEndS)) {
      const start = this.toMediaTime(this.track.sStart[this.loopS]);
      const end = this.toMediaTime(this.track.sEnd[this.loopEndS]);
      if (t < start || t >= end) t = start;
    }
    const dur = this.audio.duration || this.track.duration || 0;
    this.audio.currentTime = clamp(t, 0, dur ? Math.max(0, dur - SEEK_END_MARGIN) : t);
    this.lastSeekPosition = this.audio.currentTime;
    this._sec = -1;
    this.kick();
  }

  /** 点击句子/单词: 把歌词时间换为媒体时间，并更新循环/跟读的锚点。 */
  seekSentence(i, lyricTime) {
    const tr = this.track;
    if (i < 0 || i >= tr.S) return;
    if (this.isRangeLoop && (i < this.loopS || i > this.loopEndS)) return;
    this.seek(this.toMediaTime(lyricTime ?? tr.sStart[i]));
    if (this.repeat === 1 && !this.isRangeLoop && this.loopS !== i) {
      this.loopS = i;
      this._syncNativeLoop();
    }
    if (this.shadow !== 'off') { this.shadowS = i; this.shadow = 'listen'; }
    if (this._endBrowse()) this.onFollowChange?.(this.follow);
    this._userAt = -Infinity;
    this._centerActive = false;
    if (!this.followHeld) this._target = this.vlist.scrollTargetFor(i, this.followAlign);
  }

  _endBrowse() {
    if (this._followTimer === null) return false;
    clearTimeout(this._followTimer);
    this._followTimer = null;
    return true;
  }

  resumeFollow() {
    if (this.followEnabled) this.setFollow(true);
  }

  setFollow(on) {
    const changed = this.followEnabled !== on;
    const wasBrowsing = this._endBrowse();
    this.followEnabled = on;
    if (on && !this.followHeld) this.scrollToActive();
    else {
      this._centerActive = false;
      this._target = -1;
    }
    if (changed || wasBrowsing) this.onFollowChange?.(this.follow);
  }

  /** 选择区间时暂缓滚动，不改变用户设置的跟随开关。 */
  holdFollow(held) {
    if (this.followHeld === held) return;
    this.followHeld = held;
    if (held) {
      this._endBrowse();
      this._target = -1;
      this._centerActive = false;
    } else this.resumeFollow();
    this.onFollowChange?.(this.follow);
  }

  setRepeat(mode, first, last = null) {
    const endingCueLoop = this.repeat === 1 && mode !== 1;
    this.repeat = mode;
    this.loopS = mode === 1 ? first ?? Math.max(0, this.reader.activeS) : -1;
    this.rangeEndS = mode === 1 ? last : null;
    this._syncNativeLoop();
    if (mode) this.setShadow(false);
    if (endingCueLoop) this.resumeFollow();
    this.kick();
  }

  setShadow(on) {
    if (!on) {
      if (this.shadow === 'off') return;
      this.shadow = 'off';
      this.shadowS = -1;
      this.onShadowState && this.onShadowState('off', -1, 0);
      this.kick();
      return;
    }
    this.repeat = 0;
    this.rangeEndS = null;
    this._syncNativeLoop();
    this.shadowS = Math.max(0, this.reader.activeS);
    this.shadow = 'listen';
    this.seek(this.toMediaTime(this.track.sStart[this.shadowS]));
    this.audio.play().catch(() => {});
    this.onShadowState && this.onShadowState('listen', this.shadowS, 0);
  }

  _syncNativeLoop() {
    if (!this.audio.setLoop) return;
    const i = this.loopS;
    const inRange = this.repeat === 1 && this.hasPlayableRange(i, this.loopEndS);
    this.audio.setLoop({ all: this.repeat === 2,
      start: inRange ? this.toMediaTime(this.track.sStart[i]) : null,
      end: inRange ? this.toMediaTime(this.track.sEnd[this.loopEndS]) : null });
  }

  /** 上/下一句. */
  step(delta) {
    const s = this.reader.activeS;
    const i = clamp((s < 0 ? 0 : s) + delta, 0, this.track.S - 1);
    this.seekSentence(i);
    this.kick();
  }
}
