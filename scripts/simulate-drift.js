'use strict';

/**
 * Long-session drift simulation for the DriftController in public/js/sync.js
 * (the exact code the browsers run).
 *
 * It models one device against the master timeline:
 *   - the device's audio clock runs at (1 + skew) × the commanded rate
 *   - every 250 ms the device measures its error with realistic noise:
 *     ±1 ms jitter, a slowly wandering clock-offset estimate (±2 ms),
 *     and 1 % outlier readings of ±30 ms (bad packets / timestamp glitches)
 *   - every 10 minutes an audio-thread glitch suddenly delays playback by 40 ms
 *
 * and reports, per scenario: worst and RMS true error, % of time within the
 * profile's SYNCED tolerance, explicit resyncs, and how hard the rate was
 * pushed. This tests the control loop's stability over 5–90 minutes; it does
 * NOT replace listening to real devices.
 *
 * Usage: npm run simulate-drift   (or: node scripts/simulate-drift.js 90)
 */

const path = require('node:path');

globalThis.window = globalThis;
require(path.join(__dirname, '..', 'public', 'js', 'sync.js'));
const { DriftController, SYNC_PROFILES } = globalThis.SyncWave;

// Deterministic pseudo-random numbers so runs are reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand) {
  return Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
}

function simulate({ minutes, skewPpm, profile, seed = 1 }) {
  const rand = rng(seed);
  const ctl = new DriftController(profile);
  const tol = SYNC_PROFILES[profile].syncedMs;
  const dt = 0.25;
  const steps = Math.round((minutes * 60) / dt);

  let eTrue = (rand() - 0.5) * 6;   // initial start error ± 3 ms
  let rate = 1;
  let wander = 0;
  let resyncs = 0;
  let blackoutUntil = -1;           // after a resync the device is silent ~0.4 s
  let worst = 0, sumSq = 0, n = 0, within = 0, maxDev = 0, strongS = 0;
  let steadyWorst = 0, steadySq = 0, steadyN = 0;
  const glitchEvery = 600;          // s

  for (let i = 0; i < steps; i++) {
    const t = i * dt;
    // Physics: error accumulates from skew and the commanded rate.
    eTrue += ((1 + skewPpm * 1e-6) * rate - 1) * 1000 * dt;
    if (i > 0 && Math.round(t * 4) % (glitchEvery * 4) === 0) eTrue -= 40; // audio glitch: 40 ms late

    // Measurement noise model.
    wander = Math.max(-2, Math.min(2, wander + gaussian(rand) * 0.05));
    let meas = eTrue + wander + gaussian(rand) * 1;
    if (rand() < 0.01) meas += (rand() < 0.5 ? -30 : 30);

    if (t < blackoutUntil) continue;
    const r = ctl.update(meas, t);
    if (r.action === 'resync') {
      resyncs++;
      eTrue = gaussian(rand) * 2;   // a fresh scheduled start lands within a couple of ms
      rate = r.rate;
      blackoutUntil = t + 0.4;
      continue;
    }
    rate = r.rate;

    if (t > 10) {                    // skip initial settling
      const a = Math.abs(eTrue);
      worst = Math.max(worst, a);
      sumSq += eTrue * eTrue;
      n++;
      if (a <= tol) within++;
      // Steady state: excluding the minute after each deliberate glitch.
      if (t % glitchEvery > 60) { steadyWorst = Math.max(steadyWorst, a); steadySq += eTrue * eTrue; steadyN++; }
      maxDev = Math.max(maxDev, Math.abs(rate - 1));
      if (Math.abs(rate - 1) > SYNC_PROFILES[profile].softRate + 1e-6) strongS += dt;
    }
  }
  return {
    worst, rms: Math.sqrt(sumSq / n), withinPct: (100 * within) / n, resyncs,
    steadyWorst, steadyRms: Math.sqrt(steadySq / Math.max(1, steadyN)),
    maxRateDev: maxDev, strongS, learnedSkewPpm: ctl.bias * 1e6,
  };
}

const durations = process.argv[2] ? [Number(process.argv[2])] : [5, 15, 30, 60, 90];
const skews = [0, 30, -80, 200];
const profiles = ['music', 'movie'];

console.log('Drift-correction simulation (true error = what a listener would get; noise + glitches included)\n');
console.log('profile  skew(ppm)  minutes   worst(ms)  rms(ms)  steady worst/rms  in-tolerance  resyncs  max|rate−1|  >soft-rate(s)  learned skew(ppm)');
let failures = 0;
for (const profile of profiles) {
  for (const skewPpm of skews) {
    for (const minutes of durations) {
      const r = simulate({ minutes, skewPpm, profile, seed: minutes * 1000 + skewPpm + (profile === 'movie' ? 7 : 0) });
      // Pass criteria: stable loop (no runaway), mostly within tolerance, few resyncs
      // (glitches of 40 ms exceed Movie's 80 ms limit? no — so resyncs should stay ~0).
      const ok = r.withinPct > 90 && r.resyncs <= Math.ceil(minutes / 10) && r.worst < 60;
      if (!ok) failures++;
      console.log(
        `${profile.padEnd(7)}  ${String(skewPpm).padStart(9)}  ${String(minutes).padStart(7)}  ` +
        `${r.worst.toFixed(1).padStart(10)}  ${r.rms.toFixed(2).padStart(7)}  ` +
        `${`${r.steadyWorst.toFixed(1)}/${r.steadyRms.toFixed(2)}`.padStart(16)}  ${r.withinPct.toFixed(1).padStart(11)}%  ` +
        `${String(r.resyncs).padStart(7)}  ${(r.maxRateDev * 100).toFixed(3).padStart(10)}%  ${r.strongS.toFixed(0).padStart(13)}  ` +
        `${r.learnedSkewPpm.toFixed(0).padStart(17)}  ${ok ? 'ok' : 'FAIL'}`,
      );
    }
  }
}
console.log(`\n${failures === 0 ? 'All scenarios passed.' : `${failures} scenario(s) failed.`}`);
console.log('Notes: "worst" includes the deliberate 40 ms glitch every 10 min, i.e. the peak just before it is corrected.');
process.exitCode = failures ? 1 : 0;
