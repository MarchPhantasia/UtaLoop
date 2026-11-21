/**
 * 播放页装配 —— 取记录 → (没分析过就先送去分析) → 建阅读区 → 接上翻译/词卡/讲解.
 *
 * 这里只做「一次性」的事: 查询节点、装配对象、绑定事件。与播放进度有关的每帧
 * 工作全部在 engine.js 的那一个 rAF 循环里, 所以本文件没有任何定时器,
 * 也不监听 timeupdate。
 *
 * 数据全部来自浏览器: 音频 Blob、track.json、翻译缓存都在 IndexedDB 里 (library.js),
 * 只有「把字幕变成 track.json」这一步会去问分析后端 (`POST /api/analyze`)。所以
 * 除了那一次请求, 整个播放页离线可用。
 *
 * 三条大模型线在这儿汇合:
 *
 * * **翻译**: `trackCfg.tr` 打开后才创建请求; 译文到达 → `Reader.setTranslation`
 *   → `VirtualList.invalidate` 只重量受影响的几行。
 * * **词卡**: 点词在原有播放进度上打开释义。
 * * **讲解**: 工具条的「讲解」开 2/3 屏对话框; 长按句子仍是本地逐词拆解, 打开时均暂停播放。
 *   暂停播放的学习面板关闭后, 恢复打开前正在播放的媒体。
 */

import { $, debounce, el, fmtTime, fmtSize, icon, isIOS, locate, rafOnce, toast } from './util.js';
import { enterView } from './motion.js';
import { showCover } from './music-art.js';
import { inheritLyricPos, needsLyricPos } from './lyric-pos.js';
import { Track } from './track.js';
import { Metrics } from './metrics.js';
import { Reader } from './reader.js';
import { VirtualList } from './virtual.js';
import { Engine } from './engine.js';
import { setupPlayer } from './player.js';
import { bindLyricSync, bindVolume } from './song-controls.js';
import { mediaKind } from './media.js';
import { setupVideo } from './video-player.js';
import { setupAudioPip } from './audio-pip.js';
import { initSettings, normalizePlaybackRate, setSetting, settings } from './settings.js';
import { initTrackCfg, LYRIC_OFFSET_STEP_MS, setTrackCfg, trackCfg } from './trackcfg.js';
import { config, loadConfig } from './config.js';
import { nativeApp, nativeReady } from './native.js';
import { sourceLangs } from './langs.js';
import { createExplain, openSpeedSheet, openTrackSheet, pitchLabel } from './ui.js';
import { createSongPitch } from './song-pitch.js';
import { closeSheet, openMenu, openSheet, sheetOpen } from './sheet.js';
import { analyze } from './api.js';
import { errorMessage } from './errors.js';
import { audioBlob, flushPositions, getTrack, patchTrack, saveAnalysis, setDuration, setPosition,
  stagePosition, trackData, transcriptBlob, savePreparedTranscript, SUB_EXT, SUB_RE } from './library.js';
import { plainTrack } from './subtitles.js';
import { createTranslator } from './translate.js';
import { closeWordCard, isCardOpen, openWordCard, stopWordPronunciation } from './card.js';
import { chatOpen, closeChat, openChat } from './chat.js';
import { actionRow, button, buttonBar, group, segRow, switchRow } from './rows.js';
import { prepareSubtitleEdit, saveSubtitleEdit, sentenceAnalyzed, subtitleEditDefaults } from './subtitle-edit.js';
import { openSubtitleEditor } from './subtitle-edit-ui.js';
import { createPronunciationLoudness } from './pronunciation-loudness.js';
import { getFavorite, favoritePosition } from './favorites.js';
import { checkpointTime, getStudy, saveStudyCheckpoint, studyKey, updateStudy } from './music-study.js';
import { openMusicQueue, playbackModes, playbackSource } from './music-queue.js';
import { embeddedMusicFrame, musicBrowseURL, musicPracticeParams, musicURLForPractice, PRACTICE_BACK, PRACTICE_STATE } from './music-practice.js';
import { backWithFallback, canReturnTo, writeHistory } from './navigation.js';
import { isDegraded, updateRecord } from './store.js';

const FOLLOW_ALIGN = 0.30;
const practiceFrame = embeddedMusicFrame();
const LONG_PRESS = 460;                        // ms: 长按打开逐词拆解
const REPEAT_LABEL = ['重复', '单句', '全部'];
const HOT_BACK = 2;                            // 视口上方也顺手补几句译文
const HOT_AHEAD = 8;
let entryFavorite = null;
let entryCheckpoint = false;
const SWEEP_DELAY = 1600;                      // ms: 视口翻完再后台补全篇

const dom = {
  app: $('app'), videoStage: $('videoStage'),
  topbar: document.querySelector('.topbar'),
  scroller: $('scroller'), viewport: $('viewport'), readerState: $('readerState'),
  setup: $('setup'),
  trackTitle: $('trackTitle'), btnBack: $('btnBack'), btnDisplay: $('btnDisplay'),
  btnFiles: $('btnFiles'),
  player: $('player'), seek: $('seek'), seekFill: $('seekFill'), seekThumb: $('seekThumb'),
  timeNow: $('timeNow'), timeTotal: $('timeTotal'),
  btnPin: $('btnPin'), btnExplain: $('btnExplain'), btnRepeat: $('btnRepeat'),
  btnSpeed: $('btnSpeed'), speedText: $('speedText'), pitchText: $('pitchText'),
  btnPlay: $('btnPlay'), playText: $('playText'),
  btnShadow: $('btnShadow'), hint: $('hint'),
};

// The engine's historic `audio` name refers to the one active HTMLMediaElement.
let audio = $('audio');
let songPitch = null;
const metrics = new Metrics($('probe'));
let track = null, reader = null, vlist = null;
let player = null;
let translator = null, sweepTimer = 0;
let record = null;                 // 当前音频的库记录 (library.js)
let studyPoint = null, savingStudyPoint = false, studyRevision = 0;
let objUrl = '';                   // 当前 <audio> 用的 blob URL, 换曲要 revoke
let pronunciationBlob = null;      // 原生播放同一份 Blob, 保持点词播放处于用户手势内
let pronunciationLoudness = null;
let videoReady = false;
let videoPlayer = null;
let audioPip = null;
let lyricSync;
let rangeDraft = null;
let setupOnBack = null;
let editingSubtitle = false;
let pageActive = true;
let collection, songQueue, songAdvance, closeModeMenu;
let lyricPosJob;
window.addEventListener('pagehide', () => {
  pageActive = false;
  closeRangePicker();
  lyricPosJob?.abort();
  cancelSongAdvance();
  closeModeMenu?.();
});
window.addEventListener('pageshow', ({ persisted }) => {
  pageActive = true;
  if (persisted && track) refreshLyricPos(track);
});

function syncVideoLayout() {
  const visible = videoReady && dom.setup.hidden;
  dom.app.classList.toggle('has-video', visible);
  dom.videoStage.hidden = !visible;
  videoPlayer?.syncLayout();
  if (!dom.setup.hidden) dom.btnBack.setAttribute('aria-label', setupOnBack ? '返回设置' : '返回播放');
  else if (!videoPlayer) dom.btnBack.setAttribute('aria-label', new URLSearchParams(location.search).get('from') === 'music' ? '返回选歌列表' : '返回首页');
  syncFollowAlign();
}

function syncFollowAlign() {
  // Compact overlays leave more room below the active sentence for its extra layers.
  engine.followAlign = dom.app.classList.contains('has-video')
    && dom.app.classList.contains('is-immersive') ? 0.08 : FOLLOW_ALIGN;
  if (vlist) {
    const single = dom.app.classList.contains('is-immersive');
    if (vlist.followSingle !== single) {
      vlist.followSingle = single;
      vlist.update(true);
    }
  }
}

const engine = new Engine({ audio, reader: null, vlist: null, scroller: dom.scroller, dom,
  outputDelay: () => songPitch?.delay || 0 });
const explain = createExplain({
  explainPanel: $('explainPanel'), explainPreview: $('explainPreview'), explainBody: $('explainBody'),
  explainTitle: $('explainTitle'),
}, { metrics, onEdit: editSubtitle, onChat: showChat, onReturn: openExplain,
  onClose: () => player?.overlays.close('explain') });

// ---------------------------------------------------------------- 空态 / 提示

function showState(title, hint) {
  const box = dom.readerState;
  box.textContent = '';
  box.append(el('b', null, title));
  if (hint) box.append(el('span', null, hint));
  box.hidden = false;
}

function clearState() {
  dom.readerState.hidden = true;
  dom.readerState.textContent = '';
}

// ---------------------------------------------------------------- 送去分析

/**
 * 还没分析过的音频先停在这一屏: 选字幕 → 选源语言 → 交给分析后端 → 落库 → 进阅读区.
 *
 * 分析后端是无状态的: 它不认识这条音频, 也不保存任何东西 —— 请求带上字幕原文和几个
 * 参数, 换回一份 track.json, 由浏览器负责存。
 */
