/*
 * spatial.js — EXPERIMENTAL distributed stereo playback.
 *
 * This is not "real" spatial audio (no HRTF, no Atmos, no room model). Each
 * device is treated as ONE point speaker standing somewhere on a left↔right
 * line (x = −1 … +1), and plays a weighted mix of the track's left and right
 * channels that suits its position. Several devices spread across a room then
 * form a crude, large stereo image.
 *
 * Completely separate from synchronization:
 *
 *     Sync Engine ──► scheduled start ──► AudioBufferSource ─┐
 *                                                            ▼
 *                              SpatialRenderer (this file: gains only)
 *                                                            ▼
 *                                                   device speaker
 *
 * The renderer never changes *when* anything plays, only *how loud each
 * channel is* on this device. Config changes are applied locally with a short
 * ramp; there is no extra network streaming in spatial mode.
 */
(function () {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const DEFAULT_CONFIG = { enabled: false, width: 1, centerMix: 0.3, positions: {} };

  /**
   * ★ The gain curve (pure function, easy to experiment with).
   *
   *   p = x · width                       effective position, −1 … +1
   *   pan:    wL = (1 − p) / 2            wR = (1 + p) / 2
   *   blend:  gainL = c/2 + (1 − c)·wL    gainR = c/2 + (1 − c)·wR
   *
   * where c = centerMix = how much of the full (L+R) mix every device keeps.
   * gainL + gainR is always 1, so correlated content (vocals, bass) keeps the
   * same level everywhere and can't clip. Examples with width 1, centerMix 0.3:
   *
   *   x = −1  →  L 0.85  R 0.15   (left device: mostly left channel, a bit of right)
   *   x =  0  →  L 0.50  R 0.50   (center device: both channels equally)
   *   x = +1  →  L 0.15  R 0.85
   *
   * Width 0 or centerMix 1 makes every device play the same mono mix.
   */
  function spatialGains(x, width, centerMix) {
    const p = clamp((Number(x) || 0) * clamp(width, 0, 1), -1, 1);
    const c = clamp(centerMix, 0, 1);
    const wL = (1 - p) / 2;
    const wR = (1 + p) / 2;
    return { p, gainL: c / 2 + (1 - c) * wL, gainR: c / 2 + (1 - c) * wR };
  }

  /** Short ramp so changing settings mid-song doesn't click. */
  const RAMP_TIME_CONSTANT = 0.015;

  /**
   * Node graph:
   *
   *   input ─┬─► dry ─────────────────────────────────┐   Standard Sync: dry = 1, wet = 0
   *          │                                         ├─► output
   *          └─► splitter ─► gainL ─┐                  │   Spatial:       dry = 0, wet = 1
   *                     └──► gainR ─┴─► sum (mono) ─► wet
   *
   *   testInput ─────────────────────────────────────────► output   (spatial test signal)
   *
   * In spatial mode the device outputs gainL·L + gainR·R as mono on all of its
   * own speakers: the device itself is the "point speaker" in the room.
   */
  class SpatialRenderer {
    /**
     * @param {AudioContext} ctx
     * @param {AudioNode} output  where the result goes (the player's volume/mute node)
     */
    constructor(ctx, output) {
      this.ctx = ctx;
      this.input = ctx.createGain();
      this.input.channelCount = 2;
      this.input.channelCountMode = 'explicit';      // mono sources are up-mixed to L = R
      this.input.channelInterpretation = 'speakers';

      this.dry = ctx.createGain();
      this.wet = ctx.createGain();
      this.splitter = ctx.createChannelSplitter(2);
      this.gainL = ctx.createGain();
      this.gainR = ctx.createGain();
      this.sum = ctx.createGain();
      this.testInput = ctx.createGain();

      this.input.connect(this.dry);
      this.dry.connect(output);
      this.input.connect(this.splitter);
      this.splitter.connect(this.gainL, 0);
      this.splitter.connect(this.gainR, 1);
      this.gainL.connect(this.sum);
      this.gainR.connect(this.sum);
      this.sum.connect(this.wet);
      this.wet.connect(output);
      this.testInput.connect(output);

      this.state = { enabled: false, x: 0, width: DEFAULT_CONFIG.width, centerMix: DEFAULT_CONFIG.centerMix };
      this.apply(this.state, true);
    }

    /**
     * @param {{enabled: boolean, x: number, width: number, centerMix: number}} s
     */
    apply(s, immediate = false) {
      this.state = {
        enabled: !!s.enabled,
        x: clamp(Number(s.x) || 0, -1, 1),
        width: clamp(Number(s.width), 0, 1),
        centerMix: clamp(Number(s.centerMix), 0, 1),
      };
      const g = spatialGains(this.state.x, this.state.width, this.state.centerMix);
      const t = this.ctx.currentTime;
      const set = (param, v) => {
        param.cancelScheduledValues(t);
        if (immediate) param.value = v;
        else param.setTargetAtTime(v, t, RAMP_TIME_CONSTANT);
      };
      set(this.gainL.gain, g.gainL);
      set(this.gainR.gain, g.gainR);
      set(this.dry.gain, this.state.enabled ? 0 : 1);
      set(this.wet.gain, this.state.enabled ? 1 : 0);
    }

    /** Apply a room-wide config broadcast by the server, picking out this device's position. */
    applyRoomConfig(config, deviceId) {
      const c = { ...DEFAULT_CONFIG, ...(config || {}) };
      const x = c.positions && typeof c.positions[deviceId] === 'number' ? c.positions[deviceId] : 0;
      this.apply({ enabled: c.enabled, x, width: c.width, centerMix: c.centerMix });
    }

    /** What this device is actually rendering (reported to the Master's diagnostics). */
    status() {
      const g = spatialGains(this.state.x, this.state.width, this.state.centerMix);
      return {
        spatialOn: this.state.enabled,
        spatialX: this.state.x,
        gainL: this.state.enabled ? g.gainL : 1,
        gainR: this.state.enabled ? g.gainR : 1,
      };
    }
  }

  // ─── Spatial test signal ──────────────────────────────────────────────────
  //
  // A virtual sound source travels across the line of devices:
  //   0–2 s LEFT, 2–4 s CENTER, 4–6 s RIGHT, then 6–10 s a smooth sweep L → R.
  // Every device generates the same tone bursts locally (no file, no
  // streaming) and starts them at the same scheduled master-clock time. Each
  // device sets its OWN loudness from the distance between the virtual source
  // and its assigned position, so the loudest device should clearly move
  // left → center → right. The test therefore checks positions + sync; music
  // uses the stereo renderer above.

  const TEST_DURATION = 10;
  const TEST_PHASES = [
    { label: 'LEFT', from: 0, to: 2, freq: 523.25 },
    { label: 'CENTER', from: 2, to: 4, freq: 659.25 },
    { label: 'RIGHT', from: 4, to: 6, freq: 783.99 },
    { label: 'SWEEP LEFT → RIGHT', from: 6, to: 10, freq: 880 },
  ];
  /** Distance (in x units) at which a device fades out completely. */
  const TEST_SPREAD = 1;

  function testPhaseAt(t) {
    return TEST_PHASES.find((p) => t >= p.from && t < p.to) || null;
  }

  /** Virtual source position at test time t (seconds). */
  function testSourcePosition(t) {
    if (t < 2) return -1;
    if (t < 4) return 0;
    if (t < 6) return 1;
    return -1 + (2 * clamp(t - 6, 0, 4)) / 4;
  }

  /** Loudness of a device at position x when the virtual source is at s (equal-power fade). */
  function testLevel(x, s) {
    const d = Math.min(1, Math.abs(s - x) / TEST_SPREAD);
    return Math.cos((d * Math.PI) / 2);
  }

  /** Mono tone bursts (5 per second); the pitch tells you which phase you're in. */
  function makeTestBuffer(ctx) {
    const rate = ctx.sampleRate;
    const n = Math.ceil(rate * TEST_DURATION);
    const buf = ctx.createBuffer(1, n, rate);
    const d = buf.getChannelData(0);
    const period = 0.2;
    const burst = 0.12;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const local = t % period;
      if (local >= burst) continue;
      const phase = testPhaseAt(t);
      if (!phase) continue;
      const env = Math.sin((Math.PI * local) / burst);
      const w = 2 * Math.PI * phase.freq * t;
      d[i] = env * 0.6 * (Math.sin(w) + 0.3 * Math.sin(2 * w));
    }
    return buf;
  }

  /** Per-device loudness automation for the whole test, sampled every 20 ms. */
  function makeTestEnvelope(x) {
    const steps = Math.round(TEST_DURATION / 0.02) + 1;
    const curve = new Float32Array(steps);
    for (let i = 0; i < steps; i++) curve[i] = testLevel(x, testSourcePosition((i * TEST_DURATION) / (steps - 1)));
    return curve;
  }

  const testBuffers = new WeakMap(); // AudioContext → generated test buffer

  /**
   * Start the test on this device at master-clock time `startAt`. Timing goes
   * through the player's normal scheduling (same as music); the loudness
   * envelope comes from this device's own position.
   * @returns {boolean} false if it couldn't be scheduled (speaker off / too late)
   */
  function scheduleTest(player, renderer, startAt) {
    const ctx = player.ctx;
    if (!ctx || !renderer) return false;
    if (renderer.testRun) {
      try { renderer.testRun.source.stop(); } catch { /* already ended */ }
    }
    let buffer = testBuffers.get(ctx);
    if (!buffer) {
      buffer = makeTestBuffer(ctx);
      testBuffers.set(ctx, buffer);
    }
    const env = ctx.createGain();
    env.gain.value = 0;
    env.connect(renderer.testInput);
    const run = player.scheduleOneShot(buffer, startAt, env);
    if (!run) {
      env.disconnect();
      return false;
    }
    env.gain.setValueCurveAtTime(makeTestEnvelope(renderer.state.x), run.when, TEST_DURATION);
    run.source.onended = () => env.disconnect();
    renderer.testRun = run;
    return true;
  }

  Object.assign(window.SyncWave, {
    SpatialRenderer,
    spatialGains,
    SPATIAL_DEFAULTS: DEFAULT_CONFIG,
    SpatialTest: { DURATION: TEST_DURATION, phaseAt: testPhaseAt, schedule: scheduleTest },
  });
})();
