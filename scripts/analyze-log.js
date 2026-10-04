'use strict';

/**
 * Summarize a SyncWave CSV sync log (Master → Developer mode → Start CSV log).
 *
 * Usage:
 *   npm run analyze-log                     # newest file in logs/
 *   npm run analyze-log -- path/to/log.csv  # a specific file
 *   npm run analyze-log -- file.csv 5       # window size in minutes (default 5)
 *
 * Per device, overall and per time window, while playing: median / 95th
 * percentile / max |smoothed drift|, % of time SYNCED, explicit resyncs,
 * reconnect gaps, and how much rate correction was used. Plus every acoustic
 * measurement row.
 */

const fs = require('node:fs');
const path = require('node:path');

const logDir = process.env.LOG_DIR ? path.resolve(process.env.LOG_DIR) : path.join(__dirname, '..', 'logs');
let file = process.argv[2];
if (!file) {
  const files = fs.existsSync(logDir) ? fs.readdirSync(logDir).filter((f) => f.endsWith('.csv')) : [];
  if (!files.length) { console.error(`No CSV logs in ${logDir}`); process.exit(1); }
  files.sort((a, b) => fs.statSync(path.join(logDir, b)).mtimeMs - fs.statSync(path.join(logDir, a)).mtimeMs);
  file = path.join(logDir, files[0]);
}
const windowMin = Number(process.argv[3]) || 5;

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const cells = [];
    let cur = '';
    let q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  const [header, ...data] = rows;
  return data.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
}

const pct = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;
const num = (v) => (v === '' || v == null ? null : Number(v));

const rows = parseCsv(fs.readFileSync(file, 'utf8'));
console.log(`File: ${file}  (${rows.length} rows)\n`);

const status = rows.filter((r) => r.event === 'status');
const t0 = Math.min(...status.map((r) => Number(r.masterTimeMs)));
const byDevice = new Map();
for (const r of status) {
  const k = `${r.deviceName} (${r.deviceId.slice(0, 6)})`;
  if (!byDevice.has(k)) byDevice.set(k, []);
  byDevice.get(k).push(r);
}

function summarize(list) {
  const playing = list.filter((r) => r.state === 'playing' || r.state === 'live');
  const drift = playing.map((r) => Math.abs(num(r.smoothedDriftMs))).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const synced = playing.filter((r) => r.syncState === 'SYNCED').length;
  const corr = playing.map((r) => Math.abs(num(r.correction) || 0));
  const resyncs = list.length ? (num(list[list.length - 1].resyncs) || 0) - (num(list[0].resyncs) || 0) : 0;
  const disconnected = list.filter((r) => r.syncState === 'DISCONNECTED').length;
  return {
    playingS: playing.length,
    median: pct(drift, 0.5), p95: pct(drift, 0.95), max: drift[drift.length - 1],
    syncedPct: playing.length ? (100 * synced) / playing.length : NaN,
    resyncs, disconnectedS: disconnected,
    meanCorrPct: corr.length ? (100 * corr.reduce((a, b) => a + b, 0)) / corr.length : NaN,
    maxCorrPct: corr.length ? 100 * Math.max(...corr) : NaN,
    lastSkew: num(list[list.length - 1].skewBiasPpm),
  };
}

const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const header = 'window          playing(s)  |drift| median/p95/max (ms)  SYNCED   resyncs  offline(s)  rate corr mean/max   learned skew';
for (const [name, list] of byDevice) {
  console.log(`■ ${name}`);
  console.log(header);
  const end = Math.max(...list.map((r) => Number(r.masterTimeMs)));
  const windows = [['overall', list]];
  for (let w = 0; w * windowMin * 60000 <= end - t0; w++) {
    const a = t0 + w * windowMin * 60000;
    const b = a + windowMin * 60000;
    windows.push([`${String(w * windowMin).padStart(3)}–${String((w + 1) * windowMin).padEnd(3)} min`, list.filter((r) => Number(r.masterTimeMs) >= a && Number(r.masterTimeMs) < b)]);
  }
  for (const [label, l] of windows) {
    if (!l.length) continue;
    const s = summarize(l);
    console.log(`${label.padEnd(14)}  ${String(s.playingS).padStart(10)}  ${`${f(s.median)} / ${f(s.p95)} / ${f(s.max)}`.padStart(27)}  ` +
      `${`${f(s.syncedPct, 0)}%`.padStart(6)}  ${String(s.resyncs).padStart(7)}  ${String(s.disconnectedS).padStart(10)}  ` +
      `${`${f(s.meanCorrPct, 3)}% / ${f(s.maxCorrPct, 3)}%`.padStart(19)}  ${f(s.lastSkew, 0).padStart(12)} ppm`);
  }
  console.log('');
}

const acoustic = rows.filter((r) => r.event.startsWith('acoustic'));
if (acoustic.length) {
  console.log('Acoustic measurements (laptop microphone):');
  for (const r of acoustic) console.log(`  ${r.timestamp}  ${r.event.padEnd(18)} ${r.deviceName.padEnd(16)} ${f(num(r.acousticErrorMs))} ms  ${r.note}`);
}
