export const MUSIC_QUALITY_KEY = 'utaloop.music.quality.v1';
export const MUSIC_QUALITIES = Object.freeze({ standard: '标准', higher: '较高', exhigh: '极高', lossless: '无损', hires: 'Hi-Res' });

export function musicQuality() {
  try {
    const saved = localStorage.getItem(MUSIC_QUALITY_KEY);
    if (Object.hasOwn(MUSIC_QUALITIES, saved)) return saved;
  } catch { /* 本地存储可能被浏览器禁用。 */ }
  return 'standard';
}

export function saveMusicQuality(level) {
  if (!Object.hasOwn(MUSIC_QUALITIES, level)) return false;
  try {
    localStorage.setItem(MUSIC_QUALITY_KEY, level);
    return true;
  } catch { return false; }
}

const recoverableReads = new Set(['account', 'search', 'likes', 'folders', 'playlist', 'lyrics', 'source']);
const temporaryStatus = new Set([408, 500, 502, 503, 504]);

function musicError(message, temporary = false, status) {
  return Object.assign(Error(message), { temporary, status });
}

async function requestMusic(action, body, signal) {
  let response, value;
  try {
    response = await fetch('/music/' + action, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body, signal });
    value = await response.json().catch(error => {
      if (error.name !== 'SyntaxError') throw error;
      return null;
    });
  } catch (error) {
    signal?.throwIfAborted();
    throw musicError('无法连接音乐服务，请检查网络后重试', true);
  }
  signal?.throwIfAborted();
  if (!response.ok || !value || !Object.hasOwn(value, 'data')) {
    const status = response.status;
    throw musicError(value?.error || '暂时无法读取音乐服务，请稍后重试', temporaryStatus.has(status) || status === 429, status);
  }
  return value.data;
}

function retryDelay(signal) {
  return new Promise((resolve, reject) => {
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, 550);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function music(action, input = {}, signal) {
  const body = JSON.stringify(input);
  signal?.throwIfAborted();
  if (!recoverableReads.has(action) && (action !== 'retention' || Object.hasOwn(input, 'mode'))) {
    return requestMusic(action, body, signal);
  }
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    const timeout = setTimeout(() => controller.abort(musicError('音乐服务响应超时，请重试', true)), 12000);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      return await requestMusic(action, body, controller.signal);
    } catch (error) {
      signal?.throwIfAborted();
      if (!error?.temporary || error.status === 429 || attempt) throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }
    await retryDelay(signal);
    signal?.throwIfAborted();
  }
}
