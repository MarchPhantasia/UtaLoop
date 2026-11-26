import { mountMusicList, musicPageSize } from './music-list.js';
import { writeHistory } from './navigation.js';

const collator = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
const fold = value => String(value || '').normalize('NFKC').toLowerCase()
  .replace(/[ァ-ヶ]/g, letter => String.fromCharCode(letter.charCodeAt(0) - 96));

export function selectCollection(songs, query, order) {
  const terms = fold(query).trim().split(/\s+/).filter(Boolean);
  const rows = terms.length ? songs.filter(song => {
    if (song.unavailable) return false;
    const text = fold(song.name + ' ' + song.artist);
    return terms.every(term => text.includes(term));
  }) : songs.slice();
  if (order === 'original') return rows;
  if (order === 'reverse') return rows.reverse();
  return rows.sort((a, b) => {
    if (!!a.unavailable !== !!b.unavailable) return a.unavailable ? 1 : -1;
    if (order === 'title' || order === 'artist') {
      const key = order === 'title' ? 'name' : 'artist';
      if (!a[key] || !b[key]) return Number(!!b[key]) - Number(!!a[key]);
      return collator.compare(a[key], b[key]);
    }
    if (!a.duration || !b.duration) return Number(!!b.duration) - Number(!!a.duration);
    return order === 'long' ? b.duration - a.duration : a.duration - b.duration;
  });
}

// The default view stays paged. Build a complete, in-memory catalogue only
// when needed. Both views share page promises for the lifetime of this route.
export function collectionPages(load) {
  const pages = new Map();
  let catalogue;
  function page(offset, signal) {
    if (!pages.has(offset)) {
      const request = load(offset, musicPageSize, signal).then(data => {
        if (!Number.isSafeInteger(data?.total) || data.total < 0 || !Array.isArray(data.items)) {
          throw Error('歌单数据不完整，请重试');
        }
        return data;
      }).catch(error => {
        if (pages.get(offset) === request) pages.delete(offset);
        throw error;
      });
      pages.set(offset, request);
    }
    return pages.get(offset);
  }
  async function all(signal, progress = () => {}) {
    if (catalogue) return catalogue;
    const first = await page(0, signal);
    signal.throwIfAborted();
    const rows = [...first.items];
    for (let offset = musicPageSize; offset < first.total; offset += 2 * musicPageSize) {
      progress(rows.length, first.total);
      const batch = [page(offset, signal)];
      if (offset + musicPageSize < first.total) batch.push(page(offset + musicPageSize, signal));
      const parts = await Promise.all(batch);
      signal.throwIfAborted();
      if (parts.some(part => part.total !== first.total)) {
        pages.clear();
        throw Error('歌单刚刚发生变化，请重新加载。');
      }
      for (const part of parts) rows.push(...part.items);
    }
    catalogue = rows;
    return rows;
  }
  return { page, all };
}

