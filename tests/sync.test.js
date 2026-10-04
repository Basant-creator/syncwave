'use strict';

// Unit tests for the synchronization logic that runs in the browsers
// (public/js/sync.js, public/js/calibration.js) and on the server
// (server/syncEngine.js). Run: npm test

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '..', 'public', 'js', 'sync.js'));
require(path.join(__dirname, '..', 'public', 'js', 'calibration.js'));
const { ClockSync, DriftController, SYNC_PROFILES, wrapCentered, Calibration } = globalThis.SyncWave;
const engine = require('../server/syncEngine');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─── ClockSync ──────────────────────────────────────────────────────────────

test('ClockSync: converges on the true offset despite asymmetric slow packets, and tracks drift', () => {
  const rand = rng(42);
  const clock = new ClockSync(() => {});
  const trueOffset0 = 1234.5;      // master − local at local t = 0
  const driftPpm = 50;             // master clock runs 50 ppm faster
  const offsetAt = (localT) => trueOffset0 + driftPpm * 1e-6 * localT;
  let localT = 1e6;
  const start = localT;
  for (let i = 0; i < 120; i++) {   // 2 minutes, 1 exchange per second
    localT += 1000;
    let up = 2 + rand() * 2;        // one-way delays in ms
    let down = 2 + rand() * 2;
    if (rand() < 0.15) up += 40 + rand() * 80;    // 15 % of packets badly delayed one way
    if (rand() < 0.15) down += 40 + rand() * 80;
    const t0 = localT;
    const t1 = t0 + up + offsetAt(t0 - start);
    const t2 = t1 + 0.2;
    const t3 = t2 - offsetAt(t0 - start) + down;
    clock.addSample(t0, t1, t2, t3);
  }
  const err = clock.offsetAt(localT) - offsetAt(localT - start);
  assert.ok(Math.abs(err) < 1.0, `offset error ${err.toFixed(3)} ms should be < 1 ms`);
  assert.ok(clock.driftPpm != null && Math.abs(clock.driftPpm - driftPpm) < 15, `drift ${clock.driftPpm} ppm ≈ ${driftPpm}`);
  assert.ok(clock.uncertaintyMs < 5, `uncertainty ${clock.uncertaintyMs}`);
});

test('ClockSync: a single very slow packet does not move the estimate', () => {
  const clock = new ClockSync(() => {});
  let t = 1000;
  for (let i = 0; i < 10; i++) { t += 1000; clock.addSample(t, t + 2 + 500, t + 2.1 + 500, t + 4.1); }
  const before = clock.offset;
  t += 1000;
  clock.addSample(t, t + 300 + 500, t + 300.1 + 500, t + 302.1); // 300 ms stuck on the way out
  assert.ok(Math.abs(clock.offsetAt(t) - before) < 0.5, 'outlier ignored');
});

// ─── DriftController ────────────────────────────────────────────────────────

test('DriftController: ignores small errors (deadband)', () => {
  const c = new DriftController('music');
  let r;
  for (let i = 0; i < 40; i++) r = c.update(5 + (i % 2), i * 0.25);
  assert.equal(r.action, 'rate');
  assert.ok(Math.abs(r.rate - 1) < 2e-4, `rate ${r.rate} should stay ~1`);
});

test('DriftController: device ahead → slows down gently, within the profile cap', () => {
  const c = new DriftController('music');
  let r;
  for (let i = 0; i < 40; i++) r = c.update(30, i * 0.25);
  assert.ok(r.rate < 1, 'slows down when ahead');
  assert.ok(1 - r.rate <= SYNC_PROFILES.music.softRate + 0.0005 + 1e-9, `rate change ${1 - r.rate} ≤ soft cap`);
  assert.equal(r.zone, 'fine');
});

test('DriftController: device behind → speeds up; strong zone for large errors', () => {
  const c = new DriftController('music');
  let r;
  for (let i = 0; i < 40; i++) r = c.update(-120, i * 0.25);
  assert.ok(r.rate > 1);
  assert.equal(r.zone, 'strong');
  assert.ok(r.rate - 1 <= SYNC_PROFILES.music.hardRate + 0.0005 + 1e-9);
});

test('DriftController: rate never jumps by more than the slew limit per update', () => {
  const c = new DriftController('movie');
  let prev = 1;
  for (let i = 0; i < 20; i++) {
    const r = c.update(70, i * 0.25);
    assert.ok(Math.abs(r.rate - prev) <= 0.0005 + 1e-12);
    prev = r.rate;
  }
});

