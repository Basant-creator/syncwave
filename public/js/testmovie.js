/*
 * testmovie.js (ES module, Master only) — generate an A/V sync test movie.
 *
 * Every whole second the picture flashes white for 2 frames and the sound
 * beeps (1 kHz; 2 kHz every 10 s). A big timecode shows the position. With
 * phones playing the sound, a flash should coincide with one crisp beep:
 * an echo means devices disagree, a beep before/after the flash means
 * lip-sync is off.
 *
 * Encoded with WebCodecs (H.264 baseline + AAC-LC) and written by a small
 * MP4 writer (standard, non-fragmented: moov + one mdat). The AAC encoder's
 * start delay ("priming") is measured by decoding the result and recorded in
 * an edit list, exactly as real encoders do, so in the finished file each
 * beep is at exactly the same media time as its flash.
 */

// ─── Minimal MP4 box writer ───────────────────────────────────────────────

const enc = new TextEncoder();

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function u8(...v) { return new Uint8Array(v); }
function u16(v) { return u8((v >> 8) & 255, v & 255); }
function u32(v) { return u8((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
function str(s) { return enc.encode(s); }

function box(type, ...payload) {
  const body = concat(payload.flat());
  return concat([u32(8 + body.length), str(type), body]);
}

function fullbox(type, version, flags, ...payload) {
  return box(type, u8(version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255), ...payload);
}

const MATRIX = [0x00010000, 0, 0, 0, 0x00010000, 0, 0, 0, 0x40000000].map(u32);

function mvhd(timescale, duration) {
  return fullbox('mvhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), u16(0),
    u32(0), u32(0), ...MATRIX, ...Array(6).fill(u32(0)), u32(3));
}

function tkhd(id, duration, w, h, isAudio) {
  return fullbox('tkhd', 0, 3, u32(0), u32(0), u32(id), u32(0), u32(duration), u32(0), u32(0),
    u16(0), u16(0), u16(isAudio ? 0x0100 : 0), u16(0), ...MATRIX, u32(w << 16), u32(h << 16));
}

function mdhd(timescale, duration) {
  return fullbox('mdhd', 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
}

function hdlr(type, name) {
  return fullbox('hdlr', 0, 0, u32(0), str(type), u32(0), u32(0), u32(0), str(`${name}\0`));
}

function dinf() {
  return box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1)));
}

function stbl(entry, count, delta, sizes, chunkOffset, syncSamples) {
  const parts = [
    fullbox('stsd', 0, 0, u32(1), entry),
    fullbox('stts', 0, 0, u32(1), u32(count), u32(delta)),
  ];
  // Tables are passed as arrays (not spread into arguments): a long movie has
  // tens of thousands of entries, more than a function call can take.
  if (syncSamples) parts.push(fullbox('stss', 0, 0, u32(syncSamples.length), syncSamples.map(u32)));
  parts.push(
    fullbox('stsc', 0, 0, u32(1), u32(1), u32(count), u32(1)),          // all samples in one chunk
    fullbox('stsz', 0, 0, u32(0), u32(count), sizes.map(u32)),
    fullbox('stco', 0, 0, u32(1), u32(chunkOffset)),
  );
  return box('stbl', ...parts);
}

function avc1(w, h, avcC) {
  return box('avc1', u8(0, 0, 0, 0, 0, 0), u16(1), u16(0), u16(0), u32(0), u32(0), u32(0),
    u16(w), u16(h), u32(0x00480000), u32(0x00480000), u32(0), u16(1), new Uint8Array(32), u16(0x18), u16(0xffff),
    box('avcC', avcC));
}

function descriptor(tag, ...payload) {
  const body = concat(payload.flat());
  return concat([u8(tag, 0x80, 0x80, 0x80, body.length), body]);
}

function mp4a(sampleRate, channels, asc) {
  const esds = fullbox('esds', 0, 0, descriptor(3, u16(0), u8(0),
    descriptor(4, u8(0x40, 0x15, 0, 0, 0), u32(128000), u32(128000), descriptor(5, asc)),
    descriptor(6, u8(2))));
  return box('mp4a', u8(0, 0, 0, 0, 0, 0), u16(1), u32(0), u32(0), u16(channels), u16(16), u16(0), u16(0),
    u32(sampleRate << 16), esds);
}

function elst(segmentDuration, mediaTime) {
  return box('edts', fullbox('elst', 0, 0, u32(1), u32(segmentDuration), u32(mediaTime), u16(1), u16(0)));
}

// ─── Generator ────────────────────────────────────────────────────────────

/**
 * @param {{seconds: number, width?: number, height?: number, fps?: number, sampleRate?: number,
 *          onProgress?: (fraction: number, label: string) => void}} o
 * @returns {Promise<{file: File, primingSamples: number}>}
 */
export async function makeTestMovie({ seconds, width = 640, height = 360, fps = 25, sampleRate = 48000, onProgress = () => {} }) {
  const frames = Math.round(seconds * fps);

  // Video ────────────────────────────────────────────────────────────────
  const canvas = new OffscreenCanvas(width, height);
  const g = canvas.getContext('2d');
  const vSamples = [];
  let avcC = null;
  let vError = null;
  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description) avcC = new Uint8Array(meta.decoderConfig.description);
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      vSamples.push({ data: b, key: chunk.type === 'key' });
    },
    error: (e) => { vError = e; },
  });
  venc.configure({ codec: 'avc1.42E01E', width, height, bitrate: 500_000, framerate: fps, avc: { format: 'avc' } });
  for (let f = 0; f < frames; f++) {
    if (vError) throw vError;
    const t = f / fps;
    const flash = f % fps < 2;
    g.fillStyle = flash ? '#ffffff' : '#101318';
    g.fillRect(0, 0, width, height);
    g.fillStyle = flash ? '#000000' : '#e8eaef';
    g.font = `bold ${Math.round(height / 5)}px sans-serif`;
    g.textAlign = 'center';
    const mm = String(Math.floor(t / 60)).padStart(2, '0');
    const ss = String(Math.floor(t % 60)).padStart(2, '0');
    const ff = String(f % fps).padStart(2, '0');
    g.fillText(`${mm}:${ss}.${ff}`, width / 2, height / 2);
    g.font = `${Math.round(height / 14)}px sans-serif`;
    g.fillText('SyncWave A/V test · flash = beep', width / 2, height * 0.8);
    g.fillStyle = '#4f8cff';
    g.fillRect(0, height - 8, width * ((f % fps) / fps), 8);
    const vf = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
    venc.encode(vf, { keyFrame: f % (fps * 2) === 0 });
    vf.close();
    // 'dequeue' events, not timers (timers are throttled in background tabs).
    while (venc.encodeQueueSize > 20) await new Promise((r) => venc.addEventListener('dequeue', r, { once: true }));
    if (f % fps === 0) onProgress((f / frames) * 0.8, 'Encoding video…');
  }
  await venc.flush();
  venc.close();
  if (!avcC) throw new Error('Video encoder gave no configuration.');

  // Audio ────────────────────────────────────────────────────────────────
  const aSamples = [];
  let asc = null;
  let aError = null;
  const aenc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta && meta.decoderConfig && meta.decoderConfig.description) asc = new Uint8Array(meta.decoderConfig.description);
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      aSamples.push(b);
    },
    error: (e) => { aError = e; },
  });
  aenc.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, bitrate: 128000 });
  const beepLen = Math.round(0.08 * sampleRate);
  const ramp = Math.round(0.002 * sampleRate);
  for (let s = 0; s < Math.ceil(seconds); s++) {
    if (aError) throw aError;
    const n = sampleRate;
    const planar = new Float32Array(n * 2);
    const freq = s % 10 === 0 ? 2000 : 1000;
    for (let i = 0; i < beepLen; i++) {
      const env = Math.min(1, i / ramp, (beepLen - i) / ramp);
      const v = 0.5 * env * Math.sin((2 * Math.PI * freq * i) / sampleRate);
      planar[i] = v;
      planar[n + i] = v;
    }
    const ad = new AudioData({ format: 'f32-planar', sampleRate, numberOfFrames: n, numberOfChannels: 2, timestamp: s * 1e6, data: planar });
    aenc.encode(ad);
    ad.close();
    if (s % 10 === 0) onProgress(0.8 + (s / seconds) * 0.1, 'Encoding audio…');
  }
  await aenc.flush();
  aenc.close();
  if (!asc) throw new Error('Audio encoder gave no configuration.');

  // Measure the encoder's start delay: decode and find the first beep.
  onProgress(0.92, 'Measuring audio priming…');
  const probe = new Float32Array(sampleRate);
  let filled = 0;
  const adec = new AudioDecoder({
    output: (ad) => {
      const tmp = new Float32Array(ad.numberOfFrames);
      ad.copyTo(tmp, { planeIndex: 0, format: 'f32-planar' });
      const at = Math.round((ad.timestamp / 1e6) * sampleRate);
      for (let i = 0; i < tmp.length && at + i < probe.length; i++) probe[at + i] = tmp[i];
      filled = Math.max(filled, at + tmp.length);
      ad.close();
    },
    error: () => {},
  });
  adec.configure({ codec: 'mp4a.40.2', sampleRate, numberOfChannels: 2, description: asc });
  for (let i = 0; i < Math.min(aSamples.length, 60); i++) {
    adec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round((i * 1024 * 1e6) / sampleRate), data: aSamples[i] }));
  }
  await adec.flush();
  adec.close();
  const firstAbove = (arr, th) => { for (let i = 0; i < arr.length; i++) if (Math.abs(arr[i]) > th) return i; return -1; };
  // The original beep crosses 0.1 at the same offset from its start; compare like with like.
  let ref = -1;
  for (let i = 0; i < beepLen; i++) {
    const env = Math.min(1, i / ramp, (beepLen - i) / ramp);
    if (Math.abs(0.5 * env * Math.sin((2 * Math.PI * 2000 * i) / sampleRate)) > 0.1) { ref = i; break; }
  }
  const got = firstAbove(probe, 0.1);
  const primingSamples = got >= 0 && ref >= 0 ? Math.max(0, got - ref) : 0;

  // Assemble the MP4 ──────────────────────────────────────────────────────
  onProgress(0.97, 'Writing MP4…');
  const movieTs = 1000;
  const durMs = Math.round(seconds * 1000);
  const vTs = fps * 1000;                    // video media timescale; one frame = 1000 ticks
  const aCount = aSamples.length;
  const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));
  const vData = vSamples.map((s) => s.data);
  const vBytes = vData.reduce((n, d) => n + d.length, 0);
  const mdatHeader = u32(8 + vBytes + aSamples.reduce((n, d) => n + d.length, 0));
  const vOffset = ftyp.length + 8;           // moov goes at the END (exercises the scanner)
  const aOffset = vOffset + vBytes;
  const syncs = vSamples.map((s, i) => (s.key ? i + 1 : 0)).filter(Boolean);
  const videoTrak = box('trak', tkhd(1, durMs, width, height, false), box('mdia', mdhd(vTs, frames * 1000), hdlr('vide', 'Video'),
    box('minf', fullbox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)), dinf(),
      stbl(avc1(width, height, avcC), vSamples.length, 1000, vData.map((d) => d.length), vOffset, syncs))));
  const audioTrak = box('trak', tkhd(2, durMs, 0, 0, true), elst(durMs, primingSamples),
    box('mdia', mdhd(sampleRate, aCount * 1024), hdlr('soun', 'Sound'),
      box('minf', fullbox('smhd', 0, 0, u16(0), u16(0)), dinf(),
        stbl(mp4a(sampleRate, 2, asc), aCount, 1024, aSamples.map((d) => d.length), aOffset, null))));
  const moov = box('moov', mvhd(movieTs, durMs), videoTrak, audioTrak);
  const file = new File([ftyp, concat([mdatHeader, str('mdat')]), ...vData, ...aSamples, moov],
    `syncwave-av-test-${Math.round(seconds / 60) || seconds + 's'}${seconds >= 60 ? 'min' : ''}.mp4`, { type: 'video/mp4' });
  onProgress(1, 'Done');
  return { file, primingSamples };
}
