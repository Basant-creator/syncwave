'use strict';

/**
 * syncEngine.js — the "master clock" and the shared playback state machine.
 *
 * ─── Which clock is the master clock? ──────────────────────────────────────
 * The Node process runs on the laptop, so we use the Node process clock as the
 * reference ("master clock") for the whole room. Every browser — the laptop's
 * own Master page included — estimates its offset to this clock over the
 * WebSocket (see public/js/sync.js). Using the server rather than the Master
 * browser tab as the reference has two advantages:
 *   1. The server answers sync pings immediately; a browser tab can be
 *      throttled when it is in the background.
 *   2. The Master page goes through exactly the same code path as the phones,
 *      so there is one implementation of "schedule playback at time T".
 *
 * `performance.timeOrigin + performance.now()` gives a monotonic, sub-ms clock
 * expressed in Unix-epoch milliseconds (it does not jump if the OS wall clock
 * is adjusted while the server is running).
 *
 * ─── Playback state ────────────────────────────────────────────────────────
 * The room's playback is described by a tiny state object, never by "PLAY NOW":
 *
 *   { status: 'playing', trackId, startAt, position, seq }
 *
 * meaning: "track position `position` (seconds) is heard at master-clock time
 * `startAt` (ms), and playback continues in real time from there". Any device
 * can work out where playback *should* be at any master-clock time `t`:
 *
 *   expectedPosition(t) = position + (t - startAt) / 1000
 *
 * which is also what lets late joiners and reconnecting phones jump in.
 * `seq` increments on every change so devices can tell a new command from a
 * re-broadcast of the one they are already playing.
 */

const { performance } = require('node:perf_hooks');

/** Default scheduling lead if the Master asks for a start time that is unusable. */
const DEFAULT_LEAD_MS = 1500;
/** The Master may not schedule a start further than this into the future. */
const MAX_LEAD_MS = 10000;
/** A start time closer than this to "now" is pushed out to DEFAULT_LEAD_MS. */
const MIN_LEAD_MS = 200;

function masterNow() {
  return performance.timeOrigin + performance.now();
}

function createPlayback() {
  return { status: 'stopped', trackId: null, startAt: 0, position: 0, seq: 0, loop: false, duration: null };
}

function wrap(pos, playback) {
  return playback.loop && playback.duration > 0 ? pos % playback.duration : pos;
}

/** Track position (seconds) the room should be at, at master-clock time `t`. */
function positionAt(playback, t = masterNow()) {
  if (playback.status !== 'playing') return playback.position;
  // Before startAt the devices are waiting; position stays at the cue point.
  return wrap(playback.position + Math.max(0, t - playback.startAt) / 1000, playback);
}

function isValidPosition(p) {
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 && p < 24 * 3600;
}

function isValidDuration(d) {
  return typeof d === 'number' && Number.isFinite(d) && d > 0 && d < 24 * 3600;
}

/**
 * Validate the Master's requested start time. The Master computes startAt on
 * its own estimate of the master clock; we only clamp obviously bad values.
 */
function sanitizeStartAt(startAt, now = masterNow()) {
  if (typeof startAt !== 'number' || !Number.isFinite(startAt)) return now + DEFAULT_LEAD_MS;
  if (startAt < now + MIN_LEAD_MS) return now + DEFAULT_LEAD_MS;
  if (startAt > now + MAX_LEAD_MS) return now + MAX_LEAD_MS;
  return startAt;
}

// Each command returns a new playback object (with seq bumped) or null if it
// was invalid. The room manager stores and broadcasts the result.
// `continuous: true` marks a state that describes the SAME timeline as before
// (devices keep playing instead of restarting); every other command clears it.

function play(prev, { startAt, position, loop, duration }) {
  if (!prev.trackId) return null;
  const pos = isValidPosition(position) ? position : positionAt(prev);
  return {
    status: 'playing',
    trackId: prev.trackId,
    startAt: sanitizeStartAt(startAt),
    position: pos,
    seq: prev.seq + 1,
    loop: typeof loop === 'boolean' ? loop : prev.loop,
    duration: isValidDuration(duration) ? duration : prev.duration,
    continuous: false,
  };
}

function pause(prev) {
  if (prev.status !== 'playing') return null;
  return { ...prev, status: 'paused', position: positionAt(prev), startAt: 0, seq: prev.seq + 1, continuous: false };
}

function seek(prev, { position }) {
  if (!prev.trackId || !isValidPosition(position)) return null;
  if (prev.status === 'playing') {
    // Seeking while playing is a re-scheduled play from the new position.
    return play(prev, { startAt: masterNow() + DEFAULT_LEAD_MS, position });
  }
  return { ...prev, status: 'paused', position, startAt: 0, seq: prev.seq + 1, continuous: false };
}

function stop(prev) {
  return { ...prev, status: 'stopped', position: 0, startAt: 0, seq: prev.seq + 1, continuous: false };
}

/**
 * Turn Repeat on/off. While playing, the timeline is re-anchored at "now"
 * (same audio, same moment) and marked continuous, so nobody restarts.
 */
function setLoop(prev, { loop, duration }) {
  if (typeof loop !== 'boolean') return null;
  const dur = isValidDuration(duration) ? duration : prev.duration;
  if (prev.status === 'playing') {
    const now = masterNow();
    if (now < prev.startAt) return { ...prev, loop, duration: dur, seq: prev.seq + 1, continuous: true };
    const next = { ...prev, loop, duration: dur };
    return { ...next, startAt: now, position: positionAt(prev, now), seq: prev.seq + 1, continuous: true };
  }
  return { ...prev, loop, duration: dur, seq: prev.seq + 1, continuous: false };
}

function setTrack(prev, trackId) {
  return { ...createPlayback(), trackId, seq: prev.seq + 1, loop: prev.loop };
}

/**
 * Answer a clock-sync ping. `t1` is taken as early as possible (when the
 * message arrived) and `t2` as late as possible (just before sending), so the
 * client can subtract the server's own processing time from the round trip.
 */
function syncReply(t0, t1) {
  return { type: 'sync-reply', t0, t1, t2: masterNow() };
}

module.exports = {
  DEFAULT_LEAD_MS,
  masterNow,
  sanitizeStartAt,
  createPlayback,
  positionAt,
  play,
  pause,
  seek,
  stop,
  setLoop,
  setTrack,
  syncReply,
};
