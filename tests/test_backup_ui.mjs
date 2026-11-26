import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { outputFiles } = await build({
  stdin: { contents: `export { openBackupImport, openFileRepair } from './web/js/backup-ui.js';`, resolveDir: root },
  bundle: true, write: false, format: 'iife', globalName: 'RepairTest',
  plugins: [{ name: 'repair-storage', setup(b) {
    b.onResolve({ filter: /^\.\/library\.js$/ }, () => ({ path: 'library', namespace: 'repair' }));
    b.onLoad({ filter: /.*/, namespace: 'repair' }, () => ({ contents: `
      export const AUDIO_ACCEPT = '', SUB_EXT = ['srt'];
      export const attachFiles = (...args) => window.attachFiles(...args);
      export const flushPositions = async () => {};
      export const listTracks = async () => [];
      export const missingFiles = records => records.flatMap(r => ['audio','transcript']
        .filter(kind => r[kind]?.missing).map(kind => ({id:r.id,kind,name:r[kind].name})));
      export const matchFiles = (records,files) => ({ matches: missingFiles(records)
        .flatMap(item => files.filter(f => f.name === item.name).map(file => ({...item,file}))), ambiguous:[], unmatched:[] });
    ` }));
  } }],
});
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('backup import previews service addresses and requires a fresh choice for each file', async (t) => {
  const dom = new JSDOM('<body></body>', { url: 'https://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(outputFiles[0].text);
  w.RepairTest.openBackupImport();
  const input = w.document.querySelector('input[type=file]');
  const toggle = w.document.querySelector('button[aria-label="恢复服务配置"]');
  assert.equal(toggle.disabled, true);
  const selectBackup = async (hostname) => {
    const backup = { format: 'linguatrack.user-data', version: 1, exportedAt: '2026-11-26T00:00:00Z',
      includesCredentials: true, localStorage: { 'linguatrack.config.v1': JSON.stringify({
        apiBase: 'https://' + hostname + '/analyzer', apiToken: 'sample-token',
        asrBaseUrl: 'https://speech.example/v1', baseUrl: 'https://model.example/v1',
      }) }, stores: { tracks: [], data: [], tr: [], word: [], chat: [], kv: [] } };
    Object.defineProperty(input, 'files', {
      configurable: true, value: [{ name: 'backup.json', text: async () => JSON.stringify(backup) }],
    });
    input.dispatchEvent(new w.Event('change'));
    await flush();
  };
  await selectBackup('analysis.example');
  assert.equal(toggle.disabled, false);
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  const preview = w.document.querySelector('.transfer');
  for (const url of ['https://analysis.example/analyzer', 'https://speech.example/v1', 'https://model.example/v1']) {
    assert.ok(preview.textContent.includes(url));
  }
  assert.ok(!preview.textContent.includes('sample-token'));
  toggle.click();
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  await selectBackup('other.example');
  assert.ok(preview.textContent.includes('https://other.example/analyzer'));
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
});

for (const batch of [true, false]) test(`${batch ? 'batch' : 'single'} repair retains picker access until writes complete`, async (t) => {
  const dom = new JSDOM('<body></body>', { url: 'https://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  t.after(() => dom.window.close());
  const w = dom.window;
  w.eval(outputFiles[0].text);
  let records = ['one', 'two'].map((id) => ({ id, title: id, audio: { name: id + '.mp4', missing: true } }));
  let release;
  const writes = [], updates = [];
  w.attachFiles = async (id, files) => {
    assert.equal(input.isConnected, true);
    assert.equal(cleared, false);
    writes.push(id);
    await new Promise((resolve) => { release = resolve; });
    const updated = { ...records.find((r) => r.id === id), audio: { name: files.audio.name, missing: false } };
    records = records.map((r) => r.id === id ? updated : r);
    return updated;
  };
  w.RepairTest.openFileRepair(records, { onUpdate: (record) => {
    assert.equal(writes.length, batch ? 2 : 1, 'updates must not reload before all files are saved');
    updates.push(record.id);
  } });
  const input = w.document.querySelector(batch ? 'input[multiple]' : '.transfer-file input');
  let cleared = false;
  Object.defineProperty(input, 'value', { get: () => '', set: () => { cleared = true; } });
  Object.defineProperty(input, 'files', { value: (batch ? records : records.slice(0, 1))
    .map((r) => new w.File(['video'], r.audio.name, { type: 'video/mp4' })) });
  input.dispatchEvent(new w.Event('change'));
  assert.equal(cleared, false);
  assert.equal(writes.length, 1);
  release(); await flush();
  if (batch) { assert.equal(writes.length, 2); assert.equal(cleared, false); release(); await flush(); }
  assert.equal(cleared, true);
  assert.equal(updates.length, batch ? 2 : 1);
  assert.match(w.document.querySelector('.transfer').textContent, new RegExp(`已补充 ${batch ? 2 : 1} 个文件`));
});
