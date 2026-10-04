/*
 * calibration.js — acoustic latency calibration using the laptop's microphone.
 *
 * ─── The problem ──────────────────────────────────────────────────────────
 * The scheduler already compensates the output latency each browser
 * *reports* (getOutputTimestamp / outputLatency). What it can't see is
 * latency the browser doesn't know about or misreports — common on Android,
 * with some laptop audio drivers, and always with Bluetooth. That residual is
 * why a phone can sound a few tens of ms early or late. Software alone cannot
 * measure it: only a microphone hears when sound actually leaves a speaker.
 *
 * ─── The measurement ──────────────────────────────────────────────────────
 * 1. The Master picks master-clock times T₁, T₂, … (≈ 0.9 s apart, devices
 *    interleaved over a few rounds) and tells every device "play a 50 ms chirp
 *    at your Tᵢ" — through the normal scheduler, including each device's
 *    current latency offset.
 * 2. The laptop records its microphone. For every chirp it finds the arrival
 *    time with a matched filter (normalized cross-correlation), preferring
 *    the first strong peak (direct sound, not a reflection).
 * 3. residualᵢ = arrival − Tᵢ (in the laptop's audio-clock domain).
 *    Every residual contains the same unknown constants — the laptop's mic
 *    input latency and its own output/processing delay — so we subtract the
 *    laptop's own chirp residual:
 *
 *        errorᵢ = median(residual of device i) − median(residual of laptop)
 *
 *    = how much later device i is heard than the laptop, at the laptop's
 *    position (it includes ≈ 2.9 ms per metre of extra distance, which is
 *    what a listener sitting at the laptop hears too).
 * 4. Calibrate: each device shifts its schedule by −errorᵢ. Repeat once to
 *    verify. "Sync test" runs the same measurement without adjusting.
 *
 * Needs: microphone permission on the Master page (http://localhost counts
 * as secure), echo cancellation off, devices loud enough to be heard.
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const median = (v) => {
    if (!v.length) return NaN;
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  const CHIRP = { durationS: 0.05, f0: 1200, f1: 6000, amplitude: 0.9 };
  /** Search window around each expected arrival (late sounds are far more likely than early). */
  const SEARCH_BEFORE_S = 0.2;
  const SEARCH_AFTER_S = 0.4;
  const SPACING_MS = 900;
  const MIN_NCC = 0.2;           // normalized correlation needed to call it "heard"
  const MIN_PEAK_TO_NOISE = 5;

  /** Hann-windowed linear chirp: a sharp, unambiguous correlation peak. */
  function makeChirp(rate) {
    const n = Math.round(CHIRP.durationS * rate);
    const out = new Float32Array(n);
    const k = (CHIRP.f1 - CHIRP.f0) / CHIRP.durationS;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      out[i] = CHIRP.amplitude * w * Math.sin(2 * Math.PI * (CHIRP.f0 * t + 0.5 * k * t * t));
    }
    return out;
  }

  const buffers = new WeakMap();
  function chirpBuffer(ctx) {
    let b = buffers.get(ctx);
    if (!b) {
      const data = makeChirp(ctx.sampleRate);
      b = ctx.createBuffer(1, data.length, ctx.sampleRate);
      b.getChannelData(0).set(data);
      buffers.set(ctx, b);
    }
    return b;
  }

  /**
   * Device side: schedule this device's chirps. They go straight to the
   * speaker (not through mute or the spatial renderer) but use the normal
   * scheduler, so the device's current latency offset is applied.
   * @returns {number} how many were scheduled
   */
  function scheduleChirps(player, times) {
    if (!player.speakerEnabled || !Array.isArray(times)) return 0;
    const buf = chirpBuffer(player.ctx);
    let n = 0;
    for (const t of times) if (player.scheduleOneShot(buf, t, player.ctx.destination)) n++;
    return n;
  }

  // ─── Analysis (pure; unit-tested in Node) ────────────────────────────────

  function decimate2(x) {
    const out = new Float32Array(x.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = 0.5 * (x[2 * i] + x[2 * i + 1]);
    return out;
  }

  /**
   * Find the template inside x[from, to) (indices where the template starts).
   * @returns {{index: number, ncc: number, peakToNoise: number} | null}
   */
  function detect(x, template, from, to) {
    from = Math.max(0, Math.floor(from));
    to = Math.min(x.length - template.length, Math.floor(to));
    if (to - from < 8) return null;

    // Coarse search at half rate (4× less work), then refine at full rate.
    const x2 = decimate2(x.subarray(from & ~1, Math.min(x.length, (to + template.length + 2) & ~1)));
    const t2 = decimate2(template);
    const base = from & ~1;
    const m = t2.length;
    let tEnergy = 0;
    for (let j = 0; j < m; j++) tEnergy += t2[j] * t2[j];
    const prefix = new Float64Array(x2.length + 1);
    for (let i = 0; i < x2.length; i++) prefix[i + 1] = prefix[i] + x2[i] * x2[i];

    const lags = Math.max(0, x2.length - m);
    const ncc = new Float32Array(lags);
    let best = 0;
    let bestAt = -1;
    for (let L = 0; L < lags; L++) {
      let c = 0;
      for (let j = 0; j < m; j++) c += x2[L + j] * t2[j];
      const e = prefix[L + m] - prefix[L];
      const v = c / Math.sqrt(e * tEnergy + 1e-12);
      ncc[L] = v;
      if (v > best) { best = v; bestAt = L; }
    }
    if (bestAt < 0) return null;

    // Direct sound arrives first; reflections can be stronger. Take the
    // earliest local peak reaching 70 % of the maximum.
    let pick = bestAt;
    for (let L = 1; L < bestAt; L++) {
      if (ncc[L] >= 0.7 * best && ncc[L] >= ncc[L - 1] && ncc[L] >= ncc[L + 1]) { pick = L; break; }
    }
    const absVals = [];
    for (let L = 0; L < lags; L += 7) absVals.push(Math.abs(ncc[L]));
    const noise = median(absVals) || 1e-6;

    // Refine at full rate around the coarse pick.
    const centre = base + 2 * pick;
    let refined = centre;
    let refinedC = -Infinity;
    for (let k = centre - 4; k <= centre + 4; k++) {
      if (k < 0 || k + template.length > x.length) continue;
      let c = 0;
      for (let j = 0; j < template.length; j++) c += x[k + j] * template[j];
      if (c > refinedC) { refinedC = c; refined = k; }
    }
    return { index: refined, ncc: ncc[pick], peakToNoise: ncc[pick] / noise };
  }

  /**
   * @param {Float32Array} samples     mono recording
   * @param {number} rate              its sample rate
   * @param {number} startCtxTime      AudioContext time of samples[0] (s)
   * @param {{deviceId: string, expectedCtx: number}[]} expectations
   * @returns per-expectation results with residualMs (arrival − expected)
   */
  function analyzeRecording(samples, rate, startCtxTime, expectations) {
    const template = makeChirp(rate);
    return expectations.map((e) => {
      const expectedIdx = (e.expectedCtx - startCtxTime) * rate;
      const d = detect(samples, template, expectedIdx - SEARCH_BEFORE_S * rate, expectedIdx + SEARCH_AFTER_S * rate);
      const heard = !!d && d.ncc >= MIN_NCC && d.peakToNoise >= MIN_PEAK_TO_NOISE;
      return {
        ...e,
        heard,
        ncc: d ? d.ncc : 0,
        peakToNoise: d ? d.peakToNoise : 0,
        residualMs: heard ? ((d.index - expectedIdx) / rate) * 1000 : null,
      };
    });
  }

  /**
   * Per-device error relative to the reference device (the laptop).
   * @returns {{ok: boolean, reason?: string, devices: object[]}}
   */
  function summarize(detections, referenceId = 'master') {
    const byDevice = new Map();
    for (const d of detections) {
      if (!byDevice.has(d.deviceId)) byDevice.set(d.deviceId, []);
      byDevice.get(d.deviceId).push(d);
    }
    const ref = byDevice.get(referenceId) || [];
    const refRes = ref.filter((d) => d.heard).map((d) => d.residualMs);
    if (refRes.length === 0) {
      return { ok: false, reason: "The laptop couldn't hear its own test chirp (speaker muted or volume too low?).", devices: [] };
    }
    const refMedian = median(refRes);
    const devices = [];
    for (const [deviceId, list] of byDevice) {
      const res = list.filter((d) => d.heard).map((d) => d.residualMs);
      const med = res.length ? median(res) : null;
      const spread = res.length ? Math.max(...res) - Math.min(...res) : null;
      devices.push({
        deviceId,
        heard: res.length,
        total: list.length,
        errorMs: med == null ? null : med - refMedian,   // + = heard later than the laptop
        spreadMs: spread,
        meanNcc: list.reduce((s, d) => s + d.ncc, 0) / list.length,
        // Trust a result only if most chirps were heard and they agree.
        reliable: res.length >= Math.ceil(list.length / 2) && res.length >= 2 && spread <= 4,
      });
    }
    return { ok: true, referenceResidualMs: refMedian, devices };
  }

  // ─── Microphone recorder (Master) ─────────────────────────────────────────

  class MicRecorder {
    constructor(player) {
      this.player = player;
      this.chunks = null;
      this.node = null;
    }

    get isOpen() {
      return !!this.node;
    }

    /** Ask for the microphone (raw: no echo cancellation / noise suppression / AGC). */
    async open() {
      if (this.node) return;
      const ctx = this.player.ensureContext();
      if (!window.isSecureContext || !ctx.audioWorklet || !navigator.mediaDevices) {
        throw new Error('Microphone calibration needs the Master page opened as http://localhost.');
      }
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 1 } },
      });
      if (!MicRecorder.loaded.has(ctx)) {
        await ctx.audioWorklet.addModule('/js/capture-worklet.js');
        MicRecorder.loaded.add(ctx);
      }
      this.source = ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(ctx, 'syncwave-capture', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      this.sink = ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(ctx.destination);
      this.node.port.onmessage = (e) => {
        if (this.chunks) this.chunks.push(e.data);
      };
    }

    start() {
      this.chunks = [];
    }

    /** @returns {{samples: Float32Array, rate: number, startCtxTime: number}} */
    stop() {
      const chunks = this.chunks || [];
      this.chunks = null;
      const rate = this.player.ctx.sampleRate;
      if (chunks.length === 0) return { samples: new Float32Array(0), rate, startCtxTime: 0 };
      const first = chunks[0].frame;
      const last = chunks[chunks.length - 1];
      const total = last.frame + last.pcm.length / 2 - first;
      const samples = new Float32Array(total);
      for (const { frame, pcm } of chunks) {
        const off = frame - first;
        for (let i = 0, j = 0; j < pcm.length; i++, j += 2) samples[off + i] = (pcm[j] + pcm[j + 1]) / 65536;
      }
      return { samples, rate, startCtxTime: first / rate };
    }

    close() {
      if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); }
      if (this.sink) this.sink.disconnect();
      if (this.source) this.source.disconnect();
      if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
      this.node = this.sink = this.source = this.stream = null;
    }
  }
  MicRecorder.loaded = new WeakSet();

  /**
   * Master side: run one measurement across `deviceIds` (must include 'master').
   * @param {{send: Function, clock, player, recorder: MicRecorder, deviceIds: string[], rounds: number, kind: string}} o
   * @returns {Promise<ReturnType<typeof summarize> & {detections: object[]}>}
   */
  async function runProbe({ send, clock, player, recorder, deviceIds, rounds = 3, kind = 'calibrate', leadMs = 1500 }) {
    const t0 = clock.masterNow() + leadMs;
    const schedule = {};
    const plan = [];
    let k = 0;
    for (let r = 0; r < rounds; r++) {
      for (const id of deviceIds) {
        const T = t0 + k * SPACING_MS;
        k++;
        (schedule[id] = schedule[id] || []).push(T);
        plan.push({ deviceId: id, round: r, T });
      }
    }
    // Where the laptop's audio clock will be when each chirp *should* be heard.
    const map = player.clockMapping();
    const expectations = plan.map((p) => ({ ...p, expectedCtx: player.masterToContextTime(p.T, map) }));

    recorder.start();
    send({ type: 'probe', kind, schedule });
    const endAt = t0 + k * SPACING_MS + 800;
    await new Promise((r) => setTimeout(r, Math.max(0, endAt - clock.masterNow())));
    const rec = recorder.stop();
    const detections = analyzeRecording(rec.samples, rec.rate, rec.startCtxTime, expectations);
    return { ...summarize(detections, 'master'), detections };
  }

  root.SyncWave = Object.assign(root.SyncWave || {}, {
    Calibration: {
      CHIRP, SPACING_MS, makeChirp, chirpBuffer, scheduleChirps, detect, analyzeRecording, summarize, runProbe, MicRecorder,
    },
  });
})();
