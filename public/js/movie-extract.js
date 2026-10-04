/*
 * movie-extract.js (ES module, Master only) — pull a movie's audio track out
 * of the file, in the browser, faster than real time, without loading the
 * whole (multi-GB) file into memory.
 *
 * MP4 / MOV / M4V (the common case):
 *   1. Scan the top-level boxes (8–16 byte reads) to find `moov`, skipping
 *      the huge `mdat` without reading it.
 *   2. Let mp4box parse just ftyp + moov → the audio track's sample table
 *      (byte offset, size and timestamp of every compressed audio frame).
 *   3. Read only those bytes, decode with WebCodecs AudioDecoder.
 *   4. Place every decoded frame at its *presentation* time — composition
 *      time adjusted by the track's edit list (which is how MP4 encodes AAC
 *      encoder priming and audio start delays). That is the timeline the
 *      <video> element plays, so the audio lines up with the picture.
 *
 * Anything else (WebM, fragmented MP4, …): decode the whole file with
 * decodeAudioData (size-limited; less exact about codec start delays).
 *
 * Output: 16-bit interleaved stereo PCM in ~2 s chunks, handed to `onPcm`
 * together with its frame position (uploaded to the server by the caller).
 */

const CHUNK_SECONDS = 2;
const MAX_FALLBACK_BYTES = 600 * 1024 * 1024;

const fourcc = (dv, o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/** Top-level MP4 boxes up to and including moov (mdat is skipped by its size). */
async function scanTopLevelBoxes(file) {
  const boxes = [];
  let pos = 0;
  while (pos + 8 <= file.size && boxes.length < 10000) {
    const dv = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = dv.getUint32(0);
    const type = fourcc(dv, 4);
    let header = 8;
    if (size === 1) { size = Number(dv.getBigUint64(8)); header = 16; } else if (size === 0) size = file.size - pos;
    if (size < header || !/^[\x20-\x7e]{4}$/.test(type)) break;
    boxes.push({ type, start: pos, size });
    if (type === 'moov' && boxes.some((b) => b.type === 'ftyp')) break;
    pos += size;
  }
  return boxes;
}

/** AAC AudioSpecificConfig (DecoderSpecificInfo, tag 5) from the esds box. */
function findDecoderSpecificInfo(entry) {
  const esds = entry.esds || (entry.boxes || []).find((b) => b.type === 'esds');
  if (!esds || !esds.esd) return undefined;
  const walk = (d) => {
    if (!d) return undefined;
    if (d.tag === 5 && d.data) return d.data;
    for (const c of d.descs || []) { const r = walk(c); if (r) return r; }
    return undefined;
  };
  const data = walk(esds.esd);
  return data ? new Uint8Array(data) : undefined;
}

/**
 * Accumulates decoded audio at absolute frame positions and emits fixed-size
 * Int16 stereo chunks in order. Gaps are filled with silence, overlaps trimmed.
 */
class PcmWriter {
  constructor(rate, onPcm) {
    this.rate = rate;
    this.onPcm = onPcm;
    this.chunkFrames = Math.round(CHUNK_SECONDS * rate);
    this.cursor = 0;                       // first frame not yet emitted
    this.buf = new Int16Array(this.chunkFrames * 2);
    this.fill = 0;                         // frames in buf
    this.inflight = [];
  }

  write(start, L, R) {
    let skip = 0;
    const expected = this.cursor + this.fill;
    if (start > expected) this.silence(start - expected);
    else if (start < expected) skip = expected - start;
    for (let i = skip; i < L.length; i++) {
      const o = this.fill * 2;
      this.buf[o] = Math.max(-1, Math.min(1, L[i])) * 32767;
      this.buf[o + 1] = Math.max(-1, Math.min(1, R[i])) * 32767;
      if (++this.fill === this.chunkFrames) this.emit();
    }
  }

  silence(n) {
    for (let i = 0; i < n; i++) {
      this.buf[this.fill * 2] = 0;
      this.buf[this.fill * 2 + 1] = 0;
      if (++this.fill === this.chunkFrames) this.emit();
    }
  }

  emit() {
    if (this.fill === 0) return;
    const chunk = this.buf.slice(0, this.fill * 2);
    const frame = this.cursor;
    this.cursor += this.fill;
    this.fill = 0;
    const p = Promise.resolve(this.onPcm(frame, chunk)).finally(() => {
      this.inflight.splice(this.inflight.indexOf(p), 1);
    });
    this.inflight.push(p);
  }

  /** Wait while too many uploads are in flight. */
  async backpressure(max = 3) {
    while (this.inflight.length > max) await Promise.race(this.inflight);
  }

  async finish(totalFrames) {
    const have = this.cursor + this.fill;
    if (totalFrames > have) this.silence(totalFrames - have);
    this.emit();
    await Promise.all(this.inflight);
    return this.cursor;
  }
}

function toStereo(ad) {
  const n = ad.numberOfFrames;
  const ch = ad.numberOfChannels;
  const planes = [];
  for (let c = 0; c < ch; c++) {
    const p = new Float32Array(n);
    ad.copyTo(p, { planeIndex: c, format: 'f32-planar' });
    planes.push(p);
  }
  if (ch === 1) return [planes[0], planes[0]];
  if (ch === 2) return planes;
  // Surround → stereo (SMPTE order FL FR C LFE SL SR): standard −3 dB fold-down.
  const k = 0.7071;
  const norm = 1 / (1 + 2 * k);
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = (planes[0][i] + k * planes[2][i] + (ch > 4 ? k * planes[4][i] : 0)) * norm;
    R[i] = (planes[1][i] + k * planes[2][i] + (ch > 5 ? k * planes[5][i] : 0)) * norm;
  }
  return [L, R];
}

