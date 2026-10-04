'use strict';

/**
 * roomManager.js — in-memory rooms, devices and tracks. No database: if the
 * server restarts, rooms are gone and the Master page simply creates a new one.
 *
 * A room has exactly one Master (the laptop page) and any number of Clients
 * (phones). Devices are keyed by a stable id the browser keeps in storage, so
 * a phone that reconnects (Wi-Fi blip, screen lock, page reload) takes over
 * its old entry instead of appearing twice.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const QRCode = require('qrcode');
const sync = require('./syncEngine');
const { SyncLog } = require('./syncLog');
const movies = require('./movieStore');

// No 0/O/1/I so the room code is easy to read aloud.
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_ID_LENGTH = 4;
const MAX_ROOMS = 50;
const MAX_CLIENTS_PER_ROOM = 32;
/** Keep a room alive this long after the Master page disconnects (reload, sleep). */
const MASTER_GRACE_MS = 10 * 60 * 1000;
/** Show a disconnected phone as "disconnected" this long before dropping it. */
const CLIENT_GRACE_MS = 2 * 60 * 1000;

const ROOM_ID_RE = /^[A-Z0-9]{4,8}$/;

const rooms = new Map();

function generateRoomId() {
  for (let attempt = 0; attempt < 1000; attempt++) {
    let id = '';
    for (let i = 0; i < ROOM_ID_LENGTH; i++) id += ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)];
    if (!rooms.has(id)) return id;
  }
  throw new Error('Could not generate a unique room id');
}

function cleanName(name, fallback) {
  if (typeof name !== 'string') return fallback;
  // Strip control characters, collapse whitespace, cap the length.
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32);
  return cleaned || fallback;
}

/**
 * @param {{label: string, base: string}[]} joinBases  e.g. [{label:'Wi-Fi', base:'http://192.168.1.20:3000'}]
 */
async function createRoom(joinBases) {
  if (rooms.size >= MAX_ROOMS) sweep(true);
  if (rooms.size >= MAX_ROOMS) throw new Error('Too many rooms on this server');

  const id = generateRoomId();
  const joinUrls = await Promise.all(
    joinBases.map(async ({ label, base }) => {
      const url = `${base}/join/${id}`;
      const qr = await QRCode.toDataURL(url, { margin: 1, width: 320, errorCorrectionLevel: 'M' });
      return { label, url, qr };
    })
  );

  const room = {
    id,
    masterToken: crypto.randomBytes(16).toString('hex'),
    createdAt: Date.now(),
    master: null,
    masterLeftAt: null,
    clients: new Map(),
    track: null,
    playback: sync.createPlayback(),
    live: { active: false },
    // Experimental spatial mode. Independent of playback: only gains change.
    spatial: { enabled: false, width: 1, centerMix: 0.3, positions: { master: 0 } },
    // Sync tolerance profile: 'music' (relaxed) or 'movie' (tighter). See public/js/sync.js.
    syncProfile: 'music',
    log: null,          // SyncLog while CSV logging is on
    // Movie Sync: extracted movie audio + the Master video's timeline (server/movieStore.js).
    movie: null,
    source: 'file',     // 'file' | 'live' | 'movie' — which player the devices should use
    movieClock: { epoch: 0, playing: false, videoTime: 0, masterTime: 0, rate: 1, avOffsetMs: 0 },
    joinUrls,
  };
  rooms.set(id, room);
  return room;
}

function getRoom(id) {
  if (typeof id !== 'string') return null;
  const key = id.toUpperCase();
  return ROOM_ID_RE.test(key) ? rooms.get(key) || null : null;
}

function isValidRoomId(id) {
  return typeof id === 'string' && ROOM_ID_RE.test(id.toUpperCase());
}

function findTrack(trackId) {
  for (const room of rooms.values()) {
    if (room.track && room.track.id === trackId) return room.track;
  }
  return null;
}

function newDevice(id, role, name) {
  return { id, role, name, ws: null, connected: false, lastSeen: Date.now(), status: {}, profile: {} };
}

/**
 * What a phone remembers about itself between sessions (sent on join). Used as
 * an initial estimate only; the device recalibrates when it looks stale.
 */
