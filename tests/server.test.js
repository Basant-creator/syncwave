'use strict';

// End-to-end protocol regression tests: starts a real SyncWave server on a
// free port with temporary upload/log folders and drives it over WebSocket +
// HTTP the way the Master and phone pages do. Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const PORT = 3400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwave-test-'));
let server;

class Peer {
  constructor() {
    this.msgs = [];
    this.binary = [];
    this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (data, isBinary) => {
        if (isBinary) { this.binary.push(data); return; }
        const m = JSON.parse(data.toString());
        this.msgs.push(m);
        this.waiters = this.waiters.filter((w) => !(w.pred(m) && (w.resolve(m), true)));
      });
    });
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
  /** Wait for a message matching pred (including ones already received after `since`). */
  waitFor(pred, ms = 3000, since = 0) {
    const hit = this.msgs.slice(since).find(pred);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      this.waiters.push(w);
      setTimeout(() => { this.waiters = this.waiters.filter((x) => x !== w); reject(new Error('timeout waiting for message')); }, ms);
    });
  }
  mark() { return this.msgs.length; }
  close() { this.ws.close(); }
}

const type = (t, extra = () => true) => (m) => m.type === t && extra(m);

function wav(seconds = 1, rate = 8000) {
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i / 3) * 8000), 44 + i * 2);
  return b;
}

test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), UPLOAD_DIR: path.join(tmp, 'uploads'), LOG_DIR: path.join(tmp, 'logs') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 10000);
    server.stdout.on('data', (d) => { if (d.toString().includes('SyncWave is running')) { clearTimeout(t); resolve(); } });
    server.on('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
});

