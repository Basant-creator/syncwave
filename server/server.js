'use strict';

/**
 * server.js — HTTP + WebSocket server for SyncWave.
 *
 * Endpoints (deliberately few):
 *   GET  /                          Master page (only from this machine by default)
 *   GET  /join/:roomId              Client (phone) page
 *   GET  /css/*, /js/*              Static assets
 *   POST /api/rooms/:roomId/track   Master uploads the selected audio file (needs master token)
 *   GET  /media/:trackId            Clients download the current track (Range requests supported)
 *   WS   /ws                        Room control, clock sync, playback commands, diagnostics
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const express = require('express');
const { WebSocketServer } = require('ws');

const rooms = require('./roomManager');
const sync = require('./syncEngine');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ALLOW_REMOTE_MASTER = process.env.ALLOW_REMOTE_MASTER === '1';
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024; // 150 MB

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const UPLOAD_DIR = process.env.UPLOAD_DIR ? path.resolve(process.env.UPLOAD_DIR) : path.join(ROOT, 'uploads');

const AUDIO_TYPES = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
};

// ─── Network helpers ────────────────────────────────────────────────────────

/** Rank interfaces so the real Wi-Fi/Ethernet address beats VPN/WSL/Docker adapters. */
function scoreInterface(name, address) {
  let score = 0;
  if (/wi-?fi|wlan|wireless|^en0$|^wl/i.test(name)) score += 10;
  if (/ethernet|^eth|^en\d/i.test(name)) score += 4;
  if (/vethernet|virtual|vmware|vbox|virtualbox|docker|wsl|hyper-v|loopback|tailscale|zerotier|utun|^br-|^veth|bluetooth/i.test(name)) score -= 20;
  if (address.startsWith('192.168.')) score += 5;
  else if (address.startsWith('10.')) score += 3;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 1;
  return score;
}

function lanAddresses() {
  const list = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || a.address.startsWith('169.254.')) continue;
      list.push({ name, address: a.address, score: scoreInterface(name, a.address) });
    }
  }
  list.sort((a, b) => b.score - a.score);
  if (process.env.SYNCWAVE_HOST) {
    list.unshift({ name: 'SYNCWAVE_HOST', address: process.env.SYNCWAVE_HOST, score: 100 });
  }
  return list;
}

function joinBases() {
  const lan = lanAddresses();
  if (lan.length === 0) return [{ label: 'localhost (no LAN address found)', base: `http://localhost:${PORT}` }];
  return lan.map((a) => ({ label: `${a.name} — ${a.address}`, base: `http://${a.address}:${PORT}` }));
}

function normalizeIp(ip) {
  return (ip || '').replace(/^::ffff:/, '');
}

/** True if the request comes from this machine (any of its own addresses). */
function isLocalAddress(remote) {
  const ip = normalizeIp(remote);
  if (ip === '127.0.0.1' || ip === '::1') return true;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (normalizeIp(a.address) === ip) return true;
  }
  return false;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ─── Upload validation ──────────────────────────────────────────────────────

function sanitizeFileName(name) {
  const base = path.basename(String(name)).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').trim();
  return base.slice(-120) || 'audio';
}

/** Look at the first bytes of the file for a known audio container signature. */
function sniffAudio(buf) {
  const ascii = (s, e) => buf.toString('latin1', s, e);
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mpeg'; // MPEG audio frame / ADTS AAC
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(4, 8) === 'ftyp') return 'mp4';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm';
  return null;
}

async function readHead(file, n) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    await fh.read(buf, 0, n, 0);
    return buf;
  } finally {
    await fh.close();
  }
}

/** Reply with an error and drop the rest of a (possibly huge) request body. */
function rejectUpload(req, res, status, error) {
  res.set('Connection', 'close');
  res.status(status).json({ error });
  res.on('finish', () => req.destroy());
}

function cleanUploadDir() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const f of fs.readdirSync(UPLOAD_DIR)) {
    if (f !== '.gitkeep') fs.rmSync(path.join(UPLOAD_DIR, f), { force: true, recursive: true });
  }
}

// ─── HTTP ───────────────────────────────────────────────────────────────────