test('DriftController: explicit resync only beyond the limit, twice in a row, with cooldown', () => {
  const c = new DriftController('movie');           // resync above 80 ms
  assert.equal(c.update(500, 0).action, 'rate');    // one reading is not enough
  assert.equal(c.update(500, 0.25).action, 'resync');
  assert.equal(c.update(500, 0.5).action, 'rate');  // history reset
  assert.equal(c.update(500, 0.75).action, 'rate'); // cooldown (5 s) holds it back
  // Still far off after the cooldown → resync again at the first chance.
  assert.equal(c.update(500, 6).action, 'resync');
});

test('DriftController: single outlier readings are filtered out', () => {
  const c = new DriftController('music');
  let r;
  for (let i = 0; i < 20; i++) r = c.update(i === 10 ? 400 : 0, i * 0.25);
  assert.equal(r.action, 'rate');
  assert.ok(Math.abs(r.rate - 1) < 1e-6);
});

test('wrapCentered wraps loop errors into (−d/2, d/2]', () => {
  assert.equal(wrapCentered(0.004, 10), 0.004);
  assert.ok(Math.abs(wrapCentered(9.996, 10) - -0.004) < 1e-12);
});

// ─── Acoustic calibration analysis ──────────────────────────────────────────

function synthRecording({ delays, base = 23, gains = {}, echo = true, noise = 0.05, seed = 7 }) {
  const rate = 48000;
  const start = 10;
  const rand = rng(seed);
  const ids = Object.keys(delays);
  const rounds = 3;
  const rec = new Float32Array(Math.ceil(rate * (2 + ids.length * rounds * 0.9 + 1)));
  for (let i = 0; i < rec.length; i++) rec[i] = (rand() - 0.5) * noise;
  const chirp = Calibration.makeChirp(rate);
  const exps = [];
  let k = 0;
  for (let r = 0; r < rounds; r++) {
    for (const id of ids) {
      const expectedCtx = start + 1 + k * 0.9;
      k++;
      exps.push({ deviceId: id, expectedCtx });
      if (delays[id] == null) continue; // silent device
      const at = Math.round((expectedCtx - start + (base + delays[id]) / 1000) * rate);
      const g = gains[id] ?? 0.4;
      for (let j = 0; j < chirp.length; j++) {
        rec[at + j] += g * chirp[j];
        if (echo) rec[at + j + Math.round(0.008 * rate)] += g * 1.15 * chirp[j]; // louder reflection 8 ms later
      }
    }
  }
  return { rec, rate, start, exps };
}

test('Calibration: measures each device relative to the laptop (sub-ms), even with a louder echo', () => {
  const truth = { master: 0, a: 31.4, b: -12.2, c: 140 };
  const { rec, rate, start, exps } = synthRecording({ delays: truth, gains: { master: 0.6, a: 0.25, b: 0.25, c: 0.15 } });
  const sum = Calibration.summarize(Calibration.analyzeRecording(rec, rate, start, exps));
  assert.ok(sum.ok);
  for (const d of sum.devices) {
    assert.ok(d.reliable, `${d.deviceId} reliable`);
    assert.ok(Math.abs(d.errorMs - truth[d.deviceId]) < 0.1, `${d.deviceId}: ${d.errorMs} vs ${truth[d.deviceId]}`);
  }
});

test('Calibration: a device that never sounds is reported as not heard', () => {
  const { rec, rate, start, exps } = synthRecording({ delays: { master: 0, quiet: null } });
  const sum = Calibration.summarize(Calibration.analyzeRecording(rec, rate, start, exps));
  const quiet = sum.devices.find((d) => d.deviceId === 'quiet');
  assert.equal(quiet.heard, 0);
  assert.equal(quiet.reliable, false);
  assert.equal(quiet.errorMs, null);
});

test('Calibration: refuses to guess without the laptop reference', () => {
  const { rec, rate, start, exps } = synthRecording({ delays: { master: null, a: 10 } });
  const sum = Calibration.summarize(Calibration.analyzeRecording(rec, rate, start, exps));
  assert.equal(sum.ok, false);
});

// ─── Server playback state machine ──────────────────────────────────────────

test('syncEngine: Repeat wraps the timeline and toggling it while playing is continuous', () => {
  let pb = engine.setTrack(engine.createPlayback(), 'abc');
  const now = engine.masterNow();
  pb = engine.play(pb, { startAt: now + 1000, position: 0, loop: true, duration: 10 });
  assert.equal(pb.loop, true);
  assert.equal(pb.continuous, false);
  // 25 s after the start, a 10 s loop is at 5 s.
  const pos = engine.positionAt(pb, pb.startAt + 25000);
  assert.ok(Math.abs(pos - 5) < 1e-9);
  const toggled = engine.setLoop(pb, { loop: false });
  assert.equal(toggled.continuous, true);
  assert.equal(toggled.seq, pb.seq + 1);
  assert.equal(engine.pause(toggled).continuous, false);
});
