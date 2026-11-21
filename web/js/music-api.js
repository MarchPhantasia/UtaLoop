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

export async function music(action, input = {}, signal) {
  const response = await fetch('/music/' + action, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
  const value = await response.json().catch(() => ({}));
  if (!response.ok || !Object.hasOwn(value, 'data')) {
    throw Error(value.error || '请通过 UtaLoop 本地服务打开，并确认音乐服务已启动');
  }
  return value.data;
}
