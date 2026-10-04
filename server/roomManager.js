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
  return { id, role, name, ws: null, connected: false, lastSeen: Date.now(), status: {} };
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

function attachClient(room, clientId, name, ws) {
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

/** Copy only known fields with sane types from a device's status report. */
function updateStatus(device, s) {
  if (!s || typeof s !== 'object') return;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
  device.status = {
    reportedAt: num(s.reportedAt),
    state: str(s.state, 32),
    speakerEnabled: s.speakerEnabled === true,
    trackId: str(s.trackId, 32),
    loadProgress: num(s.loadProgress),
    position: num(s.position),
    duration: num(s.duration),
    offsetMs: num(s.offsetMs),
    rttMs: num(s.rttMs),
    clockDriftPpm: num(s.clockDriftPpm),
    playbackDriftMs: num(s.playbackDriftMs),
    outputLatencyMs: num(s.outputLatencyMs),
    timingMethod: str(s.timingMethod, 24),
    trimMs: num(s.trimMs),
    liveBufferMs: num(s.liveBufferMs),
    liveLate: num(s.liveLate),
    liveResyncs: num(s.liveResyncs),
    spatialOn: s.spatialOn === true,
    spatialX: num(s.spatialX),
    gainL: num(s.gainL),
    gainR: num(s.gainR),
    error: str(s.error, 160),
  };
  device.lastSeen = Date.now();
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
    send(room.master.ws, { type: 'devices', devices: devicesSnapshot(room), serverTime: sync.masterNow() });
  }
}

function closeRoom(room) {
  broadcast(room, { type: 'room-closed' });
  for (const d of [room.master, ...room.clients.values()]) {
    if (d && d.ws) { d.ws.syncwave = null; try { d.ws.close(4001, 'room closed'); } catch { /* ignore */ } }
  }
  deleteTrackFile(room.track);
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
  publicTrack,
  sendDevicesToMaster,
  send,
  sweep,
  allRooms,
};
