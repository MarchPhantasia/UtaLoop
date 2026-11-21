/** History metadata is optional. A browser rejecting it must not stop the view change. */
export function writeHistory(method, state, url = location.href) {
  const target = new URL(url, location.href).href;
  try {
    history[method](state, '', target);
    return location.href === target;
  } catch (error) {
    if (error?.name !== 'SecurityError') throw error;
    return false;
  }
}

export function canReturnTo(target) {
  const navigation = window.navigation;
  const entry = navigation?.currentEntry;
  const url = entry && typeof navigation.entries === 'function'
    ? navigation.entries()[entry.index - 1]?.url
    : history.length > 1 && document.referrer;
  if (!url) return false;
  const from = new URL(url);
  return from.origin === target.origin && (
    from.pathname === target.pathname
    || (target.pathname.endsWith('/index.html') && from.pathname === new URL('./', target).pathname)
  );
}

let returning = false;

/** Ignore repeated clicks and recover if the platform accepts Back without moving. */
export function backWithFallback(fallback, stays) {
  if (returning) return;
  returning = true;
  const start = location.href;
  const stillHere = stays || (() => location.href === start);
  const finish = () => {
    returning = false;
    clearTimeout(timer);
    window.removeEventListener('pagehide', finish);
    window.removeEventListener('popstate', moved);
    window.removeEventListener('hashchange', moved);
  };
  const moved = () => { if (!stillHere()) finish(); };
  const recover = () => {
    const stayed = stillHere();
    finish();
    if (stayed) fallback();
  };
  const timer = setTimeout(recover, 550);
  window.addEventListener('pagehide', finish, { once: true });
  window.addEventListener('popstate', moved);
  window.addEventListener('hashchange', moved);
  try { history.back(); }
  catch { recover(); }
}
