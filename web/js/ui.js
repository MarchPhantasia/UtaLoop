/**
 * 播放页的浮层 —— 音频配置 / 倍速 / 逐词讲解面板.
 *
 * 显示类开关分两层: 「这条音频」的开关写进 `trackcfg`, 换音频互不影响;
 * 本页的字号也写进 `trackcfg`, 缺项继承语言默认值; 主题写进 `settings`。
 * 两边都通过各自的 onChange 回到 main.js,
 * 由它决定要不要整表重排。
 *
 * 开关清单是**按语言算出来的**: 这条音频支持哪些层 (`track.features` / `track.layers`)
 * 就只列哪些, 标题也用这门语言自己的说法 (日语「假名 / 罗马音」, 韩语「发音 / 罗马字」,
 * 英法德西「音标 / 原形」)。所以后端新增一门语言, 这个面板不用改。
 */

import { el, icon } from './util.js';
import { openSheet } from './sheet.js';
import { group, infoRow, navRow, sectionTitle, segRow, switchRow } from './rows.js';
import { normalizePlaybackRate, PLAYBACK_RATE_MAX, PLAYBACK_RATE_MIN, PLAYBACK_RATE_STEP,
  setSetting, settings } from './settings.js';
import { openFontSheet } from './font-settings.js';
import { openPronunciationSheet } from './pronunciation-settings.js';
import { setTrackCfg, SONG_PITCH_LIMIT, trackCfg } from './trackcfg.js';
import { openVideoSheet } from './video-settings.js';
import { aiSettingsEntry } from './ai-settings.js';
import { TARGET_LANGS } from './config.js';
import { featureText } from './langs.js';
import { favoriteButton } from './favorite-button.js';
import { createSentenceCard } from './reader.js';
import { cachedTranslation } from './translate.js';
import { sentenceAnalyzed } from './subtitle-edit.js';

const RATES = [PLAYBACK_RATE_MIN, 0.75, 1, 1.25, 1.5, PLAYBACK_RATE_MAX];
const THEMES = [['auto', '跟随系统'], ['light', '浅色'], ['dark', '深色']];

/** 词性图例: 只加 `p-<tag>` 类, 颜色由 reader.css 里的 --pc 决定. */
function legendCard(track) {
  const legend = el('div', 'legend');
  let n = 0;
  for (const [tag, info] of Object.entries(track.posLegend || {})) {
    if (tag === 'punct') continue;
    legend.append(el('span', 'gw-pos p-' + tag, info.label || tag));
    n++;
  }
  if (!n) return null;
  const row = el('div', 'row row-block');
  const box = el('div', 'row-label');
  box.append(el('b', null, '词性图例'));
  box.append(legend);
  row.append(box);
  return group(row);
}

/**
 * 当前音频的配置入口.
 * @param {object} track
 * @param {object} [options] `{translator, video, playback, onCalibrate, onSubtitles}`
 */
export function openTrackSheet(track, options = {}) {
  const { translator, video, playback, onCalibrate, onSubtitles } = options;
  const onBack = () => openTrackSheet(track, options);
  const body = document.createDocumentFragment();
  body.append(aiSettingsEntry({ onBack }));
  const playbackSlot = playback ? el('div') : null;
  if (playbackSlot) body.append(sectionTitle('播放'), playbackSlot);
  if (video) {
    body.append(group(navRow('视频字幕布局', '', { onPick: () => openVideoSheet({ track, onBack }) })));
  }
  const langRow = segRow('译文语言', '',
    () => trackCfg.lang, (v) => setTrackCfg('lang', v),
    TARGET_LANGS.map((l) => [l.code, l.name]), { wrap: true });

  // tr 先出现 (紧跟译文语言), 然后是这门语言的注音/转写层, 最后是词性与点词
  const keys = ['tr', ...track.layerOrder, 'pos', 'card'].filter((k) => track.supports(k));
  const lyrics = !video && track.raw?.sourceLyrics;
  const rows = [navRow(lyrics ? '歌词字号' : '字幕字号', '',
    { onPick: () => openFontSheet({ track, video: !!video, onBack }) })];
  for (const key of keys) {
    const [title, hint] = featureText(track.layers, key);
    rows.push(switchRow(title, video ? '' : hint, () => trackCfg[key], (v) => {
      setTrackCfg(key, v);
      if (key === 'tr') langRow.refresh();
    }));
    if (key === 'tr') rows.push(langRow);
  }

  if (onCalibrate) rows.push(navRow('日语歌词标注', '整首分词、AI 校对与手动唱法', {
    onPick: (event) => onCalibrate(event.currentTarget, onBack),
  }));
  rows.push(navRow('发音设置', '', { onPick: () => openPronunciationSheet({ track, onBack }) }));
  if (onSubtitles) rows.push(navRow('字幕管理', '', { onPick: onSubtitles }));
  body.append(sectionTitle(lyrics ? '歌词与注音' : video ? '当前视频' : '当前音频'), group(...rows));
  body.append(group(infoRow('源语言', track.langName)));

  const progress = translator ? infoRow('翻译进度', '—') : null;
  if (progress) body.append(group(progress));

  body.append(
    sectionTitle('全局'),
    group(
      segRow('主题', '', () => settings.theme, (v) => setSetting('theme', v), THEMES),
    ),
  );
  const legend = legendCard(track);
  if (legend) body.append(sectionTitle('图例'), legend);
  let unsubscribe;
  openSheet(video ? '视频设置' : lyrics ? '练唱设置' : '音频配置', body, {
    cls: 'sheet-tall track-settings-sheet',
    onClose: () => {
      if (playback) playback.parking.append(playback.node);
      unsubscribe?.();
    },
  });
  if (playbackSlot) playbackSlot.append(playback.node);
  if (progress) unsubscribe = translator.onProgress((done, total) => {
    progress.setValue(total ? `${done} / ${total} 句` : '—');
  });
}

