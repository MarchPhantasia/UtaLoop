import { el, toast } from './util.js';
import { openSheet } from './sheet.js';
import { group, infoRow, sectionTitle, segRow, stepRow, button, buttonBar } from './rows.js';
import { config } from './config.js';
import { sourceLangs } from './langs.js';
import {
  applyFontSizes, fontSizes, setLangFontSize, setLangFontSizes, resetLangFontSizes,
  FONT_SIZE_MIN, FONT_SIZE_MAX, FONT_SIZE_STEP,
  settings, captionSize, setLangCaptionSize, resetLangCaptionSize,
} from './settings.js';
import { videoPreview, captionPreview } from './video-preview.js';
import {
  trackCfg, setTrackFontSize, resetTrackFontSizes, deferTrackFontSizes, setVideoCfg, resetVideoCfg,
} from './trackcfg.js';

// All examples describe the same sentence, so the translation preview needs no model request.
const SAMPLES = {
  ja: [
    ['私たち', 'わたしたち', 'watashitachi'], ['は', '', 'wa'],
    ['音楽', 'おんがく', 'ongaku'], ['を', '', 'o'],
    ['聴きました', 'ききました', 'kikimashita'],
  ],
  en: [
    ['We', 'wiː'], ['listened', 'ˈlɪsənd', 'listen'], ['to', 'tuː'], ['music', 'ˈmjuːzɪk'],
  ],
  es: [['Escuchamos', 'eskuˈtʃamos', 'escuchar'], ['música', 'ˈmusika']],
  fr: [
    ['Nous', 'nu'], ['avons', 'avɔ̃', 'avoir'], ['écouté', 'ekute', 'écouter'],
    ['de', 'də'], ['la', 'la'], ['musique', 'myzik'],
  ],
  de: [
    ['Wir', 'viːɐ̯'], ['haben', 'ˈhaːbən'], ['Musik', 'muˈziːk'], ['gehört', 'ɡəˈhøːɐ̯t', 'hören'],
  ],
  ko: [
    ['우리는', '우리는', 'urineun'], ['음악을', '으마글', 'eumageul'],
    ['들었어요', '드러써요', 'deureosseoyo'],
  ],
};
const TRANSLATIONS = {
  'zh-CN': '我们听了音乐', 'zh-TW': '我們聽了音樂',
  en: 'We listened to music', ja: '私たちは音楽を聴きました', ko: '우리는 음악을 들었어요',
};
const LYRIC_SAMPLE = [['星', 'ほし', 'hoshi'], ['の', '', 'no'], ['声', 'こえ', 'koe']];
const LYRIC_TRANSLATIONS = {
  'zh-CN': '星星的声音', 'zh-TW': '星星的聲音', en: 'The sound of the stars', ja: '星の声', ko: '별들의 소리',
};
const SIZE_OPT = { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX, step: FONT_SIZE_STEP, unit: 'px' };

export function previewSentence(spec, track, layers) {
  const preview = el('div', 'font-preview');
  preview.dataset.lang = spec.code;
  preview.dataset.space = spec.spaceDelimited === false ? '0' : '1';
  preview.lang = spec.code;
  preview.tabIndex = 0;
  preview.setAttribute('role', 'region');
  preview.setAttribute('aria-label', '字幕例句');
  const words = el('div', 'font-preview-words');
  const lyricSample = track?.raw?.sourceLyrics && spec.code === 'ja';
  const sample = lyricSample ? LYRIC_SAMPLE : SAMPLES[spec.code];
  const sentence = sample ? null : track?.sentences.find((s) => s.words.length);
  const entries = sample || sentence?.words.map((w) => [w.text, w.read, w.roman]) || [[spec.native || spec.name]];
  for (const [text, read, roman] of entries) {
    const word = el('span', 'font-preview-word');
    if (/^[.。!?！？,，]$/.test(text)) word.classList.add('font-preview-punct');
    if (layers.includes('read')) word.append(el('span', 'font-preview-read', read || ''));
    word.append(el('span', 'font-preview-text', text));
    if (layers.includes('roman')) word.append(el('span', 'font-preview-roman', roman || ''));
    words.append(word);
  }
  if (!layers.includes('read')) preview.style.setProperty('--lh-read', '0px');
  if (!layers.includes('roman')) preview.style.setProperty('--lh-roman', '0px');
  preview.append(words);
  if (layers.includes('tr')) {
    const target = track ? trackCfg.lang : config.targetLang;
    const translations = lyricSample ? LYRIC_TRANSLATIONS : TRANSLATIONS;
    const translation = sample ? (translations[target] || translations['zh-CN']) : sentence?.translation;
    if (translation) {
      const tr = el('p', 'font-preview-tr', translation);
      tr.lang = sample && !translations[target] ? 'zh-CN' : target;
      preview.append(tr);
    }
  }
  return preview;
}