function showSetup(onBack = null) {
  cancelSongAdvance();
  closeRangePicker();
  setupOnBack = onBack;
  player?.overlays.reset();
  audio.pause();
  engine.setSuspended(true);
  engine.noteUserScroll();
  explain.close();
  closeWordCard();
  closeChat();
  clearState();
  dom.viewport.hidden = true;
  dom.player.hidden = true;
  lyricSync?.paint(0, false);
  $('checkpointControls').hidden = true;
  const title = record.title || record.id;
  dom.trackTitle.textContent = title;
  document.title = title + ' · Lingua';

  const box = dom.setup;
  box.textContent = '';
  box.hidden = false;
  box.removeAttribute('aria-busy');

  const head = el('div', 'setup-h');
  syncVideoLayout();
  const emblem = el('span', 'setup-emblem');
  emblem.append(icon('i-doc'));
  const intro = el('div');
  intro.append(el('h1', null, '导入字幕'));
  head.append(emblem, intro);
  box.append(head);

  const fields = el('fieldset', 'setup-fields');
  const card = el('div', 'setup-card');
  const label = el('div', 'setup-section');
  label.append(el('span', 'setup-step', '01'), el('h2', null, '选择字幕'));
  card.append(label);
  fields.append(card);
  box.append(fields);

  const flags = { estimate: false, split: true, merge: true };
  let lang = record.lang || config.importLang || 'ja';
  const analysisOptions = el('details', 'setup-options');
  const summary = el('summary');
  const summaryCopy = el('span');
  summaryCopy.append(el('b', null, '分析选项'));
  summary.append(icon('i-tune', 'ic ic-sm'), summaryCopy, icon('i-chev-d', 'ic ic-sm setup-chevron'));
  analysisOptions.append(summary, group(
    switchRow('自动拆句', '按标点拆分字幕',
      () => (flags.split ? 1 : 0), (v) => { flags.split = !!v; }),
    switchRow('合并分词', '合并缩写与连字符词',
      () => (flags.merge ? 1 : 0), (v) => { flags.merge = !!v; }),
    switchRow('估算词级时间戳', '按字数分配时间，可能与实际发音不同步',
      () => (flags.estimate ? 1 : 0), (v) => { flags.estimate = !!v; }),
  ));

  const input = el('input');
  input.type = 'file';
  //  iOS 上按扩展名过滤会把 .srt / .vtt 一起灰掉 (见 util.isIOS), 只能不给 accept,
  //  让用户在 Files 里随便挑, 再由下面的后缀校验兜住。
  if (!isIOS()) input.accept = SUB_EXT.map((e) => '.' + e).join(',');
  input.hidden = true;
  input.setAttribute('aria-label', '选择字幕文件');
  const name = el('b', 'setup-file', '选择或拖入字幕文件');
  const fileHint = el('span', 'setup-file-hint', '支持 SRT、VTT、WebVTT、JSON');
  const fileCopy = el('span', 'setup-file-copy');
  fileCopy.append(name, fileHint);
  const fileIcon = el('span', 'setup-file-icon');
  fileIcon.append(icon('i-doc'));
  const choose = el('button', 'setup-pick');
  choose.type = 'button';
  choose.setAttribute('aria-label', '选择字幕文件');
  choose.append(fileIcon, fileCopy, icon('i-plus', 'ic ic-sm'));
  choose.addEventListener('click', () => input.click());
  card.append(input, choose);

  const languageCard = el('div', 'setup-card');
  const languageLabel = el('div', 'setup-section');
  languageLabel.append(el('span', 'setup-step', '02'), el('h2', null, '设置字幕语言'));
  languageCard.append(languageLabel, group(
    segRow('源语言', '', () => lang, (v) => { lang = v; },
      sourceLangs().map((l) => [l.code, l.name]), { wrap: true })), analysisOptions);
  fields.append(languageCard);

  const bar = el('div', 'setup-bar');
  bar.append(el('i'));
  bar.hidden = true;
  const log = el('pre', 'setup-log');
  log.hidden = true;
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');

  const go = button('开始分析', { main: true, glyph: 'i-check', onPick: () => start() });
  go.disabled = true;
  const only = button('只导入字幕', { glyph: 'i-doc', onPick: () => start(false) });
  only.disabled = true;
  const bottom = buttonBar(only, go);
  bottom.classList.add('setup-actions');
  fields.append(bottom);
  box.append(bar, log);
  engine.setScrollTop(0);
  enterView(box);

  let file = null, busy = false;
  function selectFile(picked, saved = false) {
    if (!picked || busy) return;
    if (!SUB_RE.test(picked.name)) {
      toast('请选择 SRT、VTT、WebVTT 或 JSON 字幕文件');
      return;
    }
    file = picked;
    name.textContent = file.name;
    fileHint.textContent = `${fmtSize(file.size)}${saved ? ' · 已保存' : ''}`;
    choose.classList.add('has-file');
    choose.setAttribute('aria-label', '更换字幕文件：' + file.name);
    choose.lastElementChild.querySelector('use').setAttribute('href', '#i-check');
    go.disabled = false;
    only.disabled = false;
  }
  transcriptBlob(record.id).then((saved) => {
    if (!saved || file || !name.isConnected || box.hidden) return;
    selectFile(new File([saved], record.transcript?.name || 'transcript.json', { type: saved.type }), true);
  }).catch(() => { if (name.isConnected) toast('已保存的字幕读取失败，请重新选择文件'); });
  input.addEventListener('change', () => {
    const picked = (input.files || [])[0] || null;
    // 没给 accept 的那条路 (iOS) 靠这里挡住选错的文件, 后缀集合与后端一致
    selectFile(picked);
    input.value = '';
  });
  card.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!busy) choose.classList.add('is-dragging');
  });
  card.addEventListener('dragleave', (event) => {
    if (!card.contains(event.relatedTarget)) choose.classList.remove('is-dragging');
  });
  card.addEventListener('drop', (event) => {
    event.preventDefault();
    choose.classList.remove('is-dragging');
    const files = event.dataTransfer?.files;
    if (files?.length > 1) { toast('一次请选择一个字幕文件'); return; }
    selectFile(files?.[0]);
  });

  const write = (text) => {
    log.hidden = false;
    log.textContent += text + '\n';
    log.scrollTop = log.scrollHeight;
  };

  async function start(withAnalysis = true) {
    if (!file || busy) return;
    busy = true;
    fields.disabled = true;
    box.setAttribute('aria-busy', 'true');
    go.disabled = true;
    choose.disabled = true;
    only.disabled = true;
    dom.btnBack.disabled = true;
    bar.hidden = false;
    bar.classList.add('is-busy');
    log.textContent = '';
    write(withAnalysis ? '正在分析字幕…' : '正在导入字幕…');
    try {
      if (!withAnalysis) {
        record = await savePreparedTranscript(record.id, file, lang);
        updateFileState();
        await openTrack();
        return;
      }
      const dur = record.duration || (Number.isFinite(audio.duration) ? audio.duration : 0);
      const resp = await analyze(file, {
        lang,
        id: record.id,
        title: record.title,
        duration: dur,
        split: flags.split,
        merge: flags.merge,
        estimate: flags.estimate,
      });
      if (!resp.track || !Array.isArray(resp.track.sentences)) throw new Error('未收到字幕分析结果，请重试');
      record = await saveAnalysis(record.id, resp.track, { transcriptName: file.name, transcriptFile: file });
      updateFileState();
      write('分析完成，正在加载…');
      await openTrack();
    } catch (err) {
      const msg = errorMessage(err, withAnalysis ? '字幕分析失败，请重试' : '字幕导入失败，请重试');
      write(msg);
      // 之前已经分析过的就别把状态打回失败, 用户还能「先看现有内容」
      if (!['ready', 'subtitles'].includes(record.status)) {
        try { record = (await patchTrack(record.id, { status: 'failed', error: msg })) || record; }
        catch (saveError) { toast(errorMessage(saveError, '无法保存分析状态，请重试')); }
      }
    } finally {
      go.disabled = false;
      choose.disabled = false;
      only.disabled = false;
      dom.btnBack.disabled = false;
      busy = false;
      fields.disabled = false;
      box.removeAttribute('aria-busy');
      bar.classList.remove('is-busy');
      bar.hidden = true;
    }
  }
}

// ---------------------------------------------------------------- 载入曲目

/** Resolve the next source before touching the current player. */
async function readAudioSource(song, signal) {
  const blob = await audioBlob(song.id);
  signal?.throwIfAborted();
  if (blob || !song.musicId || audio.nativeAudio) return { blob };
  const { music, musicQuality, MUSIC_QUALITIES } = await import('./music-api.js');
  const requested = musicQuality();
  const source = await music('source', { id: song.musicId, level: requested }, signal);
  const url = typeof source === 'string' ? source : source?.url;
  if (!url) throw Error('没有取得可播放的音源');
  const quality = Object.hasOwn(MUSIC_QUALITIES, source.level) ? MUSIC_QUALITIES[source.level] : '';
  let note = '';
  if (quality && source.level !== requested) note = '这首歌以「' + quality + '」音质播放';
  else if (source.fallback) note = '已切换到可用的标准音源';
  else if (typeof source === 'string' && requested !== 'standard') note = '请更新本地音乐服务以应用音质设置';
  return { url, quality, note };
}

