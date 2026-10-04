/*
 * movie.js — 🎬 Movie Sync.
 *
 * Music Sync starts every device at a scheduled moment on the server clock.
 * That is not enough for a movie: the picture runs on the laptop's video
 * pipeline (its own clock, its own start-up delay), so audio has to follow
 * the *video's* timeline, not the time a PLAY message arrived.
 *
 *   MasterVideoClock   (laptop) watches the <video> with
 *                      requestVideoFrameCallback: for every frame it gets the
 *                      exact media time and when that frame reaches the screen.
 *                      From that it publishes anchors:
 *                        "frame `videoTime` is on screen at master time `masterTime`,
 *                         advancing at `rate`"
 *   MovieAudioPlayer   (every device, the laptop included) plays the movie's
 *                      extracted audio so that media position p is HEARD at
 *                         masterTime + (p − videoTime)/rate + offset,
 *                      offset = this device's latency compensation + global lip-sync.
 *
 * The laptop's own movie audio goes through the same MovieAudioPlayer (the
 * <video> element is muted), so laptop and phone speakers can't drift apart
 * from each other; any remaining picture-vs-sound offset is common to all of
 * them and fixed with one lip-sync control.
 *
 * Audio delivery: the extracted track is raw 16-bit stereo PCM on the server.
 * Clients fetch 4 s blocks around the playhead with HTTP Range requests (≈45 s
 * ahead), turn them into 0.25 s AudioBuffers and schedule those back-to-back
 * on the Web Audio clock, ≈0.6 s ahead. Nothing is downloaded at PLAY time
 * beyond what's already buffered, and memory stays small for 2-hour movies.
 */
