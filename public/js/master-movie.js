/*
 * master-movie.js — 🎬 Movie Sync on the Master (laptop).
 *
 * The laptop's <video> is the reference. This file:
 *   - loads the movie, extracts its audio track and uploads it (movie-extract.js)
 *   - drives the video with *planned* controls: play / pause / seek / speed are
 *     announced to every device with a master-clock time a little in the
 *     future, so nobody has to react to "now"
 *   - publishes the video's real timeline from requestVideoFrameCallback
 *     (MasterVideoClock), once a second and right after every start
 *   - learns how long the video element takes to actually start, so planned
 *     starts land on time
 *   - plays the laptop's own movie sound through the same MovieAudioPlayer as
 *     the phones (the <video> element stays muted)
 *   - shows Movie Sync diagnostics and the movie calibration panel
 */
(function () {
  'use strict';

  const api = window.SyncWaveMasterAPI;
  const { MovieAudioPlayer, MasterVideoClock, formatTime, SYNC_PROFILES } = window.SyncWave;
  const $ = (id) => document.getElementById(id);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const PLAN_LEAD_MS = 700;        // planned start: devices get this long to prepare
  const PAUSE_LEAD_MS = 150;

  const video = $('movieVideo');
  video.muted = true;               // all movie sound comes from the synced players
  video.controls = false;

  const audio = new MovieAudioPlayer(api.player, { onChange: () => api.render() });
  const vclock = new MasterVideoClock(video, api.clock, onAnchor);

  let movie = null;                 // server's movie state
  let clockState = { epoch: 0, playing: false, videoTime: 0, masterTime: 0, rate: 1, avOffsetMs: 0 };
  let epoch = 0;
  let avOffsetMs = 0;
  let loadedFile = null;
  let preparing = false;
  let createWaiter = null;
  let videoStartLatencyMs = 80;     // learned: play() → frames actually advancing on screen
  let lastStartErrorMs = null;
  let plannedStart = null;
  let ownAction = 0;                // >0 while we are driving the video ourselves
  let lastPlayAt = 0;
  let seeking = false;

  const fmt = (v, d = 1, sign = false) => (v == null || !Number.isFinite(v) ? '—' : `${sign ? api.signed(v, d) : v.toFixed(d)} ms`);
  function hms(sec) {
    if (sec == null || !Number.isFinite(sec)) return '—';
    const ms = Math.floor((sec % 1) * 1000);
    return `${formatTime(sec)}.${String(ms).padStart(3, '0')}`;
  }
  function setMsg(text, cls) {
    $('movieMsg').textContent = text || '';
    $('movieMsg').className = `msg ${cls || ''}`;
  }

  // ── Movie clock publishing ──

  function publish(c) {
    clockState = { ...c, avOffsetMs };
    audio.setClock(clockState);                          // the laptop's own sound, immediately
    api.conn.send({ type: 'movie-sync', clock: clockState });
  }

  /** Anchor from the real video frames (MasterVideoClock). */
  function onAnchor(a) {
    if (video.paused || seeking || !clockState.playing) return;
    if (plannedStart && plannedStart.epoch === epoch) {
      // When would frame V have been on screen, judging by the real frames?
      const actualStart = a.masterTime - ((a.videoTime - plannedStart.V) / a.rate) * 1000;
      lastStartErrorMs = actualStart - plannedStart.T;   // + = video started late
      videoStartLatencyMs = clamp(videoStartLatencyMs + 0.7 * lastStartErrorMs, 0, 600);
      plannedStart = null;
    }
    publish({ epoch, playing: true, videoTime: a.videoTime, masterTime: a.masterTime, rate: a.rate, source: a.method });
  }

  function movieReadyAt(pos) {
    if (!movie) return false;
    const ready = movie.readyFrames / movie.sampleRate;
    return movie.status === 'ready' || ready >= Math.min(movie.duration, pos + 20);
  }

  /** ★ Planned play: "frame V will be on screen at master time T" — then make it so. */
  function play() {
    if (!loadedFile) return setMsg('Choose a movie first.', 'warn');
    if (!movieReadyAt(video.currentTime)) return setMsg('Still preparing the movie audio…', 'warn');
    if (!video.paused) return;
    if (video.ended) video.currentTime = 0;
    epoch++;
    vclock.reset();
    const V = video.currentTime;
    const R = Number($('mRate').value) || 1;
    video.playbackRate = R;
    const T = api.clock.masterNow() + PLAN_LEAD_MS;
    plannedStart = { T, V, epoch };
    publish({ epoch, playing: true, videoTime: V, masterTime: T, rate: R, planned: true, source: 'plan' });
    const wait = T - api.clock.masterNow() - videoStartLatencyMs;
    setTimeout(() => {
      lastPlayAt = performance.now();
      ownAction++;
      video.play().catch((e) => setMsg(`The video could not start: ${e.message}`, 'bad')).finally(() => { ownAction--; });
    }, Math.max(0, wait));
  }

  /** Planned pause: everyone stops at the same master time. */
  function pause() {
    if (video.paused) return;
    epoch++;
    const Tp = api.clock.masterNow() + PAUSE_LEAD_MS;
    const Vp = vclock.positionAt(Tp);
    publish({ epoch, playing: false, videoTime: Vp, masterTime: Tp, rate: video.playbackRate });
    const myEpoch = epoch;
    setTimeout(() => {
      ownAction++;
      video.pause();
      ownAction--;
      // Refine the cue point to where the picture really stopped.
      if (epoch === myEpoch) publish({ epoch, playing: false, videoTime: video.currentTime, masterTime: Tp, rate: video.playbackRate });
    }, PAUSE_LEAD_MS);
  }

  /** Seek: stop sound now, move the picture, then (if it was playing) a planned restart. */
  async function seekTo(pos) {
    if (!loadedFile) return;
    const wasPlaying = !video.paused;
    seeking = true;
    epoch++;
    publish({ epoch, playing: false, videoTime: pos, masterTime: api.clock.masterNow(), rate: video.playbackRate });
    ownAction++;
    video.pause();
    video.currentTime = clamp(pos, 0, video.duration || pos);
    await new Promise((r) => video.addEventListener('seeked', r, { once: true }));
    ownAction--;
    seeking = false;
    publish({ epoch, playing: false, videoTime: video.currentTime, masterTime: api.clock.masterNow(), rate: video.playbackRate });
    if (wasPlaying) play();
  }

  async function setRate(rate) {
    if (video.paused) { video.playbackRate = rate; return; }
    pause();
    await new Promise((r) => setTimeout(r, PAUSE_LEAD_MS + 60));
    play();
  }

  // Events we didn't cause (stall, end of file).
  video.addEventListener('waiting', () => {
    if (ownAction || video.paused || !clockState.playing) return;
    if (plannedStart || performance.now() - lastPlayAt < 1500) return; // normal start-up, not a stall
    epoch++;
    publish({ epoch, playing: false, videoTime: video.currentTime, masterTime: api.clock.masterNow(), rate: video.playbackRate });
    setMsg('Video stalled — sound paused until it continues.', 'warn');
  });
  video.addEventListener('playing', () => {
    if (ownAction || clockState.playing || seeking) return;
    // Resumed by itself after a stall: devices re-join on the real frames.
    epoch++;
    vclock.reset();
    publish({ epoch, playing: true, videoTime: video.currentTime, masterTime: api.clock.masterNow(), rate: video.playbackRate, source: 'resume' });
    setMsg('');
  });
  video.addEventListener('pause', () => {
    // Paused by something other than our controls (e.g. the browser suspending
    // a hidden video): stop the sound where the picture stopped.
    if (ownAction || seeking || !clockState.playing || video.ended) return;
    epoch++;
    publish({ epoch, playing: false, videoTime: video.currentTime, masterTime: api.clock.masterNow(), rate: video.playbackRate });
  });
  video.addEventListener('ended', () => {
    epoch++;
    publish({ epoch, playing: false, videoTime: video.duration, masterTime: api.clock.masterNow(), rate: video.playbackRate });
  });

  $('mPlay').addEventListener('click', play);
  $('mPause').addEventListener('click', pause);
  $('mBack').addEventListener('click', () => seekTo(Math.max(0, video.currentTime - 10)));
  $('mFwd').addEventListener('click', () => seekTo(video.currentTime + 10));
  $('mRate').addEventListener('change', () => setRate(Number($('mRate').value) || 1));
  const seekBar = $('mSeek');
  let dragging = false;
  seekBar.addEventListener('input', () => { dragging = true; $('mPos').textContent = formatTime(Number(seekBar.value)); });
  seekBar.addEventListener('change', () => { dragging = false; seekTo(Number(seekBar.value)); });
  $('avOffset').addEventListener('input', () => {
    avOffsetMs = Number($('avOffset').value);
    $('avOffsetText').textContent = `${avOffsetMs > 0 ? '+' : ''}${avOffsetMs} ms`;
  });
  $('avOffset').addEventListener('change', () => {
    // Same epoch: devices treat it as a timeline refinement and slide into place.
    publish({ ...clockState });
  });

  // ── Loading a movie ──

  function createServerMovie(name, sampleRate, duration) {
    return new Promise((resolve, reject) => {
      createWaiter = { resolve, reject };
      api.conn.send({ type: 'movie-create', name, sampleRate, duration });
      setTimeout(() => { if (createWaiter) { createWaiter = null; reject(new Error('Server did not answer.')); } }, 10000);
    });
  }

  async function uploadPcm(id, frame, int16) {
    const room = api.room();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`/api/rooms/${room.roomId}/movie/${id}/pcm?frame=${frame}`, {
        method: 'POST',
        headers: { 'X-Master-Token': room.token, 'Content-Type': 'application/octet-stream' },
        body: int16.buffer,
      }).catch(() => null);
      if (res && res.ok) return;
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('Uploading the movie audio failed.');
  }

  async function loadMovieFile(file) {
    if (preparing) return;
    if (!video.paused) pause();
    loadedFile = file;
    $('movieName').textContent = file.name;
    video.src = URL.createObjectURL(file);
    try {
      await new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('This browser cannot play this video (try MP4 H.264/AAC or WebM).')), { once: true });
      });
    } catch (e) {
      loadedFile = null;
      return setMsg(e.message, 'bad');
    }
    epoch++;
    publish({ epoch, playing: false, videoTime: 0, masterTime: api.clock.masterNow(), rate: 1 });

    // Same movie already prepared on the server (e.g. after reloading this page)? Reuse it.
    if (movie && movie.status === 'ready' && movie.name === file.name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').slice(-120) &&
        Math.abs(movie.duration - video.duration) < 1.5) {
      setMsg('Movie audio already prepared — ready.', 'ok');
      api.conn.send({ type: 'set-source', source: 'movie' });
      return;
    }

    preparing = true;
    $('moviePrep').hidden = false;
    const started = performance.now();
    setMsg('Preparing movie audio for all speakers…');
    let movieId = null;
    try {
      const { extractMovieAudio } = await import('/js/movie-extract.js');
      const result = await extractMovieAudio(file, {
        videoDuration: video.duration,
        onStart: async ({ sampleRate, duration }) => { movieId = await createServerMovie(file.name, sampleRate, duration); },
        onPcm: (frame, int16) => uploadPcm(movieId, frame, int16),
        onProgress: (p) => { $('moviePrep').firstElementChild.style.width = `${Math.round(p * 100)}%`; },
      });
      api.conn.send({ type: 'movie-complete', id: movieId, frames: result.frames });
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      const el = result.editList ? ` · audio edit list: start ${(result.editList.mediaStartS * 1000).toFixed(1)} ms` +
        `${result.editList.emptyS ? `, delay ${(result.editList.emptyS * 1000).toFixed(1)} ms` : ''}` : '';
      setMsg(`Ready: ${formatTime(result.duration)} of audio prepared in ${secs} s (${result.method}, ${result.codec})${el}.`, 'ok');
    } catch (e) {
      setMsg(`Could not prepare the movie audio: ${e.message}`, 'bad');
    } finally {
      preparing = false;
      $('moviePrep').hidden = true;
    }
  }

  $('movieChoose').addEventListener('click', () => $('movieInput').click());
  $('movieInput').addEventListener('change', (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) loadMovieFile(f);
  });

  $('makeTest').addEventListener('click', async () => {
    const seconds = Number($('testLen').value);
    $('makeTest').disabled = true;
    try {
      const { makeTestMovie } = await import('/js/testmovie.js');
      const { file, primingSamples } = await makeTestMovie({
        seconds,
        // Long test movies: lighter video so generation stays quick (sound is unaffected).
        ...(seconds > 600 ? { width: 480, height: 270, fps: 15 } : {}),
        onProgress: (p, label) => setMsg(`${label} ${Math.round(p * 100)}%`),
      });
      const a = $('testDownload');
      a.href = URL.createObjectURL(file);
      a.download = file.name;
      a.hidden = false;
      setMsg(`Test movie made (AAC priming ${primingSamples} samples, recorded in its edit list). Loading it…`);
      await loadMovieFile(file);
    } catch (e) {
      setMsg(`Could not make the test movie: ${e.message}`, 'bad');
    } finally {
      $('makeTest').disabled = false;
    }
  });

  // ── Messages from the server ──

  api.handlers.room = (msg) => {
    if (msg.movieClock) epoch = Math.max(epoch, msg.movieClock.epoch);
    if (msg.movie) { movie = msg.movie; audio.setMovie(movie); }
    if (msg.source === 'movie') {
      document.querySelector('input[name="mode"][value="movie"]').checked = true;
      onModeChange('movie');
      if (msg.movie && !loadedFile) setMsg('This room has a prepared movie. Choose the same file again to continue (its audio is kept).', 'warn');
    }
  };
  api.handlers.movie = (msg) => {
    movie = msg.movie;
    audio.setMovie(movie);
  };
  api.handlers['movie-created'] = (msg) => {
    if (createWaiter) { createWaiter.resolve(msg.id); createWaiter = null; }
  };
  api.handlers.error = (msg) => {
    if (createWaiter) { createWaiter.reject(new Error(msg.message)); createWaiter = null; } else setMsg(msg.message, 'bad');
  };
  api.handlers['movie-clock'] = () => { /* our own echo; the laptop already applied it */ };
  api.handlers.source = () => {};

  function onModeChange(mode) {
    const on = mode === 'movie';
    $('movieMode').hidden = !on;
    $('movieDiag').hidden = !on;
    audio.setActive(on);
    if (!on && !video.paused) pause();
    if (on && clockState) audio.setClock(clockState);
  }
  api.onModeChange = onModeChange;

  // Movie fields in the laptop's own status report.
  api.extraStatus = (status) => {
    if (api.selectedMode() !== 'movie') return {};
    const s = audio.status();
    const extra = { ...s };
    if (status.syncState !== 'CALIBRATING') extra.syncState = audio.syncState();
    extra.state = s.movieState;
    return extra;
  };

  // ── Diagnostics + calibration panel ──

  function likelyIssue(d, tol) {
    const s = d.status || {};
    if (!d.connected) return ['bad', 'disconnected — will resync when it reconnects'];
    if (s.movieState === 'speaker-off') return ['warn', 'speaker not enabled on the device'];
    if (s.movieState === 'buffering') return ['warn', 'network: audio not arriving fast enough'];
    if (clockState.playing && s.movieBufferS != null && s.movieBufferS < 3) return ['warn', `network: only ${s.movieBufferS.toFixed(1)} s buffered`];
    if ((s.clockUncertaintyMs || 0) > 5) return ['warn', `network/clock: Wi-Fi timing uncertain (±${s.clockUncertaintyMs.toFixed(1)} ms)`];
    if (s.movieSmoothedMs != null && Math.abs(s.movieSmoothedMs) > tol) return ['warn', 'drift: being corrected'];
    if (d.role === 'client' && s.calibrationSource !== 'acoustic') return ['', 'audio latency: browser estimate only (not measured)'];
    return ['ok', 'none detected'];
  }

  function cell(tr, text, cls) {
    const td = document.createElement('td');
    td.textContent = text;
    if (cls) td.className = cls;
    tr.appendChild(td);
    return td;
  }

  function renderDiag() {
    if ($('movieDiag').hidden) return;
    const tol = SYNC_PROFILES.movie.syncedMs;
    const now = api.clock.masterNow();
    const vpos = video.paused ? video.currentTime : vclock.positionAt(now);
    const a = vclock.anchor();
    $('movieDiagHead').textContent =
      `MASTER VIDEO ${hms(vpos)} · ${video.paused ? 'paused' : `playing ${video.playbackRate}×`} · clock source ${vclock.method}` +
      ` · learned video start delay ${videoStartLatencyMs.toFixed(0)} ms` +
      `${lastStartErrorMs != null ? ` (last start ${api.signed(lastStartErrorMs, 0)} ms vs plan)` : ''}` +
      ` · lip-sync offset ${avOffsetMs} ms · tolerance ±${tol} ms${a ? '' : ''}`;

    const tbody = $('movieTable').querySelector('tbody');
    tbody.innerHTML = '';
    const cal = $('movieCalTable').querySelector('tbody');
    cal.innerHTML = '';
    for (const d of api.devices()) {
      const s = d.status || {};
      const tr = document.createElement('tr');
      cell(tr, `${d.role === 'master' ? '💻' : '📱'} ${d.name}`);
      cell(tr, d.connected ? (s.syncState === 'DRIFTING' ? 'CORRECTING' : s.syncState || '—') : 'DISCONNECTED');
      let apos = s.movieAudioPos;
      if (apos != null && s.reportedAt && clockState.playing) apos += ((now - s.reportedAt) / 1000) * clockState.rate;
      cell(tr, hms(apos));
      // A/V difference = −error: + means the sound is early (ahead of the picture).
      cell(tr, s.movieSmoothedMs == null ? '—' : `${api.signed(s.movieSmoothedMs, 1)} ms`);
      cell(tr, fmt(s.outputLatencyMs, 0));
      const comp = (s.calibrationMs || 0) + (s.movieFineMs || 0);
      cell(tr, `${api.signed(comp, 1)} ms`);
      cell(tr, s.offsetMs == null ? '—' : `${api.signed(s.offsetMs, 1)} ± ${(s.clockUncertaintyMs || 0).toFixed(1)} ms`);
      cell(tr, fmt(s.rttMs, 1));
      cell(tr, s.movieBufferS == null ? '—' : `${s.movieBufferS.toFixed(0)} s`);
      const [cls, issue] = likelyIssue(d, tol);
      cell(tr, issue, cls ? `issue-${cls}` : '');
      tbody.appendChild(tr);

      // Calibration row.
      const cr = document.createElement('tr');
      cell(cr, `${d.role === 'master' ? '💻' : '📱'} ${d.name}`);
      cell(cr, s.outputLatencyMs == null ? '—' : `${s.outputLatencyMs.toFixed(0)} ms (estimated, already compensated)`);
      const src = d.role === 'master' ? 'reference' : s.calibrationSource;
      cell(cr, d.role === 'master' ? 'reference (0)' :
        src === 'acoustic' ? `${api.signed(-(s.calibrationMs || 0), 1)} ms → corrected` :
          src === 'previous-session' ? `${api.signed(-(s.calibrationMs || 0), 1)} ms (last session)` :
            src === 'stale' ? 'needs re-calibration' : 'not measured');
      const fineTd = cell(cr, '');
      if (d.role === 'client') {
        const minus = document.createElement('button');
        minus.className = 'mini';
        minus.textContent = '−5';
        const plus = document.createElement('button');
        plus.className = 'mini';
        plus.textContent = '+5';
        const val = document.createElement('span');
        val.className = 'mono';
        val.textContent = ` ${api.signed(s.movieFineMs || 0, 0)} ms `;
        minus.onclick = () => api.conn.send({ type: 'movie-fine', deviceId: d.id, fineMs: (s.movieFineMs || 0) - 5 });
        plus.onclick = () => api.conn.send({ type: 'movie-fine', deviceId: d.id, fineMs: (s.movieFineMs || 0) + 5 });
        fineTd.append(minus, val, plus);
      } else {
        fineTd.textContent = '—';
      }
      cell(cr, `${api.signed(comp + avOffsetMs, 1)} ms`);
      const act = cell(cr, '');
      if (d.role === 'client' && d.connected) {
        const b = document.createElement('button');
        b.className = 'mini';
        b.textContent = 'RE-CALIBRATE';
        b.disabled = api.probeRunning();
        b.onclick = () => {
          if (!video.paused) pause();
          setTimeout(() => api.runAcoustic('calibrate', [d.id]), PAUSE_LEAD_MS + 100);
        };
        act.appendChild(b);
      }
      cal.appendChild(cr);
    }
  }

  function renderControls() {
    const has = !!loadedFile;
    $('mPlay').disabled = !has || preparing && !movieReadyAt(video.currentTime) || !video.paused;
    $('mPause').disabled = !has || video.paused;
    $('mBack').disabled = !has;
    $('mFwd').disabled = !has;
    seekBar.disabled = !has;
    const dur = video.duration || 0;
    seekBar.max = String(dur);
    if (!dragging) {
      const pos = video.paused ? video.currentTime : vclock.positionAt(api.clock.masterNow());
      seekBar.value = String(pos);
      $('mPos').textContent = formatTime(pos);
    }
    $('mDur').textContent = formatTime(dur);
    const st = audio.state();
    const prep = movie && movie.status !== 'ready' ? ` · audio ${Math.round((movie.readyFrames / Math.max(1, movie.totalFrames)) * 100)}% prepared` : '';
    $('mState').textContent = `· ${video.paused ? 'paused' : 'playing'} · laptop sound: ${st}${prep}`;
  }

  setInterval(() => {
    if (api.selectedMode() !== 'movie') return;
    renderControls();
    renderDiag();
  }, 250);

  window.syncwaveDebug.movie = { audio, vclock, video, get clock() { return clockState; }, get startLatency() { return videoStartLatencyMs; } };
})();
