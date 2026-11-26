import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { desktopAudioOutput } from '../web/js/desktop-audio.js';

const worklet = readFileSync(new URL('../web/js/desktop-audio-worklet.js', import.meta.url), 'utf8');

function fixture() {
  const messages = [];
  let processor;
  runInNewContext(worklet, {
    AudioWorkletProcessor: class {
      port = { postMessage: (data) => messages.push(data) };
    },
    registerProcessor: (_, Processor) => { processor = new Processor(); },
  });
  const outputs = [new Float32Array(128), new Float32Array(128)];
  const render = (...values) => {
    const inputs = values.map((value) => new Float32Array(128).fill(value));
    assert.equal(processor.process([inputs], [outputs]), true);
  };
  const packet = (...values) => { for (let i = 0; i < 4; i++) render(...values); };
  return { messages, outputs, render, packet, send: (data) => processor.port.onmessage({ data }) };
}

test('desktop PCM preserves stereo, clips out-of-range samples, and avoids duplicate playback', () => {
  const { packet, messages, outputs } = fixture();
  packet();
  assert.equal(messages.length, 0);
  packet(-1.5, 0.5);
  assert.equal(messages[0].byteLength, 2048);
  assert.deepEqual([...new Int16Array(messages[0]).slice(0, 4)], [-32768, 16384, -32768, 16384]);
  assert(outputs.every((channel) => channel.every((value) => value === 0)));
});

test('desktop PCM bounds outstanding packets and drops queued partial audio on seek', () => {
  const { packet, render, send, messages } = fixture();
  for (let i = 0; i < 16; i++) packet(1);
  assert.equal(messages.length, 8);
  send('ack');
  render(1);
  send('flush');
  packet(-1);
  assert.equal(messages.length, 10);
  assert.equal(messages[8], 'flush');
  assert(new Int16Array(messages[9]).every((value) => value === -32768));
});

test('desktop audio stays inactive in a regular browser', () => {
  assert.equal(desktopAudioOutput(), null);
});
