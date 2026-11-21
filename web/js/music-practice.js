import { showCover } from './music-art.js';
import { enterView } from './motion.js';
import { randomId } from './util.js';
import { backWithFallback, writeHistory } from './navigation.js';

const frameId = 'music-practice-frame';
export const PRACTICE_BACK = 'utaloop:practice-back';
export const PRACTICE_STATE = 'utaloop:practice-state';

export function embeddedMusicFrame() {
  const frame = window.frameElement;
  return frame?.id === frameId ? frame : null;
}

export function musicPracticeParams(search) {
  const params = new URLSearchParams(search);
  return params.get('from') === 'music' && params.get('track') ? params : null;
}

export function musicBrowseURL(params, href) {
  const url = new URL('music.html', href);
  const source = params.get('browse');
  if (source?.startsWith('#')) {
    url.hash = source;
    return url;
  }
  const collection = params.get('collection');
  const playlist = params.get('playlist');
  if (['likes', 'learning', 'learned', 'recent'].includes(collection)) url.hash = collection;
  if (collection === 'playlist' && /^\d{1,20}$/.test(playlist || '')) url.hash = 'playlist?id=' + playlist;
  return url;
}

export function musicURLForPractice(params, href) {
  const url = musicBrowseURL(params, href);
  url.search = params.toString();
  return url;
}

/** Keep the same practice document alive when showing the music library. */
export function mountMusicPractice(onBrowse) {
  const $ = id => document.getElementById(id);
  const mini = $('music-mini'), backToSong = $('music-mini-return'), toggle = $('music-mini-toggle');
  const title = $('music-mini-title'), artist = $('music-mini-artist'), image = $('music-mini-cover');
  const library = [document.querySelector('.mast'), document.querySelector('main')];
  const libraryTitle = document.title;
  let frame, session, activeParams, snapshot, artwork;
  let visible = false, hasBrowseEntry = false;

  function viewURL(params) {
    const url = new URL(location.href);
    url.search = params?.toString() || '';
    return url;
  }

  function paint() {
    const showMini = !visible && !!snapshot;
    const appeared = showMini && mini.hidden;
    mini.hidden = !showMini;
    document.body.toggleAttribute('data-mini-player', showMini);
    document.title = visible && snapshot?.title ? snapshot.title + ' · UtaLoop' : libraryTitle;
    if (!showMini) return;
    title.textContent = snapshot.title;
    artist.textContent = snapshot.artist;
    backToSong.setAttribute('aria-label', '回到练唱 · ' + snapshot.title);
    toggle.disabled = !snapshot.ready;
    toggle.setAttribute('aria-label', snapshot.playing ? '暂停音乐' : '播放音乐');
    toggle.classList.toggle('is-playing', snapshot.playing);
    const coverKey = snapshot.params.get('track') + '|' + snapshot.cover;
    if (artwork !== coverKey) {
      artwork = coverKey;
      image.removeAttribute('src');
      showCover(image, { cover: snapshot.cover, id: snapshot.musicId, pixels: 112 });
    }
    if (appeared) enterView(mini, 'up');
  }

  function loadFrame(params, key) {
    frame?.remove();
    snapshot = artwork = null;
    session = key;
    activeParams = params;
    const playerURL = new URL('player.html', location.href);
    playerURL.search = params.toString();
    frame = document.createElement('iframe');
    frame.id = frameId;
    frame.title = '练唱';
    frame.allow = 'autoplay';
    frame.src = playerURL.href;
    document.body.append(frame);
  }

  function show(params, key) {
    const wasVisible = visible;
    visible = !!params;
    if (visible) {
      if (!frame || key !== session) loadFrame(params, key);
    }
    if (frame) frame.hidden = !visible;
    for (const element of library) element.inert = visible;
    paint();
    if (visible && !wasVisible) frame.focus({ preventScroll: true });
    if (!visible && wasVisible) {
      if (!mini.hidden) backToSong.focus({ preventScroll: true });
      onBrowse();
    }
  }

  function sync() {
    const params = musicPracticeParams(location.search), key = history.state?.musicPractice;
    hasBrowseEntry = !!params && !!key;
    show(params, key);
    if (hasBrowseEntry && params.toString() !== activeParams.toString()) {
      writeHistory('replaceState', history.state, viewURL(activeParams));
    }
  }

  function open(params, key = randomId()) {
    const created = writeHistory('pushState', { ...history.state, musicPractice: key }, viewURL(params));
    hasBrowseEntry = created && history.state?.musicPractice === key;
    show(params, key);
  }

  function browse() {
    const url = viewURL(null), state = { ...history.state };
    delete state.musicPractice;
    if (url.href !== location.href && !writeHistory('replaceState', state, url)) {
      location.replace(url.href);
      return;
    }
    hasBrowseEntry = false;
    show(null);
  }

  backToSong.onclick = () => open(activeParams, session);
  toggle.onclick = () => frame?.contentDocument?.getElementById('btnPlay')?.click();
  window.addEventListener('popstate', sync);
  window.addEventListener('message', event => {
    if (!frame || event.origin !== location.origin || event.source !== frame.contentWindow) return;
    const data = event.data;
    if (data?.type === PRACTICE_BACK) {
      if (visible) {
        if (hasBrowseEntry) backWithFallback(browse, () => visible);
        else browse();
      }
      return;
    }
    if (data?.type !== PRACTICE_STATE) return;
    const params = musicPracticeParams(data.query);
    if (!params) return;
    activeParams = params;
    snapshot = { ...data, params };
    if (visible && viewURL(params).href !== location.href && (hasBrowseEntry || location.search)) {
      writeHistory('replaceState', history.state, viewURL(params));
    }
    paint();
  });

  const initial = musicPracticeParams(location.search);
  if (initial && !history.state?.musicPractice) {
    if (writeHistory('replaceState', history.state, viewURL(null))) open(initial);
    else show(initial, randomId());
  } else sync();
  return { open };
}