const app = express();
app.disable('x-powered-by');

app.get('/', (req, res) => {
  if (!ALLOW_REMOTE_MASTER && !isLocalAddress(req.socket.remoteAddress)) {
    return res
      .status(403)
      .type('html')
      .send('<meta name="viewport" content="width=device-width"><p style="font:16px sans-serif;padding:16px">' +
        'This is the SyncWave <b>Master</b> page and only opens on the laptop running the server.<br>' +
        'To join as a speaker, scan the QR code shown on the laptop.</p>');
  }
  res.sendFile(path.join(PUBLIC_DIR, 'master.html'));
});

app.get('/join/:roomId', (req, res) => {
  if (!rooms.isValidRoomId(req.params.roomId)) return res.status(404).send('Invalid room code');
  res.sendFile(path.join(PUBLIC_DIR, 'client.html'));
});

app.use('/css', express.static(path.join(PUBLIC_DIR, 'css'), { index: false }));
app.use('/js', express.static(path.join(PUBLIC_DIR, 'js'), { index: false }));

app.post('/api/rooms/:roomId/track', async (req, res) => {
  const room = rooms.getRoom(req.params.roomId);
  if (!room || !safeEqual(req.get('x-master-token') || '', room.masterToken)) {
    return rejectUpload(req, res, 403, 'Only the Master of this room can upload.');
  }

  let rawName = '';
  try { rawName = decodeURIComponent(req.get('x-filename') || ''); } catch { /* keep empty */ }
  const name = sanitizeFileName(rawName);
  const ext = path.extname(name).toLowerCase();
  if (!AUDIO_TYPES[ext]) {
    return rejectUpload(req, res, 415, `Unsupported file type "${ext || 'unknown'}". Use MP3, WAV, M4A, AAC, OGG, OPUS, FLAC or WEBM.`);
  }
  if (Number(req.get('content-length')) > MAX_UPLOAD_BYTES) {
    return rejectUpload(req, res, 413, `File is larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  }

  const trackId = crypto.randomBytes(8).toString('hex');
  const finalPath = path.join(UPLOAD_DIR, `${room.id}-${trackId}${ext}`);
  const tmpPath = `${finalPath}.part`;

  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > MAX_UPLOAD_BYTES) cb(Object.assign(new Error('too large'), { status: 413 }));
      else cb(null, chunk);
    },
  });

  try {
    await pipeline(req, limiter, fs.createWriteStream(tmpPath));
  } catch (err) {
    fs.rm(tmpPath, { force: true }, () => {});
    if (!res.headersSent) rejectUpload(req, res, err.status || 400, err.status === 413 ? 'File too large.' : 'Upload failed.');
    return;
  }

  const head = bytes >= 16 ? await readHead(tmpPath, 16) : null;
  if (!head || !sniffAudio(head)) {
    fs.rm(tmpPath, { force: true }, () => {});
    return res.status(415).json({ error: 'That file does not look like a supported audio file.' });
  }

  await fs.promises.rename(tmpPath, finalPath);

  // The room may have closed while the file was uploading.
  if (rooms.getRoom(room.id) !== room) {
    fs.rm(finalPath, { force: true }, () => {});
    return res.status(410).json({ error: 'Room no longer exists.' });
  }

  const track = { id: trackId, name, size: bytes, ext, mime: AUDIO_TYPES[ext], filePath: finalPath };
  rooms.setTrack(room, track);
  console.log(`[room ${room.id}] track uploaded: ${name} (${(bytes / 1024 / 1024).toFixed(1)} MB)`);
  res.json({ track: rooms.publicTrack(track) });
});

app.get('/media/:trackId', (req, res) => {
  const id = req.params.trackId;
  const track = /^[0-9a-f]{16}$/.test(id) ? rooms.findTrack(id) : null;
  if (!track) return res.status(404).send('Not found');
  res.sendFile(track.filePath, {
    headers: { 'Content-Type': track.mime, 'Cache-Control': 'private, max-age=86400' },
  });
});

app.use((req, res) => res.status(404).send('Not found'));

// ─── WebSocket ──────────────────────────────────────────────────────────────

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

function roomPayload(room, device) {
  const isMaster = device.role === 'master';
  return {
    type: 'room',
    role: device.role,
    roomId: room.id,
    deviceId: device.id,
    deviceName: device.name,
    token: isMaster ? room.masterToken : undefined,
    joinUrls: isMaster ? room.joinUrls : undefined,
    masterOnline: !!(room.master && room.master.connected),
    track: rooms.publicTrack(room.track),
    playback: room.playback,
    live: room.live,
    spatial: room.spatial,
  };
}

const handlers = {
  async 'create-room'(ws, msg, ctx) {
    if (!ALLOW_REMOTE_MASTER && !ctx.isLocal) {
      return rooms.send(ws, { type: 'error', code: 'not-local', message: 'The Master must run on the laptop hosting the server.' });
    }
    if (ws.syncwave || ws.creatingRoom) return;
    ws.creatingRoom = true;
    const room = await rooms.createRoom(joinBases()).finally(() => { ws.creatingRoom = false; });
    const device = rooms.attachMaster(room, ws);
    console.log(`[room ${room.id}] created — join URL: ${room.joinUrls[0].url}`);
    rooms.send(ws, roomPayload(room, device));
  },

  'resume-room'(ws, msg, ctx) {
    const room = rooms.getRoom(msg.roomId);
    if ((!ALLOW_REMOTE_MASTER && !ctx.isLocal) || !room || !safeEqual(msg.token || '', room.masterToken)) {
      return rooms.send(ws, { type: 'error', code: 'room-gone', message: 'Room no longer exists.' });
    }
    const device = rooms.attachMaster(room, ws);
    console.log(`[room ${room.id}] master reconnected`);
    rooms.send(ws, roomPayload(room, device));
    rooms.sendDevicesToMaster(room);
  },

  join(ws, msg) {
    const room = rooms.getRoom(msg.roomId);
    if (!room) return rooms.send(ws, { type: 'error', code: 'room-not-found', message: `Room ${msg.roomId} not found.` });
    if (typeof msg.clientId !== 'string' || !CLIENT_ID_RE.test(msg.clientId)) {
      return rooms.send(ws, { type: 'error', code: 'bad-request', message: 'Invalid client id.' });
    }
    const device = rooms.attachClient(room, msg.clientId, msg.name, ws);
    if (!device) return rooms.send(ws, { type: 'error', code: 'room-full', message: 'Room is full.' });
    console.log(`[room ${room.id}] client joined: ${device.name}`);
    rooms.send(ws, roomPayload(room, device));
    rooms.sendDevicesToMaster(room);
  },

  status(ws, msg) {
    const found = rooms.deviceForSocket(ws);
    if (!found) return;
    const prevState = found.device.status.state;
    rooms.updateStatus(found.device, msg.status);
    // State changes (e.g. ready → playing) go to the Master right away, not on the next tick.
    if (found.device.status.state !== prevState) rooms.sendDevicesToMaster(found.room);
  },

  rename(ws, msg) {
    const found = rooms.deviceForSocket(ws);
    if (!found) return;
    rooms.renameDevice(found.device, msg.name);
    rooms.sendDevicesToMaster(found.room);
  },

  // Live mode: the Master streams captured audio as binary chunks (see public/js/live.js).
  'live-start'(ws, msg) {
    const found = rooms.deviceForSocket(ws);
    if (!found || found.device.role !== 'master') return;
    const num = (v, lo, hi, d) => (typeof v === 'number' && v >= lo && v <= hi ? v : d);
    rooms.setLive(found.room, {
      active: true,
      sampleRate: num(msg.sampleRate, 8000, 192000, 48000),
      channels: num(msg.channels, 1, 2, 2),
      delayMs: num(msg.delayMs, 0, 5000, 500),
      source: typeof msg.source === 'string' ? msg.source.slice(0, 40) : 'live',
    });
    console.log(`[room ${found.room.id}] live stream started (${found.room.live.source})`);
  },

  'live-stop'(ws) {
    const found = rooms.deviceForSocket(ws);
    if (!found || found.device.role !== 'master' || !found.room.live.active) return;
    rooms.setLive(found.room, { active: false });
    console.log(`[room ${found.room.id}] live stream stopped`);
  },

  // Experimental spatial mode — kept apart from the playback commands below:
  // it changes how loud each channel is on each device, never when audio plays.
  'spatial-config'(ws, msg) {
    const found = rooms.deviceForSocket(ws);
    if (!found || found.device.role !== 'master') return;
    rooms.setSpatial(found.room, msg.spatial);
  },

  /** Scheduled left → center → right test tone. Every device renders it locally. */
  'spatial-test'(ws, msg) {
    const found = rooms.deviceForSocket(ws);
    if (!found || found.device.role !== 'master') return;
    const room = found.room;
    if (room.playback.status === 'playing') rooms.applyPlayback(room, sync.pause(room.playback));
    rooms.broadcast(room, { type: 'spatial-test', startAt: sync.sanitizeStartAt(msg.startAt) });
  },

  // Master-only playback commands. The result is broadcast to every device,
  // including the Master page itself, which then schedules like everyone else.
  play: masterCommand((room, msg) => sync.play(room.playback, msg)),
  pause: masterCommand((room) => sync.pause(room.playback)),
  seek: masterCommand((room, msg) => sync.seek(room.playback, msg)),
  stop: masterCommand((room) => sync.stop(room.playback)),
};

function masterCommand(fn) {
  return (ws, msg) => {
    const found = rooms.deviceForSocket(ws);
    if (!found || found.device.role !== 'master') return;
    if (found.room.live.active) rooms.setLive(found.room, { active: false }); // file playback ends live mode
    rooms.applyPlayback(found.room, fn(found.room, msg));
  };
}

wss.on('connection', (ws, req) => {
  const ctx = { isLocal: isLocalAddress(req.socket.remoteAddress) };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (data, isBinary) => {
    // Timestamp first, before any parsing, for the clock-sync reply (t1).
    const t1 = sync.masterNow();
    if (isBinary) {
      // Only the Master of a room in live mode may send binary (live audio chunks).
      const meta = ws.syncwave;
      if (!meta || meta.role !== 'master') return;
      const room = rooms.getRoom(meta.roomId);
      if (room && room.live.active) rooms.relayLiveChunk(room, data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'sync') {
      if (typeof msg.t0 === 'number') rooms.send(ws, sync.syncReply(msg.t0, t1));
      return;
    }
    const handler = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
    if (!handler) return;
    try {
      await handler(ws, msg, ctx);
    } catch (err) {
      console.error('ws handler error:', err);
      rooms.send(ws, { type: 'error', code: 'server-error', message: err.message });
    }
  });

  ws.on('close', () => {
    const left = rooms.detach(ws);
    if (left) {
      console.log(`[room ${left.room.id}] ${left.device.role} disconnected: ${left.device.name}`);
      rooms.sendDevicesToMaster(left.room);
    }
  });
});

// Push the device list (with diagnostics) to each Master once a second.
setInterval(() => {
  for (const room of rooms.allRooms()) rooms.sendDevicesToMaster(room);
}, 1000);

// Detect dead sockets (phone went out of range without closing cleanly).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 15000);

setInterval(() => rooms.sweep(), 30000);

// ─── Start ──────────────────────────────────────────────────────────────────

cleanUploadDir();

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try: PORT=3001 npm start  (PowerShell: $env:PORT=3001; npm start)`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  const lan = lanAddresses();
  const line = '─'.repeat(60);
  console.log(`\n${line}\n  SyncWave is running\n${line}`);
  console.log(`  1. On THIS laptop open the Master page:  http://localhost:${PORT}`);
  if (lan.length) {
    console.log(`  2. Phones join by scanning the QR code, which points to:`);
    console.log(`        http://${lan[0].address}:${PORT}/join/<ROOM>    (${lan[0].name})`);
    if (lan.length > 1) {
      console.log('     Other LAN addresses on this machine (selectable on the Master page):');
      for (const a of lan.slice(1)) console.log(`        http://${a.address}:${PORT}    (${a.name})`);
    }
  } else {
    console.log('  !! No LAN IPv4 address found — are you connected to Wi-Fi?');
  }
  console.log(`${line}\n`);
});