export function pitchLabel(semitones, units = false) {
  if (semitones === 0) return '原调';
  return (semitones > 0 ? '升 ' : '降 ') + Math.abs(semitones) + (units ? ' 半音' : '');
}

function pitchControls(pitch) {
  const title = el('h3', null, '升降调');
  const value = el('output', 'pitch-value');
  const reset = el('button', 'pitch-reset', '恢复原调');
  reset.type = 'button';
  reset.onclick = () => setTrackCfg('pitchSemitones', 0);
  const head = el('div', 'pitch-head');
  head.append(title, reset);

  const step = (delta, label, glyph) => {
    const button = el('button', 'pitch-step');
    button.type = 'button';
    button.setAttribute('aria-label', label);
    button.title = label;
    button.append(icon(glyph));
    button.onclick = () => setTrackCfg('pitchSemitones', trackCfg.pitchSemitones + delta);
    return button;
  };
  const lower = step(-1, '降低半音', 'i-minus');
  const raise = step(1, '升高半音', 'i-plus');
  const buttons = el('div', 'pitch-steps');
  buttons.append(lower, value, raise);
  const status = el('p', 'pitch-status');
  status.setAttribute('role', 'status');
  const card = group(head, buttons, status);
  card.classList.add('pitch-controls');

  const refresh = () => {
    const semitones = trackCfg.pitchSemitones;
    const unavailable = pitch.status === 'unavailable';
    value.value = pitchLabel(unavailable ? 0 : semitones, true);
    lower.disabled = unavailable || semitones <= -SONG_PITCH_LIMIT;
    raise.disabled = unavailable || semitones >= SONG_PITCH_LIMIT;
    reset.disabled = !semitones;
    status.textContent = unavailable ? '升降调暂不可用' : '';
    if (!unavailable && semitones !== pitch.activeSemitones) {
      status.textContent = pitch.status === 'loading' ? '正在启用升降调…' : '播放时应用';
    }
    status.hidden = !status.textContent;
  };
  refresh();
  return { card, refresh };
}

