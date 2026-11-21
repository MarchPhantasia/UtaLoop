const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { randomBytes, createHash, createCipheriv, createDecipheriv } = require('node:crypto');

const lifetime = 30 * 86400_000;
const marker = Buffer.from('UTA2');
const headerSize = marker.length + 8;
const dataHome = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
const unknownFormat = bytes => /^UTA[0-9A-Z]$/.test(bytes.subarray(0, marker.length).toString('latin1'))
  && !bytes.subarray(0, marker.length).equals(marker);

// The browser holds the random 256-bit key in its HttpOnly cookie. The service
// stores only the authenticated ciphertext at a one-way hash of that key.
function sessionStore(directory = path.join(dataHome, 'UtaLoop', 'sessions')) {
  const valid = token => typeof token === 'string' && /^[A-Za-z0-9_-]{43}$/.test(token);
  const filename = token => path.join(directory, createHash('sha256').update(token).digest('hex') + '.session');
  function remove(token) {
    if (valid(token)) fs.rmSync(filename(token), { force: true });
  }
  function save(token, cookie, until, mode = '30d') {
    if (!valid(token) || !cookie) throw Error('无效的登录会话');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(token, 'base64url'), nonce);
    // An authenticated public deadline lets cleanup work without the browser's key.
    const header = Buffer.alloc(headerSize);
    marker.copy(header);
    header.writeDoubleBE(until, marker.length);
    cipher.setAAD(header);
    const payload = Buffer.concat([cipher.update(JSON.stringify({ cookie, until, mode }), 'utf8'), cipher.final()]);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = filename(token), temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      fs.writeFileSync(temp, Buffer.concat([header, nonce, cipher.getAuthTag(), payload]), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  }
  function load(token) {
    if (!valid(token)) return null;
    let bytes;
    try { bytes = fs.readFileSync(filename(token)); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    try {
      const offset = bytes.subarray(0, marker.length).equals(marker) ? headerSize : 0;
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(token, 'base64url'), bytes.subarray(offset, offset + 12));
      if (offset) decipher.setAAD(bytes.subarray(0, offset));
      decipher.setAuthTag(bytes.subarray(offset + 12, offset + 28));
      const value = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(offset + 28)), decipher.final()]));
      if (value.until > Date.now() && typeof value.cookie === 'string' && value.cookie) {
        return { ...value, mode: value.mode || '30d' };
      }
    } catch { /* Unreadable or unauthenticated contents require a new login. */ }
    // The pre-UTA2 format had a random nonce at byte zero, so try that reader
    // first. If neither reader succeeds, a newer header must survive rollback.
    if (unknownFormat(bytes)) throw Error('此登录凭证由新版 UtaLoop 保存，请更新音乐服务后重试');
    remove(token);
    return null;
  }
  function prune() {
    let files;
    try { files = fs.readdirSync(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const name of files.filter(n => /^[a-f0-9]{64}\.session$/.test(n))) {
      const file = path.join(directory, name);
      const fd = fs.openSync(file, 'r');
      let until;
      try {
        const header = Buffer.alloc(headerSize);
        const size = fs.readSync(fd, header);
        if (unknownFormat(header.subarray(0, size))) continue;
        until = size === headerSize && header.subarray(0, marker.length).equals(marker)
          ? header.readDoubleBE(marker.length) : fs.fstatSync(fd).mtimeMs + lifetime;
      } finally { fs.closeSync(fd); }
      if (until <= Date.now()) fs.rmSync(file, { force: true });
    }
  }
  return { load, save, remove, prune };
}
module.exports = { sessionStore, lifetime };
