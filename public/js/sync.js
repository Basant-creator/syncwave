/*
 * sync.js — shared by the Master page and the Client (phone) page.
 *
 *   Connection    WebSocket with automatic reconnect.
 *   ClockSync     Estimates (master clock − this device's clock) with NTP-style pings.
 *   SyncedPlayer  Decodes the track with Web Audio and starts it at a scheduled
 *                 master-clock time, converting that time into the AudioContext's
 *                 own clock so the sample hits the speaker at the right moment.
 *
 * Time domains used below (all in milliseconds unless stated):
 *   "master time"  The Node server's clock on the laptop (see server/syncEngine.js).
 *   "local time"   This browser's clock: performance.timeOrigin + performance.now().
 *                  Monotonic, sub-millisecond, but its zero point and rate differ
 *                  slightly from every other device.
 *   "context time" AudioContext time in SECONDS, driven by the sound card's crystal.
 *                  It is what AudioBufferSourceNode.start() is scheduled against.
 *
 * The chain for "play track position P at master time T" is:
 *   master time T  ──(− clock offset)──▶  local time  ──(output timestamp)──▶  context time
 */
(function () {
  'use strict';

  /** Local clock in epoch ms (monotonic while the page is open). */
  const localNow = () => performance.timeOrigin + performance.now();

  function formatTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
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
      // Phones often drop the socket when the screen locks; reconnect as soon as the page is visible.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && !this.isOpen) this.connectNow();
      });
    }

    get isOpen() {
      return !!this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    connect() {
      if (this.stopped) return;
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.binaryType = 'arraybuffer';
      this.ws = ws;
      ws.onopen = () => {
        this.retryMs = 500;
        this.onOpen && this.onOpen();
      };
      ws.onmessage = (ev) => {
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
      this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 5000);
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
  // Classic NTP exchange over the WebSocket:
  //
  //   device  t0 ──── {sync, t0} ────▶ t1  server
  //   device  t3 ◀── {t0, t1, t2} ──── t2  server
  //
  //   round trip   rtt    = (t3 − t0) − (t2 − t1)
  //   clock offset offset = ((t1 − t0) + (t2 − t3)) / 2       (= master − local)
  //
  // The offset formula assumes the trip out and the trip back took equally long.
  // Any asymmetry shows up as error, bounded by rtt/2. Wi-Fi latency is spiky
  // (power saving, retransmits), so we take many samples and trust only those
  // with the lowest round-trip time: a fast round trip leaves little room for
  // asymmetry. The offset is the median of the best quarter of recent samples.
  //
  // Clock drift (the two crystals ticking at slightly different rates) is
  // estimated as the slope of offset vs. time, in parts per million. This
  // version only *reports* it; continuous correction is the next phase.

  const SYNC_WINDOW_MS = 60000;   // samples older than this are discarded
  const BURST_COUNT = 15;         // quick burst on (re)connect to converge fast
  const BURST_SPACING_MS = 60;
  const STEADY_INTERVAL_MS = 1000;

  class ClockSync {
    constructor(send) {
      this.send = send;
      this.samples = [];
      this.offset = 0;          // master − local, ms
      this.bestRtt = null;      // lowest recent round trip, ms
      this.medianRtt = null;
      this.driftPpm = null;
      this.timer = null;
    }

    get ready() {
      return this.samples.length >= 5;
    }

    /** Upper bound on the offset error, from the best round trip. */
    get uncertaintyMs() {
      return this.bestRtt == null ? null : this.bestRtt / 2;
    }

    start() {
      this.stop();
      let burst = BURST_COUNT;
      const tick = () => {
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
      const t3 = localNow();
      const rtt = (t3 - t0) - (t2 - t1);
      if (!(rtt >= 0 && rtt < 3000)) return;
      const offset = ((t1 - t0) + (t2 - t3)) / 2;
      this.samples.push({ t: t3, offset, rtt });
      const cutoff = t3 - SYNC_WINDOW_MS;
      while (this.samples.length && this.samples[0].t < cutoff) this.samples.shift();
      this.recompute();
    }

    recompute() {
      const byRtt = [...this.samples].sort((a, b) => a.rtt - b.rtt);
      const best = byRtt.slice(0, Math.max(3, Math.ceil(byRtt.length * 0.25)));
      this.offset = median(best.map((s) => s.offset));
      this.bestRtt = byRtt[0].rtt;
      this.medianRtt = median(byRtt.map((s) => s.rtt));
      this.driftPpm = this.estimateDrift();
    }

    /** Least-squares slope of offset over time using only low-latency samples. */
    estimateDrift() {
      const good = this.samples.filter((s) => s.rtt <= this.bestRtt * 1.5 + 4);
      if (good.length < 8 || good[good.length - 1].t - good[0].t < 20000) return null;
      const n = good.length;
      const mt = good.reduce((a, s) => a + s.t, 0) / n;
      const mo = good.reduce((a, s) => a + s.offset, 0) / n;
      let num = 0;
      let den = 0;
      for (const s of good) {
        num += (s.t - mt) * (s.offset - mo);
        den += (s.t - mt) ** 2;
      }
      return den > 0 ? (num / den) * 1e6 : null;
    }

    /** Current master-clock time as seen from this device. */
    masterNow() {
      return localNow() + this.offset;
    }

    toLocal(masterMs) {
      return masterMs - this.offset;
    }

    toMaster(localMs) {
      return localMs + this.offset;
    }
  }

  // ─── Scheduled audio playback ─────────────────────────────────────────────

  /** How long we need between "decide to start" and the first sample (late joins). */
  const LATE_START_PREP_MS = 400;

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

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  class SyncedPlayer {
    /**
     * @param {ClockSync} clock
     * @param {() => void} onChange  called whenever the visible state changes
     * @param {{outputChain?: (ctx: AudioContext, output: AudioNode) => AudioNode}} [options]
     *        outputChain lets a page insert audio processing (e.g. the spatial
     *        renderer) between the scheduled sources and the speaker. It
     *        returns the node that sources should connect to. The player itself
     *        knows nothing about what that processing does.
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
      this.active = null;        // the currently scheduled/playing source
      this.ended = false;
      this.trimMs = 0;           // manual per-device latency trim (+ = play later)
      this.muted = false;
      this.silentAudio = null;
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
      this.ctx.onstatechange = () => {
        const running = this.ctx.state === 'running';
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
      this.onChange();
      await this.decodePending();
      this.resync();
    }

    setMuted(muted) {
      this.muted = muted;
      if (this.gain) this.gain.gain.value = muted ? 0 : 1;
    }

    setTrim(ms) {
      this.trimMs = Math.max(-1000, Math.min(1000, Math.round(ms) || 0));
      this.resync();
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
     * audio output latency. If unavailable or implausible, fall back to
     * currentTime minus the reported latency.
     */
    clockMapping() {
      const ctx = this.ctx;
      if (typeof ctx.getOutputTimestamp === 'function') {
        const ts = ctx.getOutputTimestamp();
        if (ts && ts.contextTime > 0 && ts.performanceTime > 0 &&
            Math.abs(performance.now() - ts.performanceTime) < 500) {
          return { contextTime: ts.contextTime, performanceTime: ts.performanceTime, method: 'outputTimestamp' };
        }
      }
      const latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      return { contextTime: ctx.currentTime - latency, performanceTime: performance.now(), method: 'currentTime' };
    }

    /** Convert a master-clock time (ms) to AudioContext time (s). */
    masterToContextTime(masterMs, map) {
      const localPerfMs = this.clock.toLocal(masterMs) - performance.timeOrigin;
      return map.contextTime + (localPerfMs - map.performanceTime) / 1000;
    }

    // ── Scheduling ──

    /** Apply a playback state broadcast by the server. */
    applyPlayback(playback) {
      const changed = !this.playback || this.playback.seq !== playback.seq;
      this.playback = playback;
      if (changed) {
        // A new command replaces whatever was scheduled before.
        this.ended = false;
        this.stopSource();
      }
      // Same command re-sent (e.g. after a reconnect): resync() is a no-op if
      // it is already playing, and starts late-joining if it isn't.
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

    /**
     * ★ The synchronized start.
     *
     * The server said: "track position pb.position is heard at master time
     * pb.startAt". We convert startAt into this device's AudioContext time and
     * ask Web Audio to start the buffer exactly then — sample-accurate on the
     * audio clock, independent of JavaScript timer jitter.
     *
     * If we're late (joined mid-song, reconnected, slow decode) we pick a start
     * time a little in the future and advance the track position by the same
     * amount, so we still land in step with everyone else.
     */
    startScheduled(pb) {
      const ctx = this.ctx;
      const buffer = this.decoded.buffer;
      const now = this.clock.masterNow();

      let startMaster = pb.startAt;
      let late = false;
      if (startMaster < now + LATE_START_PREP_MS / 2) {
        startMaster = now + LATE_START_PREP_MS;
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
      if (offsetSec >= buffer.duration) {
        this.ended = true;
        this.onChange();
        return;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.input);
      source.onended = () => {
        if (this.active && this.active.source === source) {
          this.active = null;
          this.ended = true;
          this.onChange();
        }
      };
      source.start(when, offsetSec);
      this.active = { source, seq: pb.seq, ctxStart: when, offsetSec, trimMs: this.trimMs, late, method: map.method };
      this.onChange();
    }

    /**
     * Schedule a one-off buffer (e.g. the spatial test signal) to start at a
     * master-clock time — the same timing path as track playback.
     * @returns {{source: AudioBufferSourceNode, when: number} | null}  null if
     *          the speaker isn't enabled or the start time has already passed.
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
      if (!this.active) return;
      const { source } = this.active;
      this.active = null;
      source.onended = null;
      try { source.stop(); } catch { /* not started */ }
      source.disconnect();
    }

    // ── Diagnostics ──

    /**
     * What is audible right now vs. what should be audible according to the
     * master clock. The difference is the *playback drift*: it starts near 0
     * and grows as this device's audio clock and system clock run at slightly
     * different rates, or as the clock-offset estimate improves. (It cannot
     * see latency the browser doesn't report, e.g. Bluetooth speakers.)
     */
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
        const map = this.clockMapping();
        out.timingMethod = map.method;
        const heard = this.active.offsetSec + (map.contextTime - this.active.ctxStart);
        if (heard < this.active.offsetSec) {
          out.position = this.active.offsetSec;
          out.startsInMs = (this.active.ctxStart - map.contextTime) * 1000;
        } else {
          // `heard` is the position at map.performanceTime, which can be a few ms
          // old; report the position audible right now so devices compare fairly.
          out.position = heard + (performance.now() - map.performanceTime) / 1000;
          const masterAtMap = this.clock.toMaster(performance.timeOrigin + map.performanceTime);
          const expected = pb.position + (masterAtMap - pb.startAt - this.active.trimMs) / 1000;
          out.playbackDriftMs = (heard - expected) * 1000;
        }
      } else if (pb) {
        out.position = pb.status === 'playing' ? null : pb.position;
      }
      return out;
    }

    /** Coarse state name for the UI/diagnostics. */
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
      const s = this.status();
      return s.startsInMs != null ? 'scheduled' : 'playing';
    }
  }

  /** Status report sent to the server once a second (shown in the Master's diagnostics). */
  /**
   * @param {LiveReceiver} [liveReceiver]  pass it while live mode is on
   */
  function buildStatus(clock, player, liveReceiver) {
    const s = player.status();
    const status = {
      reportedAt: clock.ready ? clock.masterNow() : null, // lets the Master line up positions in time
      state: player.stateName(),
      speakerEnabled: player.speakerEnabled,
      trackId: player.track ? player.track.id : null,
      loadProgress: player.loadProgress,
      position: s.position,
      duration: s.duration,
      offsetMs: clock.ready ? clock.offset : null,
      rttMs: clock.medianRtt,
      clockDriftPpm: clock.driftPpm,
      playbackDriftMs: s.playbackDriftMs,
      outputLatencyMs: s.outputLatencyMs,
      timingMethod: s.timingMethod,
      trimMs: player.trimMs,
      error: player.error,
    };
    if (liveReceiver) {
      const l = liveReceiver.status();
      status.state = !player.speakerEnabled ? 'speaker-off' : l.receiving ? 'live' : 'live-waiting';
      status.position = null;
      status.playbackDriftMs = l.driftMs;
      status.timingMethod = player.ctx ? player.clockMapping().method : null;
      status.liveBufferMs = l.bufferMs;
      status.liveLate = l.late;
      status.liveResyncs = l.resyncs;
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
      const run = () => { pending = false; fn(); };
      if (document.visibilityState === 'visible') requestAnimationFrame(run);
      else setTimeout(run, 100);
    };
  }

  window.SyncWave = {
    localNow, formatTime, randomId, decodeAudio, buildStatus, renderScheduler,
    Connection, ClockSync, SyncedPlayer,
  };
})();
