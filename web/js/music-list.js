export const musicPageSize = 60;
const size = musicPageSize;
const rowHeight = 68;

// Each page occupies its original positions, even when a song is unavailable.
export function mountMusicList({ viewport, results, more, local, load, row, report, meta, signal, position = 0, animate = true, remember }) {
  const pages = new Map(), loaded = new Set(), pending = new Set(), failed = new Set(), mounted = new Map();
  let total = local?.length ?? 0, next = 0, hasMore = false, frame = 0;
  let restore = position;
  let indexed = false, lastScroll = -Infinity;

  function windowRows(reveal = false) {
    const first = Math.max(0, Math.floor(viewport.scrollTop / rowHeight) - 4);
    const last = Math.min(total, Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight) + 4);
    for (const [index, node] of mounted) {
      if (index < first || index >= last) { node.remove(); mounted.delete(index); }
    }
    for (let index = first; index < last; index++) {
      if (mounted.has(index)) continue;
      const page = Math.floor(index / size);
      const item = local ? local[index] : pages.get(page)?.[index % size];
      const node = row(item, index);
      if (reveal && item && performance.now() - lastScroll > 150) node.classList.add('list-arrival');
      Object.assign(node.style, { position: 'absolute', top: index * rowHeight + 'px', left: '0', right: '0' });
      const following = [...results.children].find(el => Number(el.dataset.index) > index);
      node.dataset.index = index;
      results.insertBefore(node, following || null);
      mounted.set(index, node);
      if (!local && !loaded.has(page) && !failed.has(page)) void fetchPage(page);
    }
    if (hasMore && last >= total - 2 && !failed.has(next)) void fetchPage(next);
  }

  function layout(reveal) {
    results.style.height = total * rowHeight + 'px';
    if (restore) {
      viewport.scrollTop = restore;
      if (!hasMore || viewport.scrollTop >= restore - 1) restore = 0;
    }
    windowRows(animate && reveal && !position);
    meta(total, hasMore);
  }

  function retryPage() {
    const visible = Math.floor(viewport.scrollTop / (rowHeight * size));
    return failed.has(visible) ? visible : failed.values().next().value ?? next;
  }

  function updateMore() {
    more.hidden = !hasMore && !failed.size;
    more.disabled = pending.has(retryPage());
    more.textContent = failed.size ? '重试加载歌曲' : '加载更多';
  }

  async function fetchPage(page) {
    if (pending.has(page) || loaded.has(page) || signal.aborted) return;
    pending.add(page);
    if (failed.has(page)) report('正在读取…');
    updateMore();
    results.setAttribute('aria-busy', 'true');
    // Unknown totals (search or the first request) have no virtual slots yet.
    // Reserve just a few rows without inventing a song count or scroll offset.
    let preview;
    if (!indexed && page === next) {
      preview = document.createElement('div');
      preview.className = 'page-preview';
      preview.style.top = total * rowHeight + 'px';
      const count = total ? 2 : 4;
      for (let i = 0; i < count; i++) preview.append(row(null, total + i));
      results.append(preview);
      results.style.height = (total + count) * rowHeight + 'px';
    }
    try {
      const data = await load(page * size, size);
      if (signal.aborted) return;
      if (!Array.isArray(data?.items)) throw Error('暂时无法读取曲目，请重试');
      loaded.add(page);
      // Search and folder pages may contain fewer visible rows after filtering.
      if (Number.isInteger(data.total)) {
        indexed = true;
        total = data.total;
        hasMore = false;
        pages.set(page, data.items);
      } else {
        for (const item of data.items) {
          const bucket = Math.floor(total / size);
          if (!pages.has(bucket)) pages.set(bucket, []);
          pages.get(bucket).push(item);
          total++;
        }
        hasMore = !!data.more;
        next = page + 1;
      }
      failed.delete(page);
      for (const [index, node] of mounted) {
        if (Math.floor(index / size) === page) { mounted.delete(index); node.remove(); }
      }
      if (!failed.size) report(total || hasMore ? '' : '暂无内容');
      preview?.remove();
      layout(true);
    } catch (error) {
      if (!signal.aborted) {
        failed.add(page);
        report((total ? '部分曲目加载失败。' : '曲目加载失败。') + error.message);
        if (preview) results.style.height = total * rowHeight + 'px';
      }
    } finally {
      preview?.remove();
      pending.delete(page);
      if (!signal.aborted) {
        updateMore();
        if (!pending.size) results.removeAttribute('aria-busy');
      }
    }
  }

  viewport.addEventListener('scroll', () => {
    lastScroll = performance.now();
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0; windowRows(); updateMore();
      if (!restore) remember(viewport.scrollTop);
    });
  }, { passive: true, signal });
  const observer = new ResizeObserver(() => windowRows());
  observer.observe(viewport);
  signal.addEventListener('abort', () => { observer.disconnect(); cancelAnimationFrame(frame); }, { once: true });
  more.onclick = () => void fetchPage(retryPage());
  if (local) { layout(true); updateMore(); }
  else void fetchPage(0);
}
