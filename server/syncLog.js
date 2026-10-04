'use strict';

/**
 * syncLog.js — CSV log of synchronization measurements, for inspecting long
 * sessions afterwards (spreadsheet, pandas, …).
 *
 * One row per connected device per second while logging is on ("status"
 * rows), plus one row per device for every acoustic measurement
 * ("acoustic-calibrate" / "acoustic-verify" rows). Started/stopped from the
 * Master's developer panel; files land in logs/ (or $LOG_DIR).
 */

const fs = require('node:fs');
const path = require('node:path');

const COLUMNS = [
  'timestamp', 'masterTimeMs', 'room', 'deviceId', 'deviceName', 'event',
  'syncState', 'state', 'clockOffsetMs', 'rttMs', 'clockUncertaintyMs',
  'latencyMs', 'calibrationMs', 'effectiveOffsetMs', 'positionS', 'driftMs',
  'smoothedDriftMs', 'correction', 'correctionZone', 'resyncs', 'clockDriftPpm',
  'skewBiasPpm', 'acousticErrorMs', 'movieState', 'movieAudioPos', 'movieExpectedPos', 'movieErrorMs',
  'movieSmoothedMs', 'movieRate', 'movieBufferS', 'movieResyncs', 'movieUnderruns', 'note',
];

function csvCell(v) {
  if (v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v))) return '';
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

class SyncLog {
  constructor(dir, roomId) {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    this.roomId = roomId;
    this.file = path.join(dir, `sync-${roomId}-${stamp}.csv`);
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.stream.write(`${COLUMNS.join(',')}\n`);
    this.rows = 0;
    this.startedAt = Date.now();
  }

  write(row) {
    if (!this.stream) return;
    this.stream.write(`${COLUMNS.map((c) => csvCell(row[c])).join(',')}\n`);
    this.rows++;
  }

  /** One "status" row for a device, from its latest self-report. */
  status(device, masterTimeMs) {
    const s = device.status || {};
    this.write({
      timestamp: new Date().toISOString(),
      masterTimeMs,
      room: this.roomId,
      deviceId: device.id,
      deviceName: device.name,
      event: 'status',
      syncState: device.connected ? s.syncState : 'DISCONNECTED',
      state: s.state,
      clockOffsetMs: s.offsetMs,
      rttMs: s.rttMs,
      clockUncertaintyMs: s.clockUncertaintyMs,
      latencyMs: s.outputLatencyMs,
      calibrationMs: s.calibrationMs,
      effectiveOffsetMs: s.trimMs,
      positionS: s.position,
      driftMs: s.playbackDriftMs,
      smoothedDriftMs: s.smoothedDriftMs,
      correction: s.correctionRate == null ? null : s.correctionRate - 1,
      correctionZone: s.correctionZone,
      resyncs: s.resyncs,
      clockDriftPpm: s.clockDriftPpm,
      skewBiasPpm: s.skewBiasPpm,
      movieState: s.movieState,
      movieAudioPos: s.movieAudioPos,
      movieExpectedPos: s.movieExpectedPos,
      movieErrorMs: s.movieErrorMs,
      movieSmoothedMs: s.movieSmoothedMs,
      movieRate: s.movieRate,
      movieBufferS: s.movieBufferS,
      movieResyncs: s.movieResyncs,
      movieUnderruns: s.movieUnderruns,
    });
  }

  /** One row per device from an acoustic measurement (laptop microphone). */
  acoustic(kind, result, deviceName, masterTimeMs) {
    this.write({
      timestamp: new Date().toISOString(),
      masterTimeMs,
      room: this.roomId,
      deviceId: result.deviceId,
      deviceName,
      event: `acoustic-${kind}`,
      acousticErrorMs: result.errorMs,
      note: `heard ${result.heard}/${result.total}; spread ${csvCell(result.spreadMs)} ms; ` +
        `${result.reliable ? 'reliable' : 'unreliable'}${result.adjustMs != null ? `; adjusted ${csvCell(result.adjustMs)} ms` : ''}`,
    });
  }

  info() {
    return { enabled: !!this.stream, file: path.basename(this.file), rows: this.rows, startedAt: this.startedAt };
  }

  stop() {
    if (this.stream) this.stream.end();
    this.stream = null;
  }
}

module.exports = { SyncLog, COLUMNS };