function fontLayers(spec) {
  const supports = (key) => !spec.features?.length || spec.features.includes(key);
  return ['text', ...(spec.layerOrder || []).filter((key) => ['read', 'roman'].includes(key) && supports(key)),
    ...(supports('tr') ? ['tr'] : [])];
}

function trackSpec(track) {
  return { code: track.lang, name: track.langName, spaceDelimited: track.space,
    layers: track.layers, layerOrder: track.layerOrder, features: track.features };
}

function systemFonts(preview, spec, track) {
  const code = spec.code;
  const text = [...preview.querySelectorAll('.font-preview-text')].map((node) => node.textContent)
    .join(spec.spaceDelimited === false ? '' : ' ');
  const translation = preview.querySelector('.font-preview-tr');
  const caption = captionPreview(text, translation?.textContent || '', {
    sourceLang: code, targetLang: translation?.lang || '',
  });
  const get = () => track ? trackCfg.video.captionSize : captionSize(code);
  const row = stepRow('系统字幕字号', '用于画中画和悬浮窗', get, (captionSize) => {
    if (track) setVideoCfg({ captionSize });
    else setLangCaptionSize(code, captionSize);
    caption.update(get());
  }, { min: 12, max: 36, step: 1, unit: 'px' });
  const reset = button(track ? '恢复语言默认系统字号' : '恢复默认系统字号', {
    onPick: () => {
      if (track) resetVideoCfg(['captionSize']);
      else resetLangCaptionSize(code);
      row.refresh();
      caption.update(get());
    },
  });
  caption.update(get());
  return [caption.element, group(row), buttonBar(reset)];
}

function openLyricFontSheet(track, { onClose, onBack }) {
  const spec = trackSpec(track);
  const layers = fontLayers(spec);
  const preview = previewSentence(spec, track, layers);
  preview.classList.add('lyric-font-preview');
  preview.setAttribute('aria-label', '歌词预览');
  const body = el('div', 'lyric-font-pane');
  const controls = el('div', 'lyric-font-controls');
  const get = () => fontSizes(track.lang, trackCfg.fonts);
  let sizes = get();
  const sliders = layers.map((layer) => {
    const key = layer + 'Size';
    const row = el('div', 'lyric-font-row');
    const label = el('label', '', layer === 'text' ? '歌词原文' : layer === 'tr' ? '译文'
      : layer === 'read' && track.lang === 'ja' ? '假名注音' : spec.layers?.[layer] || (layer === 'read' ? '注音' : '转写'));
    const range = el('input', 'lyric-font-slider');
    range.id = 'lyric-font-' + layer;
    range.type = 'range';
    range.min = FONT_SIZE_MIN;
    range.max = FONT_SIZE_MAX;
    range.step = FONT_SIZE_STEP;
    label.htmlFor = range.id;
    const value = el('output', 'lyric-font-value');
    value.setAttribute('aria-hidden', 'true');
    const paintValue = () => {
      value.value = `${sizes[key]} px`;
      range.setAttribute('aria-valuetext', `${sizes[key]} 像素`);
      range.style.setProperty('--font-slider-fill', `${(sizes[key] - FONT_SIZE_MIN) / (FONT_SIZE_MAX - FONT_SIZE_MIN) * 100}%`);
    };
    const refresh = () => { range.value = sizes[key]; paintValue(); };
    range.addEventListener('input', () => {
      sizes[key] = range.valueAsNumber;
      paintValue();
      applyFontSizes(sizes, preview);
    });
    range.addEventListener('change', () => setTrackFontSize(key, range.valueAsNumber));
    row.append(label, range, value);
    controls.append(row);
    return refresh;
  });
  const refresh = () => {
    sizes = get();
    applyFontSizes(sizes, preview);
    sliders.forEach((paint) => paint());
  };
  const caption = el('details', 'lyric-font-caption');
  caption.append(el('summary', '', '小窗字幕字号'), ...systemFonts(preview, spec, track));
  body.append(preview, controls, caption);
  const footer = buttonBar(
    button('恢复语言默认', { onPick: () => { resetTrackFontSizes(); refresh(); } }),
    button(`设为${track.langName}默认`, { main: true, onPick: () => {
      setLangFontSizes(track.lang, get());
      toast('已保存为' + track.langName + '默认字号');
    } }),
  );
  refresh();
  let finish = () => {};
  openSheet('歌词字号', body, {
    cls: 'lyric-font-sheet', footer, onBack,
    onClose: () => { finish(); onClose?.(); },
  });
  finish = deferTrackFontSizes();
}

