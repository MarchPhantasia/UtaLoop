import { enterView } from './motion.js';
import { $ } from './util.js';

export const SONG_VOLUME_KEY = 'utaloop.volume.v1';

export function bindVolume(media) {
  const slider = document.getElementById('songVolume');
  const output = document.getElementById('volumeValue');
  const mute = document.getElementById('mute');
  function render() {
    const level = Math.round(media.volume * 100);
    slider.value = String(level);
    slider.style.setProperty('--volume-fill', level + '%');
    output.value = media.muted ? '静音' : level + '%';
    mute.setAttribute('aria-pressed', String(media.muted));
    mute.title = media.muted ? '取消静音' : '静音';
    mute.setAttribute('aria-label', mute.title);
  }
  function save() {
    try { localStorage.setItem(SONG_VOLUME_KEY, JSON.stringify({ gain: media.volume, muted: media.muted })); } catch {}
  }
  try {
    const saved = JSON.parse(localStorage.getItem(SONG_VOLUME_KEY));
    if (Number.isFinite(saved?.gain)) media.volume = Math.max(0, Math.min(1, saved.gain));
    if (typeof saved?.muted === 'boolean') media.muted = saved.muted;
  } catch {}
  slider.addEventListener('input', () => {
    const wanted = Number(slider.value) / 100;
    if (media.muted) media.muted = false;
    media.volume = wanted;
    render();
    if (Math.abs(media.volume - wanted) > .01) {
      slider.disabled = true;
      output.value = '请用设备音量键';
    }
  });
  slider.addEventListener('change', save);
  mute.addEventListener('click', () => { media.muted = !media.muted; render(); save(); });
  media.addEventListener('volumechange', render);
  render();
}

/** 轻量浮层，调节时仍可听歌和看歌词。 */
export function bindLyricSync(onStep) {
  const root = $('lyricSync'), trigger = $('btnLyricSync'), panel = $('lyricSyncPanel');
  const earlier = $('lyricSyncEarlier'), later = $('lyricSyncLater'), reset = $('lyricSyncReset'), output = $('lyricSyncValue');

  function close() {
    if (panel.hidden) return false;
    const focused = panel.contains(document.activeElement);
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (focused && !root.hidden) trigger.focus({ preventScroll: true });
    return true;
  }

  trigger.onclick = () => {
    if (close()) return;
    panel.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    enterView(panel, 'up');
  };
  earlier.onclick = () => onStep(-1);
  later.onclick = () => onStep(1);
  reset.onclick = () => {
    const focused = document.activeElement === reset;
    onStep(0);
    if (focused) earlier.focus({ preventScroll: true });
  };
  document.addEventListener('pointerdown', (event) => {
    if (!root.contains(event.target)) close();
  });
  window.addEventListener('pagehide', close);

  return {
    close,
    paint(offset, available) {
      root.hidden = !available;
      if (!available) close();
      trigger.classList.toggle('has-offset', offset !== 0);
      reset.disabled = offset === 0;
      const direction = offset < 0 ? '提前 ' : offset > 0 ? '延后 ' : '';
      output.value = direction + (Math.abs(offset) / 1000).toFixed(1) + ' 秒';
    },
  };
}
