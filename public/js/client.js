/*
 * client.js — the phone page (opened from the QR code at /join/ROOM).
 *
 * 1. Connects and joins the room with a persistent device id + device profile
 *    (last calibration, last clock offset) so a known phone starts from its
 *    previous estimates.
 * 2. Calibrates automatically: clock sync converges (software calibration);
 *    if the Master has microphone calibration on, it also measures this
 *    phone's real audible offset and sends a correction (acoustic calibration).
 * 3. Waits for "Enable Speaker" (required by mobile browsers before audio).
 * 4. Plays at the scheduled master-clock time, shifted by its latency offset,
 *    and keeps itself aligned with continuous drift correction (sync.js).
 */
(function () {
  'use strict';

  const {
    Connection, ClockSync, SyncedPlayer, LiveReceiver, decodeChunk,
    SpatialRenderer, SpatialTest, Calibration, MovieAudioPlayer,
    formatTime, randomId, buildStatus, renderScheduler,
  } = window.SyncWave;
  const $ = (id) => document.getElementById(id);

  const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '').toUpperCase();
  const devMode = new URLSearchParams(location.search).has('dev');

  // ── Persistent device profile (storage can be unavailable in private mode) ──

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  let clientId = store.get('syncwave.clientId');
  if (!clientId) {
    clientId = randomId(16);
    store.set('syncwave.clientId', clientId);
  }

  function defaultName() {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android phone';
    return 'Phone';
  }

  /**
   * { deviceId, deviceName, calibrationMs, calibratedAt, calibrationLatencyMs,
   *   lastClockOffsetMs, manualTrimMs }
   * Previous calibration is only an initial estimate: it is marked stale if
   * the browser now reports a clearly different output latency (other output
   * device, headphones, OS update…), and the Master recalibrates.
   */
  function loadProfile() {
    let p = {};
    try { p = JSON.parse(store.get('syncwave.profile')) || {}; } catch { p = {}; }
    if (p.manualTrimMs == null && store.get('syncwave.trimMs') != null) p.manualTrimMs = Number(store.get('syncwave.trimMs')) || 0;
    return {
      deviceId: clientId,
      deviceName: p.deviceName || store.get('syncwave.name') || defaultName(),
      calibrationMs: Number.isFinite(p.calibrationMs) ? p.calibrationMs : null,
      calibratedAt: p.calibratedAt || null,
      calibrationLatencyMs: Number.isFinite(p.calibrationLatencyMs) ? p.calibrationLatencyMs : null,
      lastClockOffsetMs: Number.isFinite(p.lastClockOffsetMs) ? p.lastClockOffsetMs : null,
      manualTrimMs: Number.isFinite(p.manualTrimMs) ? p.manualTrimMs : 0,
      movieFineMs: Number.isFinite(p.movieFineMs) ? p.movieFineMs : 0,
    };
  }
  const profile = loadProfile();
  function saveProfile() {
    store.set('syncwave.profile', JSON.stringify(profile));
  }

  // ── State ──

  let joined = false;
  let fatal = null;          // permanent error (room not found / closed)
  let masterOnline = true;
  let syncProfile = 'music';
  // 'none' | 'previous-session' | 'stale' | 'acoustic'
  let calibrationSource = profile.calibrationMs != null ? 'previous-session' : 'none';
  let probeUntil = 0;        // performance.now() until which an acoustic probe is running
  let latencyChecked = false;
  let rejoinedAt = 0;        // performance.now() of the last reconnect while playing

  const render = renderScheduler(renderAll);
  const conn = new Connection({ onOpen, onMessage, onBinary, onClose });
  const clock = new ClockSync((m) => conn.send(m));
  clock.seed(profile.lastClockOffsetMs);
  // Experimental spatial renderer: sits after the scheduled sources, gains only.
  let renderer = null;
  let spatialConfig = null;
  let testStartAt = null;
  const player = new SyncedPlayer(clock, render, {
    outputChain(ctx, output) {
      renderer = new SpatialRenderer(ctx, output);
      if (spatialConfig) renderer.applyRoomConfig(spatialConfig, clientId);
      return renderer.input;
    },
  });
  player.setLatencyOffset({ calibrationMs: profile.calibrationMs || 0, manualTrimMs: profile.manualTrimMs });

  function applySpatial(cfg) {
    if (!cfg) return;
    spatialConfig = cfg;
    if (renderer) renderer.applyRoomConfig(cfg, clientId);
    render();
    setTimeout(reportStatus, 100);
  }
  const receiver = new LiveReceiver(player);
  let liveActive = false;

  // 🎬 Movie Sync: plays the movie's sound locked to the laptop's video timeline.
  const movieAudio = new MovieAudioPlayer(player, { onChange: render });
  movieAudio.setFineOffset(profile.movieFineMs);
  let source = 'file';
  function setSource(s) {
    source = s || 'file';
    movieAudio.setActive(source === 'movie');
    $('movieOffsetCard').hidden = source !== 'movie';
    render();
  }

  function setLive(state) {
    const active = !!(state && state.active);
    if (active !== liveActive) receiver.reset();
    liveActive = active;
    render();
  }

  /** Live audio chunk from the laptop: schedule it at its stamped time. */
  function onBinary(buf) {
    if (!liveActive) return;
    const chunk = decodeChunk(buf);
    if (chunk) receiver.push(chunk);
  }

  function onOpen() {
    clock.start();
    conn.send({
      type: 'join', roomId, clientId, name: profile.deviceName,
      profile: {
        calibrationMs: profile.calibrationMs, calibratedAt: profile.calibratedAt,
        calibrationLatencyMs: profile.calibrationLatencyMs, lastClockOffsetMs: profile.lastClockOffsetMs,
        manualTrimMs: profile.manualTrimMs,
      },
    });
    render();
  }

  function onClose() {
    clock.stop();
    joined = false;
    render();
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'sync-reply':
        clock.handleReply(msg);
        break;
      case 'room':
        // On a reconnect the audio has kept playing locally. Re-applying the
        // room's playback state is a no-op if we're still on the same command
        // (drift correction takes care of any error); otherwise we late-join
        // at the current position. Nobody else is affected.
        if (player.playback && player.playback.status === 'playing') rejoinedAt = performance.now();
        joined = true;
        masterOnline = msg.masterOnline;
        if (msg.deviceName) profile.deviceName = msg.deviceName;
        $('nameInput').value = profile.deviceName;
        setSyncProfile(msg.syncProfile);
        player.setTrack(msg.track);
        player.applyPlayback(msg.playback);
        setLive(msg.live);
        applySpatial(msg.spatial);
        movieAudio.setMovie(msg.movie);
        if (msg.movieClock) movieAudio.setClock(msg.movieClock);
        setSource(msg.source);
        break;
      case 'source':
        setSource(msg.source);
        break;
      case 'movie':
        movieAudio.setMovie(msg.movie);
        break;
      case 'movie-clock':
        movieAudio.setClock(msg.clock);
        setTimeout(reportStatus, 150);
        break;
      case 'movie-fine':
        setMovieFine(msg.fineMs);
        break;
      case 'sync-profile':
        setSyncProfile(msg.profile);
        break;
      case 'probe': {
        // Acoustic calibration / sync test: play our chirps at the given master times.
        const times = msg.schedule && msg.schedule[clientId];
        if (times && times.length) {
          const n = Calibration.scheduleChirps(player, times);
          probeUntil = performance.now() + Math.max(0, Math.max(...times) - clock.masterNow()) + 800;
          if (n === 0) $('hint').textContent = 'Calibration beeps missed: tap Enable Speaker.';
        }
        render();
        break;
      }
      case 'calibration':
        applyCalibration(msg.adjustMs);
        break;
      case 'spatial':
        applySpatial(msg.spatial);
        break;
      case 'spatial-test':
        testStartAt = msg.startAt;
        if (!SpatialTest.schedule(player, renderer, msg.startAt)) {
          $('hint').textContent = 'Spatial test missed: tap Enable Speaker first.';
        }
        break;
      case 'live':
        setLive(msg.live);
        setTimeout(reportStatus, 100);
        break;
      case 'track':
        player.setTrack(msg.track);
        break;
      case 'playback':
        player.applyPlayback(msg.playback);
        setTimeout(reportStatus, 100); // let the Master's diagnostics catch up quickly
        break;
      case 'master-status':
        masterOnline = msg.online;
        render();
        break;
      case 'room-closed':
        stopForGood('The Master closed this room. Scan the new QR code on the laptop.');
        break;
      case 'error':
        if (msg.code === 'room-not-found') {
          stopForGood(`Room ${roomId} was not found. The laptop may have restarted — scan the QR code again.`);
        } else if (msg.code === 'room-full') {
          stopForGood('This room is full.');
        } else {
          $('hint').textContent = msg.message;
        }
        break;
    }
  }

  function setSyncProfile(name) {
    if (name !== 'music' && name !== 'movie') return;
    syncProfile = name;
    player.setSyncProfile(name);
    render();
  }

  /** Acoustic calibration result from the Master: shift our schedule by adjustMs. */
  function applyCalibration(adjustMs) {
    if (typeof adjustMs !== 'number' || !Number.isFinite(adjustMs)) return;
    const next = (profile.calibrationMs || 0) + adjustMs;
    profile.calibrationMs = Math.max(-500, Math.min(500, Math.round(next * 10) / 10));
    profile.calibratedAt = Date.now();
    profile.calibrationLatencyMs = player.status().outputLatencyMs;
    calibrationSource = 'acoustic';
    saveProfile();
    player.setLatencyOffset({ calibrationMs: profile.calibrationMs });
    setTimeout(reportStatus, 50);
    render();
  }

  /**
   * Software calibration check, once the speaker is on: if the browser now
   * reports a clearly different output latency than when we were calibrated,
   * the old acoustic correction probably doesn't apply any more.
   */
  function checkLatencyChange() {
    if (latencyChecked || !player.speakerEnabled) return;
    const lat = player.status().outputLatencyMs;
    if (lat == null) return;
    latencyChecked = true;
    if (calibrationSource === 'previous-session' && profile.calibrationLatencyMs != null &&
        Math.abs(lat - profile.calibrationLatencyMs) > 10) {
      calibrationSource = 'stale';
    }
  }

  function stopForGood(message) {
    fatal = message;
    conn.shutdown();
    clock.stop();
    player.clearTrack();
    render();
  }

  // ── User actions ──

  // Must run inside the tap handler: this is what browsers accept as permission to play audio.
  $('enableBtn').addEventListener('click', () => {
    player.enable().catch((e) => { $('hint').textContent = `Could not enable audio: ${e.message}`; });
    // Ask the screen to stay on while playing (only works on HTTPS; harmless otherwise).
    if (navigator.wakeLock) navigator.wakeLock.request('screen').catch(() => {});
  });

  $('nameInput').addEventListener('change', (e) => {
    profile.deviceName = e.target.value.trim().slice(0, 32) || defaultName();
    e.target.value = profile.deviceName;
    store.set('syncwave.name', profile.deviceName);
    saveProfile();
    conn.send({ type: 'rename', name: profile.deviceName });
  });

  document.querySelectorAll('[data-trim]').forEach((btn) => {
    btn.addEventListener('click', () => {
      profile.manualTrimMs = player.manualTrimMs + Number(btn.dataset.trim);
      player.setLatencyOffset({ manualTrimMs: profile.manualTrimMs });
      saveProfile();
      render();
    });
  });

  function setMovieFine(ms) {
    movieAudio.setFineOffset(ms);
    profile.movieFineMs = movieAudio.fineMs;
    saveProfile();
    $('movieFine').value = String(movieAudio.fineMs);
    setTimeout(reportStatus, 50);
    render();
  }
  $('movieFine').addEventListener('input', () => {
    const v = Number($('movieFine').value);
    $('movieFineText').textContent = `${v >= 0 ? '+' : ''}${v} ms`;
  });
  $('movieFine').addEventListener('change', () => setMovieFine(Number($('movieFine').value)));
  $('movieFine').value = String(profile.movieFineMs);

  if (devMode) {
    $('devTools').hidden = false;
    $('dropBtn').addEventListener('click', () => conn.simulateOutage(8000));
    $('skewBtn').addEventListener('click', () => {
      player.simulatedSkewPpm = Number($('skewInput').value) || 0;
      player.skewBase = null;
    });
  }

  // ── Sync state (what the Master shows for this device) ──

  function calibrating() {
    return !clock.converged || performance.now() < probeUntil;
  }

  function currentSyncState(status) {
    if (!joined) return 'CONNECTING';
    if (calibrating()) return 'CALIBRATING';
    if (rejoinedAt && performance.now() - rejoinedAt < 3000 && status.syncState !== 'SYNCED') return 'RESYNCING';
    return status.syncState;
  }

  function reportStatus() {
    if (!joined) return;
    checkLatencyChange();
    const status = buildStatus(clock, player, liveActive ? receiver : undefined);
    if (renderer) Object.assign(status, renderer.status());
    status.syncState = currentSyncState(status);
    status.calibrationSource = calibrationSource;
    status.calibratedAt = profile.calibratedAt;
    status.calibrating = calibrating();
    status.reconnects = conn.reconnects;
    if (source === 'movie') {
      Object.assign(status, movieAudio.status());
      status.state = status.movieState;
      if (!calibrating()) status.syncState = movieAudio.syncState();
    }
    conn.send({ type: 'status', status });
  }
  setInterval(reportStatus, 1000);

  // Remember the clock offset as next session's starting estimate.
  setInterval(() => {
    if (clock.converged) {
      profile.lastClockOffsetMs = clock.offset;
      saveProfile();
    }
  }, 10000);

  // ── Rendering ──

  function setPill(text, cls) {
    const el = $('connStatus');
    el.textContent = text;
    el.className = `pill ${cls || ''}`;
  }

  function setBig(text, cls) {
    const el = $('bigStatus');
    el.textContent = text;
    el.className = `big-status ${cls || ''}`;
  }

  const fmt = (v, unit, digits = 1, sign = false) => {
    if (v == null || !Number.isFinite(v)) return '—';
    const r = Number(v.toFixed(digits)) || 0; // avoid "-0"
    return `${sign && r >= 0 ? '+' : ''}${r.toFixed(digits)} ${unit}`;
  };

  const CAL_TEXT = {
    none: 'not measured (software estimate only)',
    'previous-session': 'from a previous session',
    stale: 'previous session — output changed, needs recalibration',
    acoustic: 'measured with the laptop microphone',
  };

  function renderAll() {
    $('roomId').textContent = roomId || '?';

    if (fatal) {
      setPill('Not connected', 'bad');
      setBig(fatal, 'bad');
      $('enableBtn').hidden = true;
      return;
    }

    if (joined && masterOnline) setPill('Connected ✓', 'ok');
    else if (joined) setPill('Connected — Master offline', 'warn');
    else setPill(conn.isOpen ? 'Joining…' : 'Reconnecting…', 'warn');

    const speakerOn = player.speakerEnabled;
    $('enableBtn').hidden = speakerOn;
    $('enableBtn').textContent = player.ctx && !speakerOn ? 'TAP TO RE-ENABLE SPEAKER' : 'ENABLE SPEAKER';
    $('speakerOk').hidden = !speakerOn;
    $('trimText').textContent = `${player.manualTrimMs > 0 ? '+' : ''}${player.manualTrimMs} ms`;

    const status = buildStatus(clock, player, liveActive ? receiver : undefined);
    const state = currentSyncState(status);
    $('syncLine').textContent = `${state} · ${syncProfile === 'movie' ? 'Movie' : 'Music'} mode · latency offset ${fmt(player.trimMs, 'ms', 1, true)}`;

    $('movieFineText').textContent = `${movieAudio.fineMs >= 0 ? '+' : ''}${movieAudio.fineMs} ms`;
    if (performance.now() < probeUntil) {
      setBig('Calibrating… (short beeps)', 'warn');
    } else if (source === 'movie') {
      const m = movieAudio.status();
      const ms = movieAudio.syncState();
      $('trackName').textContent = movieAudio.movie ? `🎬 ${movieAudio.movie.name}` : '🎬 Movie — waiting for the laptop';
      $('dlProgress').hidden = true;
      const labels = {
        'no-movie': ['Waiting for the movie…', ''], 'speaker-off': ['Tap Enable Speaker', 'warn'],
        loading: ['Loading movie audio…', ''], ready: ['🎬 Ready — waiting for the laptop', ''],
        buffering: ['Buffering…', 'warn'], starting: ['Starting…', ''], ended: ['Movie finished', ''],
      };
      if (m.movieState === 'playing') {
        setBig(ms === 'SYNCED' ? '🎬 SYNCED ✓' : ms === 'DRIFTING' ? '🎬 Correcting…' : '🎬 Resyncing…', ms === 'SYNCED' ? 'ok' : 'warn');
      } else {
        const [t, cls] = labels[m.movieState] || [m.movieState, ''];
        setBig(t, cls);
      }
      $('posText').textContent = formatTime(m.movieAudioPos != null ? m.movieAudioPos : (movieAudio.clock ? movieAudio.clock.videoTime : 0));
      $('durText').textContent = formatTime(movieAudio.movie ? movieAudio.movie.duration : 0);
      renderDiag(status, null, m);
      return;
    } else if (liveActive) {
      $('trackName').textContent = '🔴 Live from the laptop';
      $('dlProgress').hidden = true;
      const l = receiver.status();
      if (!speakerOn) setBig('Tap Enable Speaker', 'warn');
      else if (l.receiving) setBig(state === 'SYNCED' ? 'SYNCED ✓ LIVE' : `${state} · LIVE`, state === 'SYNCED' ? 'ok' : 'warn');
      else setBig('Live — waiting for audio…');
      $('posText').textContent = 'LIVE';
      $('durText').textContent = '--:--';
      renderDiag(status, l);
      return;
    } else {
      $('trackName').textContent = player.track ? player.track.name : '—';
      const showProgress = player.loadState === 'downloading';
      $('dlProgress').hidden = !showProgress;
      if (showProgress) $('dlProgress').firstElementChild.style.width = `${Math.round(player.loadProgress * 100)}%`;
      const st = player.status();
      switch (player.stateName()) {
        case 'error': setBig(player.error, 'bad'); break;
        case 'no-track': setBig(state === 'CALIBRATING' ? 'Calibrating…' : 'Waiting for Master to pick a track…'); break;
        case 'downloading': setBig(`Downloading… ${Math.round(player.loadProgress * 100)}%`); break;
        case 'downloaded': setBig('Downloaded — tap Enable Speaker', 'warn'); break;
        case 'decoding': setBig('Preparing audio…'); break;
        case 'speaker-off': setBig('Tap Enable Speaker', 'warn'); break;
        case 'ready': setBig(state === 'CALIBRATING' ? 'Calibrating…' : 'Ready — waiting for Master…'); break;
        case 'paused': setBig('Paused'); break;
        case 'ended': setBig('Track finished'); break;
        case 'waiting': setBig('Joining playback…'); break;
        case 'scheduled': setBig(`Starting in ${(st.startsInMs / 1000).toFixed(1)} s…`); break;
        case 'playing':
          if (state === 'SYNCED') setBig('SYNCED ✓', 'ok');
          else if (state === 'DRIFTING') setBig('Correcting drift…', 'warn');
          else setBig('Resyncing…', 'warn');
          break;
      }
    }
    const st = player.status();
    $('posText').textContent = formatTime(st.position != null ? st.position : 0);
    $('durText').textContent = formatTime(player.duration || 0);
    renderDiag(status);
  }

  function renderDiag(s, liveStatus, movieStatus) {
    const rate = s.correctionRate;
    const rows = [
      ['Device', `${profile.deviceName} (${clientId.slice(0, 6)})`],
      ['Connection', conn.isOpen ? (joined ? 'joined' : 'open') : 'reconnecting'],
      ['Sync state', currentSyncState(s)],
      ['Clock offset', clock.ready ? `${fmt(clock.offset, 'ms', 1, true)} ± ${fmt(clock.uncertaintyMs, 'ms')}` : 'measuring…'],
      ['Network RTT (median / best)', `${fmt(clock.medianRtt, 'ms')} / ${fmt(clock.bestRtt, 'ms')}`],
      ['Clock drift', clock.driftPpm != null ? fmt(clock.driftPpm, 'ppm', 0, true) : 'needs ~15 s'],
      ['Output latency (browser-reported)', fmt(s.outputLatencyMs, 'ms', 0)],
      ['Calibration', `${fmt(player.calibrationMs, 'ms', 1, true)} — ${CAL_TEXT[calibrationSource]}`],
      ['Effective latency offset', `${fmt(player.trimMs, 'ms', 1, true)} (calibration ${fmt(player.calibrationMs, 'ms', 1, true)} + manual ${fmt(player.manualTrimMs, 'ms', 0, true)})`],
      ['Playback drift (raw / smoothed)', `${fmt(s.playbackDriftMs, 'ms', 1, true)} / ${fmt(s.smoothedDriftMs, 'ms', 1, true)}`],
      ['Correction', rate == null ? '—' : `${rate >= 1 ? '+' : '−'}${Math.abs((rate - 1) * 100).toFixed(3)} % (${s.correctionZone || '—'})`],
      ['Learned clock skew', fmt(s.skewBiasPpm, 'ppm', 0, true)],
      ['Resyncs / reconnects', `${player.resyncs} / ${conn.reconnects}`],
      ['Timing method', s.timingMethod || '—'],
    ];
    if (movieStatus) {
      const m = movieStatus;
      const avOff = movieAudio.clock ? movieAudio.clock.avOffsetMs || 0 : 0;
      const baseRate = movieAudio.clock ? movieAudio.clock.rate : 1;
      rows.splice(9, 3,
        ['Movie A/V difference (raw / smoothed)', `${fmt(m.movieErrorMs, 'ms', 1, true)} / ${fmt(m.movieSmoothedMs, 'ms', 1, true)}`],
        ['Movie fine offset', fmt(m.movieFineMs, 'ms', 0, true)],
        ['Total movie compensation', fmt((player.calibrationMs || 0) + m.movieFineMs + avOff, 'ms', 1, true)],
        ['Movie correction', m.movieRate == null ? '—' : `${((m.movieRate / baseRate - 1) * 100).toFixed(3)} % (${m.movieZone})`],
        ['Movie buffer ahead', fmt(m.movieBufferS, 's', 0)],
        ['Movie resyncs / underruns', `${m.movieResyncs} / ${m.movieUnderruns}`]);
    }
    if (liveStatus) {
      rows.push(['Live audio queued', fmt(liveStatus.bufferMs, 'ms', 0)], ['Late chunks / live resyncs', `${liveStatus.late} / ${liveStatus.resyncs}`]);
    }
    const dl = $('diag');
    dl.innerHTML = '';
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      dl.append(dt, dd);
    }
  }

  // Refresh the clock-driven parts of the UI.
  setInterval(render, 250);

  /** Spatial position line + test phase label (both from local state only). */
  function renderSpatial() {
    const info = $('spatialInfo');
    if (renderer && renderer.state.enabled) {
      const s = renderer.status();
      const x = s.spatialX;
      const side = x < -0.2 ? 'LEFT' : x > 0.2 ? 'RIGHT' : 'CENTER';
      info.textContent = `Experimental spatial: ${side} (x = ${x.toFixed(1)}) · L ${Math.round(s.gainL * 100)}% / R ${Math.round(s.gainR * 100)}%`;
    } else {
      info.textContent = spatialConfig && spatialConfig.enabled && !renderer
        ? 'Experimental spatial: ON (enable speaker to apply)'
        : '';
    }
    const el = $('testPhase');
    const t = testStartAt == null ? null : (clock.masterNow() - testStartAt) / 1000;
    if (t == null || t >= SpatialTest.DURATION) {
      el.hidden = true;
      testStartAt = null;
      return;
    }
    el.hidden = false;
    const phase = SpatialTest.phaseAt(t);
    el.textContent = t < 0 ? `Spatial test in ${(-t).toFixed(1)} s…` : `Test: ${phase ? phase.label : ''}`;
  }
  setInterval(renderSpatial, 250);

  // For poking at things from the browser console while experimenting.
  window.syncwaveDebug = { player, clock, conn, receiver, profile, movieAudio, get renderer() { return renderer; } };

  $('nameInput').value = profile.deviceName;
  conn.connect();
  render();
})();
