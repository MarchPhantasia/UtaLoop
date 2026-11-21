import { isDegraded, updateRecord } from './store.js';
import { setSungReading, sungReadingTargets } from './music-lyrics.js';
import { annotateLyricDictionary, reviewLyricsWithModel, unverifiedLyricLines } from './lyric-review.js';
import { group, actionRow, button, buttonBar, inputField, segRow } from './rows.js';
import { openSheet, closeSheet } from './sheet.js';
import { llmReady } from './config.js';
import { el, toast } from './util.js';
import { errorMessage } from './errors.js';

export function annotationSheet(id, data, index, onSaved, { onBack, setBusy }) {
  const row = data.sentences[index];
  const targets = sungReadingTargets(row);
  let job, closed = false;
  const lifecycle = new AbortController();
  const feedback = el('div', 'lyric-calibration-feedback');
  feedback.hidden = true;
  const status = el('p');
  status.setAttribute('role', 'status');
  status.setAttribute('tabindex', '-1');
  const stop = button('停止校准', { onPick: () => {
    job?.abort();
    stop.disabled = true;
    status.textContent = '正在停止…';
    status.focus({ preventScroll: true });
  } });
  stop.hidden = true;
  feedback.append(status, stop);

  async function run(task) {
    setBusy(true);
    closeSheet();
    try {
      const message = await task();
      await onSaved();
      toast(message || '已保存本句的分词与假名');
    } catch (error) { toast(error.message); }
    finally { setBusy(false); }
  }
  const songAction = actionRow('用大模型校准整首', '分批校准日语分词、假名和词性', { onPick: reviewSong });
  const options = group(
    targets.length && actionRow('手动校正唱法', '修改本句里一个词的假名和罗马音，保存在本机', {
      onPick: () => openSungReadingEditor(id, index, row, targets, onSaved) }),
    actionRow('用词典标注整首', '使用已配置的词典分析后端，保留已校准的唱法', {
      onPick: () => run(async () => {
        const count = await annotateLyricDictionary(id, data);
        return count ? `词典已标注 ${count} 行` : '没有需要更新的日语歌词';
      }) }),
    songAction,
    row.annotation !== 'review' && actionRow('用大模型校准本句', '将本句歌词、现有标注及少量前后句发送至已配置的接口', {
      onPick: () => llmReady() ? run(async () => {
        const count = await reviewLyricsWithModel(id, data, { index });
        return count ? '已保存本句的分词与假名' : '本句没有需要保存的校对结果';
      }) : toast('请先在「设置 → AI 助学」配置接口与模型') })
  );
  const body = el('div');
  body.append(options, feedback);
  openSheet('日语歌词标注', body, { actions: [button('返回', { glyph: 'i-back', onPick: onBack })],
    onClose: () => { closed = true; job?.abort(); lifecycle.abort(); } });
  window.addEventListener('pagehide', () => job?.abort(), { signal: lifecycle.signal });

  async function reviewSong() {
    if (job) return;
    feedback.hidden = false;
    if (!llmReady()) {
      status.textContent = '请先在「设置 → AI 助学」配置接口与模型';
      return;
    }
    job = new AbortController();
    const { signal } = job;
    setBusy(true);
    const controls = [...options.querySelectorAll('button')];
    for (const control of controls) control.disabled = true;
    stop.hidden = stop.disabled = false;
    status.textContent = '正在准备整首校准…';
    stop.focus({ preventScroll: true });
    let issues = [];
    try {
      const count = await reviewLyricsWithModel(id, data, {
        signal,
        onProgress(part, total, retry) {
          status.textContent = retry ? `第 ${part} / ${total} 批 · 重试校验异常的行`
            : `正在校准第 ${part} / ${total} 批…`;
        },
        onUnverified: value => { issues = value; },
      });
      if (count) data = await onSaved(null, true) || data;
      const summary = count ? `已${isDegraded() ? '暂存' : '更新'} ${count} 行` : '没有需要保存的改动';
      status.textContent = [summary, unverifiedLyricLines(issues)].filter(Boolean).join('。');
    } catch (error) {
      status.textContent = signal.aborted ? '已停止校准' : errorMessage(error, '整首校准失败，请重试');
    } finally {
      job = null;
      setBusy(false);
      const restoreFocus = !closed && [stop, status].includes(document.activeElement);
      stop.hidden = true;
      for (const control of controls) control.disabled = false;
      if (restoreFocus) songAction.focus({ preventScroll: true });
    }
  }
}

function openSungReadingEditor(id, index, row, targets, onSaved) {
  let target = targets[0], busy = false;
  const body = el('div', 'sung-reading-editor');
  const line = el('p', 'sung-reading-line', row.text);
  line.lang = 'ja';
  const field = inputField('唱法假名', { value: target.read, onInput: paintPreview });
  field.input.lang = 'ja';
  const preview = el('p', 'field-hint');
  preview.setAttribute('aria-live', 'polite');
  const status = el('p', 'field-hint');
  status.setAttribute('role', 'status');
  const picker = segRow('选择词语', '', () => target.from, (from) => {
    target = targets.find(option => option.from === from);
    field.input.value = target.read;
    restore.hidden = !target.custom;
    paintPreview();
  }, targets.map(({ from, text }) => [from, text]), { wrap: true });
  picker.querySelectorAll('button').forEach(b => { b.lang = 'ja'; });
  body.append(line, group(picker), field, preview, status);
  const restore = button('恢复自动标注', { onPick: () => submit(null) });
  restore.hidden = !target.custom;
  const save = button('保存唱法', { main: true, onPick: () => submit(field.input.value) });
  paintPreview();
  const view = openSheet('手动校正唱法', body, {
    footer: buttonBar(restore, save), onBeforeClose: () => !busy,
  });

  function paintPreview() {
    status.textContent = '';
    field.input.removeAttribute('aria-invalid');
    let roman = '';
    try {
      const next = setSungReading(row, target, field.input.value);
      roman = sungReadingTargets(next).find(option => option.from === target.from)?.roman;
    } catch { /* Show the validation message if the user submits. */ }
    preview.textContent = roman ? '罗马音 · ' + roman : '';
  }

  async function submit(value) {
    if (busy) return;
    try { setSungReading(row, target, value); }
    catch (error) {
      status.textContent = error.message;
      field.input.setAttribute('aria-invalid', 'true');
      field.input.focus();
      return;
    }
    busy = true;
    const controls = [...body.querySelectorAll('button, input'), restore, save];
    controls.forEach(control => { control.disabled = true; });
    try {
      const updated = await updateRecord('data', id, data => {
        const current = data.sentences[index];
        if (!current || current.text !== row.text || current.start !== row.start ||
            JSON.stringify(current.words) !== JSON.stringify(row.words))
          throw new Error('本句歌词已更新，请重新打开唱法校正');
        const sentences = [...data.sentences];
        sentences[index] = setSungReading(current, target, value);
        return { ...data, sentences, hasWordTiming: sentences.some(s => s.wordTiming) };
      });
      if (!updated) throw new Error('本机未找到这首歌的歌词');
      await onSaved(updated);
      view.close();
      toast(isDegraded() ? '已暂存唱法，当前浏览器无法长期保存' : value === null ? '已恢复自动标注' : '唱法已保存在本机');
    } catch (error) { status.textContent = error.message; }
    finally {
      busy = false;
      controls.forEach(control => { control.disabled = false; });
    }
  }
}