/** 原始音视频 Blob 直接挂到当前媒体元素, 共用字幕时间轴. */
async function attachAudio(prepared) {
  dom.btnPlay.disabled = true;
  songPitch?.setSemitones(0);
  const qualityRow = $('sourceQuality');
  qualityRow.hidden = true;
  pronunciationBlob = null;
  pronunciationLoudness?.dispose();
  pronunciationLoudness = null;
  if (track) track.pronunciationLoudness = null;
  let source = prepared;
  if (!source) {
    try { source = await readAudioSource(record); }
    catch (error) {
      if (!record.musicId) throw error;
      toast(error.message);
      source = {};
    }
  }
  const { blob, url, quality, note } = source;
  if (blob) {
    pronunciationLoudness = createPronunciationLoudness(blob, audio);
    if (track) track.pronunciationLoudness = pronunciationLoudness;
  }
  if (audio.nativeAudio) {
    showState('正在加载…');
    if (blob) {
      try {
        await audio.attach(blob, record);
        pronunciationBlob = blob;
        applyPlaybackRate(settings.rate);
        objUrl = audio.src;
      } catch (error) {
        objUrl = '';
        record = { ...record, audio: { ...record.audio, missing: true } };
        toast(errorMessage(error, '音频加载失败，请重新导入'));
      }
    } else {
      await audio.release(); objUrl = '';
      record = { ...record, audio: { ...record.audio, missing: true } };
    }
    clearState();
    updateFileState(); return;
  }
  const next = blob ? URL.createObjectURL(blob) : url || '';
  if (quality) {
    $('sourceQualityValue').textContent = quality;
    qualityRow.hidden = false;
  }
  if (note) toast(note);
  if (objUrl) URL.revokeObjectURL(objUrl);
  objUrl = next;
  if (!next) {
    record = { ...record, audio: { ...record.audio, missing: true } };
    audio.removeAttribute('src');
    audio.load();
    videoReady = false;
    syncVideoLayout();
    updateFileState();
    return;
  }
  if (audio === $('audio')) audio.preload = next.startsWith('/music/media/') ? 'auto' : 'metadata';
  audio.src = next;
  // Request video data immediately, including on a paused first visit.
  if (videoPlayer) audio.load();
  applyPlaybackRate(settings.rate);
  if (trackCfg.id === record.id) songPitch?.setSemitones(trackCfg.pitchSemitones);
  updateFileState();
}

function updateFileState() {
  dom.btnFiles.hidden = !record || (!record.audio?.missing && !record.transcript?.missing);
  dom.btnPlay.disabled = !objUrl;
  dom.btnPlay.title = objUrl ? '' : '请先补充音频或视频文件';
  paintSpeed();
  paintCheckpoint();
}

async function repairFiles() {
  if (!record) return;
  let openFileRepair;
  try { ({ openFileRepair } = await import('./backup-ui.js')); }
  catch (error) { toast(errorMessage(error, '文件管理加载失败，请重试')); return; }
  openFileRepair([record], {
    onUpdate: async (updated) => {
      record = updated;
      if (!!videoPlayer !== (mediaKind(record.audio) === 'video')) {
        // A replacement may change media kind. Rebind all listeners on a fresh page.
        location.reload();
        return;
      }
      if (!objUrl && !record.audio?.missing) await attachAudio();
      if (track) track.audioUrl = objUrl;
      updateFileState();
    },
    onClose: () => { if (!dom.setup.hidden) showSetup(setupOnBack); },
  });
}

/**
 * 按 id 从浏览器库里取记录 —— 这一步没有任何网络请求.
 * @param {string} id
 * @param {boolean} forceSetup 从首页菜单点「重新分析」进来的
 */
async function load(id, forceSetup) {
  showState('正在加载…');
  await flushPositions();            // 上次离开时暂存的进度先合并, 续播位置才是新的
  record = await getTrack(id);
  if (!record) {
    dom.player.hidden = true;
    showState('媒体不存在', '请返回首页选择或重新导入');
    return false;
  }
  const isVideo = mediaKind(record.audio) === 'video';
  audio = isVideo ? $('video') : $('audio');
  if (!record.musicId && audio === $('audio') && nativeApp()?.audioPlayer) {
    const { NativeAudio } = await import('./native-audio.js');
    audio = new NativeAudio(nativeApp().audioPlayer);
  }
  if (isVideo && nativeApp()?.nativeVideoAudio) {
    const { NativeVideo } = await import('./native-video.js');
    audio = new NativeVideo(nativeApp().audioPlayer, $('video'));
  }
  engine.audio = audio;
  bindVolume(audio);
  if (!isVideo) {
    dom.app.classList.add('studio');
    $('songSummary').hidden = false;
    paintSongInfo();
  }
  if (audio === $('audio')) {
    songPitch = createSongPitch(audio);
    songPitch?.events.addEventListener('change', () => { paintSpeed(); engine.kick(); });
    if (songPitch) {
      audio.addEventListener('play', songPitch.activate);
      audio.addEventListener('seeking', () => { engine.lastSeekPosition = audio.currentTime; });
    }
  }
  const checkpointRead = isVideo ? null : restoreCheckpoint(id);
  audio.addEventListener('play', () => {
    cancelSongAdvance();
    stopWordPronunciation();
  });
  audio.addEventListener('seeking', cancelSongAdvance);
  let lastPracticed;
  audio.addEventListener(audio instanceof HTMLMediaElement ? 'playing' : 'play', () => {
    if (!record || lastPracticed === record.id) return;
    lastPracticed = record.id;
    updateStudy(studySong(record), { practiced: Date.now() }).catch(() => toast('最近练唱记录保存失败'));
  });
  audio.addEventListener('timeupdate', () => engine.backgroundTick());
  if (practiceFrame) {
    for (const event of ['play', 'pause', 'ended', 'loadedmetadata', 'error']) audio.addEventListener(event, reportPracticeState);
  }
  player = setupPlayer({ audio, engine, dom, savePosition: setPosition, stagePosition,
    beforePlay: songPitch?.activate,
    onEnded: isVideo ? null : onSongEnd });
  if (isVideo) {
    videoPlayer = setupVideo({ app: dom.app, video: $('video'), media: audio, engine, toggle: () => player.toggle(),
      onLayout: () => relayout(false), overlayOpen: () => sheetOpen() || chatOpen() || isCardOpen(),
      openSettings: openDisplay });
    dom.btnDisplay.setAttribute('aria-label', '视频设置');
    audioPip = videoPlayer.audioPip;
  } else {
    const button = $('btnAudioPip');
    audioPip = setupAudioPip({ media: audio, engine, app: dom.app,
      onStateChange: () => {
        button.hidden = !audioPip.supported();
        button.setAttribute('aria-busy', String(audioPip.isBusy()));
        button.setAttribute('aria-pressed', String(audioPip.isActive()));
        button.setAttribute('aria-label', audioPip.isActive() ? '关闭字幕画中画' : '字幕画中画');
      } });
    button.hidden = !audioPip.supported();
    button.addEventListener('click', () => audioPip.toggle());
  }
  wireTools();
  (isVideo ? $('video') : audio).addEventListener('loadedmetadata', () => {
    videoReady = isVideo && $('video').videoWidth > 0 && $('video').videoHeight > 0;
    syncVideoLayout();
  });
  // 显示层开关要在算高度之前写进 <html>, 免得首帧闪一下; 语言先用记录里的,
  // track.json 载入后再按它自述的 features 精修一次 (见 apply)
  initTrackCfg(record.id, record.lang, null, onTrackCfg);
  videoPlayer?.apply();
  await attachAudio();
  await checkpointRead;
  if (forceSetup) {
    if (record.status === 'failed' && record.error) toast(errorMessage(record.error, '上次字幕分析失败，请重试'));
    showSetup();
    return false;
  }
  return openTrack();
}

function paintSongInfo() {
  $('songName').textContent = record.title;
  $('songArtist').textContent = record.artist || '';
  showSongCover(record);
}

function reportPracticeState() {
  if (!practiceFrame || !track || track.id !== record?.id) return;
  const params = new URLSearchParams(location.search);
  if (params.get('track') !== track.id) return;
  params.delete('checkpoint');
  window.parent.postMessage({ type: PRACTICE_STATE, query: params.toString(),
    title: record.title, artist: record.artist || '', cover: record.cover || '', musicId: record.musicId,
    ready: !!objUrl && !audio.error, playing: !audio.paused && !audio.ended }, location.origin);
}

function showSongCover(song) {
  const image = $('songCover');
  image.hidden = false;
  showCover(image, { cover: song.cover, id: song.musicId, pixels: 480, onFound: cover => {
    song.cover = cover;
    if (song === record) reportPracticeState();
    void patchTrack(song.id, { cover }).catch(() => {});
    void import('./store.js').then(({ updateRecord }) =>
      updateRecord('study', song.id, current => ({ ...current, cover }))).catch(() => {});
  } });
}

async function prepareTrack(song) {
  let data = await trackData(song.id);
  if (data?.sourceLyrics) {
    const { upgradeSongLyrics, LYRIC_ALIGNMENT_VERSION } = await import('./music-lyrics.js');
    if (!(data.sourceAlignmentVersion >= LYRIC_ALIGNMENT_VERSION)) {
      try { data = await updateRecord('data', song.id, upgradeSongLyrics) || data; }
      catch { data = upgradeSongLyrics(data); }
    }
  }
  if (!data || !Array.isArray(data.sentences)) {
    const saved = await transcriptBlob(song.id);
    if (saved) {
      try {
        song = await savePreparedTranscript(song.id,
          new File([saved], song.transcript?.name || 'transcript.json'), song.lang);
        data = await trackData(song.id);
      } catch (err) { toast(errorMessage(err, '字幕加载失败，请重新导入')); }
    }
    data ||= plainTrack(song);
  }
  return { song, data };
}

async function openTrack() {
  setupOnBack = null;
  dom.setup.hidden = true;
  dom.viewport.hidden = false;
  syncVideoLayout();
  dom.setup.textContent = '';
  dom.player.hidden = false;
  showState('正在加载…');
  audio.pause();
  const { song, data } = await prepareTrack(record);
  record = song;
  apply(Track.fromData(data, objUrl));
  engine.setSuspended(false);
  // Immersive video uses transforms to center these elements; preserve that layout.
  enterView(dom.scroller, 'fade');
  enterView(dom.player, 'fade');
  return true;
}

