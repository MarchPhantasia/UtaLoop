// 512 frames of stereo PCM16 per message, matching WaveOutput in windows/DesktopAudio.cs.
const PACKET_SAMPLES = 512 * 2;
const MAX_PENDING = 8;

function pcm16(value) {
  return Math.round(Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767));
}

class DesktopAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.packet = new Int16Array(PACKET_SAMPLES);
    this.offset = 0;
    this.hasSignal = false;
    this.trailingPackets = 0;
    this.pending = 0;
    this.port.onmessage = ({ data }) => {
      if (data === 'ack') this.pending--;
      if (data === 'flush') {
        this.offset = 0;
        this.hasSignal = false;
        this.trailingPackets = 0;
        this.port.postMessage('flush');
      }
    };
  }

  process([input], [output]) {
    const [left, right = left] = input;
    for (let i = 0; i < output[0].length; i++) {
      const l = pcm16(left?.[i] ?? 0), r = pcm16(right?.[i] ?? 0);
      this.packet[this.offset++] = l;
      this.packet[this.offset++] = r;
      this.hasSignal ||= l !== 0 || r !== 0;
      if (this.offset < PACKET_SAMPLES) continue;
      if (this.hasSignal) this.trailingPackets = MAX_PENDING;
      if (this.trailingPackets > 0) {
        this.trailingPackets--;
        if (this.pending < MAX_PENDING) {
          const buffer = this.packet.buffer;
          this.port.postMessage(buffer, [buffer]);
          this.packet = new Int16Array(PACKET_SAMPLES);
          this.pending++;
        }
      }
      this.offset = 0;
      this.hasSignal = false;
    }
    // Web Audio drives the clock, while the Windows host plays the samples once.
    return true;
  }
}

registerProcessor('utaloop-desktop-audio', DesktopAudioProcessor);