test.after(() => {
  if (server) server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('full session: room, join, profile, upload, playback, repeat, profiles, calibration relay, log, reconnect', async () => {
  // Master creates a room (allowed: the request comes from this machine).
  const master = new Peer();
  await master.open();
  master.send({ type: 'create-room' });
  const room = await master.waitFor(type('room'));
  assert.match(room.roomId, /^[A-Z0-9]{4}$/);
  assert.ok(room.token && room.joinUrls.length > 0 && room.joinUrls[0].qr.startsWith('data:image/png'));
  assert.equal(room.syncProfile, 'music');

  // Clock-sync ping is answered with server timestamps.
  master.send({ type: 'sync', t0: 123 });
  const reply = await master.waitFor(type('sync-reply'));
  assert.equal(reply.t0, 123);
  assert.ok(reply.t2 >= reply.t1);

  // A phone joins with a profile from a previous session.
  const phone = new Peer();
  await phone.open();
  const clientId = 'testphone0001';
  phone.send({ type: 'join', roomId: room.roomId, clientId, name: 'Phone A', profile: { calibrationMs: -12.5, manualTrimMs: 3, bogus: 'x' } });
  const joined = await phone.waitFor(type('room'));
  assert.equal(joined.role, 'client');
  assert.equal(joined.token, undefined, 'phones never get the master token');
  assert.equal(joined.profile.calibrationMs, -12.5);
  assert.equal(joined.profile.bogus, undefined);
  const devs = await master.waitFor(type('devices', (m) => m.devices.some((d) => d.id === clientId)));
  assert.equal(devs.devices.find((d) => d.id === clientId).name, 'Phone A');

  // Upload a track (needs the master token).
  const bad = await fetch(`${BASE}/api/rooms/${room.roomId}/track`, { method: 'POST', headers: { 'X-Filename': 'a.wav' }, body: wav() });
  assert.equal(bad.status, 403);
  const up = await fetch(`${BASE}/api/rooms/${room.roomId}/track`, {
    method: 'POST', headers: { 'X-Master-Token': room.token, 'X-Filename': 'tone.wav', 'Content-Type': 'application/octet-stream' }, body: wav(),
  });
  assert.equal(up.status, 200);
  const { track } = await up.json();
  await phone.waitFor(type('track', (m) => m.track && m.track.id === track.id));
  const media = await fetch(`${BASE}${track.url}`);
  assert.equal(media.status, 200);
  assert.equal((await media.arrayBuffer()).byteLength, wav().length);

  // Play with Repeat → both see it.
  let mark = phone.mark();
  master.send({ type: 'play', startAt: Date.now() + 1500, position: 0, loop: true, duration: 1 });
  const playing = await phone.waitFor(type('playback', (m) => m.playback.status === 'playing'), 3000, mark);
  assert.equal(playing.playback.loop, true);
  assert.equal(playing.playback.continuous, false);

  // A phone can't control playback.
  mark = master.mark();
  phone.send({ type: 'pause' });
  await assert.rejects(master.waitFor(type('playback', (m) => m.playback.status === 'paused'), 600, mark));

  // Repeat off while playing: same timeline, flagged continuous (no restarts).
  mark = phone.mark();
  master.send({ type: 'loop', loop: false, duration: 1 });
  const looped = await phone.waitFor(type('playback', (m) => m.playback.seq === playing.playback.seq + 1), 3000, mark);
  assert.equal(looped.playback.continuous, true);
  assert.equal(looped.playback.loop, false);

  // Pause / seek / stop still work.
  mark = phone.mark();
  master.send({ type: 'pause' });
  await phone.waitFor(type('playback', (m) => m.playback.status === 'paused'), 3000, mark);
  mark = phone.mark();
  master.send({ type: 'seek', position: 0.5 });
  const sought = await phone.waitFor(type('playback', (m) => m.playback.position === 0.5), 3000, mark);
  assert.equal(sought.playback.status, 'paused');

  // Music/Movie profile reaches the phone.
  mark = phone.mark();
  master.send({ type: 'set-sync-profile', profile: 'movie' });
  await phone.waitFor(type('sync-profile', (m) => m.profile === 'movie'), 3000, mark);

  // Acoustic probe schedule + calibration adjustment are relayed; probes pause playback.
  mark = phone.mark();
  master.send({ type: 'play', startAt: Date.now() + 1500, position: 0 });
  await phone.waitFor(type('playback', (m) => m.playback.status === 'playing'), 3000, mark);
  mark = phone.mark();
  master.send({ type: 'probe', kind: 'calibrate', schedule: { master: [1, 2], [clientId]: [3, 4, 'x'] } });
  const probe = await phone.waitFor(type('probe'), 3000, mark);
  assert.deepEqual(probe.schedule[clientId], [3, 4]);
  await phone.waitFor(type('playback', (m) => m.playback.status === 'paused'), 3000, mark);
  mark = phone.mark();
  master.send({ type: 'calibration-adjust', deviceId: clientId, adjustMs: -21.5, errorMs: 21.5 });
  const cal = await phone.waitFor(type('calibration'), 3000, mark);
  assert.equal(cal.adjustMs, -21.5);
  phone.send({ type: 'calibration-adjust', deviceId: clientId, adjustMs: 999 }); // phones can't do this
  await assert.rejects(phone.waitFor(type('calibration', (m) => m.adjustMs !== -21.5), 500));

  // Status whitelist: known fields kept, unknown dropped.
  phone.send({ type: 'status', status: { syncState: 'SYNCED', offsetMs: 3.8, calibrationMs: -34, correctionRate: 1.001, evil: 'x' } });
  const withStatus = await master.waitFor(type('devices', (m) => {
    const d = m.devices.find((x) => x.id === clientId);
    return d && d.status.syncState === 'SYNCED';
  }));
  const st = withStatus.devices.find((d) => d.id === clientId).status;
  assert.equal(st.offsetMs, 3.8);
  assert.equal(st.correctionRate, 1.001);
  assert.equal(st.evil, undefined);

  // CSV log: start, collect a couple of seconds, download (token required).
  mark = master.mark();
  master.send({ type: 'log', enabled: true });
  await master.waitFor(type('log-status', (m) => m.log.enabled), 3000, mark);
  await new Promise((r) => setTimeout(r, 2300));
  mark = master.mark();
  master.send({ type: 'log', enabled: false });
  const stopped = await master.waitFor(type('log-status', (m) => !m.log.enabled), 3000, mark);
  assert.ok(stopped.log.rows >= 2, `rows: ${stopped.log.rows}`);
  assert.equal((await fetch(`${BASE}/api/rooms/${room.roomId}/sync-log.csv`)).status, 403);
  const csv = await (await fetch(`${BASE}/api/rooms/${room.roomId}/sync-log.csv`, { headers: { 'X-Master-Token': room.token } })).text();
  assert.match(csv.split('\n')[0], /^timestamp,masterTimeMs,room,deviceId,deviceName,event,syncState/);
  assert.ok(csv.includes(clientId) && csv.includes('SYNCED'));

  // Reconnect with the same id: same single device entry, current state delivered, room keeps playing.
  const seqBefore = (await phone.waitFor(type('playback'))).playback.seq;
  phone.close();
  await master.waitFor(type('devices', (m) => m.devices.some((d) => d.id === clientId && !d.connected)));
  const phone2 = new Peer();
  await phone2.open();
  phone2.send({ type: 'join', roomId: room.roomId, clientId, name: 'Phone A' });
  const rejoined = await phone2.waitFor(type('room'));
  assert.ok(rejoined.playback.seq >= seqBefore);
  assert.equal(rejoined.syncProfile, 'movie');
  const after = await master.waitFor(type('devices', (m) => m.devices.some((d) => d.id === clientId && d.connected)));
  assert.equal(after.devices.filter((d) => d.id === clientId).length, 1);

  // Spatial config and live relay still work.
  mark = phone2.mark();
  master.send({ type: 'spatial-config', spatial: { enabled: true, positions: { [clientId]: -1 } } });
  const sp = await phone2.waitFor(type('spatial', (m) => m.spatial.enabled), 3000, mark);
  assert.equal(sp.spatial.positions[clientId], -1);
  master.send({ type: 'live-start', sampleRate: 48000, channels: 2, delayMs: 500, source: 'test' });
  await phone2.waitFor(type('live', (m) => m.live.active));
  master.ws.send(Buffer.alloc(64), { binary: true });
  phone2.ws.send(Buffer.alloc(64), { binary: true }); // ignored: only the master may stream
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(phone2.binary.length, 1);
  assert.equal(master.binary.length, 0);

  master.close();
  phone2.close();
});

test('Movie Sync protocol: create, upload PCM, ranged audio, clock relay, permissions, fine offset, source', async () => {
  const master = new Peer();
  await master.open();
  master.send({ type: 'create-room' });
  const room = await master.waitFor(type('room'));
  const phone = new Peer();
  await phone.open();
  const clientId = 'moviephone001';
  phone.send({ type: 'join', roomId: room.roomId, clientId, name: 'Phone M' });
  const joined = await phone.waitFor(type('room'));
  assert.equal(joined.source, 'file');
  assert.equal(joined.movie, null);

  // Master announces a movie (as movie-extract.js does once it knows the format).
  let mark = phone.mark();
  master.send({ type: 'movie-create', name: 'film.mp4', sampleRate: 48000, duration: 6 });
  const created = await master.waitFor(type('movie-created'));
  await phone.waitFor(type('source', (m) => m.source === 'movie'), 3000, mark);
  const announced = await phone.waitFor(type('movie', (m) => m.movie && m.movie.id === created.id), 3000, mark);
  assert.equal(announced.movie.status, 'preparing');

  // Upload 2 s of PCM (frame value = frame index & 0x7fff on both channels).
  const frames = 96000;
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) { pcm.writeInt16LE(i & 0x7fff, i * 4); pcm.writeInt16LE(i & 0x7fff, i * 4 + 2); }
  const url = `${BASE}/api/rooms/${room.roomId}/movie/${created.id}/pcm?frame=0`;
  assert.equal((await fetch(url, { method: 'POST', body: pcm })).status, 403, 'token required');
  const up = await fetch(url, { method: 'POST', headers: { 'X-Master-Token': room.token }, body: pcm });
  assert.equal(up.status, 200);
  assert.equal((await up.json()).readyFrames, frames);
  master.send({ type: 'movie-complete', id: created.id, frames });
  const ready = await phone.waitFor(type('movie', (m) => m.movie && m.movie.status === 'ready'));
  assert.equal(ready.movie.duration, 2);

  // A phone fetches any time range: frames 48000–48009 (1.0 s).
  const r = await fetch(`${BASE}${ready.movie.url}`, { headers: { Range: `bytes=${48000 * 4}-${48010 * 4 - 1}` } });
  assert.equal(r.status, 206);
  const got = new Int16Array(await r.arrayBuffer());
  assert.equal(got.length, 20);
  assert.equal(got[0], 48000 & 0x7fff);
  assert.equal(got[18], 48009 & 0x7fff);

  // The Master's video timeline is relayed; older epochs and phones are ignored.
  mark = phone.mark();
  master.send({ type: 'movie-sync', clock: { epoch: 5, playing: true, videoTime: 1.25, masterTime: 1e12, rate: 1, avOffsetMs: 10 } });
  const clk = await phone.waitFor(type('movie-clock', (m) => m.clock.epoch === 5), 3000, mark);
  assert.equal(clk.clock.videoTime, 1.25);
  assert.equal(clk.clock.playing, true);
  mark = phone.mark();
  master.send({ type: 'movie-sync', clock: { epoch: 4, playing: false, videoTime: 0, masterTime: 1e12 } });
  phone.send({ type: 'movie-sync', clock: { epoch: 9, playing: false, videoTime: 0, masterTime: 1e12 } });
  await assert.rejects(phone.waitFor(type('movie-clock'), 500, mark));

  // Per-device fine offset is relayed to that phone only (clamped).
  mark = phone.mark();
  master.send({ type: 'movie-fine', deviceId: clientId, fineMs: 250 });
  const fine = await phone.waitFor(type('movie-fine'), 3000, mark);
  assert.equal(fine.fineMs, 100);

  // Movie fields in a phone's status are kept for diagnostics / the CSV log.
  phone.send({ type: 'status', status: { movieState: 'playing', movieSmoothedMs: -3.5, movieBufferS: 40, syncState: 'SYNCED' } });
  const dev = await master.waitFor(type('devices', (m) => {
    const d = m.devices.find((x) => x.id === clientId);
    return d && d.status.movieState === 'playing';
  }));
  assert.equal(dev.devices.find((x) => x.id === clientId).status.movieSmoothedMs, -3.5);

  // Switching the source away stops the movie timeline for everyone.
  mark = phone.mark();
  master.send({ type: 'set-source', source: 'file' });
  await phone.waitFor(type('source', (m) => m.source === 'file'), 3000, mark);
  const stopped = await phone.waitFor(type('movie-clock', (m) => !m.clock.playing), 3000, mark);
  assert.ok(stopped.clock.epoch > 5);

  // A rejoining phone gets the movie and its clock in the room snapshot.
  const late = new Peer();
  await late.open();
  late.send({ type: 'join', roomId: room.roomId, clientId: 'latephone0001', name: 'Late' });
  const snap = await late.waitFor(type('room'));
  assert.equal(snap.movie.id, created.id);
  assert.ok(snap.movieClock.epoch > 5);

  master.close();
  phone.close();
  late.close();
});

test('pages and endpoints', async () => {
  assert.equal((await fetch(`${BASE}/`)).status, 200);
  assert.equal((await fetch(`${BASE}/join/ABCD`)).status, 200);
  assert.equal((await fetch(`${BASE}/join/x%2F..`)).status, 404);
  assert.equal((await fetch(`${BASE}/js/calibration.js`)).status, 200);
  assert.equal((await fetch(`${BASE}/media/0123456789abcdef`)).status, 404);
  assert.equal((await fetch(`${BASE}/server/server.js`)).status, 404);
});
