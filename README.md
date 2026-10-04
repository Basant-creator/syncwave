# SyncWave (prototype)

Play the same audio file on a laptop and one or more phones at the same moment, each through its own built-in speaker, over local Wi-Fi.

The laptop is the **Master**: it creates a room, shows a QR code, uploads the track and controls playback. Phones are **Clients**: they scan the QR code, download the track, and start playback at a scheduled time on a shared clock.

This is a first prototype. Sync is "basic": one clock-aligned scheduled start per play/seek. There is no continuous drift correction yet (see [Known limitations](#known-limitations-and-expected-accuracy)).

The Master offers two independent choices:

| | Options |
|---|---|
| **Source**, what is played | *Audio file* (uploaded) or *Live from this laptop* (tab / app / system capture) |
| **Playback Mode**, how each device reproduces it | **Standard Sync** (default, stable: every device plays the full mix) or **Experimental Spatial** (distributed stereo by device position, see [below](#experimental-spatial-mode-distributed-stereo)) |

---

## Requirements

- Node.js 18 or newer (tested with Node 24)
- A laptop and phones **on the same Wi-Fi network**
- A modern browser: Chrome, Edge, Firefox, or Safari (desktop or mobile)

## Install and run

```bash
cd syncwave
npm install
npm start
```

The terminal prints something like:

```
────────────────────────────────────────────────────────────
  SyncWave is running
────────────────────────────────────────────────────────────
  1. On THIS laptop open the Master page:  http://localhost:3000
  2. Phones join by scanning the QR code, which points to:
        http://192.168.1.20:3000/join/<ROOM>    (Wi-Fi)
────────────────────────────────────────────────────────────
```

Optional settings:

| Variable | Meaning | Example (bash) | Example (PowerShell) |
|---|---|---|---|
| `PORT` | HTTP port (default 3000) | `PORT=3001 npm start` | `$env:PORT=3001; npm start` |
| `SYNCWAVE_HOST` | Force the IP used in the QR code | `SYNCWAVE_HOST=192.168.1.20 npm start` | `$env:SYNCWAVE_HOST="192.168.1.20"; npm start` |
| `ALLOW_REMOTE_MASTER` | Allow opening the Master page from another machine | `ALLOW_REMOTE_MASTER=1 npm start` | `$env:ALLOW_REMOTE_MASTER=1; npm start` |
| `UPLOAD_DIR` | Store uploads elsewhere. The folder is **emptied on start**, so give a second instance its own folder. | `UPLOAD_DIR=/tmp/sw2 PORT=3001 npm start` | `$env:UPLOAD_DIR="C:\temp\sw2"; $env:PORT=3001; npm start` |

The server listens on `0.0.0.0`, so it is reachable on every network interface.

## Testing with a phone on the same Wi-Fi

1. **Laptop:** run `npm start` and open **http://localhost:3000** in Chrome/Edge/Firefox. A room code (e.g. `AB12`) and a QR code appear.
2. **Laptop:** click **Choose Audio File** and pick an MP3, WAV, or M4A. The file is checked (decoded) in the browser, then uploaded to the server.
3. **Phone:** scan the QR code with the camera app and open the link. The phone shows the room code and `Connected ✓`, and starts downloading the track.
4. **Phone:** tap **ENABLE SPEAKER**. This tap is required; mobile browsers do not play audio until the user interacts with the page.
5. **Phone:** turn the volume up, and on iPhone also check the ring/silent switch (see limitations). Keep the screen on.
6. **Laptop:** when the "phones ready" line shows every phone ready, click **PLAY SYNCED**. All devices start about 1.5 seconds later, at the same scheduled moment.
7. Use **PAUSE**, **STOP**, the seek bar, and **PLAY SYNCED** again. Pressing PLAY SYNCED while playing re-syncs everyone from the current position, which resets any accumulated drift.

### Best test signal: a click track

```bash
npm run make-click-track
```

This writes `test-audio/click-track.wav`, two minutes of short beeps (one per second). Upload it and listen with the devices side by side:

- one crisp click means they are within roughly 10 ms
- a "flam" (double click) means they are 15–40 ms apart
- a clear echo means they are more than ~50 ms apart

If one phone is consistently early or late, use **Fine-tune timing** on that phone (`+` plays later, `−` plays earlier). The value is saved on the phone.

### If the phone can't connect

- **Windows Firewall:** the first time you run Node, Windows asks whether to allow it. Allow it on **Private networks**. If your Wi-Fi is set to *Public* (Settings → Network & Internet → Wi-Fi → your network → Network profile type), either switch it to *Private* or allow Node on Public networks.
- **macOS:** allow incoming connections for `node` if prompted.
- **Wrong IP in the QR code:** laptops with VPNs, WSL, Docker, or VirtualBox have several network adapters. If there is more than one, the Master page shows a **Network address** dropdown; choose the one on your Wi-Fi. You can also set `SYNCWAVE_HOST`.
- **Guest / office / hotel Wi-Fi** often has *client isolation*, which blocks device-to-device traffic. Use a home network or a phone hotspot (with the laptop connected to that hotspot).
- The phone must use `http://` (not https) with the laptop's IP and port, exactly as shown under the QR code.

---

## Live mode: play anything from the laptop (Apple Music, Spotify, YouTube…)

On the Master page choose **Source → Live from this laptop**. The Master page must be opened as **http://localhost:3000**: browsers only allow audio capture on a secure page, and `localhost` counts as one.

Why the laptop's own speaker needs care: the phones can only play a sound after it has crossed the Wi-Fi. So SyncWave delays **every** device, the laptop included, by the same *latency buffer* (default 500 ms). The original app must therefore **not** also play straight to the laptop speakers, or the laptop would be 500 ms ahead of the phones. Each capture option handles this differently:

| Capture | Use it for | Laptop in sync? | Setup |
|---|---|---|---|
| **A browser tab** | music.apple.com, open.spotify.com, YouTube… in Chrome/Edge | ✅ Yes. The shared tab is muted locally (`suppressLocalAudioPlayback`) and SyncWave plays it in sync. | None |
| **An audio input** | The **Apple Music desktop app** or any other app | ✅ Yes. The app's sound goes into a virtual cable, not the speakers. | Install [VB-CABLE](https://vb-audio.com/Cable/) (free) |
| **Whole-system audio** | Anything, quick and dirty | ❌ No. The laptop plays directly and is ahead by the buffer, so use only the phones as speakers. | None |
| **Test clicks** | Checking sync by ear | ✅ Yes | None |

**Apple Music in the browser (easiest):**
1. Open the Master at `http://localhost:3000` in **Chrome or Edge**. In another tab of the **same browser**, open music.apple.com and start a song.
2. Master page: **Live from this laptop** → Capture: *A browser tab* → **START LIVE**.
3. In the picker choose the *Chrome Tab* (or *Edge Tab*) entry for Apple Music, keep **Share tab audio** on, and click Share. The tab goes quiet and the sound comes out of the laptop and the phones together.
4. Phones: open the join link and tap **ENABLE SPEAKER**. Use Apple Music's own controls (play, skip, volume) as usual.

**Apple Music Windows app (or any app):**
1. Install VB-CABLE and reboot if asked.
2. Windows **Settings → System → Sound → Volume mixer** → Apple Music → *Output device* = **CABLE Input (VB-Audio Virtual Cable)**.
3. Master page: Capture: *An audio input* → click **Refresh list** (allow the microphone prompt; that's how browsers reveal device names) → choose **CABLE Output** → **START LIVE**.
4. Never pick your real microphone while "Play on this laptop too" is on: it will howl with feedback.

**How live sync works:** an AudioWorklet on the Master cuts the captured audio into ~43 ms chunks of 16-bit stereo PCM. Each chunk is stamped with `playAt` = capture time (on the master clock, from the audio frame counter) + latency buffer. The server relays the chunks as binary WebSocket messages; a phone that can't keep up skips chunks rather than queueing. Every device, the laptop included, converts `playAt` to its own AudioContext time and plays the chunks back-to-back. The gap between "where a chunk lands" and "where it should land" is smoothed and corrected by nudging the playback rate by up to 0.2 % (inaudible). This is **continuous drift correction**, so live mode stays aligned over long sessions. Large errors (Wi-Fi stall, CPU hiccup) cause a single jump, counted as a *re-sync* in the diagnostics.

**Live-mode limitations**
- Everything is delayed by the latency buffer (default 500 ms). That's fine for music, but video watched on the laptop will be out of lip-sync. Lower the buffer to 200–300 ms on a good network. Raise it if phones show *late chunks*.
- Bandwidth: about 1.5 Mbit/s per phone (uncompressed). Fine on home Wi-Fi for a handful of phones.
- DRM: tab capture of Apple Music/Spotify web is expected to work, but if a service blocks capture the stream will be silent. Use the VB-CABLE route instead.
- In-app or embedded browsers usually can't show the tab picker. Use regular Chrome or Edge for the Master.
- In the earlier same-machine test (laptop tab plus a phone tab via the LAN IP, test-clicks source), the result was about 485 ms queued, 0 late chunks and ±1 ms playback drift. Real phones on real Wi-Fi have not been measured yet.

---

## Experimental Spatial mode (distributed stereo)

> **What this is and isn't.** It treats each device as one speaker on a left↔right line and gives it a position-dependent mix of the track's left and right channels. It is experimental distributed stereo. There is **no** HRTF, binaural rendering, Atmos, room mapping or automatic positioning. Positions are whatever you assign, and the devices have to physically stand there.

**Standard Sync** stays the default and is untouched: every device plays the full stereo mix exactly as before. Switching back to Standard Sync takes one click and applies immediately.

### Trying it (the success-criteria flow)

1. `npm start`, then open `http://localhost:3000` on the laptop.
2. Scan the QR code with two phones and tap **ENABLE SPEAKER** on each. Optionally rename them "Phone A" / "Phone B" on the phone page.
3. Upload an audio file. Wait for "2/2 phones ready".
4. **Playback Mode: Standard Sync** → **PLAY SYNCED**. All devices play the full mix together.
5. Switch **Playback Mode** to **Experimental Spatial**. New phones are auto-placed: the first at −1 (left), the second at +1 (right); the laptop is at 0 (center). Adjust with the sliders or the **L / C / R** buttons, then press **APPLY**.
6. Physically place the devices: Phone A on your left, the laptop in the middle, Phone B on your right, roughly 1–3 m apart, facing you.
7. **PLAY SYNCED**. Instruments panned left in the recording come mostly from Phone A, right-panned ones from Phone B, and centered vocals/bass from all of them.
8. **TEST SPATIAL AUDIO** (no music file needed): a beeping source moves **LEFT (2 s) → CENTER (2 s) → RIGHT (2 s) → smooth sweep left→right (4 s)**. The pitch differs per phase, and the Master and phones show the current phase. You should hear the loudest device change from Phone A to the laptop to Phone B.

### Controls

| Control | Effect |
|---|---|
| **Position** (per device, −1 … +1) | Where the device stands on the left↔right line. |
| **Spatial Width** (0 … 1) | Scales all positions. 0 = everyone acts as center (same mix everywhere). |
| **Center Mix** (0 … 1) | How much of the full mix every device keeps. 0 = maximum separation, 1 = all devices play the same mono mix. Default 0.3. |
| **APPLY** | Sends positions, width and center mix to every device. Until then the panel shows "Unapplied changes". |
| **TEST SPATIAL AUDIO** | Scheduled left → center → right test (pauses the file if one is playing). |

### How the rendering works

```
Sync Engine ──► scheduled start ──► AudioBufferSource / live chunks
                                              │
                                              ▼
                                SpatialRenderer   (public/js/spatial.js, gains only)
                                              │
                                              ▼
                                 mute/volume ──► device speaker
```

Each device runs the renderer **locally** on audio it already has. Spatial mode adds no network streaming and no latency, and it never changes *when* audio plays: the scheduled start, clock offset and position reporting are exactly the same as in Standard Sync. The spatial settings travel as a separate small `spatial` WebSocket message, independent of the playback commands.

In spatial mode a device outputs one mono signal, `gainL·L + gainR·R`, on all of its own speakers, so the device itself is the "point speaker". The gain curve (`spatialGains()` in `spatial.js`):

```
p     = x · width                       effective position, −1 … +1
wL    = (1 − p) / 2      wR = (1 + p) / 2           linear pan
gainL = c/2 + (1 − c)·wL                c = Center Mix
gainR = c/2 + (1 − c)·wR                (gainL + gainR = 1 → no clipping, constant level for centered content)
```

| Position | gainL | gainR | (width 1, center mix 0.3) |
|---|---|---|---|
| −1 (left) | 0.85 | 0.15 | mostly left channel, a little right |
| 0 (center) | 0.50 | 0.50 | both equally |
| +1 (right) | 0.15 | 0.85 | mostly right channel |

In Standard Sync the renderer is bypassed (a crossfade to the untouched stereo path), so the stable mode is bit-for-bit what it was before. Mode changes ramp over about 50 ms to avoid clicks.

The **spatial test** is generated on each device: the same tone bursts at the same scheduled master-clock time. Each device sets its own loudness from the distance between the moving virtual source and its assigned position (`cos(π/2 · distance)`). The test therefore checks positions plus sync. Music goes through the stereo renderer above.

### What was verified (simulated devices: three browser tabs on one laptop)

- **Renderer DSP**, run through `OfflineAudioContext` with the real `SpatialRenderer`. A tone in the left channel only, then the right channel only, came out at exactly 0.85 / 0.15 at x = −1, 0.50 / 0.50 at x = 0, and 0.15 / 0.85 at x = +1. Standard Sync passed the stereo through unchanged.
- **End to end:** Master + "Phone A" (x = −1) + "Phone B" (x = +1), playing an uploaded left-then-right file. Measured on each device's output: Phone A played left content 5.66× louder than right content (85/15 as designed), the laptop 1.0×, Phone B 0.18×. Sync Status read SYNCED (worst reported error 0.2 ms), and the playback positions of all three agreed to within 1 ms.
- **Spatial test:** measured loudness per phase showed Phone A loud only in LEFT, the laptop only in CENTER, Phone B only in RIGHT, and the sweep fading across all three in order.
- **Not verified:** real phones in a real room, or how it actually *sounds*. That is the experiment.

### Spatial-mode limitations (honest expectations)

- **Sync matters even more here.** Because of the precedence (Haas) effect, our ears place a sound at whichever speaker it reaches **first**, even if it is only 1–5 ms early. With realistic phone-to-laptop errors of 10–50 ms, the image may lean toward the earliest device regardless of the gains. Use the click track plus per-phone **Fine-tune** to line devices up before judging the spatial effect.
- Devices playing the same content with small time offsets can cause comb filtering (a hollow or phasey sound), especially with Center Mix high.
- Phone speakers are small: little bass, and often effectively mono. The laptop's own stereo speakers are summed to mono in spatial mode, since the laptop acts as one point.
- Many recordings have most energy in the center (vocals, bass, kick), so the left/right difference is clearest on tracks with hard-panned instruments, or with the test signal.
- Speaker loudness differs a lot between devices. Match the phone volumes by ear.
- Distance and room acoustics are not modeled. If a device sits far from its assigned position, the image is simply wrong.
- Spatial mode also works with **Live** sources: captured audio passes through the same renderer.

---

## How the synchronization works

The core rule: never send "PLAY NOW". Every play command is a scheduled start on a shared clock.

### 1. One reference clock

The Node server runs on the laptop, and its clock (`performance.timeOrigin + performance.now()`, monotonic, sub-millisecond) is the **master clock**. Every browser, including the laptop's own Master page, estimates its offset to that clock. Using the server rather than the Master browser tab means sync pings are always answered promptly, even if the tab is in the background. It also means the laptop and the phones use exactly the same playback code.

### 2. Clock-offset estimation (NTP-style over WebSocket)

```
device  t0 ──── {sync, t0} ────▶ t1  server
device  t3 ◀── {t0, t1, t2} ──── t2  server

round trip    rtt    = (t3 − t0) − (t2 − t1)
clock offset  offset = ((t1 − t0) + (t2 − t3)) / 2      (master − device)
```

On connect, each device sends a burst of 15 pings, then one per second. Wi-Fi latency is spiky, so only the samples with the lowest round-trip time are trusted. The offset is the median of the best 25% of the last 60 seconds of samples. Its error is bounded by `rtt/2` of those samples, which is shown as `±` in the diagnostics. Clock **drift** (the crystals running at slightly different rates) is estimated as the slope of offset over time, in ppm. It is displayed only, not corrected.

### 3. Scheduled start

When you press PLAY SYNCED, the Master sends:

```json
{ "type": "play", "startAt": 1791103662966.4, "position": 0 }
```

`startAt` is master-clock time, at least 1.5 s in the future (more on slow networks). The server validates it, adds a sequence number, and broadcasts the playback state to every device.

Each device converts `startAt` to its own audio clock:

```
master time ──(− offset)──▶ device time ──(AudioContext.getOutputTimestamp)──▶ AudioContext time
```

It then calls `AudioBufferSourceNode.start(contextTime, position)`. Web Audio starts sample-accurately on the sound card's clock, so JavaScript timer jitter doesn't matter. `getOutputTimestamp()` maps "this audio sample is leaving the speaker" to "this `performance.now()` instant", which accounts for the output latency the browser knows about. If it isn't available, the code falls back to `currentTime − outputLatency − baseLatency`.

**Late joiners and reconnects:** a device that receives the play state after `startAt` (it joined mid-song, reloaded, or was slow to decode) picks a start time 400 ms ahead and advances the track position by the same amount. It still lands in step with the others.

### 4. Audio distribution

The Master uploads the file once (`POST /api/rooms/:room/track`). Each phone downloads it fully with HTTP (`GET /media/:trackId`) and decodes it in memory before playback. Nothing is streamed live.

---

## Diagnostics

The Master page shows one row per device. Each phone also shows its own values.

| Column | Meaning |
|---|---|
| Device / Connection | Name, connected or disconnected. Disconnected phones are kept for 2 minutes so they can rejoin. |
| Position | Spatial position the device **reports it is rendering**, with its L/R gains, or `(off)` in Standard Sync. |
| State | `downloading NN%`, `speaker off`, `ready`, `starting…`, `playing`, `paused`, `error: …` |
| Playback position | What the device is playing now, extrapolated to a common instant. |
| Est. clock offset | Master clock − device clock. |
| RTT | Median WebSocket round trip. |
| Est. drift | **clock** = rate difference in ppm (needs about 20 s of samples). **playback** = audible position minus the position the master clock says it should be, in ms (+ means ahead). |
| Output latency | As reported by the browser, plus which timing method is in use. |

Playback drift starts near 0 ms and grows if the device's audio clock and system clock diverge, or if the audio thread glitches. In testing, a laptop tab whose audio thread stalled while another tab loaded showed a stable −39 ms step; pressing PLAY SYNCED again brought it back to 0. Automatic correction of this is the next phase.

Above the table:

- **Spatial Mode:** `ON (experimental)` or `OFF (Standard Sync)`.
- **Sync Status:** built only from what devices report about themselves.
  - `SYNCED`: worst reported timing error ≤ 5 ms
  - `ROUGHLY SYNCED`: ≤ 20 ms
  - `OUT OF SYNC`: > 20 ms (press PLAY SYNCED)
  - `— only n/m devices playing`: some devices aren't playing
  - `IDLE`, `NOT PLAYING YET`, `MEASURING…`: nothing to judge yet

  The note under it gives the actual numbers. It cannot see speaker or acoustic latency that browsers don't report, so a "SYNCED" status can still sound off. Trust your ears and the click track.

For console experiments, each page exposes `window.syncwaveDebug` (player, clock, renderer).

---

## Known limitations and expected accuracy

These are honest expectations, not guarantees. The end-to-end flow (upload, join, download, scheduled start, pause/seek/stop, late join, reconnects, server-restart recovery) was verified with a laptop browser plus a second browser tab acting as a phone over the LAN IP. In that setup the diagnostics read about 0–2 ms between devices. That number only shows the scheduling math works; both "devices" shared one clock and one sound card. **It has not been measured on real phones yet.** Use the click track to judge real-world sync by ear.

**Expected accuracy on real devices**

- **Clock offset error:** typically 1–5 ms on a good home Wi-Fi network, worse on a congested one. Shown as `±` in the diagnostics.
- **Output latency the browser doesn't report correctly** is usually the largest error. Some Android phones and some laptops misreport `outputLatency` by 10–100 ms. Expect laptop-to-phone offsets of roughly **10–50 ms** in practice, sometimes more, and use the per-phone **Fine-tune** to compensate.
- **Bluetooth speakers/headphones** add 100–300 ms that browsers mostly don't report. Use built-in speakers.
- **No continuous drift correction:** audio clocks differ by tens of ppm, i.e. a few ms per minute. Audio-thread glitches (CPU load, tab switching) add sudden steps. Over a 4-minute song, expect devices to wander by a few ms to a few tens of ms. Press PLAY SYNCED to re-align.

**Browser limitations**

- **Autoplay:** phones must tap *Enable Speaker*, and nothing tries to bypass this. The laptop enables audio on your first click anywhere on the Master page. After a page reload, a tap or click is needed again; the page tells you so.
- **iPhone silent switch:** Web Audio can be muted by the ring/silent switch. The app sets `navigator.audioSession.type = "playback"` (iOS 17+) and, on older iOS, plays a silent looping `<audio>` element to work around this. If you hear nothing, flip the switch to ring.
- **Screen lock / background:** mobile browsers suspend audio and drop the WebSocket when the screen locks or the tab is backgrounded. When you return, the phone reconnects and (after a tap if needed) rejoins playback in sync. Keep screens on. The Wake Lock API only works over HTTPS, and this prototype is plain HTTP.
- **Formats:** MP3 and WAV work everywhere. M4A/AAC works in Chrome, Edge, and Safari, but not in every Firefox build. OGG/Opus doesn't work in older Safari. The Master decodes the file before uploading and refuses formats its own browser can't decode. A phone that can't decode shows an error, which also appears in the Master's diagnostics.
- **Memory:** tracks are fully decoded into RAM (about 10 MB per minute of stereo audio at 44.1 kHz). Very long files may fail on older phones. Upload limit: 150 MB.
- **Plain HTTP:** no TLS, no authentication beyond the room code, and a secret master token for upload and control. It's meant for a trusted home network only.

---

## Project structure

```
syncwave/
├── package.json
├── server/
│   ├── server.js          HTTP routes, upload validation, WebSocket handling, LAN IP detection
│   ├── roomManager.js     In-memory rooms/devices/tracks, QR, reconnect/cleanup, live + spatial config
│   └── syncEngine.js      Master clock, playback state machine, sync-ping replies
├── public/
│   ├── master.html        Laptop page
│   ├── client.html        Phone page
│   ├── css/style.css
│   └── js/
│       ├── sync.js        Shared: WebSocket, ClockSync, SyncedPlayer (scheduled Web Audio)
│       ├── live.js        Live mode: LiveCapture (Master) and LiveReceiver (all devices)
│       ├── capture-worklet.js  AudioWorklet that chunks captured audio on the audio thread
│       ├── spatial.js     EXPERIMENTAL: SpatialRenderer (gain curve), spatial test signal
│       ├── master.js      Room/QR, upload, controls, diagnostics table
│       └── client.js      Join, Enable Speaker, status, fine-tune
├── scripts/
│   └── make-click-track.js
├── uploads/               Uploaded tracks (wiped on server start, deleted when a room closes)
├── README.md
└── .gitignore
```

**HTTP endpoints:** `GET /` (Master; only from the laptop itself unless `ALLOW_REMOTE_MASTER=1`), `GET /join/:room`, `GET /css/*`, `GET /js/*`, `POST /api/rooms/:room/track` (needs the master token), `GET /media/:trackId`, and WebSocket `/ws`. The WebSocket carries JSON control messages plus binary live-audio chunks; only the room's Master may send binary. Nothing else is exposed. The `uploads/` folder is not served directly.

**Upload validation:** master token, extension whitelist, 150 MB size limit (checked from the header and enforced while streaming), a magic-byte check for MP3/WAV/MP4/OGG/FLAC/WebM, and sanitized file names. Files are stored under random IDs.

**Dependencies:** `express`, `ws`, `qrcode`. No database, no framework, no build step.

## Next phase (not implemented)

- Continuous drift correction for **file** playback (live mode already has it): periodically compare actual vs. expected position and nudge `playbackRate`.
- Compress live audio (Opus via WebCodecs) to cut bandwidth by about 10×.
- Calibration: measure each device's real acoustic latency with the laptop microphone, replacing manual fine-tuning.
