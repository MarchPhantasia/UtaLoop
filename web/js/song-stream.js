import { errorMessage } from './errors.js';

const BUFFER_TIMEOUT_MS = 15000;

/** Recover one interrupted network stream in place, independently of its lyric track. */
export function createSongStream(audio, { getSource, setSource, seek, play, feedback }) {
  let current, timer;
  const stopWatching = () => { clearTimeout(timer); timer = undefined; };
  const watching = state => state === current && state?.remote && !state.request && !state.failed;
  const needsData = () => audio.readyState < 1 || ((!audio.paused || audio.seeking) && audio.readyState < 3);

  function watch() {
    const state = current;
    if (timer || !watching(state) || !needsData()) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (watching(state) && needsData()) onInterruption(state, '音频缓冲超时。');
    }, BUFFER_TIMEOUT_MS);
  }

  function fail(state, text) {
    if (state !== current) return;
    stopWatching();
    state.failed = true;
    feedback(text, () => {
      if (state !== current || state.request) return;
      state.recovered = false;
      void load(state);
    });
  }

  async function load(state, prepared, standard = false) {
    stopWatching();
    const request = state.request = new AbortController();
    const { signal } = request;
    state.failed = false;
    feedback(state.recovered || state.resume ? '正在重新连接音源…' : '正在获取音源…');
    try {
      const source = prepared || await getSource(state.song, signal, standard);
      signal.throwIfAborted();
      if (state !== current) return;
      if (!source.blob && !source.url) throw Error('没有取得可播放的音源');
      state.remote = !!source.url && !source.blob;
      await setSource(source);
      if (state !== current || signal.aborted) return;
      state.request = null;
      feedback('');
      watch();
    } catch (error) {
      if (state !== current || signal.aborted) return;
      state.request = null;
      fail(state, errorMessage(error, '音源加载失败，请重试。'));
    }
  }

  function onInterruption(state, text, standard = false) {
    if (!watching(state)) return;
    state.resume ||= {
      at: audio.readyState >= 1 || audio.currentTime > 0 ? audio.currentTime : null,
      playing: !audio.ended && (!audio.paused || state.playing),
    };
    audio.pause();
    if (state.recovered) { fail(state, text); return; }
    state.recovered = true;
    void load(state, undefined, standard);
  }

  for (const event of ['waiting', 'stalled', 'seeking']) audio.addEventListener(event, watch);
  audio.addEventListener('play', () => {
    if (current) current.playing = true;
    watch();
  });
  audio.addEventListener('pause', () => {
    if (current && !audio.error) current.playing = false;
    if (audio.readyState >= 1) stopWatching();
  });
  for (const event of ['canplay', 'playing', 'ended']) audio.addEventListener(event, stopWatching);
  audio.addEventListener('loadedmetadata', () => {
    stopWatching();
    if (!watching(current) || !current.resume) { watch(); return; }
    const { at, playing } = current.resume;
    current.resume = null;
    if (at !== null) seek(at);
    if (playing) void play();
    watch();
  });

  function close() {
    stopWatching();
    current?.request?.abort();
    current = undefined;
    feedback('');
  }

  return {
    open(song, source) {
      close();
      current = { song, remote: false, recovered: false };
      void load(current, source);
    },
    close,
    suspend() {
      stopWatching();
      if (!current?.request) return;
      current.request.abort();
      current.request = null;
      fail(current, '音源加载中断，请重试。');
    },
    watch,
    blocked: () => !!(current?.request || current?.failed),
    mediaError() {
      if (!current?.remote) return false;
      const code = audio.error?.code;
      if (code && code !== 1) {
        onInterruption(current, '音频加载失败，请重试。', code === 3 || code === 4);
      }
      return true;
    },
  };
}