export function mountCollection(options) {
  const { viewport, results, more, signal, report, indexing } = options;
  const form = document.getElementById('collection-search');
  const field = document.getElementById('collection-query');
  const clear = document.getElementById('collection-clear');
  const menu = document.getElementById('collection-sort');
  const summary = menu.querySelector('summary');
  const choices = [...menu.querySelectorAll('input')];
  const saved = history.state?.collection || {};
  const source = collectionPages(options.load);
  let localSongs = options.local;
  const noun = localSongs ? '清单' : '歌单';
  field.setAttribute('aria-label', '在' + noun + '中搜索歌名、歌手');
  form.setAttribute('aria-label', noun + '内搜索');
  document.getElementById('original-order-label').textContent = localSongs ? '默认顺序' : '歌单原序';
  let query = saved.query || '', order = choices.some(choice => choice.value === saved.order) ? saved.order : 'original';
  const positions = { ...saved.positions };
  let view, prepare, timer;
  field.value = query;
  clear.hidden = !query;
  menu.open = false;
  function updateMenu() {
    for (const choice of choices) choice.checked = choice.value === order;
    const label = choices.find(choice => choice.checked).parentElement.textContent.trim();
    document.getElementById('sort-label').textContent = label;
    menu.querySelector('summary').setAttribute('aria-label', '排序方式，当前为' + label);
  }
  function isDefault() { return !query && order === 'original'; }
  function replaceView() {
    view?.abort();
    view = new AbortController();
    results.replaceChildren(); results.style.height = '';
    results.removeAttribute('aria-busy'); viewport.scrollTop = 0; more.hidden = true;
    report('');
    return view.signal;
  }
  async function show(position, animate = true) {
    prepare?.abort();
    prepare = null;
    indexing();
    if (isDefault()) {
      mountMusicList({ ...options, local: localSongs, position, animate, signal: replaceView(), load: offset => source.page(offset),
        row: (song, index) => options.row(song, index, { index, order: 'original', songs: localSongs }) });
      if (localSongs?.length === 0) report(options.emptyNote);
      return;
    }
    prepare = new AbortController();
    const current = prepare.signal;
    const selectedQuery = query, selectedOrder = order;
    if (!localSongs) indexing('正在准备完整歌单…');
    try {
      const songs = localSongs || await source.all(current, (done, total) => {
        if (!current.aborted) indexing('正在读取歌单　' + done.toLocaleString() + ' / ' + total.toLocaleString());
      });
      if (current.aborted) return;
      const ordered = selectCollection(songs, '', selectedOrder);
      const local = selectedQuery ? selectCollection(ordered, selectedQuery, 'original') : ordered;
      const slots = selectedQuery ? new Map(ordered.map((song, index) => [song, index])) : null;
      const meta = document.getElementById('meta');
      indexing();
      mountMusicList({ ...options, local, position, animate, signal: replaceView(),
        row: (song, index) => options.row(song, index, { index: slots?.get(song) ?? index, order: selectedOrder, songs: ordered }),
        meta: n => {
          meta.textContent = selectedQuery ? '找到 ' + n.toLocaleString() + ' 首，共 ' + songs.length.toLocaleString() + ' 首'
            : songs.length.toLocaleString() + ' 首歌曲';
        },
      });
      if (!local.length) report(selectedQuery ? noun + '中没有匹配的歌曲，可以换个歌名或歌手。' : options.emptyNote || '暂无内容');
    } catch (error) {
      if (current.aborted) return;
      indexing('暂时无法应用搜索或排序。' + error.message, () => void show(position));
    } finally {
      if (prepare?.signal === current) prepare = null;
    }
  }
  function apply() {
    clearTimeout(timer);
    const nextOrder = choices.find(choice => choice.checked).value;
    const nextQuery = field.value.trim();
    if (query === nextQuery && order === nextOrder) return;
    if (!query) positions[order] = viewport.scrollTop;
    query = nextQuery; order = nextOrder;
    const position = query ? 0 : positions[order] || 0;
    writeHistory('replaceState', { ...history.state, musicScroll: position, collection: { query, order, positions } });
    updateMenu(); void show(position);
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(apply, 150); }
  field.addEventListener('input', event => { clear.hidden = !field.value; if (!event.isComposing) schedule(); }, { signal });
  clear.addEventListener('click', () => { field.value = ''; clear.hidden = true; apply(); field.focus(); }, { signal });
  field.addEventListener('compositionstart', () => clearTimeout(timer), { signal });
  field.addEventListener('compositionend', schedule, { signal });
  form.addEventListener('submit', event => { event.preventDefault(); apply(); }, { signal });
  function closeSort() {
    menu.open = false;
    summary.focus({ preventScroll: true });
  }
  menu.addEventListener('change', apply, { signal });
  menu.addEventListener('click', event => {
    if (event.detail && choices.includes(event.target)) closeSort();
  }, { signal });
  document.addEventListener('pointerdown', event => { if (!menu.contains(event.target)) menu.open = false; }, { signal });
  menu.addEventListener('keydown', event => {
    if (menu.open && (event.key === 'Escape' || (event.key === 'Enter' && choices.includes(event.target)))) {
      event.preventDefault();
      closeSort();
    }
  }, { signal });
  signal.addEventListener('abort', () => {
    clearTimeout(timer); prepare?.abort(); view?.abort(); menu.open = false;
  }, { once: true });
  updateMenu(); void show(options.position);
  if (localSongs) return songs => {
    localSongs = songs;
    void show(viewport.scrollTop, false);
  };
}
