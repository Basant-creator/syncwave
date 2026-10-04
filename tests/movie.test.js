'use strict';

// Movie Sync unit tests: timeline math, frame-anchor fitting, PCM writer,
// MP4 box scanner, server-side movie storage and clock validation.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

globalThis.window = globalThis;
require(path.join(__dirname, '..', 'public', 'js', 'sync.js'));
require(path.join(__dirname, '..', 'public', 'js', 'movie.js'));
const { MovieMath } = globalThis.SyncWave;
const movies = require('../server/movieStore');

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('MovieMath: position ↔ master time are inverses, offsets shift the schedule later', () => {
  const clock = { playing: true, videoTime: 100, masterTime: 1e12, rate: 1 };
  assert.ok(near(MovieMath.expectedPosition(clock, 1e12 + 2500), 102.5));
  // A device with +40 ms compensation hears position 102.5 forty ms later.
  assert.ok(near(MovieMath.expectedPosition(clock, 1e12 + 2540, 40), 102.5));
  const t = MovieMath.masterTimeForPosition(clock, 102.5, 40);
  assert.ok(near(t, 1e12 + 2540, 1e-6));
  assert.ok(near(MovieMath.expectedPosition(clock, t, 40), 102.5, 1e-9));
});

test('MovieMath: playback rate and paused clocks', () => {
  const fast = { playing: true, videoTime: 10, masterTime: 0, rate: 1.5 };
  assert.ok(near(MovieMath.expectedPosition(fast, 2000), 13));
  assert.ok(near(MovieMath.masterTimeForPosition(fast, 13), 2000));
  const paused = { playing: false, videoTime: 42, masterTime: 0, rate: 1 };
  assert.equal(MovieMath.expectedPosition(paused, 999999), 42);
});

test('MovieMath: anchor fit from video frames is exact despite jittery/late frame timestamps', () => {
  // 25 fps for 2 s; true timeline: mediaTime = 50 + (t − 5000)/1000.
  const frames = [];
  let seed = 3;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 50; i++) {
    const media = 50 + i / 25;
    let t = 5000 + i * 40 + (rnd() - 0.5) * 4;          // ±2 ms presentation jitter
    if (i % 17 === 5) t += 35;                          // a few frames reported very late
    frames.push({ mediaTime: media, masterTime: t });
  }
  const a = MovieMath.fitAnchor(frames, 1);
  const truth = 50 + (a.masterTime - 5000) / 1000;
  assert.ok(Math.abs(a.videoTime - truth) * 1000 < 1.5, `anchor error ${((a.videoTime - truth) * 1000).toFixed(2)} ms`);
});

test('PcmWriter: places audio at absolute frames, fills gaps with silence, trims overlap, emits in order', async () => {
  const { PcmWriter } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'movie-extract.js')).href);
  const chunks = [];
  const w = new PcmWriter(10, (frame, data) => { chunks.push([frame, Array.from(data)]); });   // 10 Hz → 20-frame chunks
  w.write(3, new Float32Array([0.5, 0.5]), new Float32Array([-0.5, -0.5]));                     // gap 0–2 → silence
  w.write(4, new Float32Array([1, 1]), new Float32Array([1, 1]));                               // overlaps frame 4
  const total = await w.finish(25);
  assert.equal(total, 25);
  assert.deepEqual(chunks.map((c) => c[0]), [0, 20]);
  const first = chunks[0][1];
  assert.deepEqual(first.slice(0, 6), [0, 0, 0, 0, 0, 0]);
  assert.equal(first[6], Math.trunc(0.5 * 32767));
  assert.equal(first[10], 32767);                                                               // frame 5 from the 2nd write
  assert.equal(chunks[1][1].length, 10);
});

test('MP4 scanner finds moov after a large mdat without reading the mdat', async () => {
  const { scanTopLevelBoxes } = await import(pathToFileURL(path.join(__dirname, '..', 'public', 'js', 'movie-extract.js')).href);
  const box = (type, len) => { const b = Buffer.alloc(len); b.writeUInt32BE(len, 0); b.write(type, 4); return b; };
  const blob = new Blob([box('ftyp', 24), box('mdat', 5 * 1024 * 1024), box('moov', 100)]);
  const boxes = await scanTopLevelBoxes(blob);
  assert.deepEqual(boxes.map((b) => b.type), ['ftyp', 'mdat', 'moov']);
  assert.equal(boxes[2].start, 24 + 5 * 1024 * 1024);
});

test('movieStore: out-of-order chunks become available contiguously; clock validation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwave-movie-'));
  try {
    const m = movies.createMovie(dir, { name: 'film.mp4', sampleRate: 48000, duration: 10 });
    assert.equal(m.totalFrames, 480000);
    const chunk = (frames, v) => { const b = Buffer.alloc(frames * 4); b.fill(v); return b; };
    assert.equal(movies.writeChunk(m, 96000, chunk(96000, 2)), 0);        // second chunk first
    assert.equal(movies.writeChunk(m, 0, chunk(96000, 1)), 192000);       // now 0–192000 contiguous
    assert.throws(() => movies.writeChunk(m, 1, Buffer.alloc(3)));
    const data = fs.readFileSync(m.filePath);
    assert.equal(data[0], 1);
    assert.equal(data[96000 * 4], 2);
    movies.completeMovie(m, 192000);
    assert.equal(m.status, 'ready');
    assert.equal(m.duration, 4);
    assert.equal(movies.cleanClock({ epoch: 3, videoTime: 1, masterTime: 5 }, 4), null, 'older epoch rejected');
    const c = movies.cleanClock({ epoch: 4, videoTime: 1, masterTime: 5, rate: 99, playing: true, avOffsetMs: 9999 }, 4);
    assert.equal(c.rate, 1);
    assert.equal(c.avOffsetMs, 300);
    movies.deleteMovie(m);
  } finally {
    setTimeout(() => fs.rmSync(dir, { recursive: true, force: true }), 100);
  }
});
