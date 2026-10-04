/*
 * live.js — live mode: stream whatever is playing on the laptop to every device.
 *
 *   LiveCapture   (Master only) captures a browser tab, an audio input device
 *                 (e.g. a VB-CABLE virtual cable carrying the Apple Music app),
 *                 the whole system's audio, or a built-in test click track.
 *   LiveReceiver  (every device, the Master included) schedules incoming chunks
 *                 on its own AudioContext at the time stamped on each chunk.
 *
 * ─── Why every device plays with the same delay ───────────────────────────
 * The phones can only hear a chunk after it has crossed the Wi-Fi. So each
 * chunk is stamped with a master-clock time `playAt` = capture time + D, where
 * D (the "latency buffer", default 500 ms) is long enough for the chunk to
 * reach every phone. Every device — including the laptop itself — plays the
 * chunk at exactly `playAt`. That is why the original source must NOT also
 * play directly on the laptop speakers (it would be D ms ahead of everyone):
 * tab capture mutes the tab locally, and a virtual cable never reaches the
 * speakers in the first place.
 *
 * ─── Chunk format (binary WebSocket message) ──────────────────────────────
 *   byte 0      uint8    format version (1)
 *   byte 1      uint8    channels
 *   bytes 4–7   uint32   frames
 *   bytes 8–15  float64  playAt (master-clock ms)
 *   bytes 16–19 float32  sample rate
 *   bytes 20–23 uint32   sequence number
 *   bytes 24…   int16    interleaved PCM (little-endian, like every phone/laptop CPU)
 * Raw 16-bit stereo at 48 kHz is ~1.5 Mbit/s per phone: fine on a home LAN,
 * and it avoids codec support differences between browsers.
 */
