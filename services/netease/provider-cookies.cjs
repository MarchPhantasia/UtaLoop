// The SDK returns an array of Set-Cookie strings. Old QR records contain
// those strings joined with semicolons, including the Set-Cookie attributes.
const attributes = /^(?:path|domain|expires|max-age|samesite|secure|httponly|partitioned|priority)$/i;

function pairs(header) {
  const jar = new Map();
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (name && !attributes.test(name)) jar.set(name, part.slice(index + 1).trim());
  }
  return jar;
}

function applyCookies(current, sent, updates) {
  if (!Array.isArray(updates) || !updates.length) return current;
  const jar = pairs(current), original = pairs(sent);
  // Ignore late responses made with a previous login token.
  if (jar.get('MUSIC_U') !== original.get('MUSIC_U')) return current;
  const changed = new Set();
  for (const line of updates) {
    if (typeof line !== 'string') continue;
    const [pair, ...options] = line.split(';');
    const entry = pairs(pair).entries().next().value;
    if (!entry) continue;
    const [name, value] = entry;
    if (!changed.has(name) && jar.get(name) !== original.get(name)) continue;
    const age = options.find(option => /^\s*max-age=/i.test(option));
    const expiry = options.find(option => /^\s*expires=/i.test(option));
    const expired = age ? Number(age.split('=')[1]) <= 0
      : expiry && Date.parse(expiry.slice(expiry.indexOf('=') + 1)) <= Date.now();
    if (expired || !value) jar.delete(name);
    else jar.set(name, value);
    changed.add(name);
  }
  return Array.from(jar, entry => entry.join('=')).join('; ');
}

module.exports = { applyCookies, sdkCookies: header => Object.fromEntries(pairs(header)) };