export function openSpeedSheet(audio, saveRate, pitch) {
  const slider = el('input', 'speed-slider');
  Object.assign(slider, { type: 'range', id: 'speedSlider',
    min: PLAYBACK_RATE_MIN, max: PLAYBACK_RATE_MAX, step: PLAYBACK_RATE_STEP });
  const label = el('label', null, '微调倍速');
  label.htmlFor = slider.id;
  const value = el('output');
  value.setAttribute('for', slider.id);
  value.setAttribute('aria-live', 'off');
  const header = el('div', 'speed-adjust-head');
  header.append(label, value);
  const bounds = el('div', 'speed-bounds');
  bounds.setAttribute('aria-hidden', 'true');
  bounds.append(...[PLAYBACK_RATE_MIN, PLAYBACK_RATE_MAX].map(rate => el('span', null, rate + '×')));
  const adjust = group(header, slider, bounds);
  adjust.classList.add('speed-adjust');

  let pendingRate = null;
  const currentRate = () => normalizePlaybackRate(audio.playbackRate);
  function refresh() {
    const rate = currentRate();
    slider.value = String(rate);
    slider.setAttribute('aria-valuetext', rate + ' 倍');
    slider.style.setProperty('--slider-fill',
      (rate - PLAYBACK_RATE_MIN) / (PLAYBACK_RATE_MAX - PLAYBACK_RATE_MIN) * 100 + '%');
    value.value = rate + '×';
    presets.refresh();
  }
  function preview(rate) {
    pendingRate = rate;
    if (rate !== currentRate()) audio.playbackRate = rate;
    refresh();
  }
  function commit() {
    if (pendingRate === null) return;
    const rate = pendingRate;
    pendingRate = null;
    saveRate(rate);
  }
  const presets = segRow('常用倍速', '', currentRate, (rate) => {
    preview(rate);
    commit();
  }, RATES.map(rate => [rate, rate + '×']), { wrap: true });
  presets.classList.add('speed-presets');
  slider.addEventListener('input', () => preview(slider.valueAsNumber));
  slider.addEventListener('change', commit);
  audio.addEventListener('ratechange', refresh);
  refresh();

  const body = document.createDocumentFragment();
  body.append(adjust, presets);
  const pitchPanel = pitch && pitchControls(pitch);
  if (pitchPanel) {
    body.append(pitchPanel.card);
    pitch.events.addEventListener('change', pitchPanel.refresh);
  }
  openSheet(pitch ? '速度与升降调' : '播放速度', body, { cls: 'speed-sheet', onClose: () => {
    if (pitchPanel) pitch.events.removeEventListener('change', pitchPanel.refresh);
    audio.removeEventListener('ratechange', refresh);
    commit();
  } });
}

/* ---------------------------------------------------------------- 讲解面板 */

/**
 * 长按句子的详情。与修改、讲解共用窗口高度，固定所选句子。
 */