function cleanProfile(p) {
  if (!p || typeof p !== 'object') return {};
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);
  return {
    calibrationMs: num(p.calibrationMs, -500, 500),
    calibratedAt: num(p.calibratedAt, 0, 1e13),
    calibrationLatencyMs: num(p.calibrationLatencyMs, 0, 2000),
    lastClockOffsetMs: num(p.lastClockOffsetMs, -1e12, 1e12),
    manualTrimMs: num(p.manualTrimMs, -1000, 1000),
  };
}

function bindSocket(device, ws, room) {
  // A reconnecting device replaces its previous socket.
  if (device.ws && device.ws !== ws) {
    device.ws.syncwave = null;
    try { device.ws.close(4000, 'replaced'); } catch { /* already closed */ }
  }
  device.ws = ws;
  device.connected = true;
  device.lastSeen = Date.now();
  ws.syncwave = { roomId: room.id, deviceId: device.id, role: device.role };
}

function attachMaster(room, ws) {
  if (!room.master) room.master = newDevice('master', 'master', 'Laptop');
  bindSocket(room.master, ws, room);
  room.masterLeftAt = null;
  broadcastToClients(room, { type: 'master-status', online: true });
  return room.master;
}

function attachClient(room, clientId, name, ws, profile) {
  let device = room.clients.get(clientId);
  if (!device) {
    if (room.clients.size >= MAX_CLIENTS_PER_ROOM) return null;
    device = newDevice(clientId, 'client', cleanName(name, `Phone ${room.clients.size + 1}`));
    room.clients.set(clientId, device);
    if (typeof room.spatial.positions[clientId] !== 'number') {
      room.spatial.positions[clientId] = suggestPosition(room);
      broadcast(room, { type: 'spatial', spatial: room.spatial });
    }
  } else if (name) {
    device.name = cleanName(name, device.name);
  }
  if (profile) device.profile = cleanProfile(profile);
  bindSocket(device, ws, room);
  return device;
}

/** Called when a socket closes. Keeps the device entry so it can reconnect. */
function detach(ws) {
  const meta = ws.syncwave;
  if (!meta) return null;
  const room = rooms.get(meta.roomId);
  if (!room) return null;
  const device = meta.role === 'master' ? room.master : room.clients.get(meta.deviceId);
  if (!device || device.ws !== ws) return null;
  device.ws = null;
  device.connected = false;
  device.lastSeen = Date.now();
  if (meta.role === 'master') {
    room.masterLeftAt = Date.now();
    broadcastToClients(room, { type: 'master-status', online: false });
    // The capture lived in the Master page, so a live stream ends with it.
    if (room.live.active) setLive(room, { active: false });
  }
  return { room, device };
}

function deviceForSocket(ws) {
  const meta = ws.syncwave;
  if (!meta) return null;
  const room = rooms.get(meta.roomId);
  if (!room) return null;
  const device = meta.role === 'master' ? room.master : room.clients.get(meta.deviceId);
  return device && device.ws === ws ? { room, device } : null;
}

function renameDevice(device, name) {
  device.name = cleanName(name, device.name);
}

const STATUS_NUMBERS = [
  'reportedAt', 'loadProgress', 'position', 'duration', 'offsetMs', 'rttMs', 'bestRttMs',
  'clockUncertaintyMs', 'clockSamples', 'lastSyncAgeMs', 'clockDriftPpm', 'playbackDriftMs',
  'smoothedDriftMs', 'correctionRate', 'skewBiasPpm', 'resyncs', 'outputLatencyMs', 'calibrationMs',
  'manualTrimMs', 'trimMs', 'calibratedAt', 'liveBufferMs', 'liveLate', 'liveResyncs',
  'spatialX', 'gainL', 'gainR', 'reconnects',
  // Movie Sync
  'movieEpoch', 'movieAudioPos', 'movieErrorMs', 'movieSmoothedMs', 'movieRate', 'movieBufferS',
  'movieResyncs', 'movieUnderruns', 'movieFineMs', 'movieExpectedPos',
];
const STATUS_STRINGS = {
  state: 32, syncState: 16, trackId: 32, timingMethod: 24, correctionZone: 16,
  calibrationSource: 24, error: 160, movieState: 16, movieZone: 16,
};
const STATUS_BOOLEANS = ['speakerEnabled', 'spatialOn', 'calibrating'];

