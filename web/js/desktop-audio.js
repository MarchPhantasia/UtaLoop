let initializing, output;

export function desktopAudioOutput(onFallback) {
  if (globalThis.UtaLoopDesktopAudio !== true || !globalThis.chrome?.webview) return null;
  return initializing ||= openOutput(globalThis.chrome.webview, onFallback);
}

export function activeDesktopAudioOutput() { return output; }

async function openOutput(host, onFallback) {
  let context;
  try {
    context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    await context.audioWorklet.addModule(new URL('./desktop-audio-worklet.js', import.meta.url));
    const node = new AudioWorkletNode(context, 'utaloop-desktop-audio', {
      channelCount: 2, channelCountMode: 'explicit', outputChannelCount: [2],
    });
    const destination = context.createGain();
    destination.connect(node);
    node.connect(context.destination);

    const prefix = `utaloop-audio:${crypto.randomUUID().replaceAll('-', '')}:`;
    let pending = 0, watchdog, failed = false;
    function fallback() {
      if (failed) return;
      failed = true;
      clearTimeout(watchdog);
      host.removeEventListener('message', receive);
      try { host.postMessage(prefix + 'flush'); } catch {}
      node.port.close();
      destination.disconnect(node);
      node.disconnect();
      destination.connect(context.destination);
      onFallback?.();
    }
    function receive({ data }) {
      if (data === prefix + 'fallback') fallback();
      if (data !== prefix + 'ack' || pending === 0 || failed) return;
      node.port.postMessage('ack');
      clearTimeout(watchdog);
      if (--pending > 0) watchdog = setTimeout(fallback, 1000);
    }
    host.addEventListener('message', receive);
    node.addEventListener('processorerror', fallback);
    node.port.onmessage = ({ data }) => {
      if (failed) return;
      try {
        if (data === 'flush') {
          host.postMessage(prefix + data);
          return;
        }
        const encoded = btoa(String.fromCharCode(...new Uint8Array(data)));
        if (pending++ === 0) watchdog = setTimeout(fallback, 1000);
        host.postMessage(prefix + encoded);
      } catch { fallback(); }
    };

    const flush = () => { if (!failed) node.port.postMessage('flush'); };
    window.addEventListener('pagehide', flush);
    return output = {
      context, destination, flush,
      resume() { if (context.state !== 'running') void context.resume().catch(fallback); },
    };
  } catch {
    if (context) void context.close().catch(() => {});
    onFallback?.();
    return null;
  }
}
