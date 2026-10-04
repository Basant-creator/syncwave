'use strict';

/**
 * Generates test-audio/click-track.wav: 2 minutes of short beeps, one per
 * second (higher pitch every 4th beat). Ideal for judging sync by ear: when
 * devices are in sync you hear one crisp click; when they're off by more than
 * ~10–20 ms you hear a "flam" (double click) or an echo.
 *
 * Usage: npm run make-click-track
 */

const fs = require('node:fs');
const path = require('node:path');

const RATE = 44100;
const SECONDS = 120;
const BEEP_MS = 30;

const n = RATE * SECONDS;
const data = Buffer.alloc(n * 2);
const beepLen = Math.floor((RATE * BEEP_MS) / 1000);

for (let beat = 0; beat < SECONDS; beat++) {
  const freq = beat % 4 === 0 ? 1760 : 880;
  const start = beat * RATE;
  for (let i = 0; i < beepLen; i++) {
    const env = Math.min(1, (beepLen - i) / (beepLen * 0.5)); // sharp attack, short fade
    const sample = Math.sin((2 * Math.PI * freq * i) / RATE) * env * 0.8;
    data.writeInt16LE(Math.round(sample * 32767), (start + i) * 2);
  }
}

const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + data.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);        // PCM
header.writeUInt16LE(1, 22);        // mono
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28); // byte rate
header.writeUInt16LE(2, 32);        // block align
header.writeUInt16LE(16, 34);       // bits per sample
header.write('data', 36);
header.writeUInt32LE(data.length, 40);

const outDir = path.join(__dirname, '..', 'test-audio');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'click-track.wav');
fs.writeFileSync(out, Buffer.concat([header, data]));
console.log(`Wrote ${out} (${SECONDS} s, ${((44 + data.length) / 1024 / 1024).toFixed(1)} MB)`);
