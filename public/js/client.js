/*
 * client.js — the phone page (opened from the QR code at /join/ROOM).
 *
 * 1. Connects and joins the room (a stable id in localStorage lets it rejoin
 *    as the same device after a disconnect or reload).
 * 2. Starts clock sync immediately and downloads the current track.
 * 3. Waits for "Enable Speaker" (required by mobile browsers before audio).
 * 4. Decodes the track and plays it at the scheduled master-clock time (sync.js).
 */
(function () {
  'use strict';

  const {
    Connection, ClockSync, SyncedPlayer, LiveReceiver, decodeChunk,
    SpatialRenderer, SpatialTest,
    formatTime, randomId, buildStatus, renderScheduler,
  } = window.SyncWave;
  const $ = (id) => document.getElementById(id);

  const roomId = decodeURIComponent(location.pathname.split('/').filter(Boolean).pop() || '').toUpperCase();

  // ── Persistent per-phone settings (storage can be unavailable in private mode) ──

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
  let deviceName = store.get('syncwave.name') || defaultName();

  // ── State ──

  let joined = false;
  let fatal = null;          // permanent error (room not found / closed)
  let masterOnline = true;

  const render = renderScheduler(renderAll);
  const conn = new Connection({ onOpen, onMessage, onBinary, onClose });
  const clock = new ClockSync((m) => conn.send(m));
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
  player.trimMs = Number(store.get('syncwave.trimMs')) || 0;

  function applySpatial(cfg) {
    if (!cfg) return;
    spatialConfig = cfg;
    if (renderer) renderer.applyRoomConfig(cfg, clientId);
    render();
    setTimeout(reportStatus, 100);
  }
  const receiver = new LiveReceiver(player);
  let liveActive = false;

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
    conn.send({ type: 'join', roomId, clientId, name: deviceName });
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
        joined = true;
        masterOnline = msg.masterOnline;
        if (msg.deviceName && !store.get('syncwave.name')) deviceName = msg.deviceName;
        $('nameInput').value = deviceName;
        player.setTrack(msg.track);
        player.applyPlayback(msg.playback);
        setLive(msg.live);
        applySpatial(msg.spatial);
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
    deviceName = e.target.value.trim().slice(0, 32) || defaultName();
    e.target.value = deviceName;
    store.set('syncwave.name', deviceName);
    conn.send({ type: 'rename', name: deviceName });
  });

  document.querySelectorAll('[data-trim]').forEach((btn) => {
    btn.addEventListener('click', () => {
      player.setTrim(player.trimMs + Number(btn.dataset.trim));
      store.set('syncwave.trimMs', String(player.trimMs));
      render();
    });
  });

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
    else setPill(conn.isOpen ? 'Joining…' : 'Connecting…', conn.isOpen ? '' : 'warn');

    const speakerOn = player.speakerEnabled;
    $('enableBtn').hidden = speakerOn;
    $('enableBtn').textContent = player.ctx && !speakerOn ? 'TAP TO RE-ENABLE SPEAKER' : 'ENABLE SPEAKER';
    $('speakerOk').hidden = !speakerOn;

    if (liveActive) {
      $('trackName').textContent = '🔴 Live from the laptop';
      $('dlProgress').hidden = true;
      const l = receiver.status();
      if (!speakerOn) setBig('Tap Enable Speaker', 'warn');
      else if (l.receiving) setBig('SYNCED ✓ LIVE', 'ok');
      else setBig('Live — waiting for audio…');
      $('posText').textContent = 'LIVE';
      $('durText').textContent = '--:--';
      $('trimText').textContent = `${player.trimMs > 0 ? '+' : ''}${player.trimMs} ms`;
      renderDiag({ position: null, playbackDriftMs: l.driftMs, outputLatencyMs: player.status().outputLatencyMs,
        timingMethod: player.ctx ? player.clockMapping().method : null }, l);
      return;
    }

    $('trackName').textContent = player.track ? player.track.name : '—';
    const showProgress = player.loadState === 'downloading';
    $('dlProgress').hidden = !showProgress;
    if (showProgress) $('dlProgress').firstElementChild.style.width = `${Math.round(player.loadProgress * 100)}%`;

    const st = player.status();
    switch (player.stateName()) {
      case 'error': setBig(player.error, 'bad'); break;
      case 'no-track': setBig('Waiting for Master to pick a track…'); break;
      case 'downloading': setBig(`Downloading… ${Math.round(player.loadProgress * 100)}%`); break;
      case 'downloaded': setBig('Downloaded — tap Enable Speaker', 'warn'); break;
      case 'decoding': setBig('Preparing audio…'); break;
      case 'speaker-off': setBig('Tap Enable Speaker', 'warn'); break;
      case 'ready': setBig('Ready — waiting for Master…'); break;
      case 'paused': setBig('Paused'); break;
      case 'ended': setBig('Track finished'); break;
      case 'waiting': setBig('Joining playback…'); break;
      case 'scheduled': setBig(`Starting in ${(st.startsInMs / 1000).toFixed(1)} s…`); break;
      case 'playing': setBig(player.active && player.active.late ? 'SYNCED ✓ (joined late)' : 'SYNCED ✓', 'ok'); break;
    }

    $('posText').textContent = formatTime(st.position != null ? st.position : 0);
    $('durText').textContent = formatTime(player.duration || 0);
    $('trimText').textContent = `${player.trimMs > 0 ? '+' : ''}${player.trimMs} ms`;
    renderDiag(st);
  }

  function renderDiag(st, liveStatus) {
    const fmt = (v, unit, digits = 1, sign = false) => {
      if (v == null) return '—';
      const r = Number(v.toFixed(digits)) || 0; // avoid "-0"
      return `${sign && r >= 0 ? '+' : ''}${r.toFixed(digits)} ${unit}`;
    };
    const rows = [
      ['Device', deviceName],
      ['Connection', conn.isOpen ? (joined ? 'joined' : 'open') : 'reconnecting'],
      ['Playback position', st.position != null ? formatTime(st.position) : '—'],
      ['Est. clock offset', clock.ready ? `${fmt(clock.offset, 'ms', 1, true)} ± ${fmt(clock.uncertaintyMs, 'ms')}` : 'measuring…'],
      ['Round trip (median)', fmt(clock.medianRtt, 'ms')],
      ['Est. clock drift', clock.driftPpm != null ? fmt(clock.driftPpm, 'ppm', 0, true) : 'needs ~20 s'],
      ['Est. playback drift', fmt(st.playbackDriftMs, 'ms', 1, true)],
      ['Output latency (reported)', fmt(st.outputLatencyMs, 'ms', 0)],
      ['Timing method', st.timingMethod || '—'],
    ];
    if (liveStatus) {
      rows.splice(2, 1,
        ['Live audio queued', fmt(liveStatus.bufferMs, 'ms', 0)],
        ['Late chunks (dropped)', String(liveStatus.late)],
        ['Re-syncs', String(liveStatus.resyncs)]);
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

  // Refresh the clock-driven parts of the UI and report status to the Master.
  setInterval(render, 250);
  function reportStatus() {
    if (!joined) return;
    const status = buildStatus(clock, player, liveActive ? receiver : undefined);
    if (renderer) Object.assign(status, renderer.status());
    conn.send({ type: 'status', status });
  }
  setInterval(reportStatus, 1000);

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
        : 'Mode: Standard Sync (full mix)';
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
  window.syncwaveDebug = { player, clock, receiver, get renderer() { return renderer; } };

  $('nameInput').value = deviceName;
  conn.connect();
  render();
})();
