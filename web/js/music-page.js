import { music, musicQuality, saveMusicQuality, MUSIC_QUALITIES } from './music-api.js';
import { LYRIC_ALIGNMENT_VERSION, upgradeSongLyrics } from './music-lyrics.js';
import { patchTrack, trackData } from './library.js';
import { updateRecord } from './store.js';
import { showCover } from './music-art.js';
import { initSettings } from './settings.js';
import { llmReady, loadConfig } from './config.js';
import { enterView } from './motion.js';

import { mountMusicList } from './music-list.js';
import { mountCollection } from './music-collection.js';
import { checkpointTime, studyKey, studyListRows, studyLists, studyRecords, updateStudy } from './music-study.js';
import { addPlaybackSource } from './music-queue.js';
import { ensureSongTrack } from './music-tracks.js';
import { createSongMenu } from './music-song-menu.js';
import { mountMusicPractice } from './music-practice.js';
import { nativeApp } from './native.js';
import { backWithFallback, writeHistory } from './navigation.js';
import { debounce, fmtSize, fmtTime, icon, toast } from './util.js';

initSettings();
const practice = nativeApp() ? null : mountMusicPractice(refreshPracticeLibrary);

const $ = id => document.getElementById(id);
let account, accountRequest, request, loginRequest, timer, viewRequest, refreshStudyList, renderedHash;
let loginError = '';
let studies = new Map();
let selectedFolder, selectedArtist;
const labels = { search: '搜索结果', artist: '歌手曲目', likes: '喜欢的音乐', folders: '我的歌单', playlist: '歌单', ...studyLists };
const accountViews = new Set(['likes', 'folders', 'playlist']);
const searchChoices = [...$('search-kinds').querySelectorAll('button')];
const searchForm = $('search'), searchInput = $('query'), searchError = $('search-error'), searchClear = $('search-clear');
const status = message => { $('status').textContent = message; };
const preference = 'utaloop.music.retention';
const modeChoices = [...$('retention').querySelectorAll('input')];
let mode = '30d', hasLogin = false, checked = false;
try {
  const saved = localStorage.getItem(preference);
  if (modeChoices.some(input => input.value === saved)) mode = saved;
} catch { /* Browser preferences may be disabled. */ }

function renderRetention() {
  for (const input of modeChoices) input.checked = input.value === mode;
  const signedIn = !!account && hasLogin;
  $('account-profile').hidden = !signedIn;
  $('account-profile').textContent = signedIn ? account.name : '';
  $('account').hidden = signedIn;
  $('privacy-account').textContent = account ? account.name
    : hasLogin ? '等待验证' : checked ? '未登录' : '等待连接';
  $('retention-description').textContent = {
    session: '仅在本次运行期间保留登录。重启本地音乐服务后，需要重新扫码。',
    '30d': '登录在本机加密保存 30 天。期间更新项目，可在原浏览器继续使用。',
    long: '在本机加密保存，使用时自动延长。约一年未使用后，需要重新扫码。'
  }[mode];
  $('forget').hidden = !hasLogin;
}
function rememberMode() {
  try { localStorage.setItem(preference, mode); } catch { /* Current selection still applies. */ }
}
$('retention').onchange = async event => {
  const choice = event.target.value;
  const hadFocus = document.activeElement === event.target;
  $('retention-status').textContent = '正在保存…';
  $('retention').disabled = true;
  $('account').disabled = true;
  try {
    const active = await music('retention', { mode: choice });
    hasLogin = !!active;
    mode = active || choice;
    rememberMode();
    $('retention-status').textContent = active ? '已应用到当前登录。' : '已设为下次扫码的保存方式。';
  } catch (error) { $('retention-status').textContent = error.message; }
  finally {
    renderRetention(); $('retention').disabled = false; $('account').disabled = false;
    if (hadFocus && $('privacy').open && document.activeElement === document.body)
      modeChoices.find(input => input.checked)?.focus();
  }
};

