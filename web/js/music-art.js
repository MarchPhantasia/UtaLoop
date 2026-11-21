import { music } from './music-api.js';

// A virtual list mounts neighbouring rows together. Look up their missing art
// in one batch, sharing requests when the same song appears twice.
const pending = new Map();
const queue = new Set();
const bindings = new WeakMap();
let timer;

async function flush() {
  timer = null;
  const ids = [...queue].slice(0, 32);
  for (const id of ids) queue.delete(id);
  if (queue.size) timer = setTimeout(flush, 16);
  let covers = {};
  try { covers = await music('artwork', { ids }); } catch { /* Keep the sleeve. */ }
  for (const id of ids) {
    pending.get(id).resolve(covers?.[id] || '');
    pending.delete(id);
  }
}

function lookupSong(id) {
  id = String(id);
  if (!pending.has(id)) {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    pending.set(id, { promise, resolve });
    queue.add(id);
    if (!timer) timer = setTimeout(flush, 16);
  }
  return pending.get(id).promise;
}

function thumbnail(source, pixels) {
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname.endsWith('.music.126.net') ||
        url.username || url.password || url.port) return '';
    url.protocol = 'https:';
    url.searchParams.set('param', pixels + 'y' + pixels);
    return url.href;
  } catch { return ''; }
}

// The image sits over a fixed-size sleeve so late or broken artwork never
// moves the surrounding song title. A failed URL gets one metadata lookup.
export function showCover(image, { cover, id, kind = 'song', pixels, onFound, signal }) {
  const binding = {};
  bindings.set(image, binding);
  const active = () => !signal?.aborted && image.isConnected && bindings.get(image) === binding;
  image.alt = '';
  image.decoding = 'async';
  image.referrerPolicy = 'no-referrer';
  image.style.opacity = '0';
  let attempted = false;
  async function recover() {
    image.style.opacity = '0';
    if (attempted || !id || !active()) return;
    attempted = true;
    try {
      const found = kind === 'playlist' ? await music('artwork', { id, kind }, signal) : await lookupSong(id);
      if (active() && found && thumbnail(found, pixels) !== image.getAttribute('src')) display(found);
    } catch { /* Keep the sleeve on a failed lookup. */ }
  }
  function display(url) {
    const src = thumbnail(url, pixels);
    if (!src) return;
    image.onload = () => {
      if (!active()) return;
      image.style.opacity = '1';
      if (url !== cover) onFound?.(url);
    };
    image.onerror = recover;
    image.src = src;
  }
  if (thumbnail(cover, pixels)) display(cover);
  else if (id) {
    // Native lazy loading also schedules the lookup for a missing thumbnail.
    // A detached virtual row needs no observer or explicit teardown.
    image.onload = recover;
    image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
  }
}