export function createExplain(dom, { onEdit, onChat, onReturn, onClose, metrics } = {}) {
  const parent = dom.explainPanel.parentNode, nextSibling = dom.explainPanel.nextSibling;
  let track = null, open = false, shown = -1, selected = -1;
  let favoriteCtl = null, view = null, card = null, translationVersion = 0;
  const rows = [];

  function selectWord(j) {
    if (!open || !rows[j] || !card?._chips[j]) return;
    if (selected >= 0) {
      rows[selected]?.classList.remove('is-cur');
      rows[selected]?.querySelector('.gw-pick').setAttribute('aria-pressed', 'false');
      card._chips[selected]?.classList.remove('is-cur');
      card._chips[selected]?.setAttribute('aria-pressed', 'false');
    }
    selected = j;
    rows[j].classList.add('is-cur');
    rows[j].querySelector('.gw-pick').setAttribute('aria-pressed', 'true');
    const chip = card._chips[j];
    chip.classList.add('is-cur');
    chip.setAttribute('aria-pressed', 'true');
    const reveal = (box, top, height) => {
      if (top < box.scrollTop || top + height > box.scrollTop + box.clientHeight) box.scrollTop = Math.max(0, top - box.clientHeight * .35);
    };
    reveal(dom.explainBody, rows[j].offsetTop, rows[j].offsetHeight);
    const words = card.firstElementChild;
    reveal(words, chip.offsetTop - words.offsetTop, chip.offsetHeight);
  }

  function build(sIdx) {
    shown = sIdx;
    selected = -1;
    const s = track.sentences[sIdx];
    const plain = !sentenceAnalyzed(track, s);
    dom.explainTitle.textContent = '逐词拆解';
    dom.explainTitle.hidden = plain;
    card = createSentenceCard(track, sIdx, metrics);
    card.classList.add('is-active');
    for (const chip of card._chips) if (s.words[+chip.dataset.j].pos !== 'punct' && !plain) {
      chip.setAttribute('role', 'button');
      chip.tabIndex = 0;
      chip.setAttribute('aria-pressed', 'false');
      chip.setAttribute('aria-label', '选择词汇：' + s.words[+chip.dataset.j].text);
    }
    dom.explainPreview.replaceChildren(card);
    dom.explainPreview.scrollTop = 0;
    rows.length = 0;
    const frag = document.createDocumentFragment();
    (plain ? [] : s.words).forEach((w, j) => {
      if (w.pos === 'punct') { rows.push(null); return; }
      const row = el('div', 'gw p-' + (w.pos || 'other'));
      row.dataset.j = j;
      const pick = el('button', 'gw-pick');
      pick.type = 'button';
      pick.setAttribute('aria-label', '选择词汇：' + w.text);
      pick.setAttribute('aria-pressed', 'false');
      const left = el('span', 'gw-l');
      if (w.read) left.append(el('span', 'gw-read', w.read));
      left.append(el('span', 'gw-text', w.text));
      if (w.roman) left.append(document.createTextNode(' '), el('span', 'gw-roman', w.roman));
      const right = el('span', 'gw-r');
      right.append(el('span', 'gw-pos', track.posLabel(w.pos)));
      const bits = [];
      if (w.lemma && w.lemma !== w.text) bits.push('原形 ' + w.lemma);
      if (w.conj) bits.push(w.conj);
      if (w.parts) bits.push(w.parts.map((p) => p.text).join(' + '));
      if (w.posDetail && !bits.length) bits.push(w.posDetail);
      if (bits.length) right.append(el('span', 'gw-meta', bits.join(' · ')));
      pick.append(left, right);
      pick.addEventListener('click', () => selectWord(j));
      row.append(pick);
      rows.push(row);
      frag.append(row);
    });
    if (plain) frag.append(el('p', 'explain-empty', '本句尚未分析，可在「修改」中开启重新分析。'));
    else if (!frag.childNodes.length) frag.append(el('p', 'explain-empty', '本句没有可拆解的单词。'));
    dom.explainBody.replaceChildren(frag);
    dom.explainBody.scrollTop = 0;
    void refreshTranslation();
  }

  async function refreshTranslation() {
    if (!open || !card) return;
    const version = ++translationVersion, s = track.sentences[shown], lang = trackCfg.lang;
    let text = '';
    try {
      text = Object.hasOwn(s.translations || {}, lang) ? s.translations[lang]
        : (!s.translationLang || s.translationLang === lang) && s.translation
          || await cachedTranslation(track.id, lang, s.text);
    } catch { /* 缓存不可用时保留原文与本地拆解。 */ }
    if (open && version === translationVersion) {
      card.lastElementChild.lang = lang;
      card.lastElementChild.textContent = text || '';
    }
  }

  function cleanup() {
    open = false;
    translationVersion++;
    favoriteCtl?.abort();
    dom.explainPanel.hidden = true;
    parent.insertBefore(dom.explainPanel, nextSibling);
    view = null;
    onClose?.();
  }

  dom.explainPreview.addEventListener('click', (event) => {
    const word = event.target.closest('.w');
    if (open && word) selectWord(+word.dataset.j);
  });
  dom.explainPreview.addEventListener('keydown', (event) => {
    const word = event.target.closest('.w[role="button"]');
    if (word && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopPropagation(); selectWord(+word.dataset.j);
    }
  });

  return {
    setTrack(t) { this.close(); favoriteCtl?.abort(); track = t; shown = -1; },
    get isOpen() { return open; },
    toggle(sIdx) { open ? this.close() : this.open(sIdx); return open; },
    open(sIdx, state) {
      if (!track?.sentences[sIdx]) return;
      favoriteCtl?.abort();
      favoriteCtl = new AbortController();
      const footer = el('div', 'explain-actions');
      const action = (label, glyph, onClick) => {
        const b = el('button', 'explain-action');
        b.type = 'button';
        b.append(icon(glyph, 'ic ic-sm'), el('span', null, label));
        b.addEventListener('click', () => {
          const snapshot = { selectedText: track.sentences[sIdx].words[selected]?.text,
            selected, scrollTop: dom.explainBody.scrollTop,
            previewScrollTop: card.firstElementChild.scrollTop };
          onClick?.(sIdx, { onBack: () => onReturn?.(sIdx, snapshot) });
        });
        return b;
      };
      const favorite = el('div', 'explain-favorite');
      favorite.id = 'explainFavorite';
      favorite.append(favoriteButton(() => ({ track, i: sIdx, lang: trackCfg.lang }),
        { signal: favoriteCtl.signal, className: 'favorite-toggle explain-action' }));
      footer.append(favorite, action('修改', 'i-pen', onEdit),
        action('大模型讲解', 'i-spark', onChat));
      view = openSheet(`句子拆解 · ${sIdx + 1} / ${track.S}`, dom.explainPanel, {
        cls: 'sheet-sentence sheet-explain', footer, onClose: cleanup,
      });
      open = true;
      dom.explainPanel.hidden = false;
      build(sIdx);
      if (state) {
        const words = track.sentences[sIdx].words;
        const j = words[state.selected]?.text === state.selectedText ? state.selected
          : words.findIndex((w) => w.text === state.selectedText);
        if (j >= 0) selectWord(j);
        dom.explainBody.scrollTop = state.scrollTop || 0;
        card.firstElementChild.scrollTop = state.previewScrollTop || 0;
      }
    },
    close() {
      if (!open) return;
      view?.close();
    },
    refreshTranslation,
  };
}