function stopLogin() {
  clearTimeout(timer);
  loginRequest?.abort();
  $('login').hidden = true;
  $('retention').disabled = !checked;
}
async function profile(signal) {
  const result = await music('account', {}, signal);
  signal.throwIfAborted();
  account = result;
  hasLogin = !!account;
  renderRetention();
  $('account').textContent = '扫码登录';
}
async function login() {
  stopLogin();
  loginRequest = new AbortController();
  const { signal } = loginRequest;
  try {
    $('login').hidden = false;
    $('retention').disabled = true;
    enterView($('login'), 'up');
    $('qr').hidden = true;
    $('scan').textContent = '正在获取二维码…';
    $('qr').src = await music('qr', { mode }, signal);
    $('qr').hidden = false;
    enterView($('qr'), 'fade');
    $('scan').textContent = '请在手机上确认登录';
    async function poll() {
      try {
        if (document.hidden) { timer = setTimeout(poll, 2500); return; }
        const code = await music('poll', {}, signal);
        if (code === 803) {
          stopLogin();
          await refreshAccountView();
          return;
        }
        if (code === 800) throw Error('二维码已过期，请重新点击扫码登录');
        $('scan').textContent = code === 802 ? '已扫码，等待手机确认' : '等待扫码';
        timer = setTimeout(poll, 2200);
      } catch (e) { if (!signal.aborted) $('scan').textContent = e.message; }
    }
    timer = setTimeout(poll, 1500);
  } catch (e) { if (!signal.aborted) $('scan').textContent = e.message; }
}

async function loadSongLyrics(song, signal) {
  const { id, lang } = await ensureSongTrack(song, signal);
  const data = await trackData(id);
  if (!data?.sentences?.length) throw Error('这首歌暂无可用的歌词');
  if ((data.language || lang || 'ja') !== 'ja') throw Error('当前批量标注支持日语歌词');
  if (!data.sourceLyrics || data.sourceAlignmentVersion >= LYRIC_ALIGNMENT_VERSION) return data;
  return await updateRecord('data', id, current => {
    signal.throwIfAborted();
    return upgradeSongLyrics(current);
  }) || upgradeSongLyrics(data);
}

async function openSong(song, resumeCheckpoint = false, selection) {
  request?.abort();
  const job = request = new AbortController();
  const { signal } = job;
  const hash = location.hash, source = route(), label = $('heading').textContent;
  try {
    status('正在打开「' + song.name + '」…');
    const { id, cover } = await ensureSongTrack(song, signal);
    if (signal.aborted || location.hash !== hash) return;
    if (song.cover && cover !== song.cover) void patchTrack(id, { cover: song.cover }).catch(() => {});
    saveMusicScroll($('viewport').scrollTop);
    const params = new URLSearchParams({ from: 'music', track: id });
    if (hash) params.set('browse', hash);
    if (resumeCheckpoint) params.set('checkpoint', '1');
    addPlaybackSource(params, source.type, source.params.get('id'), label, selection);
    if (practice) {
      songMenu.close();
      status('');
      practice.open(params);
    } else location.href = 'player.html?' + params;
  } catch (error) {
    if (!signal.aborted && location.hash === hash) status(error.message);
  } finally {
    if (request === job) request = null;
  }
}


const localTabs = new Set(Object.keys(studyLists));
const emptyNotes = { learning: '点歌曲右侧的「⋯」，选「在学」即可加入。', learned: '点歌曲右侧的「⋯」，选「已学」即可加入。', recent: '开始播放练唱后，歌曲会按最近练习时间出现在这里。' };