/**
 * 共用字号菜单; 普通与系统字幕按源语言保存, 播放页可覆盖当前媒体.
 *
 * 头部只留「关闭」那一枚 X: 二级菜单不需要第二个能离开本页的图标按钮
 * (以前那枚返回箭头在设置页里做的就是同一件事, 两个按钮挨在一起只会让人犹豫).
 */
export function openFontSheet({ track = null, video = false, onClose, onBack } = {}) {
  if (track?.raw?.sourceLyrics && !video) return openLyricFontSheet(track, { onClose, onBack });
  const list = sourceLangs();
  let code = list.find((spec) => spec.code === config.importLang)?.code || list[0].code;
  const body = el('div', 'font-pane');
  const content = el('div');
  let landscape = null;
  let fitPreview = () => {};
  let fitFrame = 0;
  let finishFonts = () => {};
  const scheduleFit = () => {
    if (fitFrame) return;
    fitFrame = requestAnimationFrame(() => { fitFrame = 0; fitPreview(); });
  };
  if (track) {
    code = track.lang;
    body.append(infoRow('源语言', track.langName));
  } else {
    const languages = segRow('语言', '', () => code, (value) => { code = value; paint(); },
      list.map((spec) => [spec.code, spec.name]));
    languages.classList.add('font-languages', 'row-wrap');
    languages.querySelector('.segs').setAttribute('aria-label', '字幕字号语言');
    body.append(languages);
  }
  body.append(content);

  function paint() {
    landscape?.dispose();
    const spec = track ? trackSpec(track) : list.find((item) => item.code === code);
    const layers = fontLayers(spec);
    const preview = previewSentence(spec, track, layers);
    landscape = video ? videoPreview(preview, () => ({ ...(track ? trackCfg.video : settings.video), subtitles: 1 })) : null;
    const get = () => fontSizes(code, track ? trackCfg.fonts : {});
    fitPreview = () => {
      if (!preview.isConnected) return;
      // Transforms leave the measured grid widths unchanged, so fitting cannot reflow itself.
      const fitted = [];
      for (const word of preview.querySelectorAll('.font-preview-word')) {
        const style = getComputedStyle(word);
        const available = Math.max(0, word.clientWidth - parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) - 0.5);
        for (const span of word.children) {
          const width = span.scrollWidth;
          fitted.push([span, width > available && available > 0 ? available / width : 1]);
        }
      }
      for (const [span, scale] of fitted) span.style.transform = scale < 1 ? `scale(${scale})` : '';
    };
    const updatePreview = () => { applyFontSizes(get(), preview); landscape?.update(); scheduleFit(); };
    const rows = layers.map((layer) => {
      const label = layer === 'text' ? '原文' : layer === 'tr' ? '译文'
        : spec.layers?.[layer] || (layer === 'read' ? '注音' : '转写');
      const key = layer + 'Size';
      return stepRow(label + '字号', '', () => get()[key], (value) => {
        if (track) setTrackFontSize(key, value);
        else setLangFontSize(code, key, value);
        updatePreview();
      }, SIZE_OPT);
    });
    const reset = button(track ? '恢复语言默认字号' : '恢复默认字号', {
      glyph: 'i-refresh', onPick: () => {
        if (track) resetTrackFontSizes();
        else resetLangFontSizes(code);
        rows.forEach((row) => row.refresh());
        updatePreview();
      },
    });
    content.replaceChildren(sectionTitle(video ? '横屏视频示例' : '例句'), landscape?.element || preview,
      group(...rows), buttonBar(reset), sectionTitle('系统字幕'), ...systemFonts(preview, spec, track));
    updatePreview();
  }

  paint();
  let previousWidth = 0;
  const observer = new ResizeObserver(([entry]) => {
    if (entry.contentRect.width === previousWidth) return;
    previousWidth = entry.contentRect.width;
    scheduleFit();
  });
  openSheet(track ? '字幕字号 · 当前媒体' : '字幕字号 · 全局', body, {
    cls: 'sheet-tall', onBack, onClose: () => {
      landscape?.dispose();
      observer.disconnect();
      cancelAnimationFrame(fitFrame);
      fitFrame = 0;
      finishFonts();
      onClose?.();
    },
  });
  if (track) finishFonts = deferTrackFontSizes();
  observer.observe(body);
  scheduleFit();
}
