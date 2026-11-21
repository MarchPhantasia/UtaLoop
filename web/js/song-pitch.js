// Bundled Signalsmith Stretch 1.3.2 from the official npm release (MIT).
const FADE_SECONDS = 0.025;
const PROCESSOR_TIMEOUT_MS = 5000;

async function loadProcessor(context) {
  let timer;
  async function initialise() {
    const { default: createStretch } = await import('./vendor/signalsmith/SignalsmithStretch.mjs');
    createStretch.moduleUrl = new URL('./vendor/signalsmith/SignalsmithStretch.mjs', import.meta.url).href;
    const processor = await createStretch(context);
    await processor.configure({ blockMs: 64, intervalMs: 16, splitComputation: true });
    return { processor, latency: await processor.latency() };
  }
  try {
    return await Promise.race([initialise(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Pitch processor did not initialise')), PROCESSOR_TIMEOUT_MS);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

function fade(gain, level, now, start) {
  const current = gain.value;
  gain.cancelScheduledValues(now);
  gain.setValueAtTime(current, now);
  gain.setValueAtTime(current, start);
  gain.linearRampToValueAtTime(level, start + FADE_SECONDS);
}

/** Reroute the original media element only after the live pitch processor is ready. */
export function createSongPitch(media) {
  const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!globalThis.isSecureContext || !Context || !globalThis.AudioWorkletNode) return null;

  const events = new EventTarget();
  const changed = () => events.dispatchEvent(new Event('change'));
  let context, graph, source, preparing;
  let wanted = 0, applied = 0, wetConnected = false, failed = false;
  let mixAt = 0, releaseTimer = 0;

  function disconnectProcessor() {
    if (!wetConnected) return;
    source.disconnect(graph.processor);
    graph.processor.disconnect(graph.wet);
    wetConnected = false;
  }

  function original(immediate = false) {
    if (!wetConnected) return;
    const now = context.currentTime;
    clearTimeout(releaseTimer);
    if (immediate) {
      graph.dry.gain.cancelScheduledValues(now);
      graph.wet.gain.cancelScheduledValues(now);
      graph.dry.gain.setValueAtTime(1, now);
      graph.wet.gain.setValueAtTime(0, now);
      disconnectProcessor();
    } else {
      fade(graph.dry.gain, 1, now, now);
      fade(graph.wet.gain, 0, now, now);
      releaseTimer = setTimeout(disconnectProcessor, FADE_SECONDS * 1000 + 10);
    }
    applied = 0;
  }

  function onFailure() {
    if (failed) return;
    failed = true;
    original(true);
    if (!source && context && context.state !== 'closed') void context.close().catch(() => {});
    changed();
  }

  function apply() {
    if (failed || !wanted || applied === wanted || context.state !== 'running') return;
    if (!source) {
      source = context.createMediaElementSource(media);
      source.connect(graph.dry);
    }
    clearTimeout(releaseTimer);
    if (!wetConnected) {
      graph.processor.connect(graph.wet);
      source.connect(graph.processor);
      wetConnected = true;
    }
    void graph.processor.schedule({ active: true, semitones: wanted }).catch(onFailure);
    if (!applied) {
      const now = context.currentTime;
      const start = now + graph.latency;
      fade(graph.dry.gain, 0, now, start);
      fade(graph.wet.gain, 1, now, start);
      mixAt = start + FADE_SECONDS / 2;
    }
    applied = wanted;
    changed();
  }

  async function prepare() {
    const { processor, latency } = await loadProcessor(context);
    const dry = context.createGain(), wet = context.createGain();
    wet.gain.value = 0;
    dry.connect(context.destination);
    wet.connect(context.destination);
    processor.addEventListener('processorerror', onFailure);
    graph = { processor, latency, dry, wet };
  }

  function activate() {
    if ((!wanted || failed) && !source) return;
    try {
      context ||= new Context({ latencyHint: 'interactive' });
      // Call resume inside the play or pitch action, while user activation is still in scope.
      const running = context.state === 'running' ? Promise.resolve() : context.resume();
      if (preparing) {
        void running.catch(onFailure);
        return;
      }
      if (graph && context.state === 'running') { apply(); return; }
      preparing = running.then(() => graph || prepare()).then(apply).catch(onFailure).finally(() => {
        preparing = null;
        changed();
      });
      changed();
    } catch {
      onFailure();
    }
  }

  return {
    events,
    get status() { return failed ? 'unavailable' : preparing ? 'loading' : ''; },
    activate,
    setSemitones(semitones, fromGesture = false) {
      if (semitones !== wanted) {
        wanted = semitones;
        if (!wanted) original();
        changed();
      }
      if (wanted && (fromGesture || !media.paused)) activate();
    },
    get activeSemitones() { return applied; },
    get delay() { return applied && context.currentTime >= mixAt ? graph.latency : 0; },
  };
}