function route() {
  const [type, query] = location.hash.slice(1).split('?');
  return { type: Object.hasOwn(labels, type) ? type : '', params: new URLSearchParams(query) };
}
function hashFor(type, params = {}) {
  const query = new URLSearchParams(params).toString();
  return '#' + type + (query ? '?' + query : '');
}
function go(type, params) { location.hash = hashFor(type, params); }
const searchKind = params => params.get('kind') === 'artist' ? 'artist' : 'song';
const searchParams = (query, kind) => kind === 'artist' ? { query, kind } : { query };
function element(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
}
function localRows(type) {
  return studyListRows(studies.values(), type);
}
function counts() {
  for (const type of localTabs) $('count-' + type).textContent = localRows(type).length + ' 首';
}
async function refreshPracticeLibrary() {
  initSettings();
  const view = viewRequest;
  try {
    const rows = await studyRecords();
    if (view !== viewRequest) return;
    studies = new Map(rows.map(row => [row.track, row]));
    counts();
    const { type } = route();
    if (localTabs.has(type) && refreshStudyList) {
      const songs = localRows(type);
      $('list-head').hidden = !songs.length;
      refreshStudyList(songs);
    }
  } catch { /* Keep the current list available when local data cannot be read. */ }
}
$('batch-lyrics').onclick = async () => {
  const trigger = $('batch-lyrics');
  const { type } = route();
  trigger.disabled = true;
  try {
    const { openLyricBatch } = await import('./lyric-batch-ui.js');
    if (route().type === type) openLyricBatch(localRows(type), { loadSongLyrics, trigger });
  } catch (error) { toast(error.message); }
  finally { trigger.disabled = false; }
};
const songMenu = createSongMenu($('song-popup'), {
  viewport: $('viewport'),
  results: $('results'),
  getStudy: song => studies.get(studyKey(song)),
  onOpen: openSong,
  onError: status,
  async onMark(song, state) {
    const key = studyKey(song);
    const previous = studies.get(key)?.state;
    const saved = await updateStudy(song, { state, marked: Date.now() });
    if (saved) studies.set(key, saved);
    else studies.delete(key);
    counts();
    toast(state === 'learned' ? '已加入「已学」' : state === 'learning' ? '已加入「在学」' : '已标为未学');
    const { type } = route();
    if (refreshStudyList && (type === previous || type === state)) {
      refreshStudyList(localRows(type));
    }
  }
});

function placeholder(index, folder = false) {
  const node = element('div', folder ? 'folder-card skeleton' : 'song-row skeleton');
  node.setAttribute('aria-hidden', 'true');
  node.style.setProperty('--title-width', [57, 72, 48, 65][index % 4] + '%');
  const lines = element('span', 'skeleton-lines');
  lines.append(element('i'), element('i'));
  if (!folder) node.append(element('span', 'number'));
  node.append(element('span', 'skeleton-cover'), lines);
  return node;
}

function artistRow(artist, index, query) {
  if (!artist) return placeholder(index);
  const row = element('div', 'song-row artist-row');
  const link = element('a', 'song-open artist-link');
  link.href = hashFor('artist', { id: artist.id, name: artist.name, query });
  link.onclick = () => { selectedArtist = artist; };
  const portrait = element('span', 'thumb artist-portrait', Array.from(artist.name || '')[0] || '♪');
  portrait.setAttribute('aria-hidden', 'true');
  if (artist.cover) {
    const image = element('img');
    image.loading = 'lazy';
    portrait.append(image);
    showCover(image, { cover: artist.cover, pixels: 96, signal: viewRequest.signal });
  }
  const info = element('span', 'song-text');
  info.append(element('b', '', artist.name));
  if (artist.alias) info.append(element('small', '', artist.alias));
  const arrow = element('span', 'artist-arrow', '›');
  arrow.setAttribute('aria-hidden', 'true');
  link.append(portrait, info, arrow);
  row.append(link);
  return row;
}