/** Copy only known fields with sane types from a device's status report. */
function updateStatus(device, s) {
  if (!s || typeof s !== 'object') return;
  const out = {};
  for (const k of STATUS_NUMBERS) out[k] = typeof s[k] === 'number' && Number.isFinite(s[k]) ? s[k] : null;
  for (const [k, n] of Object.entries(STATUS_STRINGS)) out[k] = typeof s[k] === 'string' ? s[k].slice(0, n) : null;
  for (const k of STATUS_BOOLEANS) out[k] = s[k] === true;
  device.status = out;
  device.lastSeen = Date.now();
  // Keep the server's copy of the profile current (survives the phone reloading).
  if (out.calibrationMs != null) device.profile.calibrationMs = out.calibrationMs;
}

function sendToDevice(room, deviceId, msg) {
  const d = deviceId === 'master' ? room.master : room.clients.get(deviceId);
  if (d) send(d.ws, msg);
  return !!d;
}

function setSyncProfile(room, name) {
  if (name !== 'music' && name !== 'movie') return;
  room.syncProfile = name;
  broadcast(room, { type: 'sync-profile', profile: name });
}

// ─── Movie Sync ─────────────────────────────────────────────────────────────

function setSource(room, source) {
  if (!['file', 'live', 'movie'].includes(source) || room.source === source) return;
  room.source = source;
  broadcast(room, { type: 'source', source });
}

function setMovie(room, movie) {
  movies.deleteMovie(room.movie);
  room.movie = movie;
  if (movie) setSource(room, 'movie');
  room.movieClock = { epoch: room.movieClock.epoch + 1, playing: false, videoTime: 0, masterTime: 0, rate: 1, avOffsetMs: room.movieClock.avOffsetMs };
  broadcast(room, { type: 'movie', movie: movies.publicMovie(movie) });
  broadcast(room, { type: 'movie-clock', clock: room.movieClock });
}

function broadcastMovieProgress(room) {
  broadcast(room, { type: 'movie', movie: movies.publicMovie(room.movie) });
}

/** Accept a timeline update from the Master's video and relay it to everyone. */
function setMovieClock(room, clock) {
  const c = movies.cleanClock(clock, room.movieClock.epoch);
  if (!c) return false;
  room.movieClock = c;
  broadcast(room, { type: 'movie-clock', clock: c });
  return true;
}

/** Start/stop the CSV sync log for a room. */
function setLogging(room, enabled, dir) {
  if (enabled && !room.log) room.log = new SyncLog(dir, room.id);
  if (!enabled && room.log) { room.log.stop(); room.log.stopped = room.log.info(); room.lastLog = room.log; room.log = null; }
  if (room.master) send(room.master.ws, { type: 'log-status', log: logInfo(room) });
}

function logInfo(room) {
  if (room.log) return room.log.info();
  if (room.lastLog) return { ...room.lastLog.info(), enabled: false };
  return { enabled: false };
}

/** Called once a second: one CSV row per connected device. */
function writeLogRows(room) {
  if (!room.log) return;
  const t = sync.masterNow();
  for (const d of [room.master, ...room.clients.values()]) if (d && d.connected) room.log.status(d, t);
}

function deleteTrackFile(track) {
  if (track && track.filePath) fs.rm(track.filePath, { force: true }, () => {});
}

function setTrack(room, track) {
  deleteTrackFile(room.track);
  room.track = track;
  room.playback = sync.setTrack(room.playback, track.id);
  broadcast(room, { type: 'track', track: publicTrack(track) });
  broadcast(room, { type: 'playback', playback: room.playback });
}

/** Apply a playback command result (from syncEngine) and broadcast it to everyone. */
function applyPlayback(room, next) {
  if (!next) return false;
  room.playback = next;
  broadcast(room, { type: 'playback', playback: room.playback });
  return true;
}

// ─── Experimental spatial config ────────────────────────────────────────────

/** Default spot for a newly joined phone: first left, then right, then fill in between. */
const SUGGESTED_POSITIONS = [-1, 1, -0.5, 0.5, -0.75, 0.75, -0.25, 0.25];
function suggestPosition(room) {
  const taken = Object.entries(room.spatial.positions)
    .filter(([id]) => id === 'master' || room.clients.has(id))
    .map(([, x]) => x);
  return SUGGESTED_POSITIONS.find((x) => !taken.includes(x)) ?? 0;
}

