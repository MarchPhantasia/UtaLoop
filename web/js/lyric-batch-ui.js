import { llmReady, loadConfig } from './config.js';
import { LLMError } from './llm.js';
import { annotateLyricDictionary, lyricReviewPackage, lyricReviewTrack, parseLyricReview,
  reviewLyricsWithModel, saveLyricReview, unverifiedLyricLines } from './lyric-review.js';
import { studyKey } from './music-study.js';
import { saveFile } from './native.js';
import { isDegraded } from './store.js';
import { el } from './util.js';

const $ = id => document.getElementById(id);

export function openLyricBatch(songs, { loadSongLyrics, trigger }) {
  loadConfig();
  const dialog = $('lyric-batch');
  const actions = ['batch-dictionary', 'batch-export', 'batch-model'].map($);
  const done = $('batch-done'), fileInput = $('batch-file'), settings = $('batch-model-settings');
  const status = $('batch-status'), errors = $('batch-errors');
  const picker = $('batch-pick'), toggle = $('batch-toggle');
  let job;
  const rows = songs.map(song => {
    const label = el('label', 'batch-song');
    const input = el('input');
    input.type = 'checkbox'; input.checked = true;
    label.append(input, el('span', '', song.name), el('small', '', song.artist || ''));
    return { song, input, label };
  });
  $('batch-songs').replaceChildren(...rows.map(({ label }) => label));
  picker.hidden = !rows.length;
  status.textContent = rows.length ? '' : '这份清单还没有歌曲';
  errors.hidden = true; errors.replaceChildren();
  $('batch-model').hidden = !llmReady(); settings.hidden = llmReady();

  const selected = () => rows.filter(({ input }) => input.checked).map(({ song }) => song);
  function paint() {
    const count = selected().length;
    $('batch-count').textContent = `已选 ${count} / ${rows.length} 首`;
    toggle.textContent = count === rows.length ? '取消全选' : '全选';
    picker.disabled = !!job;
    for (const button of actions) button.disabled = !!job || !count;
    $('batch-import').disabled = !!job;
    $('batch-close').disabled = !!job;
    settings.inert = !!job;
    done.textContent = job ? '停止' : '完成';
  }
  picker.onchange = paint;
  toggle.onclick = () => {
    const check = selected().length !== rows.length;
    for (const { input } of rows) input.checked = check;
    paint();
  };

  async function process(items, signal, label, task) {
    let completed = 0, lines = 0;
    for (const [i, item] of items.entries()) {
      if (signal.aborted) break;
      const name = item.name || item.title;
      const title = `${label} ${i + 1} / ${items.length} · ${name}`;
      status.textContent = title;
      try {
        lines += await task(item, title);
        completed++;
      } catch (error) {
        if (signal.aborted) break;
        errors.append(el('li', '', `「${name}」${error.message}`));
        errors.hidden = false;
        if (error instanceof LLMError) break;
      }
    }
    return { completed, lines, total: items.length };
  }

  function summarize({ completed, lines, total }, signal, action) {
    const stopped = signal.aborted ? '已停止 · ' : '';
    const detail = action === '词典' ? `补齐 ${lines} 行` : `更新 ${lines} 行`;
    const save = lines && isDegraded() ? ' · 当前仅暂存' : '';
    return `${stopped}已处理 ${completed} / ${total} 首 · ${detail}${save}`;
  }

  async function run(task) {
    if (job) return;
    job = new AbortController();
    errors.hidden = true; errors.replaceChildren();
    status.textContent = '正在准备…';
    paint();
    done.disabled = false; done.focus({ preventScroll: true });
    try { status.textContent = await task(job.signal); }
    catch (error) { status.textContent = job.signal.aborted ? '已停止' : error.message; }
    finally { job = undefined; done.disabled = false; paint(); }
  }

  $('batch-dictionary').onclick = () => run(async signal => {
    const result = await process(selected(), signal, '正在标注', async song => {
      const data = await loadSongLyrics(song, signal);
      return annotateLyricDictionary(studyKey(song), data, { signal, missingOnly: true });
    });
    return summarize(result, signal, '词典');
  });
  $('batch-export').onclick = () => run(async signal => {
    const tracks = [];
    const result = await process(selected(), signal, '正在整理', async song => {
      const data = await loadSongLyrics(song, signal);
      tracks.push(lyricReviewTrack(studyKey(song), data, { title: song.name, artist: song.artist }));
      return 0;
    });
    if (signal.aborted) return '已停止导出';
    if (!tracks.length) return '没有可导出的歌词';
    const bundle = new Blob([JSON.stringify(lyricReviewPackage(tracks), null, 2)], { type: 'application/json' });
    await saveFile(bundle, 'UtaLoop-歌词校对包.json');
    return `已准备 ${result.completed} / ${result.total} 首 · 请查看下载的 JSON 校对包`;
  });
  $('batch-model').onclick = () => run(async signal => {
    const result = await process(selected(), signal, '正在校对', async (song, title) => {
      const data = await loadSongLyrics(song, signal);
      return reviewLyricsWithModel(studyKey(song), data, { signal,
        onProgress: (part, total, retry) => {
          status.textContent = `${title} · 第 ${part} / ${total} 批${retry ? ' · 重试校验异常的行' : ''}`;
        },
        onUnverified(issues) {
          if (!issues.length) return;
          errors.append(el('li', '', `「${song.name}」${unverifiedLyricLines(issues)}`));
          errors.hidden = false;
        } });
    });
    return summarize(result, signal, '模型');
  });

  $('batch-import').onclick = () => fileInput.click();
  fileInput.onchange = () => {
    const [file] = fileInput.files;
    fileInput.value = '';
    if (!file) return;
    void run(async signal => {
      const raw = await file.text();
      let value;
      try { value = JSON.parse(raw); } catch { throw Error('文件无法读取，请选择有效的 JSON 校对包'); }
      const tracks = parseLyricReview(value);
      if (!tracks.length) return '文件中还没有待导入的校对结果';
      const result = await process(tracks, signal, '正在导入', ({ id, lines }) => saveLyricReview(id, lines, { signal }));
      return summarize(result, signal, '导入');
    });
  };

  function close() { if (!job) dialog.close(); }
  $('batch-close').onclick = close;
  done.onclick = () => {
    if (!job) { close(); return; }
    job.abort(); done.disabled = true;
    status.textContent = '正在停止…';
  };
  dialog.oncancel = event => { event.preventDefault(); close(); };
  const page = new AbortController();
  window.addEventListener('pagehide', () => job?.abort(), { signal: page.signal });
  dialog.onclose = () => { page.abort(); trigger.focus({ preventScroll: true }); };
  paint();
  dialog.showModal();
  $('batch-title').focus({ preventScroll: true });
}
