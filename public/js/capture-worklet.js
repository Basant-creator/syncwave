/*
 * capture-worklet.js — runs on the Master's audio thread.
 *
 * Collects the captured audio (128-frame render quanta) into fixed-size
 * chunks of 16-bit stereo PCM and hands each chunk to the main thread together
 * with `frame`: the AudioContext frame index of the chunk's first sample.
 * That frame index is what gives every chunk an exact place on the timeline.
 */
const CHUNK_FRAMES = 2048; // ≈ 43 ms at 48 kHz; must be a multiple of 128

class SyncWaveCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.pcm = null;
    this.filled = 0;
    this.startFrame = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) {
      // Source not producing audio: drop the partial chunk so frame numbering stays exact.
      this.pcm = null;
      return true;
    }
    const left = input[0];
    const right = input[1] || input[0];
    const n = left.length;

    if (!this.pcm) {
      this.pcm = new Int16Array(CHUNK_FRAMES * 2);
      this.filled = 0;
      this.startFrame = currentFrame;
      this.peak = 0;
    }
    for (let i = 0; i < n; i++) {
      const l = Math.max(-1, Math.min(1, left[i]));
      const r = Math.max(-1, Math.min(1, right[i]));
      const o = (this.filled + i) * 2;
      this.pcm[o] = l * 32767;
      this.pcm[o + 1] = r * 32767;
      const a = Math.max(Math.abs(l), Math.abs(r));
      if (a > this.peak) this.peak = a;
    }
    this.filled += n;

    if (this.filled >= CHUNK_FRAMES) {
      this.port.postMessage({ frame: this.startFrame, pcm: this.pcm, peak: this.peak }, [this.pcm.buffer]);
      this.pcm = null;
    }
    return true;
  }
}

registerProcessor('syncwave-capture', SyncWaveCapture);