/** Repair saved tags through the local dictionary after the player is ready. */
function refreshLyricPos(current) {
  lyricPosJob?.abort();
  if (!current.raw.sourceLyrics || !['http:', 'https:'].includes(location.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname) ||
      !current.sentences.some(needsLyricPos)) return;
  const job = lyricPosJob = new AbortController();
  const { signal } = job;
  void import('./lyric-review.js').then(({ backfillLyricPos }) => {
    signal.throwIfAborted();
    return backfillLyricPos(current.id, current.raw, { base: location.origin, signal });
  }).then(saved => {
    if (!saved || signal.aborted || track !== current) return;
    current.raw.posLegend = current.posLegend = { ...current.posLegend, ...saved.posLegend };
    for (let i = 0; i < current.S; i++) {
      const row = current.sentences[i], repaired = saved.sentences[i];
      if (!repaired?.lyricPosChecked || repaired.text !== row.text || repaired.start !== row.start || repaired.end !== row.end) continue;
      const words = inheritLyricPos(row.words, repaired.words);
      if (row.words.length === repaired.words.length && row.words.every((word, j) => word.text === repaired.words[j].text)) {
        row.lyricPosChecked = true;
      }
      if (words === row.words) continue;
      row.words = words;
      reader.refreshWordClasses(i);
    }
  }).catch(() => { /* The player can retry the repair when opening the song again. */ })
    .finally(() => { if (lyricPosJob === job) lyricPosJob = null; });
}

function cancelSongAdvance() {
  if (!songAdvance || songAdvance.committing) return;
  songAdvance.controller.abort();
  songAdvance = songQueue = null;
  dom.btnPlay.removeAttribute('aria-busy');
}

async function onSongEnd() {
  if (!pageActive || songAdvance || !track || !dom.setup.hidden) return;
  if (engine.repeat === 1) {
    if (engine.hasPlayableRange(engine.loopS, engine.loopEndS)) {
      engine.seekSentence(engine.loopS);
      void player.play();
      return;
    }
    restoreSongRepeat();
    updatePractice();
    if (engine.repeat === 2) {
      engine.seek(0);
      void player.play();
      return;
    }
  }
  const mode = songMode();
  if (mode !== 'list' && mode !== 'shuffle') return;
  const advance = songAdvance = { controller: new AbortController(), committing: false };
  const { signal } = advance.controller;
  dom.btnPlay.setAttribute('aria-busy', 'true');
  try {
    const queue = songQueue || await openMusicQueue(collection, record.id, signal);
    signal.throwIfAborted();
    songQueue = queue;
    let failed = 0;
    for (const index of queue.candidates(mode)) {
      const item = await queue.at(index, signal);
      signal.throwIfAborted();
      if (!item || item.unavailable) continue;
      const id = studyKey(item);
      if (id === record.id) continue;
      let next, source, nextTrack;
      try {
        next = await getTrack(id);
        if ((!next && !id.startsWith('netease-')) || mediaKind(next?.audio) === 'video') continue;
        source = await readAudioSource(next || { id, musicId: item.id }, signal);
        if (!source.blob && !source.url) continue;
        if (!next) {
          const { ensureSongTrack } = await import('./music-tracks.js');
          next = await ensureSongTrack(item, signal);
        }
        const { song, data } = await prepareTrack(next);
        next = song;
        nextTrack = Track.fromData(data);
      } catch (error) {
        signal.throwIfAborted();
        if (++failed >= 5) throw error;
        continue;
      }
      signal.throwIfAborted();
      advance.committing = true;
      if (sheetOpen()) closeSheet();
      record = next;
      studyPoint = null;
      await attachAudio(source);
      nextTrack.audioUrl = objUrl;
      paintSongInfo();
      apply(nextTrack, { fromStart: true });
      audioPip?.refresh();
      queue.select(index);
      collection.index = index;
      const url = new URL(location.href);
      url.searchParams.set('track', id);
      url.searchParams.set('slot', index);
      url.searchParams.delete('checkpoint');
      writeHistory('replaceState', history.state, url);
      reportPracticeState();
      void restoreCheckpoint(id);
      enterView(dom.scroller, 'fade');
      if (pageActive && objUrl) void player.play();
      return;
    }
    if (failed) toast('歌单中暂无其他可播放的歌曲');
    advance.committing = true;
    engine.seek(0);
    void player.play();
  } catch (error) {
    if (!signal.aborted) {
      songQueue = null;
      toast(errorMessage(error, '下一首加载失败，请重试'));
    }
  } finally {
    if (songAdvance === advance) {
      songAdvance = null;
      dom.btnPlay.removeAttribute('aria-busy');
    }
  }
}

let calibrationBusy = false;
async function openCalibration(trigger, onBack) {
  if (calibrationBusy) { toast('正在标注歌词…'); return; }
  trigger.disabled = true;
  try {
    const current = track, id = record.id;
    const i = practiceIndex();
    const [{ annotationSheet }, stored] = await Promise.all([import('./music-calibration.js'), trackData(id)]);
    if (track !== current || !trigger.isConnected || !sheetOpen()) return;
    const latest = stored || current.raw;
    if (!latest.sentences[i]) return;
    annotationSheet(id, latest, i, async (updated, whole = false) => {
      if (!updated) {
        updated = await trackData(id);
        if (track !== current || !updated) return;
        if (!whole) {
          apply(Track.fromData(updated, objUrl));
          engine.seekSentence(i);
          return;
        }
      }
      if (track !== current) return;
      const sentences = [...current.sentences];
      const changed = whole ? updated.sentences.flatMap((row, j) => {
        const live = sentences[j];
        return live?.text === row.text && live.start === row.start && live.end === row.end
          && (live.annotation !== row.annotation || JSON.stringify(live.words) !== JSON.stringify(row.words)) ? [j] : [];
      }) : [i];
      if (!changed.length) return updated;
      for (const j of changed) {
        const { translation, translationLang } = sentences[j];
        sentences[j] = { ...updated.sentences[j], translation, translationLang };
      }
      const next = Track.fromData({ ...updated, sentences }, objUrl);
      next.duration = current.duration;
      next.title = current.title;
      Object.assign(current, next);
      for (const j of changed) {
        reader.unmount(j);
        reader.cache.delete(j);
      }
      vlist.invalidate(changed);
      vlist.update(true);
      engine.refreshTrack();
      videoPlayer?.refreshPip?.();
      audioPip?.refresh();
      refreshLyricPos(current);
      return updated;
    }, { onBack, setBusy: (busy) => { calibrationBusy = busy; } });
  } catch (error) {
    toast(errorMessage(error, '无法打开歌词标注，请重试'));
  } finally {
    trigger.disabled = false;
  }
}

/** 用新曲目重建阅读区: Reader / VirtualList / Translator 都是一曲一份. */
function apply(next, { fromStart = false } = {}) {
  player?.overlays.reset();
  lyricSync?.close();
  closeRangePicker();
  track = next;
  if (audio.readyState >= 1 && Number.isFinite(audio.duration) && audio.duration > 0) next.duration = audio.duration;
  track.pronunciationLoudness = pronunciationLoudness;
  document.documentElement.dataset.subtitleMode = next.raw.subtitleMode || 'analyzed';
  document.documentElement.toggleAttribute('data-song-lyrics', !!next.raw.sourceLyrics);
  const title = (record && record.title) || next.title;
  next.title = title;
  dom.trackTitle.textContent = title;
  $('songName').textContent = title;
  document.title = title + ' · UtaLoop';
  setSetting('track', next.id);
  // 这条音频到底支持哪些显示层, 由 track.json 自述的 features 说了算
  initTrackCfg(next.id, next.lang, next.features, onTrackCfg);
  songPitch?.setSemitones(trackCfg.pitchSemitones);
  videoPlayer?.apply();

  explain.close();
  closeWordCard();
  closeChat();
  dom.viewport.textContent = '';
  engine.setScrollTop(0);
  reader = new Reader(dom.viewport, next, metrics, time => engine.toMediaTime(time));
  vlist = new VirtualList(dom.scroller, dom.viewport, reader, metrics, (top) => engine.setScrollTop(top));
  vlist.followSingle = dom.app.classList.contains('is-immersive');
  engine.reader = reader;
  engine.vlist = vlist;
  explain.setTrack(next);

  if (translator) translator.stop();
  translator = createTranslator(next, {
    lang: trackCfg.lang,
    onApply: applyTranslations,
    onError: (msg) => toast('翻译失败：' + msg),
  });

  dom.timeNow.textContent = '0:00';
  dom.timeTotal.textContent = fmtTime(next.duration);
  dom.seek.setAttribute('aria-valuemax', (next.duration || 0).toFixed(1));

  metrics.sync(dom.viewport.clientWidth);
  vlist.reset(next.S);
  engine.attach(next, videoPlayer ? 0 : trackCfg.lyricOffsetMs / 1000);
  vlist.update(true);
  paintPractice();
  lyricSync?.paint(trackCfg.lyricOffsetMs, !!next.S);
  if (!videoPlayer && songMode() === 'single') engine.setRepeat(2);
  paintRepeat();
  paintSpeed();
  paintShadow('off', -1, 0);
  //  上次停在哪儿由 library.js 记着: 这里把位置交给 player.js 决定要不要续播
  const savedPlace = entryFavorite && next.S ? favoritePosition(entryFavorite, next) : null;
  const startAt = savedPlace ? engine.toMediaTime(savedPlace.time) : (entryCheckpoint ? studyPoint : undefined);
  entryCheckpoint = false;
  player.setTrack({ id: next.id, title, position: fromStart ? 0 : record?.position, startAt });
  if (entryFavorite && next.S) {
    toast(savedPlace ? '已定位到收藏原文' : '字幕已变更，未找到收藏原文；收藏内容仍保留');
    entryFavorite = null;
  }
  if (next.S) clearState();
  else {
    showState('');
    dom.readerState.append(button('导入字幕', { main: true, glyph: 'i-doc', onPick: () => showSetup() }));
  }
  dom.btnPin.disabled = !next.S;
  dom.btnExplain.disabled = !next.S || next.raw.subtitleMode === 'plain';
  paintCheckpoint();
  syncTranslate();
  refreshLyricPos(next);
  reportPracticeState();
}

