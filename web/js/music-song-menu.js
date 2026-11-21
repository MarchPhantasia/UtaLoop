import { checkpointTime } from './music-study.js';
import { fmtTime } from './util.js';

export function createSongMenu(popup, { viewport, results, getStudy, onOpen, onMark, onError }) {
  const document = popup.ownerDocument;
  const window = document.defaultView;
  const menu = popup.querySelector('[role="menu"]');
  const options = [...menu.querySelectorAll('button')];
  const marks = menu.querySelectorAll('[role="menuitemradio"]');
  const resume = menu.querySelector('[value="resume"]');
  const reset = menu.querySelector('[value=""]');
  const feedback = popup.querySelector('[role="status"]');
  const saving = new Set();
  let active;

  function place({ anchor, point }) {
    const bounds = anchor.getBoundingClientRect();
    const visual = window.visualViewport;
    const edge = 10, gap = 5;
    const left = (visual?.offsetLeft ?? 0) + edge;
    const top = (visual?.offsetTop ?? 0) + edge;
    const width = (visual?.width ?? document.documentElement.clientWidth) - 2 * edge;
    const height = (visual?.height ?? window.innerHeight) - 2 * edge;
    const bottom = top + height;
    popup.style.maxWidth = Math.max(0, width) + 'px';
    popup.style.maxHeight = '';
    const needed = popup.offsetHeight;
    const upperEdge = point?.y ?? bounds.top;
    const lowerEdge = point?.y ?? bounds.bottom;
    const below = bottom - lowerEdge - gap;
    const above = upperEdge - top - gap;
    const opensDown = below >= needed || below >= above;
    const available = opensDown ? below : above;
    popup.style.maxHeight = Math.max(0, available >= 48 ? available : height) + 'px';
    const right = left + width;
    const popupWidth = popup.offsetWidth;
    const x = point ? (point.x + popupWidth <= right ? point.x : point.x - popupWidth) : bounds.right - popupWidth;
    const y = opensDown ? lowerEdge + gap : upperEdge - gap - popup.offsetHeight;
    popup.style.left = Math.max(left, Math.min(x, right - popupWidth)) + 'px';
    popup.style.top = Math.max(top, Math.min(y, bottom - popup.offsetHeight)) + 'px';
    popup.dataset.side = opensDown ? 'below' : 'above';
  }

  function close(restoreFocus = false) {
    const previous = active;
    if (!previous) return;
    active = undefined;
    previous.listeners.abort();
    previous.anchor.setAttribute('aria-expanded', 'false');
    popup.hidden = true;
    if (restoreFocus) {
      const target = previous.focusFrom.isConnected ? previous.focusFrom : viewport;
      target.focus({ preventScroll: true });
    }
  }

  function updateBusy() {
    const busy = saving.has(active?.anchor.dataset.key);
    if (busy) menu.setAttribute('aria-busy', 'true');
    else menu.removeAttribute('aria-busy');
    for (const option of options) option.setAttribute('aria-disabled', String(busy));
  }

  function visibleOptions() { return options.filter(option => !option.hidden); }

  function focusOption(option) {
    option.focus({ preventScroll: true });
    const start = option.offsetTop;
    const end = start + option.offsetHeight;
    if (start < popup.scrollTop) popup.scrollTop = start;
    else if (end > popup.scrollTop + popup.clientHeight) popup.scrollTop = end - popup.clientHeight;
  }

  function open(anchor, song, { edge, point, focusFrom = anchor, selection } = {}) {
    if (active?.anchor === anchor && !edge && !point) { close(true); return; }
    close();
    const listeners = new window.AbortController();
    const { signal } = listeners;
    const opened = { anchor, song, point, focusFrom, listeners, selection };
    active = opened;
    const study = getStudy(song);
    for (const option of marks) option.setAttribute('aria-checked', String(option.value === study?.state));
    reset.hidden = !study?.state;
    const time = checkpointTime(study);
    resume.hidden = time === null;
    if (time !== null) resume.querySelector('span').textContent = '从 ' + fmtTime(time) + ' 继续';
    feedback.textContent = '';
    menu.setAttribute('aria-label', '「' + song.name + '」的更多操作');
    updateBusy();
    anchor.setAttribute('aria-expanded', 'true');
    popup.hidden = false;
    popup.scrollTop = 0;
    place(opened);
    const choices = visibleOptions();
    focusOption(edge === 'last' ? choices.at(-1) : choices[0]);

    document.addEventListener('pointerdown', event => {
      if (!popup.contains(event.target) && !anchor.contains(event.target)) close();
    }, { signal, capture: true });
    document.addEventListener('scroll', event => {
      if (!popup.contains(event.target)) close();
    }, { signal, capture: true, passive: true });
    document.addEventListener('focusin', event => {
      if (!popup.contains(event.target) && !anchor.contains(event.target)) close();
    }, { signal });
    const reposition = () => place(opened);
    window.addEventListener('resize', reposition, { signal });
    window.visualViewport?.addEventListener('resize', reposition, { signal });
    window.visualViewport?.addEventListener('scroll', reposition, { signal });

    // A virtual row can be replaced by a filter or leave the rendered window.
    const observer = new window.MutationObserver(() => {
      if (!anchor.isConnected) close(popup.contains(document.activeElement));
    });
    observer.observe(results, { childList: true });
    signal.addEventListener('abort', () => observer.disconnect(), { once: true });
  }

  popup.addEventListener('keydown', event => {
    if (event.key === 'Tab') { close(true); return; }
    if (event.key === 'Escape') { event.preventDefault(); close(true); return; }
    const choices = visibleOptions();
    const index = choices.indexOf(document.activeElement);
    let next;
    switch (event.key) {
      case 'ArrowDown': next = choices[(index + 1) % choices.length]; break;
      case 'ArrowUp': next = choices[(index + choices.length - 1) % choices.length]; break;
      case 'Home': next = choices[0]; break;
      case 'End': next = choices.at(-1); break;
      default: return;
    }
    event.preventDefault();
    focusOption(next);
  });

  menu.addEventListener('click', async event => {
    const option = event.target.closest('button');
    if (!option || !active || option.hidden) return;
    const { anchor, song, selection } = active;
    const key = anchor.dataset.key;
    if (saving.has(key)) return;
    if (option.value === 'open' || option === resume) {
      close(true);
      onOpen(song, option === resume, selection);
      return;
    }
    if ((getStudy(song)?.state || '') === option.value) { close(true); return; }
    saving.add(key);
    feedback.textContent = '';
    updateBusy();
    place(active);
    try {
      await onMark(song, option.value);
      if (active?.anchor.dataset.key === key) close(true);
    } catch {
      const message = '学习状态保存失败，请重试。';
      if (active?.anchor.dataset.key === key) {
        feedback.textContent = message;
        place(active);
      } else if (anchor.isConnected) onError(message);
    } finally {
      saving.delete(key);
      if (active) updateBusy();
    }
  });

  return { open, close };
}