function songRow(item, index, type, selection) {
  if (!item) return placeholder(index);
  const node = element('div', 'song-row');
  if (item.unavailable) {
    node.classList.add('pending');
    node.textContent = '曲目信息暂不可用';
    return node;
  }
  const folder = type === 'folders';
  const open = element('button', 'song-open');
  const thumb = element('span', 'thumb', folder ? '▤' : '♫');
  thumb.style.setProperty('--sleeve-hue', String((Number(item.id) || index + 1) * 47 % 360));
  thumb.setAttribute('aria-hidden', 'true');
  const onlineId = !item.track || item.track.startsWith('netease-') ? item.id : null;
  if (item.cover || onlineId) {
    const image = element('img');
    image.loading = 'lazy';
    thumb.append(image);
    showCover(image, { cover: item.cover, id: onlineId, pixels: folder ? 320 : 96,
      kind: folder ? 'playlist' : 'song', signal: viewRequest.signal, onFound: cover => {
        item.cover = cover;
        if (!folder) {
          const key = studyKey(item), saved = studies.get(key);
          if (saved) saved.cover = cover;
          // Update existing records only. Artwork alone never marks a song as learned.
          void updateRecord('study', key, current => ({ ...current, cover })).catch(() => {});
        }
      } });
  }
  const info = element('span', 'song-text');
  const point = localTabs.has(type) ? checkpointTime(item) : null;
  const resumeCheckpoint = type === 'learning' && point !== null;
  const description = element('small');
  if (point !== null) {
    description.append(element('span', 'checkpoint-label', (resumeCheckpoint ? '继续 ' : '学到 ') + fmtTime(point)));
    if (item.artist) description.append(' · ' + item.artist);
  } else description.textContent = item.artist || '';
  info.append(element('b', '', item.name), description);
  open.append(element('span', 'number', index + 1), thumb, info);
  open.onclick = () => {
    if (!folder) return openSong(item, resumeCheckpoint, selection);
    selectedFolder = { ...item, uid: account?.uid };
    go('playlist', { id: item.id, name: item.name });
  };
  node.append(open);
  if (folder) node.append(element('span', 'duration', '›'));
  else {
    if (type === 'recent') node.append(element('span', 'duration', new Date(item.practiced).toLocaleDateString()));
    else if (item.duration) node.append(element('span', 'duration', Math.floor(item.duration / 60) + ':' + String(Math.floor(item.duration % 60)).padStart(2, '0')));
    const more = element('button', 'song-menu-trigger');
    more.type = 'button';
    more.dataset.key = studyKey(item);
    more.title = '更多操作';
    more.setAttribute('aria-label', '「' + item.name + '」的更多操作');
    more.setAttribute('aria-haspopup', 'menu');
    more.setAttribute('aria-controls', 'song-menu');
    more.setAttribute('aria-expanded', 'false');
    const dots = icon('ic-dots', 'song-menu-icon');
    dots.setAttribute('aria-hidden', 'true');
    more.append(dots);
    more.onclick = () => songMenu.open(more, item, { selection });
    more.onkeydown = event => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      songMenu.open(more, item, { edge: event.key === 'ArrowDown' ? 'first' : 'last', selection });
    };
    node.oncontextmenu = event => {
      event.preventDefault();
      const focusFrom = node.contains(document.activeElement) ? document.activeElement : more;
      const point = event.button === 2 || event.pointerType === 'touch'
        ? { x: event.clientX, y: event.clientY } : undefined;
      songMenu.open(more, item, { edge: 'first', point, focusFrom, selection });
    };
    node.onkeydown = event => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      event.preventDefault();
      songMenu.open(more, item, { edge: 'first', focusFrom: event.target, selection });
    };
    node.append(more);
  }
  return node;
}

async function showFolders(signal, position, remember) {
  const results = $('results'), viewport = $('viewport'), more = $('more');
  let offset = 0, count = 0, busy = false;
  results.classList.add('folder-grid');
  async function load() {
    if (busy || signal.aborted) return;
    busy = true;
    more.disabled = true;
    const preview = Array.from({ length: count ? 2 : 4 }, (_, i) => placeholder(i, true));
    results.append(...preview);
    results.setAttribute('aria-busy', 'true');
    try {
      let page;
      do {
        page = await music('folders', { offset, limit: 60 }, signal);
        if (signal.aborted) return;
        preview.forEach(node => node.remove());
        for (const item of page.items) {
          const card = songRow(item, count++, 'folders').querySelector('.song-open');
          card.className = 'folder-card';
          if (!position && count <= 6) card.classList.add('list-arrival');
          results.append(card);
        }
        offset += 60;
      } while (page.more && (!count || viewport.scrollHeight - viewport.clientHeight < position));
      viewport.scrollTop = position || viewport.scrollTop;
      position = 0;
      $('meta').textContent = count + ' 个歌单';
      more.hidden = !page.more; more.textContent = '加载更多歌单';
      status(count ? '' : '还没有自建歌单。');
    } catch (error) {
      if (!signal.aborted) { status(error.message); more.hidden = false; more.textContent = '重新加载'; }
    } finally {
      preview.forEach(node => node.remove());
      busy = false;
      if (!signal.aborted) { more.disabled = false; results.removeAttribute('aria-busy'); }
    }
  }
  viewport.addEventListener('scroll', () => remember(viewport.scrollTop), { signal, passive: true });
  more.onclick = load;
  await load();
}