// ---------------------------------------------------------------- 翻译

/*  译文是异步补齐的: 一批到达 → 写进 DOM → 只重量这几行 → 让引擎重新算滚动位置.
    translate.js 已经把结果攒到一帧一批, 这里不再节流。                      */

function applyTranslations(batch) {
  if (!reader) return;
  const list = [];
  for (const [i, text] of batch) if (reader.setTranslation(i, text, translator.lang)) list.push(i);
  if (list.length) { videoPlayer?.refreshPip?.(); audioPip?.refresh(); }   // 小窗里的译文跟着补齐
  if (list.length) void explain.refreshTranslation();
  if (!dom.setup.hidden || !list.length || !vlist) return;
  if (document.documentElement.dataset.tr === '0') return;   // 没显示译文, 高度不变
  vlist.invalidate(list);
  engine.markScrollDirty();
}

/** 视口内优先翻; 滚动与句子切换都会触发, 140ms 合并一次. */
const wantVisible = debounce(() => {
  if (!dom.setup.hidden || !translator || !vlist || !trackCfg.tr) return;
  const st = dom.scroller.scrollTop;
  const vh = dom.scroller.clientHeight;
  //  焦点句 = 正在朗读的那句 (没在放就是视口第一句): 队列从它往后出队,
  //  于是听到哪儿就先翻哪儿之后的, 而不是每次都从整曲第一句重新排。
  translator.setFocus(curIndex());
  translator.want(vlist.indexAt(st) - HOT_BACK, vlist.indexAt(st + vh) + HOT_AHEAD);
}, 140);

/** 开关/语言变化后重新对齐翻译器状态. */
function syncTranslate() {
  if (!translator || editingSubtitle) return;
  translator.setEnabled(!!trackCfg.tr, trackCfg.lang);
  if (sweepTimer) { clearTimeout(sweepTimer); sweepTimer = 0; }
  if (!trackCfg.tr) return;
  wantVisible();
  sweepTimer = setTimeout(() => { sweepTimer = 0; if (translator) translator.sweep(); }, SWEEP_DELAY);
}

// ---------------------------------------------------------------- 重排

/*  字号/显示层/窗口宽度变化后, 句子高度全都变了: 重新量一遍 CSS,
    重算全部预测高度, 并把当前句留在原来的视觉位置。               */

let pendingForce = false;

const runRelayout = rafOnce(() => {
  if (engine.presentationHidden) return;
  const force = pendingForce;
  pendingForce = false;
  if (!dom.setup.hidden || !track || !vlist || engine.presentationHidden) return;
  syncFollowAlign();
  const changed = metrics.sync(dom.viewport.clientWidth);
  if (!changed && !force) { engine.markScrollDirty(); return; }
  const active = reader.activeS;
  const keepActive = active >= 0 && engine.follow;
  vlist.remeasure(keepActive ? active : vlist.indexAt(dom.scroller.scrollTop),
    keepActive ? engine.followAlign : 0);
  if (keepActive) engine.scrollToActive();
  else engine.markScrollDirty();
});

function relayout(force) {
  pendingForce = pendingForce || !!force;
  runRelayout();
}

/** Immersive subtitles are one non-wrapping line; follow the spoken word horizontally. */
const followSubtitleX = rafOnce(() => {
  if (!videoPlayer || !engine.follow || !dom.app.classList.contains('is-immersive')) return;
  const word = dom.scroller.querySelector('.s.is-active .w.is-cur');
  if (!word) return;
  const wr = word.getBoundingClientRect();
  const sr = dom.scroller.getBoundingClientRect();
  const pad = 24;
  if (wr.left < sr.left + pad) dom.scroller.scrollLeft -= sr.left + pad - wr.left;
  else if (wr.right > sr.right - pad) dom.scroller.scrollLeft += wr.right - (sr.right - pad);
});

// ---------------------------------------------------------------- 阅读区交互

function restartTranslator() {
  translator?.stop();
  translator = createTranslator(track, { lang: trackCfg.lang, onApply: applyTranslations,
    onError: (msg) => toast('翻译失败：' + msg) });
  syncTranslate();
}

async function editSubtitle(i, { onBack } = {}) {
  if (editingSubtitle) return;
  editingSubtitle = true;
  const original = track, lang = trackCfg.lang;
  translator?.stop();
  player.overlays.open('subtitle-edit');
  let closed = false, transferred = false;
  const finish = ({ dismissed } = {}) => {
    editingSubtitle = false;
    if (track === original) restartTranslator();
    if (dismissed && !sheetOpen() && track === original && pageActive && !engine.suspended) onBack?.();
    player.overlays.close('subtitle-edit');
  };
  openSheet('修改字幕', el('p', 'field-hint', '正在读取字幕…'), { cls: 'sheet-sentence', onClose: (reason) => {
    if (!transferred) { closed = true; finish(reason); }
  } });
  try {
    const defaults = await subtitleEditDefaults(original, i, lang);
    if (closed || track !== original) return;
    transferred = true;
    openSubtitleEditor(defaults, { onClose: finish, onSave: async (values, hooks) => {
      const prepared = await prepareSubtitleEdit(original, i, { ...values, lang }, hooks);
      hooks.signal.throwIfAborted();
      hooks.onCommit();
      record = await saveSubtitleEdit(original, prepared);
      const live = original.sentences;
      Object.assign(original, Track.fromData(prepared.data, objUrl));
      original.sentences.forEach((s, at) => {
        s.translation = at === i ? prepared.translation : live[at].translation;
        s.translationLang = at === i ? lang : live[at].translationLang;
      });
      const anchor = vlist.indexAt(dom.scroller.scrollTop);
      document.documentElement.dataset.subtitleMode = original.raw.subtitleMode;
      initTrackCfg(original.id, original.lang, original.features, onTrackCfg);
      reader.clearAll();
      reader.cache.clear();
      metrics.sync(dom.viewport.clientWidth);
      vlist.remeasure(anchor, 0);
      engine.refreshTrack();
      explain.setTrack(original);
      dom.btnExplain.disabled = original.raw.subtitleMode === 'plain';
      videoPlayer?.refreshPip?.();
      audioPip?.refresh();
      updateFileState();
      toast('字幕已保存');
    } });
  } catch (error) {
    if (!closed) { closeSheet(); toast(errorMessage(error, '字幕读取失败，请重试')); }
  }
}

let stuck = false;
const press = { id: -1, x: 0, y: 0, i: -1, timer: 0 };
let pressFired = false;

function curIndex() {
  if (reader && reader.activeS >= 0) return reader.activeS;
  return vlist ? vlist.indexAt(dom.scroller.scrollTop) : 0;
}

function seekWord(i, j) {
  if (!track) return;
  const s = track.sentences[i];
  const w = s && s.words[j];
  engine.seekSentence(i, s && s.wordTiming && w && w.start != null ? w.start : null);
  engine.kick();
}

/** 词卡是查看操作。关闭词卡功能时，点词仍可定位到原音。 */
function onReaderClick(e) {
  if (!track) return;
  if (pressFired) { pressFired = false; return; }
  const art = e.target.closest('.s');
  if (!art) return;
  const i = +art.dataset.i;
  if (rangeDraft) { pickRangeLine(i, e.detail === 0); return; }
  const chip = e.target.closest('.w');
  if (!chip) { engine.seekSentence(i, null); engine.kick(); return; }
  const j = +chip.dataset.j;
  const sentence = track.sentences[i], word = sentence?.words[j];
  if (trackCfg.card && word?.text.trim() && word.pos !== 'punct' && sentenceAnalyzed(track, sentence)) {
    void openWordCard({ track, i, j, lang: trackCfg.lang, lyricOffset: engine.lyricOffset,
      getAudioBlob: pronunciationBlob ? () => pronunciationBlob : undefined });
    return;
  }
  seekWord(i, j);
}

function cancelPress() {
  if (press.timer) { clearTimeout(press.timer); press.timer = 0; }
}

function onPressStart(e) {
  if (rangeDraft || e.button > 0 || e.isPrimary === false) return;
  const art = e.target.closest('.s');
  if (!art) return;
  cancelPress();
  pressFired = false;
  press.id = e.pointerId;
  press.x = e.clientX;
  press.y = e.clientY;
  press.i = +art.dataset.i;
  press.timer = setTimeout(() => {
    press.timer = 0;
    pressFired = true;
    openExplain(press.i);
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* 忽略 */ } }
  }, LONG_PRESS);
}