/** Validate and store the Master's spatial settings, then send them to every device. */
function setSpatial(room, cfg) {
  if (!cfg || typeof cfg !== 'object') return;
  const unit = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : d);
  const s = room.spatial;
  const positions = { ...s.positions };
  if (cfg.positions && typeof cfg.positions === 'object') {
    for (const [id, x] of Object.entries(cfg.positions)) {
      const known = id === 'master' || room.clients.has(id);
      if (known && typeof x === 'number' && Number.isFinite(x)) positions[id] = Math.min(1, Math.max(-1, x));
    }
  }
  room.spatial = {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : s.enabled,
    width: unit(cfg.width, s.width),
    centerMix: unit(cfg.centerMix, s.centerMix),
    positions,
  };
  broadcast(room, { type: 'spatial', spatial: room.spatial });
}

/** Turn live mode on/off. Live mode and file playback are exclusive. */
function setLive(room, live) {
  room.live = live;
  if (live.active) setSource(room, 'live');
  if (live.active && room.playback.status !== 'stopped') applyPlayback(room, sync.stop(room.playback));
  broadcast(room, { type: 'live', live });
}

/**
 * Forward one binary live-audio chunk from the Master to every phone. A phone
 * whose socket is backed up (weak Wi-Fi) skips chunks instead of building an
 * ever-growing queue; its receiver then re-syncs on the next chunk it gets.
 */
const LIVE_BACKLOG_LIMIT = 256 * 1024; // ≈ 1.3 s of 48 kHz stereo PCM
function relayLiveChunk(room, data) {
  for (const d of room.clients.values()) {
    const ws = d.ws;
    if (ws && ws.readyState === 1 && ws.bufferedAmount < LIVE_BACKLOG_LIMIT) ws.send(data, { binary: true });
  }
}

function publicTrack(track) {
  if (!track) return null;
  return { id: track.id, name: track.name, size: track.size, url: `/media/${track.id}` };
}

function devicesSnapshot(room) {
  const list = [];
  const add = (d) => list.push({
    id: d.id,
    role: d.role,
    name: d.name,
    connected: d.connected,
    lastSeen: d.lastSeen,
    status: d.status,
    profile: d.profile,
  });
  if (room.master) add(room.master);
  for (const d of room.clients.values()) add(d);
  return list;
}

function send(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastToClients(room, msg) {
  const data = JSON.stringify(msg);
  for (const d of room.clients.values()) {
    if (d.ws && d.ws.readyState === 1) d.ws.send(data);
  }
}

function broadcast(room, msg) {
  broadcastToClients(room, msg);
  if (room.master) send(room.master.ws, msg);
}

function sendDevicesToMaster(room) {
  if (room.master && room.master.connected) {
    send(room.master.ws, { type: 'devices', devices: devicesSnapshot(room), serverTime: sync.masterNow(), log: logInfo(room) });
  }
}

function closeRoom(room) {
  broadcast(room, { type: 'room-closed' });
  for (const d of [room.master, ...room.clients.values()]) {
    if (d && d.ws) { d.ws.syncwave = null; try { d.ws.close(4001, 'room closed'); } catch { /* ignore */ } }
  }
  deleteTrackFile(room.track);
  movies.deleteMovie(room.movie);
  if (room.log) room.log.stop();
  rooms.delete(room.id);
}

/**
 * Housekeeping: drop phones that have been gone for a while and close rooms
 * whose Master never came back. `aggressive` also closes rooms without a
 * connected Master at all (used when we hit MAX_ROOMS).
 */
function sweep(aggressive = false) {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const [id, d] of room.clients) {
      if (!d.connected && now - d.lastSeen > CLIENT_GRACE_MS) {
        room.clients.delete(id);
        delete room.spatial.positions[id];
      }
    }
    const masterGone = !room.master || !room.master.connected;
    const leftAt = room.masterLeftAt ?? room.createdAt;
    if (masterGone && (aggressive || now - leftAt > MASTER_GRACE_MS)) closeRoom(room);
  }
}

function allRooms() {
  return rooms.values();
}

module.exports = {
  createRoom,
  getRoom,
  isValidRoomId,
  findTrack,
  attachMaster,
  attachClient,
  detach,
  deviceForSocket,
  renameDevice,
  updateStatus,
  setTrack,
  applyPlayback,
  setLive,
  relayLiveChunk,
  setSpatial,
  broadcast,
  sendToDevice,
  setSyncProfile,
  setMovie,
  setMovieClock,
  setSource,
  broadcastMovieProgress,
  setLogging,
  logInfo,
  writeLogRows,
  publicTrack,
  sendDevicesToMaster,
  send,
  sweep,
  allRooms,
};
