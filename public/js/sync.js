/*
 * sync.js — shared by the Master page and the Client (phone) page.
 *
 *   Connection       WebSocket with automatic reconnect + dead-link watchdog.
 *   ClockSync        Estimates (master clock − this device's clock) from many
 *                    NTP-style pings, robust to slow/outlier packets, and tracks
 *                    clock drift with a weighted linear fit.
 *   DriftController  Pure logic: turns measured playback error into a gentle
 *                    playback-rate correction (or, rarely, an explicit resync).
 *   SyncedPlayer     Decodes the track with Web Audio, starts it at a scheduled
 *                    master-clock time, keeps an exact model of where playback is
 *                    (through rate changes and looping), measures drift and
 *                    corrects it continuously.
 *
 * Time domains (ms unless stated):
 *   "master time"  The Node server's clock on the laptop (server/syncEngine.js).
 *   "local time"   This browser's clock: performance.timeOrigin + performance.now().
 *   "context time" AudioContext time in SECONDS, driven by the sound card's crystal.
 *
 * "Play track position P at master time T" becomes:
 *   master time T ──(− clock offset)──▶ local time ──(output timestamp)──▶ context time
 *   …then shifted by this device's latency offset (calibration + manual trim).
 *
 * This file must not depend on the DOM at load time: tests load it in Node.
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;

  /** Local clock in epoch ms (monotonic while the page is open). */
  const localNow = () => performance.timeOrigin + performance.now();
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const mm = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return h ? `${h}:${mm}` : mm;
  }

  /** Random id without crypto.randomUUID (which is unavailable on plain-http LAN pages). */
  function randomId(len = 16) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => chars[b % chars.length]).join('');
  }

  function median(values) {
    if (values.length === 0) return NaN;
    const v = [...values].sort((a, b) => a - b);
    const mid = v.length >> 1;
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  }

  // ─── Connection ───────────────────────────────────────────────────────────

  /** No message (sync replies arrive every second) for this long ⇒ treat the link as dead. */
  const WATCHDOG_MS = 6000;

  class Connection {
    constructor({ onOpen, onMessage, onBinary, onClose }) {
      this.onOpen = onOpen;
      this.onMessage = onMessage;
      this.onBinary = onBinary;
      this.onClose = onClose;
      this.ws = null;
      this.retryMs = 500;
      this.retryTimer = null;
      this.stopped = false;
      this.blockedUntil = 0;     // test hook: simulate a Wi-Fi outage
      this.lastMessageAt = 0;
      this.reconnects = 0;
      // Phones often drop the socket when the screen locks; reconnect as soon as the page is visible.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !this.isOpen) this.connectNow();
      });
      // A Wi-Fi drop often leaves the socket "open" but silent for a long time.
      // Close it ourselves so the reconnect logic kicks in quickly.
      setInterval(() => {
        if (this.isOpen && performance.now() - this.lastMessageAt > WATCHDOG_MS) this.ws.close();
      }, 1000);
    }

    get isOpen() {
      return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    connect() {
      if (this.stopped) return;
      if (performance.now() < this.blockedUntil) {
        this.scheduleReconnect();
        return;
      }
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.retryMs = 500;
        this.lastMessageAt = performance.now();
        this.onOpen && this.onOpen();
      };
      ws.onmessage = (ev) => {
        this.lastMessageAt = performance.now();
        if (typeof ev.data !== 'string') {
          if (this.onBinary) this.onBinary(ev.data); // live audio chunk
          return;
        }
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        this.onMessage && this.onMessage(msg);
      };
      ws.onclose = (ev) => {
        if (this.ws !== ws) return;
        this.ws = null;
        this.reconnects++;
        this.onClose && this.onClose(ev);
        this.scheduleReconnect();
      };
      ws.onerror = () => { /* onclose follows */ };
    }

    connectNow() {
      clearTimeout(this.retryTimer);
      if (this.ws && this.ws.readyState === WebSocket.CONNECTING) return;
      this.connect();
    }

    scheduleReconnect() {
      if (this.stopped) return;
      clearTimeout(this.retryTimer);
      const wait = Math.max(this.retryMs, this.blockedUntil - performance.now());
      this.retryTimer = setTimeout(() => this.connect(), wait);
      this.retryMs = Math.min(this.retryMs * 2, 4000);
    }

    /** Test hook: drop the connection and refuse to reconnect for `ms` (simulated Wi-Fi outage). */
    simulateOutage(ms) {
      this.blockedUntil = performance.now() + ms;
      if (this.ws) this.ws.close();
    }

    send(obj) {
      if (!this.isOpen) return false;
      this.ws.send(JSON.stringify(obj));
      return true;
    }

    sendBinary(buf) {
      if (!this.isOpen) return false;
      this.ws.send(buf);
      return true;
    }

    /** Stop for good (room closed / not allowed). */
    shutdown() {
      this.stopped = true;
      clearTimeout(this.retryTimer);
      if (this.ws) this.ws.close();
    }
  }

  // ─── Clock synchronization ────────────────────────────────────────────────
  //
  // NTP-style exchange over the WebSocket, once per second (plus a fast burst
  // after every (re)connect):
  //
  //   device  t0 ──── {sync, t0} ────▶ t1  server
  //   device  t3 ◀── {t0, t1, t2} ──── t2  server
  //
  //   round trip   rtt    = (t3 − t0) − (t2 − t1)
  //   clock offset θ      = ((t1 − t0) + (t2 − t3)) / 2        (= master − local)
  //
  // θ is exact if the trip out and the trip back took equally long; any
  // asymmetry is error, bounded by rtt/2. Wi-Fi delays are spiky (power save,
  // retransmits, queueing), and a slow packet is almost always *asymmetrically*
  // slow, so:
  //
  //   1. Keep the last 2 minutes of samples.
  //   2. Only trust "good" samples: rtt ≤ 1.5 × (lowest rtt in the window) + 3 ms.
  //      A single slow packet can't move the estimate.
  //   3. With ≥ 8 good samples spanning ≥ 15 s, fit θ(t) = a + b·(t − t̄) by
  //      weighted least squares (weight 1/(rtt+1)²: fast round trips count more).
  //      b is the clock drift rate (ppm); the offset used *now* is θ(now), so it
  //      doesn't lag behind when the two clocks run at slightly different speeds.
  //   4. Otherwise: median of the best quarter of samples.
  //
  // uncertaintyMs = half the best round trip + scatter of the good samples
  // around the fit: an honest bound, not a guarantee.

  const SYNC_WINDOW_MS = 120000;
  const BURST_COUNT = 15;
  const BURST_SPACING_MS = 60;
  const STEADY_INTERVAL_MS = 1000;

  class ClockSync {
    constructor(send) {
      this.send = send;
      this.samples = [];
      this.offset = 0;           // master − local at the last update, ms
      this.fit = null;           // { a, b, tRef } when the drift fit is active
      this.bestRtt = null;
      this.medianRtt = null;
      this.driftPpm = null;
      this.scatterMs = null;
      this.lastSampleAt = 0;     // local time of the last accepted sample
      this.fitFallback = null;
      this.timer = null;
      this.seeded = false;
    }

    /** Enough samples to schedule audio against. */
    get ready() {
      return this.samples.length >= 5;
    }

    /** Settled enough to call calibration done. */
    get converged() {
      return this.samples.length >= 10;
    }

    get uncertaintyMs() {
      if (this.bestRtt == null) return null;
      return this.bestRtt / 2 + (this.scatterMs || 0);
    }

    /** Use the offset remembered from a previous session until real samples arrive. */
    seed(offsetMs) {
      if (this.samples.length === 0 && Number.isFinite(offsetMs)) {
        this.offset = offsetMs;
        this.seeded = true;
      }
    }

    start() {
      this.stop();
      let burst = BURST_COUNT;
      const tick = () => {
        // After a long gap (page asleep, Wi-Fi outage) run another quick burst.
        if (this.lastSampleAt && localNow() - this.lastSampleAt > 5000 && burst <= 0) burst = 5;
        this.send({ type: 'sync', t0: localNow() });
        burst -= 1;
        this.timer = setTimeout(tick, burst > 0 ? BURST_SPACING_MS : STEADY_INTERVAL_MS);
      };
      tick();
    }

    stop() {
      clearTimeout(this.timer);
      this.timer = null;
    }

    handleReply({ t0, t1, t2 }) {
      this.addSample(t0, t1, t2, localNow());
    }

    /** Separate from handleReply so tests can feed synthetic exchanges. */
    addSample(t0, t1, t2, t3) {
      const rtt = (t3 - t0) - (t2 - t1);
      if (!(rtt >= 0 && rtt < 3000)) return;
      const offset = ((t1 - t0) + (t2 - t3)) / 2;
      this.samples.push({ t: t3, offset, rtt });
      const cutoff = t3 - SYNC_WINDOW_MS;
      while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
      this.lastSampleAt = t3;
      this.recompute(t3);
    }

    recompute(now) {
      const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
      this.bestRtt = byRtt[0].rtt;
      this.medianRtt = median(byRtt.map((s) => s.rtt));
      const good = this.samples.filter((s) => s.rtt <= this.bestRtt * 1.5 + 3);

      this.fit = null;
      if (good.length >= 8 && good[good.length - 1].t - good[0].t >= 15000) {
        let sw = 0, st = 0, so = 0;
        for (const s of good) { const w = 1 / (s.rtt + 1) ** 2; sw += w; st += w * s.t; so += w * s.offset; }
        const tRef = st / sw;
        const a = so / sw;
        let num = 0, den = 0;
        for (const s of good) { const w = 1 / (s.rtt + 1) ** 2; num += w * (s.t - tRef) * (s.offset - a); den += w * (s.t - tRef) ** 2; }
        const b = den > 0 ? clamp(num / den, -5e-4, 5e-4) : 0; // |drift| ≤ 500 ppm sanity cap
        this.fit = { a, b, tRef };
        this.driftPpm = b * 1e6;
        const res = good.map((s) => s.offset - (a + b * (s.t - tRef)));
        this.scatterMs = Math.sqrt(res.reduce((q, r) => q + r * r, 0) / res.length);
      } else {
        const best = byRtt.slice(0, Math.max(3, Math.ceil(byRtt.length * 0.25)));
        this.driftPpm = null;
        this.scatterMs = null;
        this.fitFallback = median(best.map((s) => s.offset));
      }
      this.offset = this.offsetAt(now);
    }

    /** Offset (master − local) at local time t, following the drift fit if there is one. */
    offsetAt(t) {
      if (this.fit) return this.fit.a + this.fit.b * (t - this.fit.tRef);
      if (this.fitFallback != null) return this.fitFallback;
      return this.offset;
    }

    /** Current master-clock time as seen from this device. */
    masterNow() {
      const t = localNow();
      return t + this.offsetAt(t);
    }

    toLocal(masterMs) {
      // offset changes by ≤ 500 ppm, so one fixed-point step is plenty.
      const guess = masterMs - this.offsetAt(localNow());
      return masterMs - this.offsetAt(guess);
    }

    toMaster(localMs) {
      return localMs + this.offsetAt(localMs);
    }
  }

  // ─── Drift correction ─────────────────────────────────────────────────────
  //
  // Input: the measured playback error e (ms, + = this device is ahead of the
  // master timeline), sampled 4× per second. Output: a playback rate.
  //
  //   1. Robust smoothing: median of the last 5 measurements, then an
  //      exponential average. A single glitchy reading can't trigger anything.
  //   2. Zones (per profile, Music shown; Movie is tighter):
  //        |e| <  10 ms   ignore (hysteresis: once correcting, continue until < 4 ms)
  //        10–50 ms       fine correction: rate = 1 − e/τ, capped at ±0.1 %
  //        50–200 ms      strong correction: same, capped at ±0.4 %
  //        > 200 ms       explicit resync (only if seen twice in a row, max once per 5 s)
  //      ±0.1 % ≈ 1.7 cents of pitch: below what listeners notice. It removes
  //      1 ms of error per second.
  //   3. Skew learning: while no correction is running, the error should be
  //      flat. If it slopes (this device's audio clock runs a few tens of ppm
  //      fast/slow), fit the slope over ≥ 20 s and feed half of it forward as
  //      a constant rate bias. Steady skew is then cancelled continuously
  //      instead of causing a slow sawtooth of corrections. (Measured
  //      directly rather than integrated, so it can't oscillate.)
  //   4. The rate may change by at most 0.05 % per update (no audible jumps).
  //
  // First-order loop: e decays as e·exp(−t/τ). With τ = 4–6 s and ~1 s of
  // smoothing lag it is well damped (see scripts/simulate-drift.js).

  const SYNC_PROFILES = {
    music: {
      label: 'Music', deadbandMs: 10, releaseMs: 4, softLimitMs: 50,
      softRate: 0.0015, hardRate: 0.004, resyncMs: 200, syncedMs: 10, tauS: 6,
    },
    movie: {
      label: 'Movie', deadbandMs: 4, releaseMs: 1.5, softLimitMs: 25,
      softRate: 0.002, hardRate: 0.005, resyncMs: 80, syncedMs: 5, tauS: 4,
    },
  };

  const SKEW_WINDOW_S = 20;       // estimate the error slope over this long while holding
  const SKEW_GAIN = 0.4;          // apply part of the measured slope per window
  const MAX_BIAS = 0.0005;        // ±500 ppm
  const RATE_SLEW = 0.0005;       // max rate change per update
  const RESYNC_COOLDOWN_S = 5;

  class DriftController {
    constructor(profileName = 'music') {
      this.setProfile(profileName);
      this.bias = 0;              // learned constant rate offset (survives resyncs)
      this.reset();
    }

    setProfile(name) {
      this.profileName = SYNC_PROFILES[name] ? name : 'music';
      this.p = SYNC_PROFILES[this.profileName];
    }

    /** Forget the current measurement history (new start / resync). Keeps the learned bias. */
    reset() {
      this.history = [];
      this.hold = [];
      this.smoothed = null;
      this.correcting = false;
      this.rate = 1 - this.bias;
      this.overCount = 0;
      this.zone = 'idle';
      this.lastT = null;
      if (this.lastResyncAt === undefined) this.lastResyncAt = -Infinity;
    }

    /**
     * @param {number} errorMs  measured error, + = ahead
     * @param {number} tS       a monotonic time in seconds
     * @returns {{action: 'rate'|'resync', rate: number, zone: string, errorMs: number}}
     */
    update(errorMs, tS) {
      const p = this.p;
      this.lastT = tS;

      this.history.push(errorMs);
      if (this.history.length > 5) this.history.shift();
      const m = median(this.history);
      this.smoothed = this.smoothed == null ? m : this.smoothed + 0.35 * (m - this.smoothed);
      const e = this.smoothed;
      const a = Math.abs(e);

      if (a > p.resyncMs) {
        this.overCount++;
        if (this.overCount >= 2 && tS - this.lastResyncAt > RESYNC_COOLDOWN_S) {
          this.lastResyncAt = tS;
          this.reset();
          this.zone = 'resync';
          return { action: 'resync', rate: this.rate, zone: 'resync', errorMs: e };
        }
      } else {
        this.overCount = 0;
      }

      if (!this.correcting && a > p.deadbandMs) this.correcting = true;
      else if (this.correcting && a < p.releaseMs) this.correcting = false;

      // Skew learning from the error's slope while holding a constant rate.
      if (!this.correcting) {
        this.hold.push([tS, errorMs]);
        const span = tS - this.hold[0][0];
        if (span >= SKEW_WINDOW_S && this.hold.length >= 50) {
          // Robust slope: median of slopes between points half a window apart
          // (outlier readings can't swing it, unlike least squares).
          const h = this.hold.length >> 1;
          const slopes = [];
          for (let i = 0; i + h < this.hold.length; i++) {
            const [t0, e0] = this.hold[i];
            const [t1, e1] = this.hold[i + h];
            slopes.push((e1 - e0) / (t1 - t0));
          }
          const slopeMsPerS = median(slopes);  // + = drifting ahead
          // Only act on a slope clearly above the noise of the *median* estimate
          // (≈ spread of individual slopes / √n).
          const spread = median(slopes.map((s) => Math.abs(s - slopeMsPerS)));
          if (Math.abs(slopeMsPerS) > (3 * spread) / Math.sqrt(slopes.length)) {
            this.bias = clamp(this.bias + SKEW_GAIN * slopeMsPerS / 1000, -MAX_BIAS, MAX_BIAS);
          }
          this.hold = [];
        }
      } else {
        this.hold = [];
      }

      let adj = 0;
      if (this.correcting) {
        const cap = a > p.softLimitMs ? p.hardRate : p.softRate;
        adj = clamp(e / 1000 / p.tauS, -cap, cap);
        this.zone = a > p.softLimitMs ? 'strong' : 'fine';
      } else {
        this.zone = 'hold';
      }
      const target = 1 - adj - this.bias;
      this.rate += clamp(target - this.rate, -RATE_SLEW, RATE_SLEW);
      return { action: 'rate', rate: this.rate, zone: this.zone, errorMs: e };
    }
  }

  // ─── Scheduled audio playback ─────────────────────────────────────────────

  /** How long we need between "decide to start" and the first sample (late joins / resyncs). */
  const LATE_START_PREP_MS = 400;
  const DRIFT_TICK_MS = 250;
  /** After a (re)start, report RESYNCING until the error has settled this long. */
  const SETTLE_S = 2;

  function decodeAudio(ctx, arrayBuffer) {
    // Promise form where supported, callback form for older Safari.
    return new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, (e) => reject(e || new Error('decode failed')));
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    });
  }

  async function fetchWithProgress(url, signal, onProgress) {
    const res = await fetch(url, { signal, cache: 'force-cache' });
    if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    if (!res.body || !total) {
      const buf = await res.arrayBuffer();
      onProgress(1);
      return buf;
    }
    const reader = res.body.getReader();
    let out = new Uint8Array(total);
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (received + value.length > out.length) {
        const bigger = new Uint8Array((received + value.length) * 2);
        bigger.set(out.subarray(0, received));
        out = bigger;
      }
      out.set(value, received);
      received += value.length;
      onProgress(Math.min(1, received / total));
    }
    return received === out.length ? out.buffer : out.slice(0, received).buffer;
  }

  /** 0.5 s of silence as a WAV blob URL (used to unlock iOS media playback). */
  function silentWavUrl() {
    const rate = 8000;
    const samples = rate / 2;
    const buf = new ArrayBuffer(44 + samples * 2);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + samples * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, samples * 2, true);
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  const isIOS = typeof navigator !== 'undefined' && (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

  /** Wrap x into (−d/2, d/2]. */
  function wrapCentered(x, d) {
    return x - d * Math.round(x / d);
  }

  class SyncedPlayer {
    /**
     * @param {ClockSync} clock
     * @param {() => void} onChange  called whenever the visible state changes
     * @param {{outputChain?: (ctx: AudioContext, output: AudioNode) => AudioNode}} [options]
     *        outputChain lets a page insert audio processing (e.g. the spatial
     *        renderer) between the scheduled sources and the speaker. It
     *        returns the node that sources should connect to.
     */
    constructor(clock, onChange, options = {}) {
      this.clock = clock;
      this.onChange = onChange || (() => {});
      this.outputChain = options.outputChain || null;
      this.ctx = null;
      this.gain = null;          // final volume/mute → speaker
      this.input = null;         // where sources connect (processing chain input, or gain)
      this.track = null;         // { id, name, url }
      this.raw = null;           // { trackId, data: ArrayBuffer } downloaded, not yet decoded
      this.decoded = null;       // { trackId, buffer: AudioBuffer }
      this.loadState = 'idle';   // idle | downloading | downloaded | decoding | ready | error
      this.loadProgress = 0;
      this.error = null;
      this.abort = null;
      this.playback = null;      // last playback state from the server
      this.active = null;        // the currently scheduled/playing source + its position model
      this.ended = false;
      // Latency compensation: total shift applied to this device's schedule
      // (+ = play later). trimMs = calibrationMs + manualTrimMs.
      this.calibrationMs = 0;
      this.manualTrimMs = 0;
      this.trimMs = 0;
      this.muted = false;
      this.silentAudio = null;

      this.controller = new DriftController('music');
      this.correction = { rate: 1, zone: 'idle', errorMs: null, rawErrorMs: null };
      this.resyncs = 0;
      this.lastResyncAt = 0;      // performance.now() of the last explicit resync
      this.startedAt = 0;         // performance.now() when the current source was scheduled
      this.simulatedSkewPpm = 0;  // test hook, see clockMapping()
      this.skewBase = null;
      this.driftTimer = null;
    }

    get speakerEnabled() {
      return !!this.ctx && this.ctx.state === 'running';
    }

    get duration() {
      return this.decoded ? this.decoded.buffer.duration : null;
    }

    /** Create the AudioContext (may start "suspended" until a user gesture). */
    ensureContext() {
      if (this.ctx) return this.ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('Web Audio is not supported in this browser');
      try {
        this.ctx = new AC({ latencyHint: 'interactive' });
      } catch {
        this.ctx = new AC();
      }
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.muted ? 0 : 1;
      this.gain.connect(this.ctx.destination);
      // Audio pipeline: source → [optional processing, e.g. spatial] → gain (mute) → speaker
      this.input = this.outputChain ? this.outputChain(this.ctx, this.gain) : this.gain;

      let wasRunning = this.ctx.state === 'running';
      if (wasRunning) this.startKeepAlive();
      this.ctx.onstatechange = () => {
        const running = this.ctx.state === 'running';
        if (running) this.startKeepAlive();
        // If the context was suspended/interrupted (screen lock, phone call),
        // its clock stopped: the old schedule is meaningless. Re-join playback.
        if (running && !wasRunning) this.resync();
        if (!running && wasRunning) this.stopSource();
        wasRunning = running;
        this.onChange();
      };
      return this.ctx;
    }

    /**
     * Must be called from a user gesture (tap/click). Browsers, especially on
     * mobile, refuse to output audio until the user has interacted with the page.
     */
    async enable() {
      this.ensureContext();
      // iOS 17+: treat Web Audio as media playback so the ring/silent switch doesn't mute it.
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch { /* ignore */ }
      const resumed = this.ctx.resume(); // call synchronously inside the gesture
      // Older iOS needs a sound started inside the gesture to unlock output.
      const blip = this.ctx.createBufferSource();
      blip.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      blip.connect(this.ctx.destination);
      blip.start(0);
      // Older iOS: a playing <audio> element switches the audio session to
      // "playback" so Web Audio isn't silenced by the mute switch.
      if (isIOS && !navigator.audioSession && !this.silentAudio) {
        const a = document.createElement('audio');
        a.src = silentWavUrl();
        a.loop = true;
        a.setAttribute('playsinline', '');
        a.play().catch(() => {});
        this.silentAudio = a;
      }
      await resumed;
      this.startKeepAlive();
      this.onChange();
      await this.decodePending();
      this.resync();
    }

    /**
     * Keep the audio output "awake". Chrome (desktop and Android) switches a
     * Web Audio output that has produced pure digital silence for a few
     * seconds to a fake sink to save power, and switching back to the real
     * speaker takes ~1 s — so the first sound after a pause would come out
     * about a second late (measured in testing: −970 to −1290 ms, fixed only
     * by a resync). A looping, inaudible noise floor (−100 dBFS) means the
     * output is never "silent", so scheduled starts stay accurate. Costs a
     * little battery while the page is open.
     */
    startKeepAlive() {
      if (this.keepAlive || !this.ctx) return;
      const ctx = this.ctx;
      const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * 1e-5;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(ctx.destination);
      src.start();
      this.keepAlive = src;
    }

    setMuted(muted) {
      this.muted = muted;
      if (this.gain) this.gain.gain.value = muted ? 0 : 1;
    }

    setSyncProfile(name) {
      this.controller.setProfile(name);
    }

    /**
     * Change this device's latency compensation. While playing, the change
     * shows up as playback error and is absorbed smoothly by the drift
     * controller (or, if large, by one explicit resync) — no restart.
     */
    setLatencyOffset({ calibrationMs = this.calibrationMs, manualTrimMs = this.manualTrimMs } = {}) {
      this.calibrationMs = clamp(Math.round(calibrationMs * 10) / 10, -500, 500);
      this.manualTrimMs = clamp(Math.round(manualTrimMs), -1000, 1000);
      this.trimMs = this.calibrationMs + this.manualTrimMs;
      this.onChange();
    }

    /** Back-compat for the manual fine-tune buttons. */
    setTrim(ms) {
      this.setLatencyOffset({ manualTrimMs: ms });
    }

    // ── Loading ──

    /** Switch to a track announced by the server; downloads it if needed. */
    setTrack(track) {
      if (!track) {
        this.clearTrack();
        return;
      }
      if (this.track && this.track.id === track.id) return;
      this.clearTrack();
      this.track = track;
      this.download(track);
    }

    clearTrack() {
      if (this.abort) this.abort.abort();
      this.abort = null;
      this.stopSource();
      this.track = null;
      this.raw = null;
      this.decoded = null;
      this.loadState = 'idle';
      this.loadProgress = 0;
      this.error = null;
      this.onChange();
    }

    async download(track) {
      const abort = new AbortController();
      this.abort = abort;
      this.loadState = 'downloading';
      this.loadProgress = 0;
      this.onChange();
      try {
        const data = await fetchWithProgress(track.url, abort.signal, (p) => {
          this.loadProgress = p;
          this.onChange();
        });
        if (this.track !== track) return;
        this.raw = { trackId: track.id, data };
        this.loadState = 'downloaded';
        this.onChange();
        await this.decodePending();
        this.resync();
      } catch (err) {
        if (abort.signal.aborted || this.track !== track) return;
        this.fail(err.message || 'Download failed');
      }
    }

    /** The Master decoded the file locally before uploading: no need to download it back. */
    loadDecoded(track, buffer) {
      this.clearTrack();
      this.track = track;
      this.decoded = { trackId: track.id, buffer };
      this.loadState = 'ready';
      this.onChange();
      this.resync();
    }

    /** Decoding needs an AudioContext, which on phones only exists after "Enable Speaker". */
    async decodePending() {
      if (!this.raw || !this.ctx || this.loadState === 'decoding') return;
      const { trackId, data } = this.raw;
      this.loadState = 'decoding';
      this.onChange();
      try {
        const buffer = await decodeAudio(this.ctx, data);
        if (!this.track || this.track.id !== trackId) return;
        this.raw = null;
        this.decoded = { trackId, buffer };
        this.loadState = 'ready';
        this.onChange();
      } catch (err) {
        if (!this.track || this.track.id !== trackId) return;
        this.raw = null;
        this.fail('This browser cannot decode this audio format. Try MP3 or WAV.');
      }
    }

    fail(message) {
      this.loadState = 'error';
      this.error = message;
      this.onChange();
    }

    // ── Clock mapping ──

    /**
     * Pair of simultaneous readings { contextTime (s), performanceTime (ms) }
     * meaning "the sample at contextTime is coming out of the speaker at
     * performanceTime". getOutputTimestamp() gives exactly this, including the
     * output latency the browser knows about. If unavailable or implausible,
     * fall back to currentTime minus the reported latency.
     */
    clockMapping() {
      const ctx = this.ctx;
      let map = null;
      if (typeof ctx.getOutputTimestamp === 'function') {
        const ts = ctx.getOutputTimestamp();
        if (ts && ts.contextTime > 0 && ts.performanceTime > 0 &&
            Math.abs(performance.now() - ts.performanceTime) < 500) {
          map = { contextTime: ts.contextTime, performanceTime: ts.performanceTime, method: 'outputTimestamp' };
        }
      }
      if (!map) {
        const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
        map = { contextTime: ctx.currentTime - latency, performanceTime: performance.now(), method: 'currentTime' };
      }
      // TEST HOOK ONLY: pretend this device's audio clock runs fast/slow by
      // `simulatedSkewPpm`, so the drift correction can be exercised on one
      // laptop where every tab shares the same sound card. The device's
      // measurements then show real-looking drift; its audio is NOT actually
      // meaningful while this is on.
      if (this.simulatedSkewPpm) {
        if (!this.skewBase) this.skewBase = { p: map.performanceTime };
        const k = 1 + this.simulatedSkewPpm * 1e-6;
        map.performanceTime = this.skewBase.p + (map.performanceTime - this.skewBase.p) / k;
      }
      return map;
    }

    /** Convert a master-clock time (ms) to AudioContext time (s). */
    masterToContextTime(masterMs, map) {
      const localPerfMs = this.clock.toLocal(masterMs) - performance.timeOrigin;
      return map.contextTime + (localPerfMs - map.performanceTime) / 1000;
    }

    // ── Scheduling ──

    /**
     * Apply a playback state broadcast by the server. A state marked
     * `continuous` describes the same timeline (e.g. Repeat toggled while
     * playing): adopt it without restarting the audio.
     */
    applyPlayback(playback) {
      const changed = !this.playback || this.playback.seq !== playback.seq;
      const prev = this.playback;
      this.playback = playback;
      if (changed && playback.continuous && this.active && prev && prev.trackId === playback.trackId &&
          playback.status === 'playing') {
        this.setLoop(!!playback.loop);
        this.onChange();
        return;
      }
      if (changed) {
        // A new command replaces whatever was scheduled before.
        this.ended = false;
        this.stopSource();
        this.controller.reset();
      }
      // Same command re-sent (e.g. after a reconnect): resync() is a no-op if
      // it is already playing, and late-joins if it isn't.
      this.resync();
    }

    /** (Re)start according to the current playback state if we can and aren't already. */
    resync() {
      const pb = this.playback;
      if (!pb || pb.status !== 'playing') {
        this.stopSource();
        this.onChange();
        return;
      }
      if (this.active || this.ended) return;
      if (!this.speakerEnabled || !this.decoded || this.decoded.trackId !== pb.trackId) {
        this.onChange();
        return;
      }
      this.startScheduled(pb);
    }

    /** Expected (unwrapped) track position at master time t, including this device's latency offset. */
    expectedPositionAt(pb, masterMs) {
      return pb.position + (masterMs - pb.startAt - this.trimMs) / 1000;
    }

    /**
     * ★ The synchronized start.
     *
     * The server said: "track position pb.position is heard at master time
     * pb.startAt". We convert startAt (shifted by this device's latency
     * offset) into AudioContext time and ask Web Audio to start the buffer
     * exactly then — sample-accurate on the audio clock.
     *
     * If we're late (joined mid-song, reconnected, resync) we pick a start
     * time a little in the future and advance the track position by the same
     * amount, so we still land in step with everyone else.
     */
    startScheduled(pb) {
      const ctx = this.ctx;
      const buffer = this.decoded.buffer;
      const duration = buffer.duration;
      const loop = !!pb.loop;
      const now = this.clock.masterNow();

      let startMaster = pb.startAt;
      let late = false;
      if (startMaster + this.trimMs < now + LATE_START_PREP_MS / 2) {
        startMaster = now + LATE_START_PREP_MS - this.trimMs;
        late = true;
      }
      let offsetSec = pb.position + (startMaster - pb.startAt) / 1000;

      const map = this.clockMapping();
      let when = this.masterToContextTime(startMaster + this.trimMs, map);
      // Never schedule in the context's past: that would start immediately at
      // the wrong position. Shift both time and position instead.
      const earliest = ctx.currentTime + 0.02;
      if (when < earliest) {
        offsetSec += earliest - when;
        when = earliest;
        late = true;
      }
      if (loop) offsetSec = ((offsetSec % duration) + duration) % duration;
      else if (offsetSec >= duration) {
        this.ended = true;
        this.onChange();
        return;
      }

      const rate = this.controller.rate;
      this.correction = { rate, zone: 'idle', errorMs: null, rawErrorMs: null };
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = loop;
      source.playbackRate.value = rate;
      source.connect(this.input);
      source.onended = () => {
        if (this.active && this.active.source === source) {
          this.active = null;
          this.ended = true;
          this.stopDriftLoop();
          this.onChange();
        }
      };
      source.start(when, offsetSec);
      // Debug trail of recent scheduling decisions (window.syncwaveDebug.player.scheduleLog).
      this.scheduleLog = (this.scheduleLog || []).slice(-9);
      this.scheduleLog.push({
        at: performance.now(), seq: pb.seq, startAt: pb.startAt, startMaster, masterNow: now, late,
        when, ctxNow: ctx.currentTime, offsetSec, map: { ...map }, perfNow: performance.now(),
      });
      this.active = {
        source, seq: pb.seq, ctxStart: when, offsetSec, late, method: map.method, loop, duration,
        // Exact position model: position(c) = anchorPos + (c − anchorCtx) · rate
        anchorCtx: when, anchorPos: offsetSec, rate,
      };
      this.startedAt = performance.now();
      this.startDriftLoop();
      this.onChange();
    }

    /** Unwrapped track position at context time c (seconds), from the exact model. */
    positionAtContext(c) {
      const a = this.active;
      if (c < a.ctxStart) return a.offsetSec;
      return a.anchorPos + (c - a.anchorCtx) * a.rate;
    }

    /** Change the playback rate at a known context time so the position model stays exact. */
    setRate(rate) {
      const a = this.active;
      if (!a) return;
      const c = this.ctx.currentTime + 0.01;
      if (c < a.ctxStart) return;
      a.anchorPos = this.positionAtContext(c);
      a.anchorCtx = c;
      a.rate = rate;
      a.source.playbackRate.setValueAtTime(rate, c);
    }

    setLoop(loop) {
      const a = this.active;
      if (!a || a.loop === loop) return;
      if (!loop) {
        // The source's real position is wrapped; re-anchor the model to match.
        const c = this.ctx.currentTime + 0.01;
        const pos = this.positionAtContext(c);
        a.anchorPos = ((pos % a.duration) + a.duration) % a.duration;
        a.anchorCtx = Math.max(c, a.ctxStart);
      }
      a.loop = loop;
      a.source.loop = loop;
    }

    /**
     * Schedule a one-off buffer (spatial test, calibration chirp) to start at
     * a master-clock time — the same timing path as track playback, including
     * this device's latency offset.
     * @returns {{source: AudioBufferSourceNode, when: number} | null}
     */
    scheduleOneShot(buffer, startMasterMs, destination) {
      if (!this.speakerEnabled) return null;
      const ctx = this.ctx;
      const when = this.masterToContextTime(startMasterMs + this.trimMs, this.clockMapping());
      if (when < ctx.currentTime + 0.01) return null;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(destination || this.input);
      source.start(when);
      return { source, when };
    }

    stopSource() {
      this.stopDriftLoop();
      if (!this.active) return;
      const { source } = this.active;
      this.active = null;
      source.onended = null;
      try { source.stop(); } catch { /* not started */ }
      source.disconnect();
    }

    // ── Continuous drift detection & correction ──

    startDriftLoop() {
      this.stopDriftLoop();
      this.driftTimer = setInterval(() => this.driftTick(), DRIFT_TICK_MS);
    }

    stopDriftLoop() {
      clearInterval(this.driftTimer);
      this.driftTimer = null;
    }

    /**
     * Playback error right now: what this device is playing minus what the
     * master timeline (plus this device's latency offset) says it should be
     * playing. + = ahead. Measured at the instant getOutputTimestamp refers to.
     */
    measureError() {
      const a = this.active;
      const pb = this.playback;
      if (!a || !pb || pb.status !== 'playing' || !this.ctx) return null;
      const map = this.clockMapping();
      if (map.contextTime < a.ctxStart) return null; // not audible yet
      const heard = this.positionAtContext(map.contextTime);
      const masterAtMap = this.clock.toMaster(performance.timeOrigin + map.performanceTime);
      let err = heard - this.expectedPositionAt(pb, masterAtMap);
      if (a.loop && a.duration) err = wrapCentered(err, a.duration);
      return { errorMs: err * 1000, heard, map };
    }

    driftTick() {
      const m = this.measureError();
      if (!m) return;
      const r = this.controller.update(m.errorMs, performance.now() / 1000);
      this.correction = { rate: r.rate, zone: r.zone, errorMs: r.errorMs, rawErrorMs: m.errorMs };
      if (r.action === 'resync') {
        this.resyncs++;
        this.lastResyncAt = performance.now();
        this.stopSource();
        this.resync();              // late-start path: lands back on the timeline
        return;
      }
      if (this.active && Math.abs(r.rate - this.active.rate) > 1e-6) this.setRate(r.rate);
    }

    // ── Diagnostics ──

    status() {
      const out = {
        position: null,
        duration: this.duration,
        startsInMs: null,
        playbackDriftMs: null,
        outputLatencyMs: null,
        timingMethod: null,
      };
      const pb = this.playback;
      if (this.ctx) {
        out.outputLatencyMs = ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000;
      }
      if (this.active && this.ctx) {
        const a = this.active;
        const map = this.clockMapping();
        out.timingMethod = map.method;
        if (map.contextTime < a.ctxStart) {
          out.position = a.offsetSec;
          out.startsInMs = (a.ctxStart - map.contextTime) * 1000;
        } else {
          // Position audible right now (map.performanceTime can be a few ms old).
          let pos = this.positionAtContext(map.contextTime) + ((performance.now() - map.performanceTime) / 1000) * a.rate;
          if (a.loop && a.duration) pos = ((pos % a.duration) + a.duration) % a.duration;
          out.position = pos;
          const m = this.measureError();
          out.playbackDriftMs = m ? m.errorMs : null;
        }
      } else if (pb) {
        out.position = pb.status === 'playing' ? null : pb.position;
      }
      return out;
    }

    /** Coarse playback state for the UI. */
    stateName() {
      if (this.loadState === 'error') return 'error';
      if (!this.track) return 'no-track';
      if (this.loadState !== 'ready') return this.loadState;
      if (!this.speakerEnabled) return 'speaker-off';
      const pb = this.playback;
      if (!pb || pb.status === 'stopped') return 'ready';
      if (pb.status === 'paused') return 'paused';
      if (this.ended) return 'ended';
      if (!this.active) return 'waiting';
      return this.ctx && this.clockMapping().contextTime < this.active.ctxStart ? 'scheduled' : 'playing';
    }

    /**
     * Sync state, from this device's own measurements:
     *   SYNCED     playing, smoothed error within the profile's tolerance
     *   DRIFTING   playing, outside tolerance, being corrected by rate
     *   RESYNCING  restarting / just (re)joined / error beyond the resync limit
     *   READY      loaded and able to play, not playing
     * (CONNECTING / CALIBRATING / DISCONNECTED are decided by the page.)
     */
    syncState() {
      const pb = this.playback;
      const playing = pb && pb.status === 'playing' && !this.ended;
      if (!playing) return 'READY';
      if (!this.active) return 'RESYNCING';
      const sinceStart = (performance.now() - this.startedAt) / 1000;
      const started = this.ctx && this.clockMapping().contextTime >= this.active.ctxStart;
      if (!started) return this.active.late ? 'RESYNCING' : 'READY';
      const e = this.correction.errorMs;
      if (e == null || sinceStart < SETTLE_S) return this.active.late ? 'RESYNCING' : 'SYNCED';
      if (Math.abs(e) <= this.controller.p.syncedMs) return 'SYNCED';
      if (Math.abs(e) > this.controller.p.resyncMs) return 'RESYNCING';
      return 'DRIFTING';
    }
  }

  /**
   * Status report sent to the server once a second (Master diagnostics + CSV log).
   * @param {LiveReceiver} [liveReceiver]  pass it while live mode is on
   */
  function buildStatus(clock, player, liveReceiver) {
    const s = player.status();
    const status = {
      reportedAt: clock.ready ? clock.masterNow() : null, // lets the Master line up positions in time
      state: player.stateName(),
      syncState: player.syncState(),
      speakerEnabled: player.speakerEnabled,
      trackId: player.track ? player.track.id : null,
      loadProgress: player.loadProgress,
      position: s.position,
      duration: s.duration,
      offsetMs: clock.ready ? clock.offset : null,
      rttMs: clock.medianRtt,
      bestRttMs: clock.bestRtt,
      clockUncertaintyMs: clock.uncertaintyMs,
      clockSamples: clock.samples.length,
      lastSyncAgeMs: clock.lastSampleAt ? localNow() - clock.lastSampleAt : null,
      clockDriftPpm: clock.driftPpm,
      playbackDriftMs: s.playbackDriftMs,
      smoothedDriftMs: player.active ? player.correction.errorMs : null,
      correctionRate: player.active ? player.active.rate : null,
      correctionZone: player.active ? player.correction.zone : null,
      skewBiasPpm: player.controller.bias * 1e6,
      resyncs: player.resyncs,
      outputLatencyMs: s.outputLatencyMs,
      timingMethod: s.timingMethod,
      calibrationMs: player.calibrationMs,
      manualTrimMs: player.manualTrimMs,
      trimMs: player.trimMs,
      error: player.error,
    };
    if (liveReceiver) {
      const l = liveReceiver.status();
      status.state = !player.speakerEnabled ? 'speaker-off' : l.receiving ? 'live' : 'live-waiting';
      status.position = null;
      status.playbackDriftMs = l.driftMs;
      status.smoothedDriftMs = l.driftMs;
      status.correctionRate = l.rate;
      status.correctionZone = 'live';
      status.timingMethod = player.ctx ? player.clockMapping().method : null;
      status.liveBufferMs = l.bufferMs;
      status.liveLate = l.late;
      status.liveResyncs = l.resyncs;
      const tol = player.controller.p.syncedMs;
      status.syncState = !l.receiving ? 'READY' : l.driftMs != null && Math.abs(l.driftMs) > tol ? 'DRIFTING' : 'SYNCED';
      status.error = null;
    }
    return status;
  }

  /** Coalesce many state-change notifications into one render per frame. */
  function renderScheduler(fn) {
    let pending = false;
    return () => {
      if (pending) return;
      pending = true;
      const run = () => {
        if (!pending) return;
        pending = false;
        fn();
      };
      // Whichever comes first: a frame, or a timer (frames never arrive for
      // pages that aren't painted, even when they claim to be visible).
      requestAnimationFrame(run);
      setTimeout(run, 120);
    };
  }

  root.SyncWave = Object.assign(root.SyncWave || {}, {
    localNow, formatTime, randomId, median, decodeAudio, buildStatus, renderScheduler, wrapCentered,
    Connection, ClockSync, DriftController, SyncedPlayer, SYNC_PROFILES,
  });
})();