function searchBusy(busy) {
  searchForm.setAttribute('aria-busy', String(busy));
  $('search-label').textContent = busy ? '搜索中' : '搜索';
}

function setSearchError(invalid) {
  if (invalid) searchInput.setAttribute('aria-invalid', 'true');
  else searchInput.removeAttribute('aria-invalid');
  const message = invalid ? '输入歌名或歌手后再搜索' : '';
  if (searchError.textContent !== message) searchError.textContent = message;
}

function saveMusicScroll(top) {
  if (history.state?.musicScroll !== top) writeHistory('replaceState', { ...history.state, musicScroll: top });
}

async function render() {
  songMenu.close();
  refreshStudyList = undefined;
  const currentHash = location.hash;
  if (renderedHash !== currentHash) request?.abort();
  renderedHash = currentHash;
  viewRequest?.abort();
  viewRequest = new AbortController();
  const signal = viewRequest.signal, { type, params } = route();
  const remember = debounce(top => {
    if (!signal.aborted && location.hash === currentHash) saveMusicScroll(top);
  }, 240);
  const searching = type === 'search';
  const artists = searching && searchKind(params) === 'artist';
  const artistPage = type === 'artist';
  const query = params.get('query') || '';
  const id = params.get('id');
  const artist = artistPage && id === String(selectedArtist?.id) ? selectedArtist : null;
  let displayedCover = '';
  function headerCover(cover) {
    if (!cover || cover === displayedCover || signal.aborted) return;
    displayedCover = cover;
    const host = $('detail-cover');
    host.querySelector('img')?.remove();
    const image = element('img'); host.append(image);
    showCover(image, { cover, pixels: 192, signal });
  }
  const position = history.state?.musicScroll || 0;
  const local = localTabs.has(type);
  $('overview').hidden = !!type;
  $('home-title').hidden = !!type;
  searchForm.hidden = !!type && !searching;
  $('search-home').hidden = !searching;
  $('back').hidden = searching;
  $('detail').classList.toggle('search-results', searching);
  $('detail').classList.toggle('artist-results', artists);
  $('search-kinds').hidden = !searching;
  for (const choice of searchChoices) choice.setAttribute('aria-pressed', String(choice.dataset.kind === searchKind(params)));
  if (searching) searchInput.value = query;
  searchClear.hidden = !searchInput.value;
  setSearchError(false);
  searchBusy(searching && !!query);
  $('detail').hidden = !type;
  $('batch-lyrics').hidden = true;
  $('collection-tools').hidden = true;
  $('more').hidden = true; $('authenticate').hidden = true; $('list-head').hidden = true;
  $('more').disabled = false;
  $('results').classList.remove('folder-grid'); $('results').replaceChildren(); $('results').removeAttribute('aria-busy'); $('results').style.height = ''; $('viewport').scrollTop = 0;
  status('');
  if (type) {
    const title = artist?.name || ((type === 'playlist' || artistPage) ? params.get('name') : '');
    $('heading').textContent = title || labels[type];
    $('source-label').textContent = artistPage ? '歌手曲目' : local ? '学习清单' : '我的网易云';
    $('back').textContent = type === 'playlist' ? '‹　我的歌单' : artistPage && query ? '‹　歌手结果' : '‹　选歌练唱';
    $('detail-cover').className = type === 'playlist' ? 'folders' : type;
    $('detail-cover').textContent = { likes: '♥', folders: '▤', playlist: '♫', search: '♪', artist: '♪', learning: '♫', learned: '✓', recent: '◷' }[type];
    if (type === 'playlist' && selectedFolder?.uid === account?.uid && String(selectedFolder?.id) === id) headerCover(selectedFolder?.cover);
    if (artist) headerCover(artist.cover);
    $('meta').textContent = '';
  }
  enterView($(type ? 'detail' : 'overview'), 'fade');
  try {
    const rows = await studyRecords().catch(error => {
      if (local) throw error;
      return null;
    });
    if (signal.aborted) return;
    if (rows) { studies = new Map(rows.map(row => [row.track, row])); counts(); }
    $('batch-lyrics').hidden = !local;
    if (!type) return;
    if (searching && !query) { status('输入歌名或歌手名开始搜索。'); return; }
    if (accountViews.has(type) && !account) {
      if (accountRequest) { status('正在连接网易云音乐…'); return; }
      status(loginError || (hasLogin ? '暂时无法读取账号，请重试登录状态。' : '登录网易云音乐后，即可查看自己的收藏。'));
      $('authenticate').textContent = loginError || hasLogin ? '重试登录状态' : '扫码登录';
      $('authenticate').hidden = false; return;
    }
    const data = local ? localRows(type) : null;
    if (type === 'folders') { status('正在读取…'); await showFolders(signal, position, remember); return; }
    $('list-head').hidden = artists || data?.length === 0;
    if (data && !data.length) status(emptyNotes[type]);
    else if (!local) status('正在读取…');
    const unit = artists ? ' 位歌手' : ' 首歌曲';
    const noResults = artists ? '没有找到相关歌手，可以换个名字或试试别名。'
      : searching ? '没有找到相关歌曲，可以切换到「歌手」或换个关键词。'
      : artistPage ? '这位歌手暂时没有可浏览的曲目。' : '暂无内容';
    const inCollection = local || type === 'likes' || type === 'playlist';
    $('collection-tools').hidden = !inCollection;
    const mount = inCollection ? mountCollection : mountMusicList;
    refreshStudyList = mount({ viewport: $('viewport'), results: $('results'), more: $('more'), signal, position, local: data,
      emptyNote: emptyNotes[type],
      row: artists ? (item, index) => artistRow(item, index, query) : (item, index, selection) => songRow(item, index, type, selection),
      report: message => status(message === '暂无内容' ? noResults : message),
      meta: (n, more) => { $('meta').textContent = (more ? '已载入 ' : '') + n.toLocaleString() + unit; },
      load: async (offset, limit) => {
        const firstSearch = searching && offset === 0;
        if (firstSearch) searchBusy(true);
        let page;
        const input = artistPage ? { id, kind: 'artist-songs', includeArtist: !artist } : Object.fromEntries(params);
        try { page = await music(artistPage ? 'search' : type, { ...input, offset, limit }, signal); }
        finally { if (firstSearch && !signal.aborted) searchBusy(false); }
        if (!signal.aborted && page.playlist) {
          headerCover(page.playlist.cover);
          if (type === 'playlist' && page.playlist.name) $('heading').textContent = page.playlist.name;
        }
        if (!signal.aborted && page.artist) {
          selectedArtist = page.artist;
          if (page.artist.name) $('heading').textContent = page.artist.name;
          headerCover(page.artist.cover);
        }
        return page;
      },
      remember });
  } catch (error) { if (!signal.aborted) { searchBusy(false); status(error.message); } }
}
searchInput.addEventListener('input', () => {
  searchClear.hidden = !searchInput.value;
  if (searchInput.value.trim()) setSearchError(false);
});
searchClear.onclick = () => {
  searchInput.value = '';
  searchClear.hidden = true;
  setSearchError(false);
  searchInput.focus({ preventScroll: true });
};
searchForm.onsubmit = event => {
  event.preventDefault();
  const query = searchInput.value.trim();
  if (!query) {
    searchInput.value = '';
    searchClear.hidden = true;
    setSearchError(true);
    searchInput.focus();
    return;
  }
  setSearchError(false);
  const current = route();
  const kind = searchKind(current.params);
  const same = current.type === 'search' && current.params.get('query') === query;
  if (same && searchForm.getAttribute('aria-busy') === 'true') return;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    $('search-submit').animate([{ transform: 'scale(.92)' }, { transform: 'scale(1.035)' }, { transform: 'scale(1)' }],
      { duration: 230, easing: 'ease-out' });
  }
  if (matchMedia('(pointer: coarse)').matches) searchInput.blur();
  searchBusy(true);
  if (same) void render(); else go('search', searchParams(query, kind));
};
for (const choice of searchChoices) choice.onclick = () => {
  const { params } = route();
  const query = searchInput.value.trim() || params.get('query') || '';
  if (!query) { setSearchError(true); searchInput.focus(); return; }
  const kind = choice.dataset.kind;
  if (params.get('query') !== query || searchKind(params) !== kind) go('search', searchParams(query, kind));
};
$('back').onclick = () => {
  const { type, params } = route();
  const query = params.get('query');
  const target = type === 'playlist' ? '#folders' : type === 'artist' && query ? hashFor('search', searchParams(query, 'artist')) : '';
  if (location.hash === target) return;
  const url = new URL(location.href);
  url.hash = target;
  const fallback = () => location.replace(url.href);
  if (history.state?.musicParent === target) backWithFallback(fallback);
  else fallback();
};
$('authenticate').onclick = () => $('account').click();
$('search-home').onclick = () => $('back').click();