async function extractMp4(file, { onStart, onPcm, onProgress, videoDuration }) {
  const boxes = await scanTopLevelBoxes(file);
  const ftyp = boxes.find((b) => b.type === 'ftyp');
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) throw new Error('No movie header (moov) found — the file may be incomplete.');
  if (moov.size > 256 * 1024 * 1024) throw new Error('Movie header too large.');

  const { createFile, MP4BoxBuffer } = await import('/vendor/mp4box/mp4box.all.mjs');
  const mp4 = createFile();
  let info = null;
  let parseError = null;
  mp4.onReady = (i) => { info = i; };
  mp4.onError = (e) => { parseError = e; };
  // Parse a synthetic file of just ftyp + moov. Sample offsets in moov are
  // absolute positions in the ORIGINAL file, so they stay valid.
  const parts = await Promise.all([ftyp, moov].filter(Boolean).map((b) => file.slice(b.start, b.start + b.size).arrayBuffer()));
  const synth = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { synth.set(new Uint8Array(p), o); o += p.byteLength; }
  mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(synth.buffer, 0));
  mp4.flush();
  if (!info) throw new Error(`Could not read the movie structure${parseError ? `: ${parseError}` : ''}.`);
  if (info.isFragmented) return null; // fragmented MP4 → fallback path
  const track = info.audioTracks && info.audioTracks[0];
  if (!track) throw new Error('This movie has no audio track.');
  const trak = mp4.getTrackById(track.id);
  const samples = trak.samples;
  if (!samples || !samples.length) throw new Error('The audio track has no samples.');

  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  let codec = track.codec;
  if (/^mp4a\.(6b|69)/i.test(codec)) codec = 'mp3';
  const sampleRate = track.audio.sample_rate;
  const channels = track.audio.channel_count;
  const config = { codec, sampleRate, numberOfChannels: channels };
  if (codec.startsWith('mp4a')) config.description = findDecoderSpecificInfo(entry);
  const support = await AudioDecoder.isConfigSupported(config).catch(() => ({ supported: false }));
  if (!support.supported) throw new Error(`This browser can't decode the movie's audio (${codec}).`);

  // Edit list: initial empty edits delay the audio; the first real edit says
  // which media time is presented at movie time 0 (AAC priming etc.).
  const movieTimescale = info.timescale;
  const mediaTimescale = trak.mdia.mdhd.timescale;
  let emptyS = 0;
  let mediaStartS = 0;
  const elst = trak.edts && trak.edts.elst && trak.edts.elst.entries;
  if (elst) {
    for (const e of elst) {
      if (e.media_time === -1 || e.media_time === 0xffffffff) emptyS += e.segment_duration / movieTimescale;
      else { mediaStartS = e.media_time / mediaTimescale; break; }
    }
  }
  const movieDuration = Math.max(videoDuration || 0, info.duration / movieTimescale || 0);
  await onStart({ sampleRate, duration: movieDuration });

  const writer = new PcmWriter(sampleRate, onPcm);
  let decodeError = null;
  const decoder = new AudioDecoder({
    output: (ad) => {
      try {
        const [L, R] = toStereo(ad);
        writer.write(Math.round((ad.timestamp / 1e6) * sampleRate), L, R);
      } finally {
        ad.close();
      }
    },
    error: (e) => { decodeError = e; },
  });
  decoder.configure(config);

  for (let i = 0; i < samples.length;) {
    if (decodeError) throw decodeError;
    // Read runs of contiguous samples (≤ 1 MB) in one go.
    let j = i;
    const start = samples[i].offset;
    let end = start + samples[i].size;
    while (j + 1 < samples.length && samples[j + 1].offset === end && end - start < (1 << 20)) { j++; end += samples[j].size; }
    const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
    for (let k = i; k <= j; k++) {
      const s = samples[k];
      const presentS = s.cts / s.timescale - mediaStartS + emptyS;
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round(presentS * 1e6),
        duration: Math.round((s.duration / s.timescale) * 1e6),
        data: bytes.subarray(s.offset - start, s.offset - start + s.size),
      }));
    }
    i = j + 1;
    // Wait on the decoder's own 'dequeue' event, not a timer: timers are
    // throttled to ~1/s when the tab is in the background.
    while (decoder.decodeQueueSize > 64) await new Promise((r) => decoder.addEventListener('dequeue', r, { once: true }));
    await writer.backpressure();
    onProgress && onProgress(i / samples.length);
  }
  await decoder.flush();
  decoder.close();
  if (decodeError) throw decodeError;
  const frames = await writer.finish(Math.ceil(movieDuration * sampleRate));
  return { sampleRate, frames, duration: frames / sampleRate, method: 'mp4 + WebCodecs', codec, editList: { emptyS, mediaStartS } };
}