function onPressMove(e) {
  if (!press.timer || e.pointerId !== press.id) return;
  if (Math.abs(e.clientX - press.x) > 8 || Math.abs(e.clientY - press.y) > 8) {
    pressFired = true;
    cancelPress();
  }
}

function wireReader() {
  const sc = dom.scroller;
  sc.addEventListener('scroll', () => {
    engine.onScroll();
    if (!engine.follow) updatePractice();
    // A queued follow-scroll can arrive just after a paused video press begins.
    // Pointer movement and wheel still cancel an intentional subtitle gesture.
    if (!videoPlayer || !audio.paused) cancelPress();
    wantVisible();
    const on = sc.scrollTop > 2;
    if (on !== stuck) { stuck = on; dom.topbar.classList.toggle('is-stuck', on); }
  }, { passive: true });
  sc.addEventListener('wheel', cancelPress, { passive: true });
  for (const ev of ['touchstart', 'pointerdown']) {
    sc.addEventListener(ev, () => engine.noteUserScroll(), { passive: true });
  }
  for (const ev of ['wheel', 'touchmove']) {
    sc.addEventListener(ev, () => engine.noteUserScroll({ browse: true }), { passive: true });
  }
  sc.addEventListener('pointerdown', (event) => {
    // Scrollbar dragging is manual scrolling too; ordinary subtitle taps retain follow.
    const rect = sc.getBoundingClientRect();
    if (sc.offsetWidth > sc.clientWidth && event.clientX >= rect.left + sc.clientWidth) {
      engine.noteUserScroll({ browse: true });
    }
  }, { passive: true });
  sc.addEventListener('keydown', (event) => {
    if (event.target.closest('input, textarea, select, button, [contenteditable]')) return;
    if (rangeDraft?.target && ['Enter', ' ', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const row = event.target.closest('.s');
      const i = row ? +row.dataset.i : vlist.indexAt(sc.scrollTop + sc.clientHeight * FOLLOW_ALIGN);
      if (event.key === 'Enter' || event.key === ' ') pickRangeLine(i, true);
      else {
        const next = Math.max(0, Math.min(track.S - 1, i + (event.key === 'ArrowDown' ? 1 : -1)));
        if (!reader.els.has(next)) {
          engine.setScrollTop(vlist.scrollTargetFor(next, FOLLOW_ALIGN));
          vlist.update(true);
        }
        reader.els.get(next)?.focus();
      }
      return;
    }
    if (['PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
      engine.noteUserScroll({ browse: true });
    }
  });
  new ResizeObserver(() => { if (!practiceFrame?.hidden) relayout(false); }).observe(sc);
  let activityPip = false, nativeActive = true;
  const syncPresentation = () => {
    if (practiceFrame?.hidden) closeRangePicker();
    engine.setPresentationHidden(document.hidden || !nativeActive || activityPip || !!practiceFrame?.hidden);
    if (!engine.presentationHidden) relayout(false);
  };
  document.addEventListener('visibilitychange', syncPresentation);
  if (practiceFrame) new MutationObserver(syncPresentation).observe(practiceFrame, { attributeFilter: ['hidden'] });
  window.addEventListener('native-app-state', ({ detail }) => { nativeActive = detail.active; syncPresentation(); });
  window.addEventListener('native-pip', ({ detail }) => {
    if (typeof detail.active !== 'boolean') return;
    activityPip = detail.active; syncPresentation();
  });
  syncPresentation();

  dom.viewport.addEventListener('click', onReaderClick);
  dom.viewport.addEventListener('pointerdown', onPressStart);
  dom.viewport.addEventListener('pointermove', onPressMove);
  dom.viewport.addEventListener('pointerup', cancelPress);
  dom.viewport.addEventListener('pointercancel', cancelPress);
  dom.viewport.addEventListener('contextmenu', (event) => {
    const art = event.target.closest('.s');
    if (!art) return;
    event.preventDefault();
    if (!rangeDraft && !press.timer && !pressFired) openExplain(+art.dataset.i);
  });
}

// ---------------------------------------------------------------- 工具行

/** 长按打开的本地逐词拆解 (不调模型). */
function openExplain(i, state) {
  if (!track?.S || !pageActive || engine.suspended) return;
  const at = i >= 0 ? i : curIndex();
  if (explain.isOpen) return;
  player.overlays.open('explain');
  explain.open(at, state);
  engine.markScrollDirty();
  if (engine.follow) engine.scrollToActive();
}

/** 工具条的「讲解」: 2/3 屏对话框, 流式讲解当前句. */
function toggleChat() {
  if (!track?.S || track.raw.subtitleMode === 'plain') return;
  if (chatOpen()) { closeChat(); return; }
  showChat(dom.app.classList.contains('studio') ? practiceIndex() : curIndex());
}

function showChat(i, { onBack } = {}) {
  if (!track?.sentences[i]) return;
  const original = track;
  player.overlays.open('chat');
  dom.btnExplain.setAttribute('aria-pressed', 'true');
  openChat({
    track, i, lang: trackCfg.lang,
    onClose: ({ dismissed } = {}) => {
      dom.btnExplain.setAttribute('aria-pressed', 'false');
      if (dismissed && track === original && pageActive && !engine.suspended) onBack?.();
      player.overlays.close('chat');
    },
  });
}

/** Topbar and the immersive toolbar share one settings entry. */
function openDisplay() {
  if (!track) return;
  lyricSync?.close();
  openTrackSheet(track, {
    translator, video: videoPlayer,
    playback: videoPlayer ? null : { node: $('studioPlayback'), parking: $('studioSettingsParking') },
    onCalibrate: track.lang === 'ja' && track.S ? openCalibration : null,
    onSubtitles: () => { closeSheet(); showSetup(openDisplay); },
  });
}

function paintRepeat() {
  const mode = engine.repeat;
  const button = dom.btnRepeat;
  if (videoPlayer) {
    button.setAttribute('aria-pressed', String(mode !== 0));
    button.querySelector('.tool-t').textContent = REPEAT_LABEL[mode];
    button.querySelector('use').setAttribute('href', mode === 1 ? '#i-repeat1' : '#i-repeat');
    return;
  }
  const current = songMode();
  const { label, icon } = playbackModes[current];
  button.dataset.mode = current;
  button.setAttribute('aria-label', '播放模式，当前为' + label);
  button.title = label;
  button.querySelector('.tool-t').textContent = label;
  button.querySelector('use').setAttribute('href', '#' + icon);
  if (!audio.nativeAudio) audio.loop = mode === 2;
}

function songMode() {
  const mode = settings.songPlayMode;
  return typeof mode === 'string' && Object.hasOwn(playbackModes, mode)
    && (collection || mode === 'stop' || mode === 'single') ? mode : 'stop';
}

function restoreSongRepeat() {
  engine.setRepeat(songMode() === 'single' ? 2 : 0);
  paintRepeat();
}

function openModeMenu() {
  if (closeModeMenu) { closeModeMenu(); return; }
  const choices = collection ? Object.keys(playbackModes) : ['stop', 'single'];
  const current = songMode();
  const button = dom.btnRepeat;
  button.setAttribute('aria-expanded', 'true');
  closeModeMenu = openMenu(button, choices.map(mode => ({
    ...playbackModes[mode], checked: mode === current,
    onPick() {
      if (mode === current) return;
      cancelSongAdvance();
      setSetting('songPlayMode', mode);
      if (engine.repeat === 1) paintRepeat();
      else restoreSongRepeat();
    },
  })), { label: '播放模式', title: collection?.name, onClose() {
    button.setAttribute('aria-expanded', 'false');
    closeModeMenu = null;
  } });
}

function applyPlaybackRate(rate) {
  if (audio instanceof HTMLMediaElement) {
    audio.preservesPitch = true;
    audio.defaultPlaybackRate = rate;
  }
  if (audio.playbackRate !== rate) audio.playbackRate = rate;
}

function paintSpeed() {
  const rate = normalizePlaybackRate(audio.playbackRate);
  const pitchAvailable = !!songPitch && !!objUrl;
  const semitones = pitchAvailable && songPitch.status !== 'unavailable' ? trackCfg.pitchSemitones : 0;
  dom.speedText.textContent = rate + '×';
  dom.pitchText.hidden = !pitchAvailable;
  dom.pitchText.textContent = pitchLabel(semitones);
  dom.btnSpeed.title = pitchAvailable ? '速度与升降调' : '播放速度';
  dom.btnSpeed.setAttribute('aria-label', pitchAvailable
    ? '速度与升降调，' + rate + ' 倍，' + pitchLabel(semitones, true)
    : '播放速度 ' + rate + ' 倍');
  dom.btnSpeed.dataset.adjusted = String(rate !== 1 || semitones !== 0);
}

let hintText = '';

/** 跟读状态机的界面反馈 (按钮已隐藏, 逻辑留着备用). */
function paintShadow(kind, i, until) {
  dom.btnShadow.setAttribute('aria-pressed', kind === 'off' ? 'false' : 'true');
  const total = track ? track.S : 0;
  let text = '';
  if (kind === 'listen') text = `跟读 ${i + 1}/${total} · 播放示范`;
  else if (kind === 'speak' || kind === 'tick') {
    const left = Math.max(0, Math.ceil((until - performance.now()) / 1000));
    text = `跟读 ${i + 1}/${total} · 请跟读，剩余 ${left} 秒`;
  }
  if (text === hintText) return;
  hintText = text;
  dom.hint.textContent = text;
  const hide = !text;
  if (dom.hint.hidden !== hide) { dom.hint.hidden = hide; engine.markScrollDirty(); }
}

function practiceIndex() {
  if (!track?.S || !vlist) return 0;
  if (engine.follow) return Math.max(0, reader.activeS);
  const sc = dom.scroller;
  return vlist.indexAt(sc.scrollTop + sc.clientHeight * FOLLOW_ALIGN);
}

function paintRangePicker() {
  $('rangePicker').hidden = !rangeDraft;
  if (!rangeDraft) return;
  const { first, last, target } = rangeDraft;
  for (const [key, id] of [['first', 'rangeFirst'], ['last', 'rangeLast']]) {
    const at = rangeDraft[key];
    const field = $(id);
    field.setAttribute('aria-pressed', String(target === key));
    field.querySelector('span').textContent = at < 0 ? '待选择' : track.sentences[at].text;
    field.title = at < 0 ? '' : track.sentences[at].text;
  }
  const ready = engine.hasPlayableRange(first, last);
  $('rangeStart').disabled = !ready || !!target || !objUrl;
  const hint = target
    ? '点歌词选择' + (target === 'first' ? '起句' : '止句')
    : ready ? `共 ${last - first + 1} 句 · ${reader.timeLabel(first, last)}`
      : '这一段超出音频范围，请重选';
  $('rangeHint').textContent = hint;
}

function openRangePicker() {
  cancelPress();
  pressFired = false;
  rangeDraft = { first: -1, last: -1, target: 'first' };
  engine.holdFollow(true);
  paintRangePicker();
  paintPractice();
  enterView($('rangePicker'), 'up');
  dom.scroller.focus({ preventScroll: true });
}

function closeRangePicker(restoreFocus = false) {
  if (!rangeDraft) return false;
  rangeDraft = null;
  engine.holdFollow(false);
  paintRangePicker();
  paintPractice();
  if (restoreFocus) $('studyRange').focus({ preventScroll: true });
  return true;
}

function pickRangeLine(i, keyboard) {
  const target = rangeDraft?.target;
  if (!target || !track.sentences[i]) return;
  rangeDraft[target] = i;
  if (rangeDraft.first < 0) rangeDraft.target = 'first';
  else if (rangeDraft.last < 0) rangeDraft.target = 'last';
  else {
    if (rangeDraft.first > rangeDraft.last) {
      [rangeDraft.first, rangeDraft.last] = [rangeDraft.last, rangeDraft.first];
    }
    rangeDraft.target = null;
  }
  paintRangePicker();
  paintPractice();
  if (keyboard && !rangeDraft.target) {
    ($('rangeStart').disabled ? $('rangeLast') : $('rangeStart')).focus({ preventScroll: true });
  }
}

function startPracticeLoop(first, last = null) {
  if (!objUrl || !engine.hasPlayableRange(first, last ?? first)) return;
  closeRangePicker(true);
  cancelSongAdvance();
  engine.setRepeat(1, first, last);
  engine.seekSentence(first);
  paintRepeat();
  paintPractice();
  if (audio.paused) void player.play();
}

function paintPractice() {
  if (!dom.app.classList.contains('studio') || !track) return;
  const desk = $('practiceDesk');
  desk.hidden = false;
  desk.querySelector('.practice-cue').hidden = !track.S;
  desk.querySelector('.practice-actions').hidden = !track.S;
  if (!track.S) return;
  const i = practiceIndex();
  const rangeLoop = engine.isRangeLoop;
  reader.setBrowse(engine.follow || rangeDraft ? -1 : i);
  reader.setPracticeRange(rangeDraft ? rangeDraft.first : rangeLoop ? engine.loopS : -1,
    rangeDraft ? rangeDraft.last : rangeLoop ? engine.loopEndS : -1, !!rangeDraft?.target);
  const label = rangeDraft ? '选取区间' : rangeLoop ? '区间练唱'
    : (engine.follow ? '练唱' : '浏览') + ' · 第 ' + (i + 1) + ' 句';
  if ($('practiceLabel').textContent !== label) {
    $('practiceLabel').textContent = label;
  }
  const time = rangeLoop ? reader.timeLabel(engine.loopS, engine.loopEndS) : reader.timeLabel(i);
  if ($('practiceTime').textContent !== time) $('practiceTime').textContent = time;
  const loop = $('studyLoop');
  const repeating = engine.repeat === 1 && !rangeLoop;
  loop.disabled = !!rangeDraft || !objUrl || (!repeating && !engine.hasPlayableRange(i));
  $('studyWords').disabled = !!rangeDraft;
  loop.setAttribute('aria-pressed', String(repeating));
  loop.querySelector('span').textContent = repeating ? '结束循环' : '练这句';
  const range = $('studyRange');
  range.disabled = !objUrl;
  if (rangeLoop) range.removeAttribute('aria-expanded');
  else range.setAttribute('aria-expanded', String(!!rangeDraft));
  range.classList.toggle('is-looping', rangeLoop);
  const rangeLabel = rangeLoop ? '结束区间' : '练一段';
  const rangeText = range.querySelector('span');
  if (rangeText.textContent !== rangeLabel) rangeText.textContent = rangeLabel;
}
const updatePractice = rafOnce(paintPractice);

function studySong(song) {
  return { track: song.id, id: song.musicId || song.id, name: song.title,
    artist: song.artist, cover: song.cover, duration: song.duration };
}

function checkpointReady() {
  return !!(track && objUrl && !dom.player.hidden && audio.readyState >= 1);
}

function paintCheckpoint() {
  if (!dom.app.classList.contains('studio')) return;
  const saved = studyPoint !== null;
  const ready = checkpointReady() && !savingStudyPoint;
  const duration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : track?.duration;
  $('checkpointControls').hidden = !track || dom.player.hidden;
  $('saveCheckpoint').disabled = !ready;
  $('saveCheckpoint').querySelector('span').textContent = saved ? '更新进度' : '学到这里';
  $('resumeCheckpoint').hidden = !saved;
  $('resumeCheckpoint').disabled = !ready;
  $('clearCheckpoint').hidden = !saved;
  $('clearCheckpoint').disabled = savingStudyPoint;
  $('seekCheckpoint').hidden = !saved || !(duration > 0);
  if (saved) {
    const time = $('checkpointTime');
    time.textContent = fmtTime(studyPoint);
    time.dateTime = 'PT' + studyPoint + 'S';
    if (duration > 0) $('seekCheckpoint').style.left = Math.min(100, 100 * studyPoint / duration) + '%';
  }
}

async function restoreCheckpoint(id) {
  const revision = studyRevision;
  try {
    const saved = await getStudy(id);
    if (record?.id !== id || savingStudyPoint || studyRevision !== revision) return;
    studyPoint = checkpointTime(saved);
    paintCheckpoint();
  } catch (error) { toast(errorMessage(error, '学习进度读取失败')); }
}

async function writeCheckpoint(time) {
  if (savingStudyPoint || !record) return false;
  const song = record;
  studyRevision++;
  savingStudyPoint = true;
  paintCheckpoint();
  try {
    const point = checkpointTime(await saveStudyCheckpoint(studySong(song), time));
    if (record.id === song.id) studyPoint = point;
    toast(point === null ? '已清除学习进度' : isDegraded()
      ? '已暂存学习进度，当前浏览器无法长期保存' : '已记为学到 ' + fmtTime(point));
    return true;
  } catch (error) {
    toast(errorMessage(error, '学习进度保存失败，请重试'));
    return false;
  } finally {
    savingStudyPoint = false;
    if (record.id !== song.id) void restoreCheckpoint(record.id);
    paintCheckpoint();
  }
}

function wireCheckpoint() {
  const save = $('saveCheckpoint');
  save.onclick = async () => {
    if (!checkpointReady()) return;
    const hadFocus = document.activeElement === save;
    await writeCheckpoint(Math.round(audio.currentTime * 1000) / 1000);
    if (hadFocus && document.activeElement === document.body) save.focus({ preventScroll: true });
  };
  $('resumeCheckpoint').onclick = () => {
    if (!checkpointReady() || studyPoint === null) return;
    closeRangePicker();
    if (engine.repeat === 1) restoreSongRepeat();
    engine.setShadow(false);
    engine.setFollow(true);
    const lyricTime = engine.toLyricTime(studyPoint);
    if (track.S) engine.seekSentence(Math.max(0, locate(track.sStart, track.S, lyricTime, reader.activeS)), lyricTime);
    else engine.seek(studyPoint);
    updatePractice();
  };
  $('clearCheckpoint').onclick = async () => {
    const hadFocus = document.activeElement === $('clearCheckpoint');
    if (await writeCheckpoint(null) && hadFocus && document.activeElement === document.body
      && $('studioPlayback').closest('.sheet.is-open')) $('mute').focus({ preventScroll: true });
  };
  for (const event of ['loadedmetadata', 'durationchange', 'emptied']) audio.addEventListener(event, paintCheckpoint);
  window.addEventListener('pageshow', event => { if (event.persisted) void restoreCheckpoint(record.id); });
}

function wireTools() {
  const studio = dom.app.classList.contains('studio');
  if (studio) {
    lyricSync = bindLyricSync(step => {
      if (track?.S) setTrackCfg('lyricOffsetMs', step ? trackCfg.lyricOffsetMs + step * LYRIC_OFFSET_STEP_MS : 0);
    });
    const desk = $('practiceDesk');
    const seek = dom.player.querySelector('.p-seek');
    desk.before(seek);
    seek.append(dom.btnSpeed);
    desk.querySelector('.practice-actions').before(dom.btnPlay);
    desk.querySelector('.practice-leading').prepend(dom.btnRepeat);
    dom.btnRepeat.removeAttribute('aria-pressed');
    dom.btnRepeat.setAttribute('aria-haspopup', 'menu');
    dom.btnRepeat.setAttribute('aria-expanded', 'false');
    $('studioPlayback').prepend(dom.player.querySelector('.volume-strip'), dom.player.querySelector('.tools'));
    wireCheckpoint();
    dom.btnPin.querySelector('.tool-t').textContent = '跟随歌词';
    dom.btnExplain.querySelector('.tool-t').textContent = '句法讲解';
    $('studyWords').onclick = () => openExplain(practiceIndex());
    $('studyLoop').onclick = () => {
      if (!track?.S || !objUrl || rangeDraft) return;
      if (engine.repeat === 1 && !engine.isRangeLoop) {
        restoreSongRepeat();
        paintPractice();
        return;
      }
      startPracticeLoop(practiceIndex());
    };
    $('studyRange').onclick = () => {
      if (!track?.S || !objUrl || closeRangePicker(true)) return;
      if (engine.isRangeLoop) {
        restoreSongRepeat();
        paintPractice();
      } else openRangePicker();
    };
    for (const [key, id] of [['first', 'rangeFirst'], ['last', 'rangeLast']]) {
      $(id).onclick = () => {
        if (!rangeDraft) return;
        rangeDraft.target = key;
        paintRangePicker();
        paintPractice();
        dom.scroller.focus({ preventScroll: true });
      };
    }
    $('rangeCancel').onclick = () => closeRangePicker(true);
    $('rangeStart').onclick = () => {
      if (rangeDraft) startPracticeLoop(rangeDraft.first, rangeDraft.last);
    };
    $('rangePicker').addEventListener('keydown', event => {
      if (event.key !== 'Escape') event.stopPropagation();
    });
  }
  engine.onFollowChange = () => {
    dom.btnPin.setAttribute('aria-pressed', String(engine.followEnabled));
    updatePractice();
    followSubtitleX();
  };
  dom.btnPin.addEventListener('click', () => {
    if (!track) return;
    const on = !engine.followEnabled;
    engine.setFollow(on);
    toast(on ? '已开启字幕跟随' : '已关闭字幕跟随');
  });

  dom.btnExplain.addEventListener('click', toggleChat);

  dom.btnRepeat.addEventListener('click', () => {
    if (!track) return;
    if (studio) { openModeMenu(); return; }
    engine.setRepeat((engine.repeat + 1) % 3);
    paintRepeat();
    toast(['已关闭循环播放', '单句循环', '全部循环'][engine.repeat]);
    updatePractice();
  });

  dom.btnSpeed.addEventListener('click', () => openSpeedSheet(audio, rate => setSetting('rate', rate), objUrl ? songPitch : null));

  dom.btnDisplay.addEventListener('click', openDisplay);
  audio.addEventListener('ratechange', paintSpeed);

  engine.onCursor = (s, w, changed) => {
    if (changed) {
      updatePractice();
      wantVisible();
      if (engine.follow && dom.app.classList.contains('is-immersive')) dom.scroller.scrollLeft = 0;
    }
    followSubtitleX();
  };
  engine.onShadowState = paintShadow;

  //  字幕给的时长只到最后一句结束, 真实时长要等浏览器读完音频头; 回写库里,
  //  首页的列表就能显示准确的时长, 下次再分析也能把它当参数带给后端。
  audio.addEventListener('loadedmetadata', async () => {
    if (!record) return;
    const id = record.id, duration = audio.duration;
    try {
      const updated = await setDuration(id, duration);
      if (updated && record.id === id) record = updated;
    } catch (error) { console.warn('Media duration was not saved', error); }
    if (track?.id === id && Number.isFinite(duration)) {
      track.duration = duration;
      dom.timeTotal.textContent = fmtTime(duration);
      dom.seek.setAttribute('aria-valuemax', duration.toFixed(1));
      if (lyricSync && engine.repeat === 1 && !engine.hasPlayableRange(engine.loopS, engine.loopEndS)) restoreSongRepeat();
      if (engine.lyricOffset) reader.refreshTimeLabels();
      if (rangeDraft) paintRangePicker();
      if (lyricSync) updatePractice();
    }
  });

  dom.closeOverlays = () => {
    if (lyricSync?.close()) return;
    if (closeModeMenu) { closeModeMenu(); return; }
    if (isCardOpen()) { closeWordCard(); return; }
    if (chatOpen()) { closeChat(); return; }
    if (sheetOpen()) { closeSheet(); return; }
    if (closeRangePicker(true)) return;
    if (explain.isOpen) { explain.close(); engine.markScrollDirty(); return; }
    if (engine.shadow !== 'off') engine.setShadow(false);
  };
}

/** 全局设置回调; `layout` 表示句子高度会变, 需要整表重排. */
function onSetting(key, value, layout) {
  if (key === 'rate') { applyPlaybackRate(value); paintSpeed(); }
  if (layout) relayout(true);
  else engine.kick();
}

/** 本条音频的配置回调. */
function onTrackCfg(key, value, layout) {
  if (key === 'pitchSemitones') {
    songPitch?.setSemitones(value, true);
    return;
  }
  if (key === 'lyricOffsetMs') {
    if (!lyricSync) return;
    engine.setLyricOffset(value / 1000);
    if (engine.repeat === 1 && !engine.hasPlayableRange(engine.loopS, engine.loopEndS)) restoreSongRepeat();
    reader.refreshTimeLabels();
    lyricSync.paint(value, !!track.S);
    if (rangeDraft) paintRangePicker();
    updatePractice();
    audioPip?.refresh();
    return;
  }
  audioPip?.refresh();
  if (key === 'lang') void explain.refreshTranslation();
  if (key === 'video') { videoPlayer?.apply(); return; }
  if (key === 'tr' || key === 'lang') { syncTranslate(); videoPlayer?.refreshPip?.(); }
  // Give the inherited font and grid sizes a frame to settle before measuring the probe.
  if (layout && key === 'fonts') requestAnimationFrame(() => relayout(true));
  else if (layout) relayout(true);
  else engine.kick();
}

// ---------------------------------------------------------------- 启动

async function boot() {
  const practiceLink = musicPracticeParams(location.search);
  if (practiceLink && !practiceFrame && !nativeApp()) {
    location.replace(musicURLForPractice(practiceLink, location.href).href);
    return;
  }
  loadConfig();
  initSettings(onSetting);
  wireReader();
  nativeReady(); // A valid entry point is ready before network or large media reads.
  if (practiceLink) dom.btnBack.setAttribute('aria-label', '返回选歌列表');
  let closingSetup = false;
  dom.btnBack.addEventListener('click', async (event) => {
    event.preventDefault();
    if (closingSetup) return;
    lyricSync?.close();
    closeRangePicker();
    if (!dom.setup.hidden) {
      const onBack = setupOnBack;
      closingSetup = true;
      try {
        await openTrack();
        onBack?.();
      } catch (error) {
        showState('播放器加载失败', errorMessage(error, '请返回列表后重试'));
      } finally {
        closingSetup = false;
      }
      return;
    }
    if (videoPlayer?.isImmersive()) { void videoPlayer.leaveHorizontal(); return; }
    if (practiceFrame) {
      window.parent.postMessage({ type: PRACTICE_BACK }, location.origin);
      return;
    }
    const params = new URLSearchParams(location.search);
    const target = params.get('from') === 'music' ? musicBrowseURL(params, location.href)
      : new URL(params.has('favorite') ? 'index.html#favorites' : 'index.html', location.href);
    const fallback = () => location.replace(target.href);
    const playerPath = location.pathname;
    if (canReturnTo(target)) backWithFallback(fallback, () => location.pathname === playerPath);
    else fallback();
  });
  window.addEventListener('native-back', (event) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    dom.btnBack.click();
  });

  const q = new URLSearchParams(location.search);
  collection = playbackSource(q);
  entryCheckpoint = q.get('checkpoint') === '1';
  const id = q.get('track') || settings.track;
  if (q.has('favorite')) {
    try {
      const favorite = await getFavorite(q.get('favorite'));
      if (favorite?.track === id) entryFavorite = favorite;
    } catch (error) { toast(errorMessage(error, '收藏读取失败')); }
  }
  if (!id) {
    dom.player.hidden = true;
    showState('未选择媒体', '请返回首页选择或导入音频、视频');
    return;
  }
  await load(id, q.get('setup') === '1');
  dom.btnFiles.addEventListener('click', repairFiles);
  if (record?.audio?.missing && !record.musicId && q.get('setup') !== '1') repairFiles();

  // 本地字体加载完再校一次度量: 字体一换, 所有宽度都要重量.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => relayout(true));
}

// 当前音源跟随文档生命周期, 供页面从 bfcache 恢复后继续使用。
// 换曲由 attachAudio 释放旧 URL, 文档销毁时浏览器会自动释放剩余的 URL。

boot().catch((err) => {
  console.error(err);
  showState('播放器加载失败', errorMessage(err, '请刷新页面后重试'));
});

// 带 ?debug 时挂一个只读句柄, 方便在控制台里看内部状态 (高度表/游标/翻译进度)
if (new URLSearchParams(location.search).has('debug')) {
  window.LT = {
    engine, metrics, relayout,
    get track() { return track; },
    get reader() { return reader; },
    get vlist() { return vlist; },
    get translator() { return translator; },
  };
}