const qualityOptions = Object.entries(MUSIC_QUALITIES).map(([value, text]) => {
  const label = element('label');
  const radio = element('input');
  radio.type = 'radio'; radio.name = 'music-quality'; radio.value = value;
  label.append(radio, text);
  $('quality-options').append(label);
  return radio;
});
function renderMusicQuality() {
  const selected = musicQuality();
  for (const radio of qualityOptions) radio.checked = radio.value === selected;
}
$('quality-options').addEventListener('change', event => {
  const saved = saveMusicQuality(event.target.value);
  if (!saved) renderMusicQuality();
  $('quality-status').textContent = saved ? '' : '无法保存音质设置。';
});

let cacheBusy = false, cacheRevision = 0, cacheRefresh;
async function updateSongCache(action = 'cache-info', limitMiB) {
  if (cacheBusy) return;
  clearTimeout(cacheRefresh);
  const revision = ++cacheRevision;
  const change = action !== 'cache-info';
  const message = $('song-cache-message');
  const controls = ['song-cache-limit', 'song-cache-save', 'song-cache-clear'].map($);
  if (change) {
    cacheBusy = true;
    controls.forEach(control => { control.disabled = true; });
    message.textContent = '正在更新歌曲缓存…';
  }
  try {
    const data = await music(action, limitMiB === undefined ? {} : { limitMiB });
    if (revision !== cacheRevision || !$('privacy').open) return;
    $('song-cache').hidden = !data;
    if (!data) return;
    $('song-cache-location').textContent = data.directory;
    $('song-cache-form').hidden = !data.available;
    $('song-cache-size').textContent = data.available ? fmtSize(data.usedBytes) + ' 已用' : '';
    if (!data.available) {
      message.textContent = '歌曲缓存不可用。请检查安装目录的写入权限。';
      return;
    }
    if (change || !$('song-cache-limit').value) $('song-cache-limit').value = String(data.limitMiB);
    message.textContent = data.pendingBytes ? fmtSize(data.pendingBytes) + ' 正在占用，释放后清理。'
      : action === 'cache-clear' ? '歌曲缓存已清空。' : action === 'cache-limit' ? '容量上限已更新。' : '';
    if (data.pendingBytes) cacheRefresh = setTimeout(() => {
      if ($('privacy').open) void updateSongCache();
    }, 2500);
  } catch (error) {
    if (revision === cacheRevision && $('privacy').open && change) message.textContent = error.message;
  } finally {
    if (change) {
      cacheBusy = false;
      controls.forEach(control => { control.disabled = false; });
    }
  }
}