(function () {
  'use strict';

  const HEADER_BYTES = 24;

  function encodeChunk({ playAt, sampleRate, channels, seq }, pcm) {
    const frames = pcm.length / channels;
    const buf = new ArrayBuffer(HEADER_BYTES + pcm.byteLength);
    const v = new DataView(buf);
    v.setUint8(0, 1);
    v.setUint8(1, channels);
    v.setUint32(4, frames, true);
    v.setFloat64(8, playAt, true);
    v.setFloat32(16, sampleRate, true);
    v.setUint32(20, seq >>> 0, true);
    new Int16Array(buf, HEADER_BYTES).set(pcm);
    return buf;
  }

  function decodeChunk(buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < HEADER_BYTES) return null;
    const v = new DataView(buf);
    if (v.getUint8(0) !== 1) return null;
    const channels = v.getUint8(1);
    const frames = v.getUint32(4, true);
    if (channels < 1 || channels > 2 || buf.byteLength !== HEADER_BYTES + frames * channels * 2) return null;
    return {
      channels,
      frames,
      playAt: v.getFloat64(8, true),
      sampleRate: v.getFloat32(16, true),
      seq: v.getUint32(20, true),
      pcm: new Int16Array(buf, HEADER_BYTES, frames * channels),
    };
  }

  // ─── Receiver ─────────────────────────────────────────────────────────────

  /** If a chunk's ideal start is further than this from the end of the previous one, jump. */
  const HARD_RESYNC_S = 0.025;
  /** Ignore errors smaller than this (avoids constant tiny pitch changes). */
  const DEADBAND_S = 0.001;
  /** Max playback-rate nudge: 0.2 % ≈ 3 cents, inaudible; corrects up to 2 ms per second. */
  const MAX_RATE_ADJUST = 0.002;

  class LiveReceiver {
    /** @param {SyncWave.SyncedPlayer} player  provides the AudioContext, gain, clock mapping and trim */
    constructor(player) {
      this.player = player;
      this.sources = new Set();
      this.reset();
    }

    reset() {
      for (const s of this.sources) {
        s.onended = null;
        try { s.stop(); } catch { /* not started */ }
        s.disconnect();
      }
      this.sources.clear();
      this.next = null;      // context time where the previous chunk ends
      this.errAvg = 0;       // smoothed (ideal − actual) start error, seconds
      this.rate = 1;
      this.received = 0;
      this.late = 0;
      this.resyncs = 0;
      this.lastChunkAt = 0;
    }

    get receiving() {
      return performance.now() - this.lastChunkAt < 1500;
    }

    /**
     * ★ Live scheduling.
     *
     * Each chunk has an ideal start time (its playAt converted to this
     * device's AudioContext time, exactly like file playback). Scheduling every
     * chunk at its own ideal time would leave tiny gaps/overlaps (clicks),
     * because each conversion has ~1 ms of measurement jitter. So chunks are
     * laid end-to-end, and the error between "where it lands" and "where it
     * should land" is smoothed and corrected by nudging the playback rate by at
     * most 0.2 %. This continuously absorbs clock drift between the laptop and
     * the phone. A big error (network stall, CPU glitch, suspended audio)
     * triggers a hard jump instead.
     */
    push(chunk) {
      this.received++;
      this.lastChunkAt = performance.now();
      const p = this.player;
      if (!p.speakerEnabled) {
        if (this.next !== null || this.sources.size) this.reset();
        return;
      }
      const ctx = p.ctx;

      const buffer = ctx.createBuffer(chunk.channels, chunk.frames, chunk.sampleRate);
      for (let c = 0; c < chunk.channels; c++) {
        const out = buffer.getChannelData(c);
        for (let i = 0, j = c; i < chunk.frames; i++, j += chunk.channels) out[i] = chunk.pcm[j] / 32768;
      }

      const ideal = p.masterToContextTime(chunk.playAt + p.trimMs, p.clockMapping());
      const now = ctx.currentTime;
      let when;
      let offset = 0;

      if (this.next !== null && Math.abs(ideal - this.next) <= HARD_RESYNC_S && this.next > now + 0.003) {
        // Seamless: start exactly where the previous chunk ends, steer gently.
        when = this.next;
        this.errAvg = this.errAvg * 0.9 + (ideal - this.next) * 0.1;
        const e = Math.abs(this.errAvg) > DEADBAND_S ? this.errAvg : 0;
        // Ahead of schedule (ideal later than planned) → play slightly slower, and vice versa.
        this.rate = 1 - Math.max(-MAX_RATE_ADJUST, Math.min(MAX_RATE_ADJUST, e * 0.5));
      } else {
        if (ideal + buffer.duration <= now + 0.005) {
          // Arrived after its time had already passed: the network was too slow.
          this.late++;
          this.next = null;
          return;
        }
        if (this.next !== null) this.resyncs++;
        this.errAvg = 0;
        this.rate = 1;
        when = ideal;
        if (when < now + 0.005) {
          offset = now + 0.005 - when; // join part-way through this chunk
          when = now + 0.005;
        }
      }

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.playbackRate.value = this.rate;
      src.connect(p.input);
      src.onended = () => {
        this.sources.delete(src);
        src.disconnect();
      };
      src.start(when, offset);
      this.sources.add(src);
      this.next = when + (buffer.duration - offset) / this.rate;
    }

    /** For diagnostics: how much audio is queued, and the smoothed timing error. */
    status() {
      const ctx = this.player.ctx;
      const buffered = this.next !== null && ctx ? Math.max(0, this.next - ctx.currentTime) * 1000 : null;
      return {
        receiving: this.receiving,
        bufferMs: buffered,
        // errAvg > 0 means chunks start before their ideal time, i.e. this device is ahead.
        driftMs: this.next !== null ? this.errAvg * 1000 : null,
        late: this.late,
        resyncs: this.resyncs,
        rate: this.rate,
      };
    }
  }

  // ─── Capture (Master) ─────────────────────────────────────────────────────

  /** Master-clock timestamps further than this from the running timeline start a new one. */
  const REANCHOR_MS = 100;

  class LiveCapture {
    /**
     * @param {SyncWave.SyncedPlayer} player   the Master's player (AudioContext + clock)
     * @param {{onChunk: Function, onLevel: Function, onEnded: Function}} handlers
     */
    constructor(player, { onChunk, onLevel, onEnded }) {
      this.player = player;
      this.onChunk = onChunk;
      this.onLevel = onLevel || (() => {});
      this.onEnded = onEnded || (() => {});
      this.delayMs = 500;
      this.active = false;
      this.workletLoaded = false;
    }

    /**
     * @param {'tab'|'device'|'screen'|'test'} kind
     * @param {{deviceId?: string}} opts
     */
    async start(kind, opts = {}) {
      this.stop();
      const ctx = this.player.ensureContext();
      if (!window.isSecureContext || !ctx.audioWorklet) {
        throw new Error(`Live capture only works on a secure page. Open the Master at http://localhost:${location.port || 80}`);
      }
      if (!this.workletLoaded) {
        await ctx.audioWorklet.addModule('/js/capture-worklet.js');
        this.workletLoaded = true;
      }

      let sourceNode;
      if (kind === 'test') {
        sourceNode = this.testClicks(ctx);
      } else {
        this.stream = await this.openStream(kind, opts);
        const track = this.stream.getAudioTracks()[0];
        track.addEventListener('ended', () => {
          if (this.active) {
            this.stop();
            this.onEnded('Capture ended (sharing was stopped).');
          }
        });
        sourceNode = ctx.createMediaStreamSource(new MediaStream([track]));
      }

      const node = new AudioWorkletNode(ctx, 'syncwave-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        channelCount: 2,
        channelCountMode: 'explicit',
        channelInterpretation: 'speakers',
      });
      // The worklet must be pulled by the destination to run, but its output is silent:
      // the captured audio is only heard through the scheduled (delayed) path.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      sourceNode.connect(node);
      node.connect(sink);
      sink.connect(ctx.destination);
      node.port.onmessage = (e) => this.handleChunk(e.data);

      this.sourceNode = sourceNode;
      this.node = node;
      this.sink = sink;
      this.anchor = null;
      this.seq = 0;
      this.active = true;
      return { sampleRate: ctx.sampleRate, channels: 2 };
    }

    async openStream(kind, { deviceId }) {
      const md = navigator.mediaDevices;
      if (!md) throw new Error('This browser cannot capture audio.');
      const clean = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };

      if (kind === 'device') {
        return md.getUserMedia({
          audio: { ...clean, channelCount: { ideal: 2 }, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
        });
      }

      if (!md.getDisplayMedia) throw new Error('This browser cannot capture tabs or system audio. Use Chrome or Edge.');
      const stream = await md.getDisplayMedia({
        // A video track is mandatory for getDisplayMedia; we stop it right away.
        video: true,
        audio: { ...clean, suppressLocalAudioPlayback: kind === 'tab' },
        systemAudio: kind === 'screen' ? 'include' : 'exclude',
        selfBrowserSurface: 'exclude',
        preferCurrentTab: false,
        monitorTypeSurfaces: kind === 'screen' ? 'include' : 'exclude',
      });
      stream.getVideoTracks().forEach((t) => t.stop());
      if (stream.getAudioTracks().length === 0) {
        throw new Error(kind === 'tab'
          ? 'No audio was shared. Pick a tab and make sure "Share tab audio" is switched on.'
          : 'No audio was shared. Choose "Entire screen" and tick "Share system audio".');
      }
      return stream;
    }

    /** Looping click track generated in the browser: tests the live path without any capture setup. */
    testClicks(ctx) {
      const rate = ctx.sampleRate;
      const buf = ctx.createBuffer(2, rate * 4, rate);
      for (let beat = 0; beat < 4; beat++) {
        const freq = beat === 0 ? 1760 : 880;
        const len = Math.floor(rate * 0.03);
        for (let c = 0; c < 2; c++) {
          const d = buf.getChannelData(c);
          for (let i = 0; i < len; i++) d[beat * rate + i] = Math.sin((2 * Math.PI * freq * i) / rate) * 0.8 * (1 - i / len);
        }
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.start();
      return src;
    }

    /** Context frame index → master-clock ms, via the same mapping the players use. */
    frameToMasterTime(frame) {
      const p = this.player;
      const map = p.clockMapping();
      const perfMs = map.performanceTime + (frame / p.ctx.sampleRate - map.contextTime) * 1000;
      return p.clock.toMaster(performance.timeOrigin + perfMs);
    }

    /**
     * Stamp a captured chunk. Timestamps come from the frame counter (perfectly
     * regular), anchored once to the master clock, so consecutive chunks are
     * exactly contiguous. Only a large discontinuity (capture paused, audio
     * glitch) starts a new anchor.
     */
    handleChunk({ frame, pcm, peak }) {
      if (!this.active) return;
      const rate = this.player.ctx.sampleRate;
      const actual = this.frameToMasterTime(frame);
      let nominal = this.anchor ? this.anchor.time + ((frame - this.anchor.frame) / rate) * 1000 : NaN;
      if (!(Math.abs(nominal - actual) <= REANCHOR_MS)) {
        this.anchor = { frame, time: actual };
        nominal = actual;
      }
      const chunk = { channels: 2, frames: pcm.length / 2, sampleRate: rate, seq: this.seq++, playAt: nominal + this.delayMs, pcm };
      this.onLevel(peak);
      this.onChunk(chunk, encodeChunk(chunk, pcm));
    }

    stop() {
      this.active = false;
      if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); }
      if (this.sink) this.sink.disconnect();
      if (this.sourceNode) {
        try { if (this.sourceNode.stop) this.sourceNode.stop(); } catch { /* ignore */ }
        this.sourceNode.disconnect();
      }
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.node = this.sink = this.sourceNode = this.stream = null;
    }
  }

  Object.assign(window.SyncWave, { LiveReceiver, LiveCapture, encodeChunk, decodeChunk });
})();