async function extractWhole(file, { onStart, onPcm, onProgress, videoDuration }) {
  if (file.size > MAX_FALLBACK_BYTES) {
    throw new Error('This format can only be prepared up to 600 MB. Use an MP4 (H.264/AAC) file for long movies.');
  }
  onProgress && onProgress(0.05);
  const sampleRate = 48000;
  const ctx = new OfflineAudioContext(2, 1, sampleRate);
  let buffer;
  try {
    buffer = await ctx.decodeAudioData(await file.arrayBuffer());
  } catch {
    throw new Error("This browser can't read the movie's audio. Use an MP4 (H.264/AAC) or WebM file.");
  }
  const duration = Math.max(videoDuration || 0, buffer.duration);
  await onStart({ sampleRate, duration });
  const writer = new PcmWriter(sampleRate, onPcm);
  const L = buffer.getChannelData(0);
  const R = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : L;
  const step = sampleRate * 10;
  for (let i = 0; i < L.length; i += step) {
    writer.write(i, L.subarray(i, i + step), R.subarray(i, i + step));
    await writer.backpressure();
    onProgress && onProgress(0.05 + 0.95 * (i / L.length));
  }
  const frames = await writer.finish(Math.ceil(duration * sampleRate));
  return { sampleRate, frames, duration: frames / sampleRate, method: 'decodeAudioData (approximate start)', codec: 'browser' };
}

/**
 * @param {File} file
 * @param {{ onStart: ({sampleRate, duration}) => Promise<void>, onPcm: (frame, Int16Array) => Promise<void>,
 *           onProgress?: (fraction) => void, videoDuration?: number }} opts
 */
export async function extractMovieAudio(file, opts) {
  const head = new DataView(await file.slice(0, 12).arrayBuffer());
  const isMp4 = head.byteLength >= 8 && fourcc(head, 4) === 'ftyp';
  if (isMp4 && typeof AudioDecoder !== 'undefined') {
    const r = await extractMp4(file, opts);
    if (r) return r;
  }
  return extractWhole(file, opts);
}

export { PcmWriter, scanTopLevelBoxes };
