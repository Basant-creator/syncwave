'use strict';

/**
 * movieStore.js — Movie Sync: the movie's audio track, stored as raw PCM, and
 * the authoritative movie clock published by the Master.
 *
 * Audio: the Master extracts the movie's audio track in the browser and
 * uploads it as 16-bit interleaved stereo PCM, in order, in chunks. It lands
 * in one file per movie. Clients fetch any time range with an HTTP Range
 * request (byte offset = frame × 4), so a phone only ever holds the minute
 * around the playhead — no decoding, no multi-GB downloads, instant seeks.
 *
 * Clock: the Master's video element is the reference. The Master publishes
 *   { epoch, playing, videoTime, masterTime, rate, avOffsetMs }
 * meaning "the frame with media time `videoTime` is on screen at master-clock
 * time `masterTime`, and the timeline advances at `rate`". `epoch` changes on
 * play / pause / seek / rate change (clients restart their schedule); within
 * an epoch, newer anchors only refine the timeline (clients correct drift).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BYTES_PER_FRAME = 4;                 // 16-bit × 2 channels
const MAX_DURATION_S = 4 * 3600;           // 4 h ≈ 2.8 GB at 48 kHz
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

function createMovie(dir, { name, sampleRate, duration }) {
  const sr = Number(sampleRate);
  const dur = Number(duration);
  if (!(sr >= 8000 && sr <= 96000)) throw new Error('Unsupported sample rate');
  if (!(dur > 0 && dur <= MAX_DURATION_S)) throw new Error('Movie too long (max 4 h) or unknown duration');
  const id = crypto.randomBytes(8).toString('hex');
  const filePath = path.join(dir, `movie-${id}.pcm`);
  fs.writeFileSync(filePath, Buffer.alloc(0));
  return {
    id,
    name: String(name || 'movie').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').slice(-120) || 'movie',
    sampleRate: sr,
    channels: 2,
    duration: dur,
    totalFrames: Math.ceil(dur * sr),
    readyFrames: 0,                        // frames available contiguously from the start
    status: 'preparing',                   // preparing | ready | error
    filePath,
    fd: fs.openSync(filePath, 'r+'),
    pending: new Map(),                    // out-of-order chunks: frame → frames
  };
}

/** Write one PCM chunk at its frame position; returns the new readyFrames. */
function writeChunk(movie, frame, buf) {
  if (!Number.isInteger(frame) || frame < 0) throw new Error('Bad frame offset');
  if (buf.length === 0 || buf.length % BYTES_PER_FRAME !== 0 || buf.length > MAX_CHUNK_BYTES) throw new Error('Bad chunk size');
  const frames = buf.length / BYTES_PER_FRAME;
  if (frame + frames > movie.totalFrames + movie.sampleRate) throw new Error('Chunk beyond the end of the movie');
  fs.writeSync(movie.fd, buf, 0, buf.length, frame * BYTES_PER_FRAME);
  movie.pending.set(frame, frames);
  while (movie.pending.has(movie.readyFrames)) {
    const n = movie.pending.get(movie.readyFrames);
    movie.pending.delete(movie.readyFrames);
    movie.readyFrames += n;
  }
  return movie.readyFrames;
}

function completeMovie(movie, frames) {
  if (Number.isInteger(frames) && frames > 0 && frames <= movie.readyFrames) movie.totalFrames = frames;
  movie.totalFrames = Math.min(movie.totalFrames, movie.readyFrames);
  movie.duration = movie.totalFrames / movie.sampleRate;
  movie.status = 'ready';
}

function deleteMovie(movie) {
  if (!movie) return;
  try { fs.closeSync(movie.fd); } catch { /* already closed */ }
  fs.rm(movie.filePath, { force: true }, () => {});
}

function publicMovie(movie) {
  if (!movie) return null;
  return {
    id: movie.id, name: movie.name, sampleRate: movie.sampleRate, channels: movie.channels,
    duration: movie.duration, totalFrames: movie.totalFrames, readyFrames: movie.readyFrames,
    status: movie.status, url: `/movie-audio/${movie.id}`,
  };
}

/** Validate a movie-clock update from the Master. */
function cleanClock(c, prevEpoch) {
  if (!c || typeof c !== 'object') return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const epoch = num(c.epoch);
  const videoTime = num(c.videoTime);
  const masterTime = num(c.masterTime);
  const rate = num(c.rate);
  if (epoch == null || epoch < prevEpoch || videoTime == null || videoTime < 0 || masterTime == null) return null;
  return {
    epoch,
    playing: c.playing === true,
    videoTime,
    masterTime,
    rate: rate != null && rate >= 0.25 && rate <= 4 ? rate : 1,
    avOffsetMs: Math.max(-300, Math.min(300, num(c.avOffsetMs) || 0)),
    source: typeof c.source === 'string' ? c.source.slice(0, 16) : 'master',
    planned: c.planned === true,
  };
}

module.exports = { createMovie, writeChunk, completeMovie, deleteMovie, publicMovie, cleanClock, BYTES_PER_FRAME };
