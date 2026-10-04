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
    SpatialRenderer, SpatialTest, SPATIAL_DEFAULTS,
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
        applyLive(msg.live);
        applySpatial(msg.spatial);
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
        renderDevices();
        break;
      case 'room-closed':
        clearSaved(); // the socket closes next; on reconnect we create a fresh room
        break;
      case 'error':
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
    return pb.position + Math.max(0, clock.masterNow() - pb.startAt) / 1000;
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
    conn.send({ type: 'play', startAt: clock.masterNow() + leadTimeMs(), position });
  }

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
    if (!roomPlaying) return { text: 'IDLE (nothing playing)', cls: '', note: '' };
    const playing = connected.filter((d) => d.status && (d.status.state === 'playing' || d.status.state === 'live'));
    if (playing.length === 0) return { text: 'NOT PLAYING YET', cls: 'warn', note: '' };
    const errs = playing.map((d) => Math.abs(d.status.playbackDriftMs)).filter(Number.isFinite);
    if (errs.length === 0) return { text: 'MEASURING…', cls: '', note: '' };
    const worst = Math.max(...errs);
    const worstRtt = Math.max(0, ...playing.map((d) => d.status.rttMs || 0));
    let text = worst <= 5 ? 'SYNCED' : worst <= 20 ? 'ROUGHLY SYNCED' : 'OUT OF SYNC';
    let cls = worst <= 5 ? 'ok' : worst <= 20 ? 'warn' : 'bad';
    if (playing.length < connected.length) {
      text += ` — only ${playing.length}/${connected.length} devices playing`;
      cls = 'warn';
    }
    const note = `Worst reported timing error: ${worst.toFixed(1)} ms (each device's estimate against the master clock; ` +
      `clock-offset uncertainty up to ~${(worstRtt / 2).toFixed(1)} ms). Speaker/acoustic latency is NOT measured — ` +
      `trust your ears.${worst > 20 ? ' Press PLAY SYNCED to re-align.' : ''}`;
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
      if (mode === 'file' && live.active) stopLive();
      if (mode === 'live' && player.playback && player.playback.status === 'playing') conn.send({ type: 'stop' });
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
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = `${d.role === 'master' ? '💻' : '📱'} ${d.name}`;
      const tag = document.createElement('span');
      if (d.role === 'master') {
        tag.className = 'tag master';
        tag.textContent = 'MASTER';
      } else if (d.connected) {
        tag.className = 'tag ok';
        tag.textContent = 'CONNECTED';
      } else {
        tag.className = 'tag bad';
        tag.textContent = 'DISCONNECTED';
      }
      li.append(name, tag);
      list.appendChild(li);
    }

    const tbody = $('diag').querySelector('tbody');
    tbody.innerHTML = '';
    for (const d of devices) {
      const s = d.status || {};
      const ago = Math.round((Date.now() - d.lastSeen) / 1000);
      const cells = [
        `${d.role === 'master' ? '💻' : '📱'} ${d.name}`,
        spatialText(d),
        d.connected ? 'connected' : `disconnected (${ago}s)`,
        deviceStateText(d),
        positionText(s),
        s.offsetMs != null ? `${signed(s.offsetMs, 1)} ms` : 'measuring…',
        s.rttMs != null ? `${s.rttMs.toFixed(1)} ms` : '—',
        driftText(s),
        s.outputLatencyMs != null ? `${s.outputLatencyMs.toFixed(0)} ms${s.timingMethod ? ` (${s.timingMethod})` : ''}` : '—',
      ];
      const tr = document.createElement('tr');
      for (const c of cells) {
        const td = document.createElement('td');
        td.textContent = c;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    renderReady();
    renderSpatialPanel();
    renderSummary();
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

  function driftText(s) {
    const parts = [];
    if (s.clockDriftPpm != null) parts.push(`clock ${signed(s.clockDriftPpm, 0)} ppm`);
    if (s.playbackDriftMs != null) parts.push(`playback ${signed(s.playbackDriftMs, 1)} ms`);
    return parts.join(' · ') || '—';
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
    if (pb && pb.status === 'playing' && dur && pos >= dur && autoStoppedSeq !== pb.seq) {
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
    conn.send({ type: 'status', status });
  }
  setInterval(reportStatus, 1000);

  // A suspended AudioContext can already decode, so the track (and its duration)
  // is ready before the first click. Output still waits for a user gesture.
  try { player.ensureContext(); } catch (e) { showFatal(e.message); }
  renderLiveHelp();
  renderSpatialPanel();
  // For poking at things from the browser console while experimenting.
  window.syncwaveDebug = { player, clock, live, get renderer() { return renderer; } };
  if (!window.isSecureContext) {
    setLiveMsg(`Live mode needs this page opened as http://localhost:${location.port || 80} on the laptop.`, 'warn');
  }

  conn.connect();
  render();
})();