$('song-cache-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = $('song-cache-limit'), value = input.value.trim();
  const limit = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(limit * 1024 * 1024)) {
    input.setAttribute('aria-invalid', 'true');
    $('song-cache-message').textContent = '请输入大于或等于 0 的整数。';
    input.focus();
    return;
  }
  input.removeAttribute('aria-invalid');
  void updateSongCache('cache-limit', limit);
});
$('song-cache-clear').onclick = () => void updateSongCache('cache-clear');
$('privacy').addEventListener('close', () => clearTimeout(cacheRefresh));

let privacyTrigger;
function openPrivacy(trigger) {
  privacyTrigger = trigger;
  loadConfig();
  $('model-status').textContent = llmReady() ? '已配置' : '未配置';
  renderMusicQuality();
  $('quality-status').textContent = '';
  renderRetention();
  $('retention-status').textContent = loginError;
  $('privacy').showModal();
  $('song-cache-limit').value = '';
  void updateSongCache();
}
let closingPrivacy = false;
async function closePrivacy() {
  const sheet = $('privacy');
  if (!sheet.open || closingPrivacy) return;
  closingPrivacy = true;
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await sheet.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(16px)' }],
      { duration: 130, easing: 'ease-in' }).finished.catch(() => {});
  }
  sheet.close(); closingPrivacy = false;
  privacyTrigger?.focus({ preventScroll: true });
}
$('settings').onclick = () => openPrivacy($('settings'));
$('privacy').querySelector('.model-link').addEventListener('click', (event) => {
  if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) $('privacy').close();
});
$('privacy-close').onclick = $('privacy-done').onclick = closePrivacy;
$('privacy').addEventListener('cancel', event => { event.preventDefault(); void closePrivacy(); });
$('privacy').addEventListener('click', event => {
  if (event.target !== $('privacy')) return;
  const box = $('privacy').getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) void closePrivacy();
});
window.addEventListener('hashchange', event => {
  if (new URL(event.newURL).hash !== location.hash) return;
  const parent = new URL(event.oldURL).hash;
  if (!history.state) writeHistory('replaceState', { musicParent: parent });
  stopLogin();
  if (renderedHash !== location.hash) void render();
});
$('account').onclick = async () => {
  if (!checked || (hasLogin && !account)) return refreshAccountView();
  if (!hasLogin) return login();
};
$('forget').onclick = async () => {
  $('forget').disabled = true;
  try {
    await music('logout'); await restore();
    $('retention-status').textContent = '本机登录已清除。';
    if (location.hash) location.hash = ''; else await render();
  } catch (e) { $('retention-status').textContent = e.message; }
  finally { $('forget').disabled = false; }
};
$('cancel').onclick = stopLogin;
window.addEventListener('pagehide', () => {
  stopLogin(); songMenu.close(); accountRequest?.abort(); request?.abort(); viewRequest?.abort();
});

async function restore() {
  accountRequest?.abort();
  const job = accountRequest = new AbortController();
  const { signal } = job;
  $('account').disabled = true;
  $('retention').disabled = true;
  checked = false;
  account = null;
  loginError = '';
  try {
    const active = await music('retention', {}, signal);
    signal.throwIfAborted();
    checked = true;
    hasLogin = !!active;
    if (active) { mode = active; rememberMode(); }
    renderRetention();
    if (hasLogin) await profile(signal);
    else $('account').textContent = '扫码登录';
  } catch (error) {
    if (signal.aborted) return false;
    loginError = error.message;
    $('account').textContent = '重试登录状态';
  } finally {
    if (accountRequest === job) {
      accountRequest = null;
      $('account').disabled = false;
      $('retention').disabled = !checked;
    }
  }
  return !signal.aborted;
}
async function refreshAccountView() {
  if (await restore() && accountViews.has(route().type)) await render();
}
function refreshView() {
  void render();
  void refreshAccountView();
}
renderRetention();
refreshView();
window.addEventListener('pageshow', e => {
  if (e.persisted) refreshView();
});
