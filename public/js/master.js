/*
 * master.js — the laptop page. Creates the room, shows the QR code, uploads the
 * track and sends playback commands.
 *
 * Note that the Master does not play audio "directly" when you press Play: it
 * sends a play command with a future start time, the server broadcasts the new
 * playback state to every device (this page included), and every device —
 * laptop and phones alike — schedules the start the same way (sync.js).
 */
(function () {
  'use strict';

  const {
    Connection, ClockSync, SyncedPlayer, LiveReceiver, LiveCapture,
    SpatialRenderer, SpatialTest, SPATIAL_DEFAULTS, Calibration, SYNC_PROFILES,
    formatTime, decodeAudio, buildStatus, renderScheduler,
  } = window.SyncWave;
  const $ = (id) => document.getElementById(id);

  const MAX_FILE_BYTES = 150 * 1024 * 1024;
  const ALLOWED_EXT = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.flac', '.webm'];
  const SAVE_KEY = 'syncwave.master';
  /** Minimum time between pressing Play and the scheduled start on every device. */
  const MIN_LEAD_MS = 1500;
  const MAX_LEAD_MS = 5000;

  let room = null;            // { roomId, token, joinUrls }
  let devices = [];
  let uploading = false;
  let pendingDecoded = null;  // { name, buffer } decoded locally, waiting for the server's track id
  let seeking = false;
  let autoStoppedSeq = null;

  const render = renderScheduler(renderAll);
  const conn = new Connection({ onOpen, onMessage, onClose });
  const clock = new ClockSync((m) => conn.send(m));
  // Experimental spatial mode lives in its own renderer, inserted after the
  // scheduled sources; the player and sync engine don't know it exists.
  let renderer = null;
  let spatialConfig = { ...SPATIAL_DEFAULTS, positions: { master: 0 } };
  const player = new SyncedPlayer(clock, render, {
    outputChain(ctx, output) {
      renderer = new SpatialRenderer(ctx, output);
      renderer.applyRoomConfig(spatialConfig, 'master');
      return renderer.input;
    },
  });

  // Live mode: capture → stamp → send to phones AND schedule locally, with the same delay.
  const live = {
    active: false,       // server says the room is live
    kind: null,          // capture kind in use
    receiver: new LiveReceiver(player),
    capture: null,
  };
  live.capture = new LiveCapture(player, {
    onChunk(chunk, encoded) {
      conn.sendBinary(encoded);   // to the phones (relayed by the server)
      live.receiver.push(chunk);  // and to this laptop's own speaker, on the same timeline
    },
    onLevel: showLevel,
    onEnded(message) {
      conn.send({ type: 'live-stop' });
      setLiveMsg(message, 'warn');
    },
  });

  // Hooks for public/js/master-movie.js (Movie Sync), which loads after this file.
  const api = { handlers: {}, extraStatus: null, onModeChange: null };
  window.SyncWaveMasterAPI = api;

  // ── Session persistence: a reload of this tab keeps the same room ──

  function loadSaved() {
    try { return JSON.parse(sessionStorage.getItem(SAVE_KEY)); } catch { return null; }
  }
  function save(data) {
    try { sessionStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch { /* private mode */ }
  }
  function clearSaved() {
    try { sessionStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
  }

  // ── Connection ──

  function onOpen() {
    setConn('Connected', 'ok');
    clock.start();
    const saved = loadSaved();
    if (saved && saved.roomId && saved.token) {
      conn.send({ type: 'resume-room', roomId: saved.roomId, token: saved.token });
    } else {
      conn.send({ type: 'create-room' });
    }
  }

  function onClose() {
    clock.stop();
    setConn('Server disconnected — reconnecting…', 'bad');
  }

  function onMessage(msg) {
    switch (msg.type) {
      case 'sync-reply':
        clock.handleReply(msg);
        break;
      case 'room':
        room = { roomId: msg.roomId, token: msg.token, joinUrls: msg.joinUrls || [] };
        save({ roomId: room.roomId, token: room.token, iface: (loadSaved() || {}).iface });
        renderRoom();
        handleTrack(msg.track);
        player.applyPlayback(msg.playback);
        $('repeat').checked = !!(msg.playback && msg.playback.loop);
        applyLive(msg.live);
        applySpatial(msg.spatial);
        setSyncProfile(msg.syncProfile);
        applyLogInfo(msg.log);
        if (api.handlers.room) api.handlers.room(msg);
        break;
      case 'sync-profile':
        setSyncProfile(msg.profile);
        break;
      case 'log-status':
        applyLogInfo(msg.log);
        break;
      case 'probe':
        // The laptop plays its own reference chirps like every other device.
        Calibration.scheduleChirps(player, msg.schedule && msg.schedule.master);
        break;
      case 'live':
        applyLive(msg.live);
        break;
      case 'spatial':
        applySpatial(msg.spatial);
        break;
      case 'spatial-test':
        runSpatialTest(msg.startAt);
        break;
      case 'track':
        handleTrack(msg.track);
        break;
      case 'playback':
        player.applyPlayback(msg.playback);
        setTimeout(reportStatus, 100);
        render();
        break;
      case 'devices':
        devices = msg.devices;
        if (msg.log) applyLogInfo(msg.log);
        renderDevices();
        break;
      case 'room-closed':
        clearSaved(); // the socket closes next; on reconnect we create a fresh room
        break;
      case 'movie':
      case 'movie-created':
      case 'movie-clock':
      case 'source':
        if (api.handlers[msg.type]) api.handlers[msg.type](msg);
        break;
      case 'error':
        if (msg.code === 'movie' && api.handlers.error) { api.handlers.error(msg); break; }
        if (msg.code === 'room-gone') {
          clearSaved();
          conn.send({ type: 'create-room' });
        } else if (msg.code === 'not-local') {
          conn.shutdown();
          showFatal(msg.message);
        } else {
          setTrackMsg(msg.message, 'bad');
        }
        break;
    }
  }

  function handleTrack(track) {
    if (!track) {
      player.clearTrack();
    } else if (pendingDecoded && pendingDecoded.name === track.name) {
      // We just uploaded this file and already decoded it locally.
      player.loadDecoded(track, pendingDecoded.buffer);
      pendingDecoded = null;
    } else if (!player.track || player.track.id !== track.id) {
      player.setTrack(track); // e.g. after reloading this page: fetch it back from the server
    }
    render();
  }

  // ── Speaker ──

  /** Browsers only allow audio after a user gesture; any click on the page counts. */
  function enableSpeaker() {
    if (!player.speakerEnabled) player.enable().catch((e) => setTrackMsg(e.message, 'bad'));
  }
  document.addEventListener('click', enableSpeaker, true);

  /**
   * Whole-system capture also records whatever this page plays, so playing it
   * on the laptop would loop back into the capture: force the laptop silent.
   */
  function applyLocalMute() {
    const forcedOff = live.active && live.kind === 'screen';
    $('localSpeaker').disabled = forcedOff;
    player.setMuted(forcedOff || !$('localSpeaker').checked);
  }
  $('localSpeaker').addEventListener('change', applyLocalMute);

  // ── Track selection & upload ──

  $('chooseBtn').addEventListener('click', () => {
    if (!uploading) $('fileInput').click();
  });

  $('fileInput').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file || !room) return;

    const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')).toLowerCase() : '';
    if (!ALLOWED_EXT.includes(ext)) {
      return setTrackMsg(`Unsupported file type "${ext || 'unknown'}". Use MP3, WAV or M4A.`, 'bad');
    }
    if (file.size > MAX_FILE_BYTES) {
      return setTrackMsg(`File is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`, 'bad');
    }

    // Decode locally first: if this browser can't decode it, the phones most likely can't either.
    setTrackMsg(`Checking ${file.name}…`);
    let buffer;
    try {
      player.ensureContext();
      buffer = await decodeAudio(player.ctx, await file.arrayBuffer());
    } catch {
      return setTrackMsg(`This browser cannot decode "${file.name}". Try MP3 or WAV.`, 'bad');
    }

    pendingDecoded = { name: sanitizedName(file.name), buffer };
    upload(file);
  });

  /** Mirror of the server's file-name cleanup so we can match the track it announces. */
  function sanitizedName(name) {
    return name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').trim().slice(-120) || 'audio';
  }

  function upload(file) {
    uploading = true;
    $('chooseBtn').disabled = true;
    $('uploadProgress').hidden = false;
    setProgress($('uploadProgress'), 0);
    setTrackMsg(`Uploading ${file.name}…`);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/rooms/${room.roomId}/track`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.setRequestHeader('X-Master-Token', room.token);
    xhr.setRequestHeader('X-Filename', encodeURIComponent(file.name));
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) setProgress($('uploadProgress'), ev.loaded / ev.total);
    };
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch { /* ignore */ }
      if (xhr.status === 200 && body.track) {
        handleTrack(body.track); // in case the WebSocket announcement hasn't arrived yet
        setTrackMsg('Uploaded. Phones are downloading it now.', 'ok');
      } else {
        pendingDecoded = null;
        setTrackMsg(body.error || `Upload failed (HTTP ${xhr.status}).`, 'bad');
      }
      done();
    };
    xhr.onerror = () => {
      pendingDecoded = null;
      setTrackMsg('Upload failed (network error).', 'bad');
      done();
    };
    xhr.send(file);

    function done() {
      uploading = false;
      $('chooseBtn').disabled = false;
      $('uploadProgress').hidden = true;
      render();
    }
  }

  // ── Playback controls ──

  /** Where the room is (or should be) right now, from the server state + master clock. */
  function currentPosition() {
    const pb = player.playback;
    if (!pb) return 0;
    if (pb.status !== 'playing') return pb.position;
    const pos = pb.position + Math.max(0, clock.masterNow() - pb.startAt) / 1000;
    return pb.loop && pb.duration ? pos % pb.duration : pos;
  }

  /**
   * How far in the future to schedule the start: enough for every device to
   * receive the command over Wi-Fi and set up the audio node. Slow networks
   * (high round trip times) get more lead time.
   */
  function leadTimeMs() {
    let worstRtt = 0;
    for (const d of devices) {
      if (d.connected && d.status && d.status.rttMs) worstRtt = Math.max(worstRtt, d.status.rttMs);
    }
    return Math.min(MAX_LEAD_MS, Math.max(MIN_LEAD_MS, worstRtt * 4 + 500));
  }

  function sendPlay(position) {
    // ★ The scheduled start: "play `position` at master time `startAt`".
    conn.send({
      type: 'play', startAt: clock.masterNow() + leadTimeMs(), position,
      loop: $('repeat').checked, duration: player.duration || undefined,
    });
  }

  // Repeat: applied to the next play, or right away (without restarting) while playing.
  $('repeat').addEventListener('change', () => {
    const pb = player.playback;
    if (pb && pb.status === 'playing') {
      conn.send({ type: 'loop', loop: $('repeat').checked, duration: player.duration || undefined });
    }
  });

  // ── Playback Mode: Music / Movie (sync tolerances) ──

  const PROFILE_HELP = {
    music: 'Music: ignores timing errors under 10 ms, corrects 10–50 ms with ≤ 0.15 % playback-rate changes, ' +
      'up to 0.4 % beyond that, and resyncs only above 200 ms.',
    movie: 'Movie: tighter, because dialogue makes timing errors obvious. Ignores errors under 4 ms, corrects ' +
      'with ≤ 0.2 % rate changes (0.5 % above 25 ms) and resyncs above 80 ms.',
  };
  let syncProfile = 'music';
  function setSyncProfile(name) {
    if (!SYNC_PROFILES[name]) return;
    syncProfile = name;
    player.setSyncProfile(name);
    const radio = document.querySelector(`input[name="syncprofile"][value="${name}"]`);
    if (radio) radio.checked = true;
    $('profileHelp').textContent = PROFILE_HELP[name];
  }
  document.querySelectorAll('input[name="syncprofile"]').forEach((r) => {
    r.addEventListener('change', () => conn.send({ type: 'set-sync-profile', profile: r.value }));
  });

  $('playBtn').addEventListener('click', () => {
    const pb = player.playback;
    if (!pb || !pb.trackId) return;
    const dur = player.duration || Infinity;
    let pos = currentPosition();
    if (pb.status === 'stopped' || pos >= dur) pos = 0;
    // While already playing, "Play Synced" re-synchronizes everyone from the current position.
    sendPlay(pos);
  });

  $('pauseBtn').addEventListener('click', () => conn.send({ type: 'pause' }));
  $('stopBtn').addEventListener('click', () => conn.send({ type: 'stop' }));

  const seek = $('seek');
  seek.addEventListener('input', () => {
    seeking = true;
    $('posText').textContent = formatTime(Number(seek.value));
  });
  seek.addEventListener('change', () => {
    seeking = false;
    const pos = Number(seek.value);
    const pb = player.playback;
    if (pb && pb.status === 'playing') sendPlay(pos);
    else conn.send({ type: 'seek', position: pos });
  });

  // ── Experimental spatial mode ──
  //
  // The Master only edits and broadcasts the config; every device (this page
  // included) applies it to its own SpatialRenderer when the 'spatial'
  // message comes back from the server.

  const draft = { width: null, centerMix: null, positions: {} }; // unapplied local edits
  let testStartAt = null;
  let positionRowsKey = '';

  const draftWidth = () => (draft.width ?? spatialConfig.width);
  const draftCenter = () => (draft.centerMix ?? spatialConfig.centerMix);
  const draftPosition = (id) => draft.positions[id] ?? spatialConfig.positions[id] ?? 0;
  const isDirty = () => draft.width != null || draft.centerMix != null || Object.keys(draft.positions).length > 0;
  const fmtX = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(1)}`;

  function applySpatial(cfg) {
    if (!cfg) return;
    spatialConfig = cfg;
    if (renderer) renderer.applyRoomConfig(cfg, 'master');
    document.querySelector(`input[name="pmode"][value="${cfg.enabled ? 'spatial' : 'standard'}"]`).checked = true;
    renderSpatialPanel();
    render();
    setTimeout(reportStatus, 100);
  }

  function sendSpatial(partial) {
    conn.send({ type: 'spatial-config', spatial: partial });
  }

  // Switching modes takes effect immediately, so getting back to Standard Sync is always one click.
  document.querySelectorAll('input[name="pmode"]').forEach((r) => {
    r.addEventListener('change', () => {
      const enabled = document.querySelector('input[name="pmode"]:checked').value === 'spatial';
      sendSpatial({ enabled });
      renderSpatialPanel();
    });
  });

  $('spWidth').addEventListener('input', () => {
    draft.width = Number($('spWidth').value);
    renderSpatialPanel();
  });
  $('spCenter').addEventListener('input', () => {
    draft.centerMix = Number($('spCenter').value);
    renderSpatialPanel();
  });

  $('spApply').addEventListener('click', () => {
    const positions = {};
    for (const d of devices) positions[d.id] = draftPosition(d.id);
    sendSpatial({ enabled: true, width: draftWidth(), centerMix: draftCenter(), positions });
    draft.width = null;
    draft.centerMix = null;
    draft.positions = {};
  });

  $('spTest').addEventListener('click', () => {
    conn.send({ type: 'spatial-test', startAt: clock.masterNow() + leadTimeMs() });
  });

  function runSpatialTest(startAt) {
    testStartAt = startAt;
    const ok = SpatialTest.schedule(player, renderer, startAt);
    if (!ok && !player.muted) setSpatialMsg('This laptop could not schedule the test (speaker not enabled yet? click the page).', 'warn');
  }

  function setSpatialMsg(text, cls) {
    const el = $('spMsg');
    el.textContent = text || '';
    el.className = `msg ${cls || ''}`;
  }

  function setDraftPosition(id, x) {
    draft.positions[id] = Math.round(Math.max(-1, Math.min(1, x)) * 10) / 10;
    renderSpatialPanel();
  }

  /** Per-device position rows: rebuilt only when the device list changes, so dragging isn't interrupted. */
  function renderPositionRows() {
    const key = devices.map((d) => `${d.id}:${d.name}`).join('|');
    const list = $('positionList');
    if (key !== positionRowsKey) {
      positionRowsKey = key;
      list.innerHTML = '';
      for (const d of devices) {
        const row = document.createElement('div');
        row.className = 'pos-row';
        row.dataset.id = d.id;
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = `${d.role === 'master' ? '💻' : '📱'} ${d.name}`;
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '-1';
        slider.max = '1';
        slider.step = '0.1';
        slider.setAttribute('aria-label', `${d.name} position`);
        slider.addEventListener('input', () => setDraftPosition(d.id, Number(slider.value)));
        const val = document.createElement('span');
        val.className = 'mono val';
        const quick = document.createElement('span');
        quick.className = 'quick';
        for (const [label, x] of [['L', -1], ['C', 0], ['R', 1]]) {
          const b = document.createElement('button');
          b.type = 'button';
          b.textContent = label;
          b.addEventListener('click', () => setDraftPosition(d.id, x));
          quick.appendChild(b);
        }
        row.append(name, slider, val, quick);
        list.appendChild(row);
      }
      if (devices.length === 0) list.innerHTML = '<p class="muted small">No devices yet.</p>';
    }
    for (const row of list.querySelectorAll('.pos-row')) {
      const x = draftPosition(row.dataset.id);
      const slider = row.querySelector('input');
      if (document.activeElement !== slider) slider.value = String(x);
      row.querySelector('.val').textContent = fmtX(x);
    }
  }

  function renderRoomStrip() {
    const strip = $('roomStrip');
    strip.querySelectorAll('.marker').forEach((m) => m.remove());
    for (const d of devices) {
      const x = draftPosition(d.id);
      const m = document.createElement('div');
      m.className = `marker${d.connected ? '' : ' off'}`;
      m.style.left = `${6 + ((x + 1) / 2) * 88}%`;
      const icon = document.createElement('span');
      icon.className = 'icon';
      icon.textContent = d.role === 'master' ? '💻' : '📱';
      const label = document.createElement('span');
      label.textContent = `${d.name} ${fmtX(x)}`;
      m.append(icon, label);
      strip.appendChild(m);
    }
  }

  function renderSpatialPanel() {
    const spatialSelected = document.querySelector('input[name="pmode"]:checked').value === 'spatial';
    $('spatialPanel').hidden = !spatialSelected;
    if (document.activeElement !== $('spWidth')) $('spWidth').value = String(draftWidth());
    if (document.activeElement !== $('spCenter')) $('spCenter').value = String(draftCenter());
    $('spWidthText').textContent = draftWidth().toFixed(2);
    $('spCenterText').textContent = draftCenter().toFixed(2);
    renderPositionRows();
    renderRoomStrip();
    $('spTest').disabled = !spatialConfig.enabled;
    if (!spatialSelected) return;
    if (!spatialConfig.enabled) setSpatialMsg('Switching to spatial…');
    else if (isDirty()) setSpatialMsg('Unapplied changes — press APPLY.', 'warn');
    else setSpatialMsg('Applied ✓  Every device is rendering its assigned position.', 'ok');
  }

  /** Big "LEFT / CENTER / RIGHT" label while the spatial test runs. */
  function renderTestPhase() {
    const el = $('spTestPhase');
    if (testStartAt == null) { el.hidden = true; return; }
    const t = (clock.masterNow() - testStartAt) / 1000;
    if (t >= SpatialTest.DURATION) { testStartAt = null; el.hidden = true; return; }
    el.hidden = false;
    const phase = SpatialTest.phaseAt(t);
    el.textContent = t < 0 ? `Test starts in ${(-t).toFixed(1)} s…` : `Test: ${phase ? phase.label : ''}`;
  }

  /**
   * Honest sync summary: built only from what devices report about themselves.
   * Nothing here can see acoustic delays the browsers don't report.
   */
  function syncSummary() {
    const connected = devices.filter((d) => d.connected);
    const pb = player.playback;
    const roomPlaying = (pb && pb.status === 'playing') || live.active;
    const tol = SYNC_PROFILES[syncProfile].syncedMs;
    const clients = connected.filter((d) => d.role === 'client');
    const measured = clients.filter((d) => d.status && d.status.calibrationSource === 'acoustic').length;
    const calNote = clients.length
      ? ` Acoustic calibration: ${measured}/${clients.length} phones measured this session${measured < clients.length ? ' (the rest rely on browser-reported latency only)' : ''}.`
      : '';
    if (!roomPlaying) return { text: 'IDLE (nothing playing)', cls: '', note: calNote.trim() };
    const playing = connected.filter((d) => d.status && (d.status.state === 'playing' || d.status.state === 'live'));
    if (playing.length === 0) return { text: 'NOT PLAYING YET', cls: 'warn', note: calNote.trim() };
    const errs = playing.map((d) => Math.abs(d.status.smoothedDriftMs ?? d.status.playbackDriftMs)).filter(Number.isFinite);
    if (errs.length === 0) return { text: 'MEASURING…', cls: '', note: calNote.trim() };
    const worst = Math.max(...errs);
    const worstUnc = Math.max(0, ...playing.map((d) => d.status.clockUncertaintyMs || 0));
    const states = playing.map((d) => d.status.syncState);
    let text = worst <= tol ? 'SYNCED' : states.includes('RESYNCING') ? 'RESYNCING' : 'DRIFTING (correcting)';
    let cls = worst <= tol ? 'ok' : 'warn';
    if (playing.length < connected.length) {
      text += ` — only ${playing.length}/${connected.length} devices playing`;
      cls = 'warn';
    }
    const note = `Worst device error vs the master timeline: ${worst.toFixed(1)} ms (smoothed; tolerance ±${tol} ms in ` +
      `${SYNC_PROFILES[syncProfile].label} mode). Clock-offset uncertainty up to ~${worstUnc.toFixed(1)} ms.${calNote}`;
    return { text, cls, note };
  }

  function renderSummary() {
    const sp = $('sumSpatial');
    sp.textContent = spatialConfig.enabled ? 'ON (experimental)' : 'OFF (Standard Sync)';
    sp.className = spatialConfig.enabled ? 'warn' : '';
    const s = syncSummary();
    $('sumSync').textContent = s.text;
    $('sumSync').className = s.cls;
    $('sumSyncNote').textContent = s.note;
  }

  // ── Latency calibration (acoustic, laptop microphone) ──
  //
  // Software calibration happens on every device by itself (clock sync +
  // browser-reported output latency). This part measures what software
  // can't: each device's real audible offset, heard by the laptop's mic.
  // See public/js/calibration.js for the method.

  const pref = {
    get(k) { try { return localStorage.getItem(`syncwave.${k}`); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(`syncwave.${k}`, v); } catch { /* ignore */ } },
  };
  const recorder = new Calibration.MicRecorder(player);
  const calAttempts = new Map();   // deviceId → { count, lastAt } (auto mode doesn't nag forever)
  const calResults = new Map();    // deviceId → last measured row
  let probeRunning = false;

  function setCalMsg(text, cls) {
    const el = $('calMsg');
    el.textContent = text || '';
    el.className = `msg ${cls || ''}`;
  }

  function micError(err) {
    if (err && err.name === 'NotAllowedError') return 'Microphone access was blocked. Allow it in the browser (address bar icon) to use acoustic calibration.';
    if (err && err.name === 'NotFoundError') return 'No microphone found on this laptop — acoustic calibration is unavailable (software calibration still runs).';
    return `Microphone unavailable: ${err ? err.message : 'unknown error'}`;
  }

  const deviceName = (id) => (devices.find((d) => d.id === id) || { name: id }).name;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Candidates: connected phones with their speaker on and a settled clock. */
  function calibratableIds() {
    return devices
      .filter((d) => d.role === 'client' && d.connected && d.status && d.status.speakerEnabled && (d.status.clockSamples || 0) >= 10)
      .map((d) => d.id);
  }

  /**
   * kind 'calibrate': measure, send each device its correction, then measure
   * again to verify (up to 2 passes). kind 'verify' (sync test): 5 chirps per
   * device, measure only.
   */
  async function runAcoustic(kind, deviceIds) {
    if (probeRunning) return;
    if (deviceIds.length === 0) { setCalMsg('No phones ready to measure (they need Enable Speaker tapped).', 'warn'); return; }
    if (live.active) { setCalMsg('Stop live mode first — the measurement needs a quiet room.', 'warn'); return; }
    if (!player.speakerEnabled) { setCalMsg('Click anywhere on this page first so the laptop can play its reference chirp.', 'warn'); return; }
    try { await recorder.open(); } catch (err) { setCalMsg(micError(err), 'bad'); return; }
    probeRunning = true;
    render();
    const ids = ['master', ...deviceIds];
    const passes = kind === 'calibrate' ? 2 : 1;
    let failed = false;
    try {
      for (let pass = 1; pass <= passes; pass++) {
        setCalMsg(`${kind === 'calibrate' ? 'Calibrating' : 'Sync test'}: listening to ${ids.length} devices` +
          `${passes > 1 ? ` (pass ${pass}/${passes})` : ''}… keep the room quiet.`, 'warn');
        const result = await Calibration.runProbe({
          send: (m) => conn.send(m), clock, player, recorder, deviceIds: ids, rounds: kind === 'verify' ? 5 : 3, kind,
        });
        if (!result.ok) { setCalMsg(result.reason, 'bad'); failed = true; break; }
        const rows = result.devices.filter((d) => d.deviceId !== 'master');
        for (const r of rows) {
          if (kind === 'calibrate' && r.reliable) {
            r.adjustMs = -r.errorMs;
            conn.send({ type: 'calibration-adjust', deviceId: r.deviceId, adjustMs: r.adjustMs, errorMs: r.errorMs });
            r.action = Math.abs(r.adjustMs) < 0.5 ? 'aligned ✓' : `corrected by ${signed(r.adjustMs, 1)} ms`;
          } else if (!r.reliable) {
            r.action = r.heard === 0 ? 'not heard — volume up / move closer' : 'inconsistent — try again';
          } else {
            r.action = Math.abs(r.errorMs) <= SYNC_PROFILES[syncProfile].syncedMs ? 'within tolerance ✓' : 'outside tolerance';
          }
          calResults.set(r.deviceId, { ...r, kind, pass, at: Date.now() });
        }
        conn.send({ type: 'probe-result', kind, devices: rows });
        renderCalTable();
        const done = rows.every((r) => !r.reliable || Math.abs(r.errorMs) <= 2);
        if (kind !== 'calibrate' || done) break;
        await sleep(500); // let the corrections land before verifying
      }
      const measured = [...calResults.values()].filter((r) => deviceIds.includes(r.deviceId) && r.reliable);
      if (failed) {
        // message already shown
      } else if (measured.length) {
        const worst = Math.max(...measured.map((r) => Math.abs(r.errorMs)));
        setCalMsg(`${kind === 'calibrate' ? 'Calibration' : 'Sync test'} done: ${measured.length}/${deviceIds.length} devices measured; ` +
          `largest audible offset vs laptop in the last pass: ${worst.toFixed(1)} ms.`, 'ok');
      } else {
        setCalMsg('No device was heard clearly. Turn phone volume up, move phones closer to the laptop, and keep the room quiet.', 'bad');
      }
    } catch (err) {
      setCalMsg(`Measurement failed: ${err.message}`, 'bad');
    } finally {
      probeRunning = false;
      render();
    }
  }

  function renderCalTable() {
    const tbody = $('calTable').querySelector('tbody');
    tbody.innerHTML = '';
    for (const r of calResults.values()) {
      const tr = document.createElement('tr');
      const err = r.errorMs == null ? '—' : `${signed(r.errorMs, 1)} ms ${r.errorMs > 0 ? '(later)' : '(earlier)'}`;
      for (const c of [deviceName(r.deviceId), err, `${r.heard}/${r.total}`, r.spreadMs == null ? '—' : `${r.spreadMs.toFixed(1)} ms`, r.action]) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    $('calTable').hidden = calResults.size === 0;
  }

  $('calNow').addEventListener('click', () => runAcoustic('calibrate', calibratableIds()));
  $('syncTest').addEventListener('click', () => runAcoustic('verify', calibratableIds()));

  $('autoCal').checked = pref.get('autoCal') === '1';
  $('autoCal').addEventListener('change', async (e) => {
    pref.set('autoCal', e.target.checked ? '1' : '0');
    if (!e.target.checked) return;
    try {
      await recorder.open();
      setCalMsg('Microphone ready. Phones are calibrated automatically when they join (while nothing is playing).', 'ok');
    } catch (err) {
      e.target.checked = false;
      pref.set('autoCal', '0');
      setCalMsg(micError(err), 'bad');
    }
  });

  // Auto mode: calibrate devices that haven't been measured this session,
  // only while the room is quiet; give up on a device after 3 tries.
  setInterval(() => {
    if (!$('autoCal').checked || probeRunning || !player.speakerEnabled) return;
    const pb = player.playback;
    if ((pb && pb.status === 'playing') || live.active) return;
    const now = Date.now();
    const need = devices.filter((d) => {
      const s = d.status || {};
      if (d.role !== 'client' || !d.connected || !s.speakerEnabled || (s.clockSamples || 0) < 10) return false;
      if (s.calibrationSource === 'acoustic') return false;
      const a = calAttempts.get(d.id);
      return !a || (a.count < 3 && now - a.lastAt > 60000);
    });
    if (!need.length) return;
    for (const d of need) {
      const a = calAttempts.get(d.id) || { count: 0 };
      calAttempts.set(d.id, { count: a.count + 1, lastAt: now });
    }
    runAcoustic('calibrate', need.map((d) => d.id));
  }, 2000);

  // ── Developer diagnostics + CSV log ──

  let logInfo = { enabled: false };
  function applyLogInfo(info) {
    if (!info) return;
    logInfo = info;
    $('logBtn').textContent = info.enabled ? 'Stop CSV log' : 'Start CSV log';
    $('logDownload').disabled = !info.file;
    $('logInfo').textContent = info.file
      ? `${info.enabled ? 'Recording' : 'Stopped'}: ${info.file} (${info.rows} rows)`
      : 'One row per device per second: timestamp, device, clock offset, latency, drift, correction, …';
  }
  $('logBtn').addEventListener('click', () => conn.send({ type: 'log', enabled: !logInfo.enabled }));
  $('logDownload').addEventListener('click', async () => {
    const res = await fetch(`/api/rooms/${room.roomId}/sync-log.csv`, { headers: { 'X-Master-Token': room.token } });
    if (!res.ok) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = logInfo.file || 'sync-log.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  $('devMode').checked = pref.get('devMode') === '1';
  $('devMode').addEventListener('change', (e) => {
    pref.set('devMode', e.target.checked ? '1' : '0');
    renderDevPanel();
  });

  const fmtMs = (v, digits = 1, sign = false) => (v == null || !Number.isFinite(v) ? '—' : `${sign ? signed(v, digits) : v.toFixed(digits)} ms`);
  const CAL_SOURCE = { acoustic: 'measured (mic)', 'previous-session': 'from last session', stale: 'stale — recalibrate', none: 'not measured', reference: 'reference' };

  /** Device's total audio latency estimate: reported output latency + extra measured acoustically. */
  function latencyEstimate(s) {
    if (s.outputLatencyMs == null) return null;
    return s.outputLatencyMs - (s.calibrationMs || 0);
  }

  function correctionText(s) {
    if (s.correctionRate == null) return '—';
    const pct = (s.correctionRate - 1) * 100;
    return `${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(3)} % (${s.correctionRate.toFixed(5)}×, ${s.correctionZone || '—'})`;
  }

  function stateOf(d) {
    if (!d.connected) return 'DISCONNECTED';
    return (d.status && d.status.syncState) || 'CONNECTING';
  }

  function renderDevPanel() {
    const on = $('devMode').checked;
    $('devPanel').hidden = !on;
    if (!on) return;
    const mt = clock.masterNow();
    const time = new Date(mt).toISOString().slice(11, 23);
    $('devHead').textContent = `Room ${room ? room.roomId : '—'} · Master clock ${time} UTC · Mode ${SYNC_PROFILES[syncProfile].label}` +
      ` · tolerance ±${SYNC_PROFILES[syncProfile].syncedMs} ms · ${probeRunning ? 'acoustic probe running' : 'idle'}`;
    const box = $('devCards');
    box.innerHTML = '';
    for (const d of devices) {
      const s = d.status || {};
      const card = document.createElement('div');
      card.className = 'dev-card';
      const h = document.createElement('h3');
      const nm = document.createElement('span');
      nm.textContent = `${d.role === 'master' ? '💻' : '📱'} ${d.name}`;
      const st = document.createElement('span');
      st.className = `state ${stateOf(d)}`;
      st.textContent = d.role === 'master' ? `MASTER · ${stateOf(d)}` : stateOf(d);
      h.append(nm, st);
      const rows = [
        ['Clock offset', s.offsetMs == null ? 'measuring…' : `${fmtMs(s.offsetMs, 1, true)} ± ${fmtMs(s.clockUncertaintyMs)}`],
        ['Network RTT', `${fmtMs(s.rttMs)} (best ${fmtMs(s.bestRttMs)})`],
        ['Clock drift', s.clockDriftPpm == null ? '—' : `${signed(s.clockDriftPpm, 0)} ppm`],
        ['Audio latency', `${fmtMs(latencyEstimate(s), 0)} (reported ${fmtMs(s.outputLatencyMs, 0)})`],
        ['Calibration', `${fmtMs(s.calibrationMs, 1, true)} — ${CAL_SOURCE[d.role === 'master' ? 'reference' : s.calibrationSource] || '—'}`],
        ['Effective offset', fmtMs(s.trimMs, 1, true)],
        ['Playback position', positionText(s)],
        ['Playback drift', `${fmtMs(s.playbackDriftMs, 1, true)} / smoothed ${fmtMs(s.smoothedDriftMs, 1, true)}`],
        ['Correction', correctionText(s)],
        ['Learned skew', s.skewBiasPpm == null ? '—' : `${signed(s.skewBiasPpm, 0)} ppm`],
        ['Resyncs / reconnects', `${s.resyncs ?? 0} / ${s.reconnects ?? 0}`],
        ['Last clock sync', s.lastSyncAgeMs == null ? '—' : `${(s.lastSyncAgeMs / 1000).toFixed(1)} s ago (${s.clockSamples} samples)`],
        ['Timing method', s.timingMethod || '—'],
      ];
      if (s.spatialOn) rows.push(['Spatial position', spatialText(d)]);
      if (s.state === 'live') rows.push(['Live buffer', `${fmtMs(s.liveBufferMs, 0)} · ${s.liveLate || 0} late`]);
      const dl = document.createElement('dl');
      for (const [k, v] of rows) {
        const dt = document.createElement('dt');
        dt.textContent = k;
        const dd = document.createElement('dd');
        dd.textContent = v;
        dl.append(dt, dd);
      }
      card.append(h, dl);
      box.appendChild(card);
    }
  }

  // ── Live mode ──

  const LIVE_HELP = {
    tab: 'Open music.apple.com (or Spotify / YouTube) in another tab of THIS browser and start the music. ' +
      'Click START LIVE, choose that tab and keep "Share tab audio" on. The tab goes quiet by itself and ' +
      'its sound comes out of the laptop and the phones together, in sync.',
    device: 'For the Apple Music app (or any desktop app): install the free VB-CABLE driver (vb-audio.com/Cable). ' +
      'In Windows Settings → System → Sound → Volume mixer, set Apple Music\'s output device to "CABLE Input". ' +
      'Then pick "CABLE Output" below (click "Refresh list" if names are missing). ' +
      'Do not pick a real microphone while "Play on this laptop too" is on: it will feed back.',
    screen: 'Captures everything the laptop plays. Choose "Entire screen" and tick "Share system audio". ' +
      'The laptop speakers already play the sound directly, so they will be ahead of the phones by the latency ' +
      'buffer; turn the laptop volume down and use the phones as the speakers. (SyncWave itself stays silent ' +
      'on the laptop in this mode to avoid an echo loop.)',
    test: 'Streams a click every second from this page — no capture setup needed. Use it to check sync by ear: ' +
      'one crisp click = in sync, a double click = off by 15–40 ms.',
  };

  function selectedMode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }

  document.querySelectorAll('input[name="mode"]').forEach((r) => {
    r.addEventListener('change', () => {
      const mode = selectedMode();
      if (mode !== 'live' && live.active) stopLive();
      if (mode !== 'file' && player.playback && player.playback.status === 'playing') conn.send({ type: 'stop' });
      if (mode !== 'live') conn.send({ type: 'set-source', source: mode });
      if (api.onModeChange) api.onModeChange(mode);
      render();
    });
  });

  $('liveSource').addEventListener('change', () => {
    renderLiveHelp();
    if ($('liveSource').value === 'device') refreshDevices(false);
  });

  $('delay').addEventListener('input', () => {
    const ms = Number($('delay').value);
    $('delayText').textContent = `${ms} ms`;
    live.capture.delayMs = ms; // takes effect on the next chunk; devices re-sync once
  });

  /** List audio inputs. Names are only visible after the browser has granted microphone access once. */
  async function refreshDevices(askPermission) {
    const md = navigator.mediaDevices;
    if (!md || !md.enumerateDevices) return;
    try {
      let devices = await md.enumerateDevices();
      const unnamed = devices.some((d) => d.kind === 'audioinput' && !d.label);
      if (unnamed && askPermission) {
        const s = await md.getUserMedia({ audio: true });
        s.getTracks().forEach((t) => t.stop());
        devices = await md.enumerateDevices();
      }
      const select = $('liveDevice');
      const prev = select.value;
      select.innerHTML = '';
      const inputs = devices.filter((d) => d.kind === 'audioinput');
      for (const d of inputs) {
        const opt = document.createElement('option');
        opt.value = d.deviceId;
        opt.textContent = d.label || (d.deviceId === 'default' ? 'Default input' : 'Audio input (name hidden)');
        select.appendChild(opt);
      }
      if (inputs.length === 0) select.innerHTML = '<option value="">No audio inputs found</option>';
      const cable = inputs.find((d) => /cable output|vb-audio|blackhole|loopback|stereo mix/i.test(d.label));
      select.value = inputs.some((d) => d.deviceId === prev) ? prev : cable ? cable.deviceId : select.options[0].value;
      if (!cable && inputs.every((d) => d.label)) {
        setLiveMsg('No virtual cable found. Install VB-CABLE, then click "Refresh list".', 'warn');
      }
    } catch (e) {
      setLiveMsg(`Could not list audio inputs: ${e.message}`, 'bad');
    }
  }
  $('refreshDevices').addEventListener('click', () => refreshDevices(true));

  async function startLive() {
    const kind = $('liveSource').value;
    setLiveMsg(kind === 'tab' ? 'Choose the tab to share…' : kind === 'screen' ? 'Choose "Entire screen"…' : 'Starting…');
    $('liveStartBtn').disabled = true;
    try {
      live.capture.delayMs = Number($('delay').value);
      const info = await live.capture.start(kind, { deviceId: $('liveDevice').value });
      live.kind = kind;
      live.receiver.reset();
      conn.send({ type: 'live-start', sampleRate: info.sampleRate, channels: info.channels, delayMs: live.capture.delayMs, source: kind });
      setLiveMsg('Live. Phones need "Enable Speaker" tapped to hear it.', 'ok');
    } catch (e) {
      live.capture.stop();
      const cancelled = e && (e.name === 'NotAllowedError' || e.name === 'AbortError');
      setLiveMsg(cancelled ? 'Capture was cancelled or not allowed.' : e.message, 'bad');
    } finally {
      render();
    }
  }

  function stopLive() {
    live.capture.stop();
    live.receiver.reset();
    conn.send({ type: 'live-stop' });
    resetLevel();
    setLiveMsg('');
  }

  $('liveStartBtn').addEventListener('click', startLive);
  $('liveStopBtn').addEventListener('click', stopLive);

  function applyLive(state) {
    const wasActive = live.active;
    live.active = !!(state && state.active);
    if (!live.active && wasActive) {
      // Ended by the server (e.g. a file was played): release the capture.
      live.capture.stop();
      live.receiver.reset();
      resetLevel();
    }
    if (live.active) document.querySelector('input[name="mode"][value="live"]').checked = true;
    applyLocalMute();
    render();
  }

  let levelShown = 0;
  function showLevel(peak) {
    levelShown = Math.max(peak, levelShown * 0.9); // ~23 chunks/s → falls off over ~0.5 s
    $('meterBar').style.width = `${Math.round(Math.min(1, levelShown) * 100)}%`;
  }
  function resetLevel() {
    levelShown = 0;
    $('meterBar').style.width = '0%';
  }

  function setLiveMsg(text, cls) {
    const el = $('liveMsg');
    el.textContent = text || '';
    el.className = `msg ${cls || ''}`;
  }

  function renderLiveHelp() {
    const kind = $('liveSource').value;
    $('liveHelp').textContent = LIVE_HELP[kind];
    $('deviceRow').hidden = kind !== 'device';
  }

  // ── Rendering ──

  function setConn(text, cls) {
    const el = $('connStatus');
    el.textContent = text;
    el.className = `pill ${cls || ''}`;
  }

  function setTrackMsg(text, cls) {
    const el = $('trackMsg');
    el.textContent = text || '';
    el.className = `msg ${cls || ''}`;
  }

  function showFatal(text) {
    $('fatal').textContent = text;
    $('fatal').hidden = false;
  }

  function setProgress(el, frac) {
    el.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
  }

  function renderRoom() {
    $('roomId').textContent = room.roomId;
    document.title = `SyncWave · Room ${room.roomId}`;
    const select = $('iface');
    select.innerHTML = '';
    room.joinUrls.forEach((j, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = j.label;
      select.appendChild(opt);
    });
    const saved = loadSaved() || {};
    const idx = Math.min(Number(saved.iface) || 0, room.joinUrls.length - 1);
    select.value = String(idx);
    $('ifaceWrap').hidden = room.joinUrls.length < 2;
    showJoin(idx);
  }

  function showJoin(i) {
    const j = room.joinUrls[i];
    if (!j) return;
    $('qr').src = j.qr;
    $('joinUrl').textContent = j.url;
    $('joinUrl').href = j.url;
  }

  $('iface').addEventListener('change', (e) => {
    const i = Number(e.target.value);
    showJoin(i);
    save({ ...(loadSaved() || {}), iface: i });
  });

  const STATE_LABEL = {
    'no-track': 'no track',
    idle: 'idle',
    downloading: 'downloading',
    downloaded: 'downloaded',
    decoding: 'decoding',
    'speaker-off': 'speaker off',
    ready: 'ready',
    waiting: 'waiting',
    scheduled: 'starting…',
    playing: 'playing',
    paused: 'paused',
    ended: 'ended',
    error: 'error',
  };

  function deviceStateText(d) {
    const s = d.status || {};
    if (!s.state) return '—';
    if (s.state === 'downloading') return `downloading ${Math.round((s.loadProgress || 0) * 100)}%`;
    if (s.state === 'live') {
      let t = `live · buffer ${s.liveBufferMs != null ? s.liveBufferMs.toFixed(0) : '?'} ms`;
      if (s.liveLate) t += ` · ${s.liveLate} late`;
      if (s.liveResyncs) t += ` · ${s.liveResyncs} resyncs`;
      return t;
    }
    if (s.state === 'live-waiting') return 'live · no audio arriving';
    if (s.state === 'error') return `error: ${s.error || ''}`;
    return STATE_LABEL[s.state] || s.state;
  }

  function isReady(d, trackId) {
    const s = d.status || {};
    return s.trackId === trackId && ['ready', 'waiting', 'scheduled', 'playing', 'paused', 'ended'].includes(s.state);
  }

  function renderDevices() {
    const list = $('deviceList');
    list.innerHTML = '';
    for (const d of devices) {
      const s = d.status || {};
      const li = document.createElement('li');
      const left = document.createElement('span');
      left.textContent = `${d.role === 'master' ? '💻' : '📱'} ${d.name}`;
      const meta = document.createElement('span');
      meta.className = 'meta';
      const lat = latencyEstimate(s);
      const drift = s.smoothedDriftMs ?? s.playbackDriftMs;
      meta.textContent = d.connected
        ? `Latency: ${lat == null ? '—' : `${lat.toFixed(0)} ms`} · Drift: ${drift == null ? '—' : `${signed(drift, 0)} ms`}` +
          `${d.role === 'client' && s.calibrationSource === 'acoustic' ? ' · mic-calibrated' : ''}`
        : `last seen ${Math.round((Date.now() - d.lastSeen) / 1000)} s ago`;
      left.appendChild(meta);
      const tag = document.createElement('span');
      const st = d.role === 'master' ? 'MASTER' : stateOf(d);
      tag.className = `state ${st}`;
      tag.textContent = st;
      li.append(left, tag);
      list.appendChild(li);
    }
    renderReady();
    renderSpatialPanel();
    renderSummary();
    renderDevPanel();
  }

  /**
   * Devices report once a second at different moments; while playing, advance
   * each report to "now" so the column compares like with like.
   */
  function positionText(s) {
    if (s.state === 'live') return 'live';
    if (s.position == null) return '—';
    let pos = s.position;
    if (s.state === 'playing' && s.reportedAt) pos += Math.max(0, clock.masterNow() - s.reportedAt) / 1000;
    return `${pos.toFixed(3)} s`;
  }

  /** What the device itself reports it is rendering — not what we asked for. */
  function spatialText(d) {
    const s = d.status || {};
    if (typeof s.spatialX !== 'number') return '—';
    if (!s.spatialOn) return `${fmtX(s.spatialX)} (off)`;
    const pct = (g) => `${Math.round(g * 100)}%`;
    return `${fmtX(s.spatialX)} · L ${pct(s.gainL)} R ${pct(s.gainR)}`;
  }

  function signed(v, digits) {
    const r = Number(v.toFixed(digits)) || 0; // avoid "-0"
    return `${r >= 0 ? '+' : ''}${r.toFixed(digits)}`;
  }

  function renderReady() {
    const pb = player.playback;
    const clients = devices.filter((d) => d.role === 'client' && d.connected);
    if (live.active) {
      const hearing = clients.filter((d) => d.status && d.status.state === 'live');
      const off = clients.filter((d) => d.status && d.status.state === 'speaker-off').map((d) => d.name);
      $('readyText').textContent = clients.length
        ? `${hearing.length}/${clients.length} phones playing live.${off.length ? ` Speaker not enabled on: ${off.join(', ')}` : ''}`
        : 'No phones connected yet.';
      return;
    }
    if (!pb || !pb.trackId) {
      $('readyText').textContent = clients.length ? `${clients.length} phone(s) connected.` : 'No phones connected yet.';
      return;
    }
    const ready = clients.filter((d) => isReady(d, pb.trackId));
    const notReady = clients.filter((d) => !isReady(d, pb.trackId)).map((d) => `${d.name}: ${deviceStateText(d)}`);
    $('readyText').textContent = clients.length
      ? `${ready.length}/${clients.length} phones ready.${notReady.length ? ` Waiting on — ${notReady.join(', ')}` : ''}`
      : 'No phones connected yet.';
  }

  function renderAll() {
    const pb = player.playback;
    const hasTrack = !!(pb && pb.trackId && player.track);
    $('trackName').textContent = player.track ? player.track.name : 'No track selected';
    $('playBtn').disabled = !hasTrack || uploading;
    $('pauseBtn').disabled = !pb || pb.status !== 'playing';
    $('stopBtn').disabled = !pb || pb.status === 'stopped';
    seek.disabled = !hasTrack || !player.duration;
    if (player.loadState === 'error') setTrackMsg(player.error, 'bad');

    const showHint = !player.speakerEnabled && !player.muted && ((pb && pb.status === 'playing') || live.active);
    $('speakerHint').hidden = !showHint;

    const mode = selectedMode();
    $('fileMode').hidden = mode !== 'file';
    $('liveMode').hidden = mode !== 'live';
    const capturing = live.capture.active;
    $('liveStartBtn').disabled = capturing;
    $('liveStopBtn').disabled = !capturing && !live.active;
    $('liveSource').disabled = capturing;
    $('liveDevice').disabled = capturing;
    $('calNow').disabled = probeRunning;
    $('syncTest').disabled = probeRunning;
    renderPlayback();
  }

  function renderPlayback() {
    const pb = player.playback;
    const dur = player.duration || 0;
    const pos = Math.min(currentPosition(), dur || Infinity);
    $('durText').textContent = formatTime(dur);
    seek.max = String(dur);
    if (!seeking) {
      $('posText').textContent = formatTime(pos);
      seek.value = String(pos);
    }
    let state = '';
    if (pb) {
      if (pb.status === 'playing') {
        const startsIn = pb.startAt - clock.masterNow();
        state = startsIn > 0 ? `starting in ${(startsIn / 1000).toFixed(1)} s` : 'playing';
      } else {
        state = pb.status;
      }
    }
    $('playState').textContent = state ? `· ${state}` : '';

    // Reached the end: stop the room so Play starts from the top next time.
    if (pb && pb.status === 'playing' && !pb.loop && dur && pos >= dur && autoStoppedSeq !== pb.seq) {
      autoStoppedSeq = pb.seq;
      conn.send({ type: 'stop' });
    }
  }

  // Playback clock display + status report for diagnostics.
  setInterval(() => {
    renderPlayback();
    renderTestPhase();
  }, 250);
  function reportStatus() {
    if (!room) return;
    const status = buildStatus(clock, player, live.active ? live.receiver : undefined);
    if (renderer) Object.assign(status, renderer.status());
    if (!clock.converged || probeRunning) status.syncState = 'CALIBRATING';
    status.calibrationSource = 'reference'; // the laptop is what everyone is aligned to
    status.calibrating = probeRunning;
    status.reconnects = conn.reconnects;
    if (api.extraStatus) Object.assign(status, api.extraStatus(status));
    conn.send({ type: 'status', status });
  }
  setInterval(reportStatus, 1000);

  // A suspended AudioContext can already decode, so the track (and its duration)
  // is ready before the first click. Output still waits for a user gesture.
  try { player.ensureContext(); } catch (e) { showFatal(e.message); }
  renderLiveHelp();
  renderSpatialPanel();
  // For poking at things from the browser console while experimenting.
  window.syncwaveDebug = { player, clock, live, recorder, calResults, get renderer() { return renderer; } };
  Object.assign(api, {
    conn, clock, player, calResults, signed, render, selectedMode, setSyncProfile,
    devices: () => devices,
    room: () => room,
    syncProfile: () => syncProfile,
    runAcoustic: (kind, ids) => runAcoustic(kind, ids),
    probeRunning: () => probeRunning,
  });
  setSyncProfile('music');
  applyLogInfo({ enabled: false });
  // Re-open the microphone if auto-calibration was left on (works without a
  // prompt once permission was granted for this page).
  if ($('autoCal').checked) recorder.open().catch((err) => setCalMsg(micError(err), 'warn'));
  if (!window.isSecureContext) {
    setLiveMsg(`Live mode needs this page opened as http://localhost:${location.port || 80} on the laptop.`, 'warn');
  }

  conn.connect();
  render();
})();