(function () {
  'use strict';

  const root = typeof window !== 'undefined' ? window : globalThis;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const median = (v) => {
    if (!v.length) return NaN;
    const s = [...v].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // ─── Timeline math (pure; unit-tested) ────────────────────────────────────

  /**
   * Movie position that should be audible from this device at master time t.
   * offsetMs > 0 means this device plays later (its compensation shifts it).
   */
  function expectedPosition(clock, masterMs, offsetMs = 0) {
    if (!clock) return 0;
    if (!clock.playing) return clock.videoTime;
    return clock.videoTime + ((masterMs - offsetMs - clock.masterTime) / 1000) * clock.rate;
  }

  /** Master time at which `pos` should be audible from this device. */
  function masterTimeForPosition(clock, pos, offsetMs = 0) {
    return clock.masterTime + ((pos - clock.videoTime) / clock.rate) * 1000 + offsetMs;
  }

  /**
   * Anchor from recent video frames: [{ mediaTime (s), masterTime (ms) }].
   * With the rate known, each frame predicts the media time at tRef; the
   * median of those predictions rejects frames with late/odd timestamps.
   */
  function fitAnchor(frames, rate) {
    if (!frames.length) return null;
    const tRef = frames[frames.length - 1].masterTime;
    const v = median(frames.map((f) => f.mediaTime + ((tRef - f.masterTime) / 1000) * rate));
    return { videoTime: v, masterTime: tRef };
  }

  /**
   * setInterval that keeps ticking in background tabs. Main-thread timers are
   * throttled to ~1/s when a page is hidden (minimised laptop window, phone
   * app switch), which is too slow to keep 0.6 s of audio scheduled. Timers
   * in a dedicated worker aren't throttled that way.
   */
  function steadyInterval(fn, ms) {
    try {
      const src = `setInterval(() => postMessage(0), ${ms});`;
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = fn;
      return { stop: () => w.terminate() };
    } catch {
      const id = setInterval(fn, ms);
      return { stop: () => clearInterval(id) };
    }
  }

  // ─── Movie audio player (all devices) ─────────────────────────────────────

  const BLOCK_S = 4;            // HTTP fetch unit
  const PIECE_S = 0.25;         // Web Audio scheduling unit
  const LOOKAHEAD_S = 0.6;      // keep this much scheduled ahead
  const PREFETCH_S = 45;        // keep this much downloaded ahead
  const KEEP_BEHIND_S = 6;
  const READY_AHEAD_S = 8;      // "ready" = this much buffered at the cue point
  const START_PREP_MS = 350;    // lead for a (re)start that isn't planned in advance
  const STARTUP_WINDOW_MS = 3000;
  const STARTUP_RESYNC_MS = 35; // right after a start, re-align at once instead of slewing

  class MovieAudioPlayer {
    /**
     * @param {SyncWave.SyncedPlayer} player  provides the AudioContext, output, clock and latency offsets
     */
    constructor(player, { onChange } = {}) {
      this.player = player;
      this.onChange = onChange || (() => {});
      this.movie = null;
      this.clock = null;
      this.fineMs = 0;              // per-device manual fine offset (movie only)
      this.blocks = new Map();      // block index → Int16Array | 'loading'
      this.fetching = 0;
      this.pieces = [];             // scheduled: { src, ctxStart, ctxEnd, pos, rate }
      this.sched = null;            // { nextCtx, nextFrame, rate, ended }
      this.controller = new root.SyncWave.DriftController('movie');
      this.correction = { rate: 1, zone: 'idle', errorMs: null, rawErrorMs: null, expectedPos: null, heardPos: null };
      this.resyncs = 0;
      this.underruns = 0;
      this.blindTicks = 0;
      this.startedAt = 0;
      this.startupDone = false;
      this.waitingForData = false;
      this.active = false;          // Movie Sync is the current source
      this.timer = steadyInterval(() => this.tick(), 100);
      this.driftTimer = steadyInterval(() => this.driftTick(), 250);
    }

    get sampleRate() { return this.movie ? this.movie.sampleRate : 48000; }
    get blockFrames() { return BLOCK_S * this.sampleRate; }

    /** Total shift applied to this device: automatic calibration + fine offset + global lip-sync. */
    get offsetMs() {
      return (this.player.calibrationMs || 0) + this.fineMs + (this.clock ? this.clock.avOffsetMs || 0 : 0);
    }

    setActive(on) {
      this.active = !!on;
      if (!this.active) this.flush();
      this.onChange();
    }

    setMovie(movie) {
      if (!movie) {
        this.flush();
        this.movie = null;
        this.blocks.clear();
        this.onChange();
        return;
      }
      if (!this.movie || this.movie.id !== movie.id) {
        this.flush();
        this.blocks.clear();
      }
      this.movie = { ...movie };
      this.onChange();
    }

    setFineOffset(ms) {
      this.fineMs = clamp(Math.round(ms), -100, 100);
      this.onChange();
    }

    /**
     * Apply a movie-clock update. A new epoch (play / pause / seek / rate) is a
     * fresh timeline: drop the schedule and start again. The same epoch just
     * refines the anchor; the drift loop absorbs the difference.
     */
    setClock(clock) {
      const newEpoch = !this.clock || clock.epoch !== this.clock.epoch;
      const prev = this.clock;
      this.clock = { ...clock };
      if (newEpoch) {
        if (!clock.playing && prev && prev.playing) this.stopAt(clock.masterTime);
        else this.flush();
        this.controller.reset();
        this.startupDone = false;
        if (clock.playing) this.restart();
      } else if (clock.playing && !this.sched) {
        this.restart();
      }
      this.onChange();
    }

    canPlay() {
      return this.active && this.movie && this.clock && this.clock.playing && this.player.speakerEnabled;
    }

    /** Stop everything (pause at a planned master time if given). */
    stopAt(masterMs) {
      const ctx = this.player.ctx;
      if (ctx && masterMs != null) {
        const stopCtx = this.player.masterToContextTime(masterMs + this.offsetMs, this.player.clockMapping());
        for (const p of this.pieces) {
          try { if (p.ctxStart >= stopCtx - 0.005) p.src.stop(); else p.src.stop(Math.max(stopCtx, ctx.currentTime)); } catch { /* ended */ }
        }
        this.pieces = [];
        this.sched = null;
        return;
      }
      this.flush();
    }

    flush() {
      for (const p of this.pieces) {
        p.src.onended = null;
        try { p.src.stop(); } catch { /* not started */ }
        p.src.disconnect();
      }
      this.pieces = [];
      this.sched = null;
      this.waitingForData = false;
    }

    /**
     * ★ (Re)start on the current timeline. A planned start (play / resume /
     * seek: masterTime in the future) begins exactly at the cue point; a late
     * start (joined mid-movie, reconnected, resync) begins START_PREP_MS from
     * now at the position the timeline will have reached by then.
     */
    restart() {
      this.flush();
      if (!this.canPlay()) return;
      const clock = this.clock;
      const off = this.offsetMs;
      const now = this.player.clock.masterNow();
      const plannedAt = masterTimeForPosition(clock, clock.videoTime, off);
      const startMaster = Math.max(now + START_PREP_MS, plannedAt);
      let pos = expectedPosition(clock, startMaster, off);
      if (pos < 0) pos = 0;
      if (pos >= this.movie.duration) return;
      let frame = Math.round(pos * this.sampleRate);
      if (!this.hasFrames(frame, Math.round(PIECE_S * this.sampleRate))) {
        this.waitingForData = true;     // fetch first; tick() calls restart() again
        this.onChange();
        return;
      }
      const ctx = this.player.ctx;
      const map = this.player.clockMapping();
      let when = this.player.masterToContextTime(masterTimeForPosition(clock, frame / this.sampleRate, off), map);
      const earliest = ctx.currentTime + 0.02;
      if (when < earliest) {
        frame += Math.ceil((earliest - when) * clock.rate * this.sampleRate);
        when = this.player.masterToContextTime(masterTimeForPosition(clock, frame / this.sampleRate, off), map);
      }
      this.sched = { nextCtx: when, nextFrame: frame, rate: clock.rate * this.controller.rate, ended: false };
      this.startedAt = performance.now();
      this.waitingForData = false;
      this.pump();
      this.onChange();
    }

    hasFrames(frame, n) {
      const bf = this.blockFrames;
      for (let b = Math.floor(frame / bf); b <= Math.floor((frame + n - 1) / bf); b++) {
        const blk = this.blocks.get(b);
        if (!(blk instanceof Int16Array)) return false;
      }
      return true;
    }

    /** Build a stereo AudioBuffer for frames [frame, frame + n) from the downloaded blocks. */
    makePiece(frame, n) {
      if (!this.hasFrames(frame, n)) return null;
      const ctx = this.player.ctx;
      const buf = ctx.createBuffer(2, n, this.sampleRate);
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      const bf = this.blockFrames;
      for (let i = 0; i < n;) {
        const f = frame + i;
        const b = Math.floor(f / bf);
        const blk = this.blocks.get(b);
        const start = f - b * bf;
        const count = Math.min(n - i, bf - start, blk.length / 2 - start);
        if (count <= 0) return null;
        for (let k = 0; k < count; k++) {
          L[i + k] = blk[(start + k) * 2] / 32768;
          R[i + k] = blk[(start + k) * 2 + 1] / 32768;
        }
        i += count;
      }
      return buf;
    }

    /** Keep ~LOOKAHEAD_S of pieces scheduled back-to-back. */
    pump() {
      const s = this.sched;
      const ctx = this.player.ctx;
      if (ctx) while (this.pieces.length && this.pieces[0].ctxEnd < ctx.currentTime - 1) this.pieces.shift();
      if (!s || s.ended) return;
      const total = Math.floor(this.movie.duration * this.sampleRate);
      while (s.nextCtx - ctx.currentTime < LOOKAHEAD_S) {
        if (s.nextFrame >= total) { s.ended = true; break; }
        if (s.nextCtx < ctx.currentTime + 0.005) {
          // The page stalled longer than the lookahead: the next piece's slot has
          // already passed. Don't play it late (that would shift everything);
          // re-join the timeline cleanly instead.
          this.underruns++;
          this.restart();
          return;
        }
        const n = Math.min(Math.round(PIECE_S * this.sampleRate), total - s.nextFrame);
        const buf = this.makePiece(s.nextFrame, n);
        if (!buf) {
          // Data didn't arrive in time: stop here, restart on the timeline when it does.
          this.underruns++;
          this.waitingForData = true;
          this.sched = null;
          this.onChange();
          return;
        }
        const src = ctx.createBufferSource();
        src.buffer = buf;
        src.playbackRate.value = s.rate;
        src.connect(this.player.input);
        src.start(s.nextCtx);
        const piece = { src, ctxStart: s.nextCtx, ctxEnd: s.nextCtx + n / this.sampleRate / s.rate, pos: s.nextFrame / this.sampleRate, rate: s.rate };
        // Keep the piece in the list after it has been *rendered*: the speaker
        // plays it ~outputLatency later, and heardAt() must still find it then.
        // (Removing it on 'ended' made ~20 % of drift measurements miss — and
        // phase-locked with the 250 ms drift tick, the controller went blind
        // for seconds and overshot.) Old pieces are pruned below instead.
        src.onended = () => src.disconnect();
        this.pieces.push(piece);
        s.nextCtx = piece.ctxEnd;
        s.nextFrame += n;
      }
    }

    /** Movie position audible at context time c (null if nothing is playing then). */
    heardAt(c) {
      for (const p of this.pieces) {
        if (c >= p.ctxStart && c < p.ctxEnd) return p.pos + (c - p.ctxStart) * p.rate;
      }
      return null;
    }

    tick() {
      if (!this.movie || !this.active || !this.player.ctx) return;
      this.fetchAround();
      if (this.canPlay()) {
        if (!this.sched && (this.waitingForData || this.clock.playing)) {
          const pos = expectedPosition(this.clock, this.player.clock.masterNow() + START_PREP_MS, this.offsetMs);
          if (this.hasFrames(Math.round(Math.max(0, pos) * this.sampleRate), Math.round(PIECE_S * this.sampleRate))) this.restart();
        }
        this.pump();
      }
    }

    /** Position to buffer around: what we're playing, or the cue point. */
    focusPosition() {
      if (!this.clock) return 0;
      return Math.max(0, expectedPosition(this.clock, this.player.clock.masterNow(), this.offsetMs));
    }

    fetchAround() {
      const sr = this.sampleRate;
      const bf = this.blockFrames;
      const pos = this.focusPosition();
      const ready = this.movie.readyFrames;
      const first = Math.max(0, Math.floor((pos - KEEP_BEHIND_S) * sr / bf));
      const last = Math.floor(Math.min((pos + PREFETCH_S) * sr, ready - 1) / bf);
      for (const b of this.blocks.keys()) if (b < first || b > last + 1) this.blocks.delete(b);
      for (let b = Math.floor(pos * sr / bf); b <= last && this.fetching < 2; b++) {
        if (this.blocks.has(b)) continue;
        const startF = b * bf;
        const endF = Math.min(startF + bf, ready);
        // Only fetch complete blocks (or the final partial one once extraction is done).
        if (endF - startF < bf && this.movie.status !== 'ready') break;
        if (endF <= startF) break;
        this.fetchBlock(b, startF, endF);
      }
      // Earlier blocks needed for a just-behind start.
      const b0 = Math.floor(pos * sr / bf);
      if (b0 - 1 >= first && !this.blocks.has(b0 - 1) && this.fetching < 2 && b0 - 1 >= 0) {
        this.fetchBlock(b0 - 1, (b0 - 1) * bf, Math.min(b0 * bf, ready));
      }
    }

    async fetchBlock(b, startF, endF) {
      this.blocks.set(b, 'loading');
      this.fetching++;
      const movieId = this.movie.id;
      try {
        const res = await fetch(this.movie.url, { headers: { Range: `bytes=${startF * 4}-${endF * 4 - 1}` }, cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = new Int16Array(await res.arrayBuffer());
        if (!this.movie || this.movie.id !== movieId) return;
        this.blocks.set(b, data);
      } catch {
        this.blocks.delete(b);
      } finally {
        this.fetching--;
        this.onChange();
      }
    }

    /** Seconds of audio downloaded contiguously from the current focus position. */
    bufferedAhead() {
      if (!this.movie) return 0;
      const sr = this.sampleRate;
      const bf = this.blockFrames;
      const pos = this.focusPosition();
      let b = Math.floor(pos * sr / bf);
      let end = pos;
      while (this.blocks.get(b) instanceof Int16Array) {
        end = (b * bf + this.blocks.get(b).length / 2) / sr;
        b++;
      }
      return Math.max(0, end - pos);
    }

    /**
     * ★ Drift loop, 4×/s. error = position audible now − position the
     * master video timeline (+ this device's offset) says should be audible.
     * Same controller as Music Sync, with Movie tolerances. Rate changes apply
     * to the next pieces (≤ 0.6 s later; stable per simulation).
     */
    driftTick() {
      const s = this.sched;
      if (!s || !this.clock || !this.clock.playing || !this.player.ctx) return;
      const map = this.player.clockMapping();
      const heard = this.heardAt(map.contextTime);
      if (heard == null) {
        // Safety net: never keep steering blind. After ~1 s without a
        // measurement, go back to the neutral rate.
        if (++this.blindTicks >= 4) s.rate = this.clock.rate * (1 - this.controller.bias);
        return;
      }
      this.blindTicks = 0;
      const masterAtMap = this.player.clock.toMaster(performance.timeOrigin + map.performanceTime);
      const expected = expectedPosition(this.clock, masterAtMap, this.offsetMs);
      const errMs = (heard - expected) * 1000;
      this.correction.rawErrorMs = errMs;
      this.correction.expectedPos = expected;
      this.correction.heardPos = heard;

      // Right after a start the first anchors from the real video can differ from
      // the plan by tens of ms: re-align once, immediately, rather than slewing.
      if (!this.startupDone && performance.now() - this.startedAt < STARTUP_WINDOW_MS) {
        if (Math.abs(errMs) > STARTUP_RESYNC_MS) {
          this.startupDone = true;
          this.resyncs++;
          this.controller.reset();
          this.restart();
          return;
        }
      } else {
        this.startupDone = true;
      }

      const r = this.controller.update(errMs, performance.now() / 1000);
      this.correction.rate = r.rate;
      this.correction.zone = r.zone;
      this.correction.errorMs = r.errorMs;
      if (r.action === 'resync') {
        this.resyncs++;
        this.restart();
        return;
      }
      s.rate = this.clock.rate * r.rate;
    }

    state() {
      if (!this.movie) return 'no-movie';
      if (!this.player.speakerEnabled) return 'speaker-off';
      if (!this.clock || !this.clock.playing) {
        return this.bufferedAhead() >= Math.min(READY_AHEAD_S, this.movie.duration - this.focusPosition() - 0.1) ? 'ready' : 'loading';
      }
      if (this.sched && this.sched.ended && !this.pieces.length) return 'ended';
      if (this.waitingForData || !this.sched) return 'buffering';
      const map = this.player.clockMapping();
      return this.heardAt(map.contextTime) == null ? 'starting' : 'playing';
    }

    /** SYNCED / DRIFTING / RESYNCING / READY in the Movie tolerance. */
    syncState() {
      const st = this.state();
      if (st === 'buffering' || st === 'starting') return 'RESYNCING';
      if (st !== 'playing') return 'READY';
      const e = this.correction.errorMs;
      if (e == null || performance.now() - this.startedAt < 1500) return 'RESYNCING';
      const p = this.controller.p;
      if (Math.abs(e) <= p.syncedMs) return 'SYNCED';
      return Math.abs(e) > p.resyncMs ? 'RESYNCING' : 'DRIFTING';
    }

    status() {
      const st = this.state();
      const map = this.player.ctx ? this.player.clockMapping() : null;
      const heard = map ? this.heardAt(map.contextTime) : null;
      return {
        movieState: st,
        movieEpoch: this.clock ? this.clock.epoch : null,
        movieAudioPos: heard,
        movieExpectedPos: this.correction.expectedPos,
        movieErrorMs: st === 'playing' ? this.correction.rawErrorMs : null,
        movieSmoothedMs: st === 'playing' ? this.correction.errorMs : null,
        movieRate: this.sched ? this.sched.rate : null,
        movieZone: this.correction.zone,
        movieBufferS: this.bufferedAhead(),
        movieResyncs: this.resyncs,
        movieUnderruns: this.underruns,
        movieFineMs: this.fineMs,
      };
    }
  }

  // ─── Master video clock (laptop) ──────────────────────────────────────────

  const FRAME_WINDOW_MS = 2000;   // anchor = robust fit over the last 2 s of frames
  const ANCHOR_EVERY_MS = 1000;

  class MasterVideoClock {
    /**
     * @param {HTMLVideoElement} video
     * @param {SyncWave.ClockSync} clock
     * @param {(anchor: {videoTime: number, masterTime: number, rate: number, method: string}) => void} onAnchor
     */
    constructor(video, clock, onAnchor) {
      this.video = video;
      this.clock = clock;
      this.onAnchor = onAnchor;
      this.frames = [];
      this.lastSentAt = 0;
      this.hasRVFC = 'requestVideoFrameCallback' in HTMLVideoElement.prototype;
      this.method = this.hasRVFC ? 'rVFC' : 'currentTime';
      this.lastFrameInfo = null;
      this.lastRvfcAt = 0;
      if (this.hasRVFC) {
        const cb = (now, md) => {
          this.lastRvfcAt = performance.now();
          this.useMethod('rVFC');
          this.onFrame(md.mediaTime, md.expectedDisplayTime, md);
          this.video.requestVideoFrameCallback(cb);
        };
        this.video.requestVideoFrameCallback(cb);
      }
      // Frame callbacks only fire while the video is actually painted. If the
      // page is hidden/minimised (or the API is missing), follow the media
      // clock instead: nobody sees the picture then, and the sound must simply
      // keep following the video's position.
      setInterval(() => {
        if (this.video.paused || this.video.seeking) return;
        if (this.hasRVFC && performance.now() - this.lastRvfcAt < 500) return;
        this.useMethod(this.hasRVFC ? 'currentTime (not painted)' : 'currentTime');
        this.onFrame(this.video.currentTime, performance.now(), null);
      }, 50);
    }

    /** Switching measurement method: don't mix frames from both in one fit. */
    useMethod(m) {
      if (this.method === m) return;
      this.method = m;
      this.frames = [];
      this.lastSentAt = 0;
    }

    /** Forget frames from before a play / seek / rate change. */
    reset() {
      this.frames = [];
      this.lastSentAt = 0;
    }

    onFrame(mediaTime, displayPerfMs, md) {
      if (this.video.paused || this.video.seeking) return;
      const masterTime = this.clock.toMaster(performance.timeOrigin + displayPerfMs);
      this.frames.push({ mediaTime, masterTime });
      this.lastFrameInfo = { mediaTime, masterTime, presented: md ? md.presentedFrames : null };
      while (this.frames.length && masterTime - this.frames[0].masterTime > FRAME_WINDOW_MS) this.frames.shift();
      const now = performance.now();
      // First anchor quickly (after a few frames), then once a second.
      if ((this.lastSentAt === 0 && this.frames.length >= 4) || (this.lastSentAt && now - this.lastSentAt >= ANCHOR_EVERY_MS)) {
        this.lastSentAt = now;
        const a = this.anchor();
        if (a) this.onAnchor(a);
      }
    }

    anchor() {
      const rate = this.video.playbackRate || 1;
      const a = fitAnchor(this.frames, rate);
      return a ? { ...a, rate, method: this.method } : null;
    }

    /** Where the video is at master time t (for the diagnostics display). */
    positionAt(masterMs) {
      const a = this.anchor();
      if (!a || this.video.paused) return this.video.currentTime;
      return a.videoTime + ((masterMs - a.masterTime) / 1000) * a.rate;
    }
  }

  root.SyncWave = Object.assign(root.SyncWave || {}, {
    MovieAudioPlayer, MasterVideoClock,
    MovieMath: { expectedPosition, masterTimeForPosition, fitAnchor },
  });
})();
