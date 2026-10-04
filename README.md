# SyncWave (prototype)

Play the same audio on a laptop and one or more phones at the same moment, each through its own built-in speaker, over local Wi-Fi.

The laptop is the **Master**: it creates a room, shows a QR code, and controls playback. Phones are **Clients**: they scan the QR code, get the audio, and play it at scheduled moments on a shared clock.

Synchronization is automatic:

- **Clock sync.** Every device continuously estimates its offset from the laptop's clock, using many WebSocket pings and ignoring slow or outlier packets.
- **Latency compensation.** The output latency each browser reports is always compensated. With the laptop's microphone (optional, one tick-box), SyncWave also **measures** each phone's real audible offset and corrects it automatically.
- **Continuous drift correction.** While playing, every device measures how far it is from the shared timeline 4× per second and corrects small errors with inaudible playback-rate nudges (≤ 0.15 % in Music mode). A resync happens only for large errors.
- **Reconnection.** A phone that drops off Wi-Fi keeps playing locally. When it reconnects it re-checks the timeline and corrects itself, and the room keeps playing.

The Master offers three independent choices:

| | Options |
|---|---|
| **Source**, what is played | *Audio file* (uploaded), *Live from this laptop* (tab / app / system capture), or **🎬 Movie** (video plays on the laptop, every speaker follows the picture, see [Movie Sync](#-movie-sync)) |
| **Playback Mode**, sync tolerance | **Music** (default) or **Movie** (tighter: dialogue makes timing errors obvious). The 🎬 Movie source always uses the Movie tolerances. |
| **Speaker Layout**, how each device reproduces it | **Standard Sync** (default: every device plays the full mix) or **Experimental Spatial** (distributed stereo, see [below](#experimental-spatial-mode-distributed-stereo)) |

> **What has and hasn't been measured.** Everything below was tested with real browsers on one laptop (a Master tab plus phone tabs over the LAN IP), with unit tests, and with a long-session simulation. One laptop has one sound card and one clock, so those tests prove the *algorithms and plumbing*. They do not prove how real phones sound in a room. Acoustic calibration was verified against synthetic recordings but **has not yet been run with real phones and a real microphone**. No real-world accuracy number is claimed here. Use **Run sync test** and the CSV log to measure your own setup.

---

## Requirements

- Node.js 18 or newer (tested with Node 24)
- A laptop and phones **on the same Wi-Fi network**
- A modern browser: Chrome, Edge, Firefox, or Safari (desktop or mobile)
- Optional: a working microphone on the laptop (for acoustic calibration)

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
| `LOG_DIR` | Where CSV sync logs are written (default `logs/`) | `LOG_DIR=/tmp/swlogs npm start` | `$env:LOG_DIR="C:\temp\swlogs"; npm start` |

The server listens on `0.0.0.0`, so it is reachable on every network interface.

## Using it with phones on the same Wi-Fi

1. **Laptop:** run `npm start` and open **http://localhost:3000** in Chrome/Edge/Firefox. A room code and a QR code appear.
2. **Laptop (once, recommended):** under **Latency calibration**, tick **Auto-calibrate devices with this laptop's microphone** and allow microphone access. Click anywhere on the page so the laptop can play sound.
3. **Laptop:** click **Choose Audio File** and pick an MP3, WAV, or M4A.
4. **Phone:** scan the QR code and tap **ENABLE SPEAKER** (required by mobile browsers). Turn the volume up and keep the screen on.
5. The phone shows **CALIBRATING** while its clock sync settles (about 1–2 s). If auto-calibration is on, you'll hear a few short beeps from each device: the laptop is measuring the phone's real audible offset. The phone then shows **READY**.
6. **Laptop:** pick **Playback Mode: Music** (or **Movie** for film audio) and click **PLAY SYNCED**.
7. The device list shows each phone's state (**SYNCED / DRIFTING / RESYNCING …**), estimated latency, and current drift. Corrections happen automatically, so you shouldn't need the phones' manual timing adjustment.

Pause, Stop, Seek, and **Repeat** work as before. Pressing PLAY SYNCED while playing restarts everyone from the current position.

### Best test signal: a click track

```bash
npm run make-click-track
```

This writes `test-audio/click-track.wav` (one beep per second). With devices side by side:

- one crisp click means they are within roughly 10 ms
- a "flam" (double click) means 15–40 ms apart
- an echo means more than ~50 ms apart

### If the phone can't connect

- **Windows Firewall:** the first time you run Node, Windows asks whether to allow it. Allow it on **Private networks**. If your Wi-Fi is set to *Public* (Settings → Network & Internet → Wi-Fi → your network → Network profile type), either switch it to *Private* or allow Node on Public networks.
- **macOS:** allow incoming connections for `node` if prompted.
- **Wrong IP in the QR code:** laptops with VPNs, WSL, Docker, or VirtualBox have several network adapters. If there is more than one, the Master page shows a **Network address** dropdown; choose the one on your Wi-Fi. You can also set `SYNCWAVE_HOST`.
- **Guest / office / hotel Wi-Fi** often has *client isolation*, which blocks device-to-device traffic. Use a home network or a phone hotspot (with the laptop connected to that hotspot).
- The phone must use `http://` (not https) with the laptop's IP and port, exactly as shown under the QR code.

---

## 🎬 Movie Sync

Music Sync starts every device at a scheduled moment on the server clock. That is not enough for a movie. The picture runs on the laptop's **video pipeline**, which has its own clock and its own start-up delay. Sound that follows the server clock or the arrival of a PLAY message ends up a little off the picture, and the error grows over a long film. Movie Sync makes every speaker follow the **video's actual timeline** instead.

### Using it

1. Open the Master at `http://localhost:3000` (Chrome or Edge), choose **Source → 🎬 Movie**, and click **Choose Movie** (MP4/MOV/M4V with H.264 + AAC is best; WebM works up to 600 MB).
   The laptop extracts the movie's audio track and uploads it to the server. This is much faster than real time: about 8 s for 10 minutes of audio in testing. The video itself is not uploaded.
2. Phones scan the QR code and tap **ENABLE SPEAKER**. They buffer the audio around the current position and show **🎬 Ready**.
3. Press **▶ PLAY**. Use the SyncWave controls (play, pause, ±10 s, the seek bar, speed). The video has no native controls, so every action can be announced to the phones in advance.
4. To check sync by eye and ear, use **Generate A/V test movie** (1 / 10 / 30 min): every second the picture flashes white and the sound beeps. You can also download it.

You don't normally need to adjust anything. The optional controls:

- **Lip-sync** (Master, under the video): shifts *all* speakers relative to the picture. Use it if dialogue is consistently early or late everywhere, for example because a TV or projector adds display delay that the browser can't see.
- **Movie audio offset** (each phone, −100…+100 ms, saved on the phone), or **−5 / +5** for that phone in the Master's *Movie audio calibration* table: a fine nudge for one device.

### How it works

```
LAPTOP                                                        EVERY DEVICE (laptop included)
<video> ── requestVideoFrameCallback ──► MasterVideoClock     MovieAudioPlayer
   (media time + when the frame           │ anchor:             │ expected position at master time t:
    reaches the screen)                   │ {epoch, videoTime,  │   videoTime + (t − masterTime − offset)/1000 · rate
                                          │  masterTime, rate}  │ offset = calibration + fine offset + lip-sync
                                          └──── WebSocket ─────►│
movie file ── demux + WebCodecs ──► 16-bit PCM ──► server ──HTTP Range──► 4 s blocks ──► 0.25 s AudioBuffers
                                                                           scheduled on the Web Audio clock
```

**1. Master video clock.** For every frame it presents, `requestVideoFrameCallback` reports the exact media time and when that frame reaches the screen. The Master converts that time to the master clock. A robust fit over the last 2 s of frames (median of per-frame predictions, so a late frame callback can't skew it) gives an **anchor**:

```json
{ "type": "movie-sync", "clock": { "epoch": 12, "playing": true, "videoTime": 853.217,
  "masterTime": 1791143510373.1, "rate": 1, "avOffsetMs": 0 } }
```

meaning "the frame with media time 853.217 is on screen at master time 1791143510373.1". Anchors are sent right after every start and then once a second. If the page isn't being painted (window minimised, tab hidden), frame callbacks stop and the clock falls back to sampling `video.currentTime`. Nobody sees the picture then; the sound simply keeps following the video's media clock. The diagnostics show which method is in use.

**2. Planned controls, never "play now".**

- **Play / resume:** the Master announces *frame V will be on screen at master time T = now + 0.7 s*, then starts the video early by its learned start-up delay. It measures how late or early the video really started and refines that delay for next time.
- **Pause:** announced 150 ms ahead, so everyone stops at the same moment. The exact paused frame is then published as the cue point.
- **Seek:** sound stops at once, the picture moves, and if it was playing a new planned start follows. A new **epoch** means no client uses its old schedule.
- **Speed:** `rate` is part of every anchor. Clients play at that rate (on phones the pitch changes with the speed; there is no time-stretching).

**3. Audio delivery: preloaded, not downloaded at PLAY.** The movie's audio track is extracted on the laptop:

1. Read the MP4's top-level boxes and skip the huge `mdat`.
2. Parse `moov` with mp4box to get the audio sample table.
3. Read only the audio bytes and decode them with WebCodecs.
4. Place every decoded frame at its **presentation time**: composition time adjusted by the track's **edit list**, which is how MP4 records AAC encoder priming and audio start delays. That is the same timeline the `<video>` element shows. Verified on the generated test movie: 58 of 58 beeps landed within **0.02 ms** of their exact whole-second positions.

The server stores 16-bit stereo PCM. Clients fetch 4 s blocks around the playhead with HTTP Range requests, about 45 s ahead, so memory stays small even for a 2-hour film. A seek fetches the new position in milliseconds on a LAN.

**4. All speakers, one engine.** The laptop's own movie sound also goes through `MovieAudioPlayer`, and the `<video>` element is muted. Every device that makes sound, laptop and phones alike, follows the same anchors with the same scheduler. They can't develop a fixed offset *between each other*, which would be heard as echo or doubled dialogue. Any constant sound-versus-picture offset is shared by all of them and fixed with one lip-sync control.

**5. Latency compensation.** Each device's schedule is shifted by its offset:

| Part | Where it comes from | Measured? |
|---|---|---|
| Browser-reported output latency | `getOutputTimestamp()` / `outputLatency`, compensated automatically by the scheduler | reported by the OS, not measured |
| Calibration | Laptop microphone: test pulses from the laptop and each device, timed acoustically | **measured**, at the laptop's position |
| Fine offset | Per device, manual, saved on the device | manual |
| Lip-sync | Master, all devices together | manual |

If the microphone isn't used, the diagnostics say *audio latency: browser estimate only (not measured)*. The app never presents an estimate as a measurement.

**6. Continuous correction, tuned for movies.** Four times a second each device compares the position it is audibly playing with the position the video timeline says, and feeds the error to the shared drift controller (Movie tolerances):

| Smoothed error | Action |
|---|---|
| < 4 ms | ignore (hysteresis down to 1.5 ms) |
| 4–25 ms | playback-rate nudge ≤ ±0.2 % |
| 25–80 ms | stronger nudge ≤ ±0.5 % |
| > 80 ms (twice in a row) | explicit resync: re-schedule at the current position |
| > 35 ms within 3 s of a start/seek | immediate re-align (the real video start differed from the plan) |

These are tighter than the starting values you suggested (10 / 40 / 100 / 300 ms). With dialogue, two speakers 10–20 ms apart already sound doubled. In simulation the loop is stable with up to 1.5 s between a decision and its effect; movie audio needs ≤ 0.6 s.

**7. Reconnection and late join.** A phone keeps playing through a Wi-Fi drop: it has about 45 s of audio and its own clock. On reconnect it receives the current anchor (epoch + timeline). If nothing changed, the drift controller carries on. If the Master paused or seeked meanwhile, the phone follows the new epoch. A phone that joins mid-film, or reloads, starts on the timeline about 0.35 s after it has its first 0.25 s of audio.

### Movie Sync diagnostics

Shown on the Master in Movie mode:

- **Master video:** position, play state, clock source (`rVFC` or `currentTime (not painted)`), learned video start delay and the last start error, lip-sync offset, and tolerance.
- **One row per device:** status (SYNCED / CORRECTING / RESYNCING / READY / DISCONNECTED), audio position, A/V difference (smoothed, + = sound early), output latency, total compensation, clock offset ± uncertainty, network RTT, audio buffered ahead, and a **likely issue**:

  | Likely issue | What it points to |
  |---|---|
  | *network: audio not arriving fast enough* / *only N s buffered* | **network** |
  | *network/clock: Wi-Fi timing uncertain (±N ms)* | **clock sync** |
  | *drift: being corrected* | **drift** |
  | *audio latency: browser estimate only* | **audio latency** (not measured) |
  | *speaker not enabled* / *disconnected* | the device |

- **Movie audio calibration:** browser-estimated output latency, the measured offset vs the laptop (or *not measured*), fine offset with −5 / +5, total compensation, and **RE-CALIBRATE** (pauses the movie and runs the microphone measurement for that device).

The CSV log gains movie columns (state, audio and expected positions, raw and smoothed A/V error, rate, buffer, resyncs, underruns).

### What was tested, and how

**Method.** All browser tests ran in **one laptop browser**: a Master tab and two "phone" tabs connected over the LAN IP, using the generated flash + beep test movie. In every tab a hook recorded when each beep was scheduled to leave the speaker (Web Audio start time → `getOutputTimestamp` → wall clock). On the Master, the published video anchors gave when each media second was on the video timeline. That measures the whole software chain: extraction alignment, anchors, scheduling, chunk stitching, seeks, and drift correction. It does **not** measure physical speakers, and all tabs shared one sound card and one clock. **I could not listen**, so "dialogue has no echo" still has to be confirmed by ear on real phones.

In these runs the Master page was never painted (the test browser pane was hidden). The video clock therefore ran on its `currentTime` fallback. **Frame-accurate `rVFC` anchors were not exercised in a browser**; only their math is unit-tested. That is the most important thing to check on your laptop, with the video visible.

**Extraction:** on the generated test movie (AAC with a 9.1 ms priming edit list), 58 of 58 beeps in the extracted audio were within **0.02 ms** of their exact whole-second positions. The first beep reads 9.1 ms, which is the AAC encoder's attenuated first frame, not a timing error.

| Test | Result (sampled beeps, laptop + 2 phones) |
|---|---|
| **A/B** Laptop + 1–2 phones, startup | The real video start differed from the plan by −15 to −33 ms. Devices corrected smoothly to ±0.5 ms within ~10 s. The learned start delay adapts each time (80 → 61 → 57 ms). |
| **C** 10 minutes | Device-to-device spread: median **1.0 ms**, max **1.3 ms**. Sound vs video timeline: median −0.7 ms, p95 1.4 ms. No gradual drift. |
| **E** Pause / resume | 6 s after resume: all devices SYNCED, +0.5…+0.6 ms. |
| **F** Seek +30 s / −20 s | Forward: SYNCED +0.2…+0.4 ms at 6 s. Back: all three +7…+9 ms *together* at 6 s, then corrected. |
| **G** Phone joins mid-movie | Playing ~0.5 s after Enable Speaker, first error +0.8 ms, no resync. |
| Wi-Fi drop (8 s, simulated) | Kept playing: error ≤ 0.4 ms during and after, reconnected as the same device, no resync. |
| Video stalled ~80 ms (hidden page) | All devices followed the picture together (spread ≤ 2 ms) and re-locked within ~16 s by rate correction (80 ms is just under the explicit-resync limit). |
| **D** 30 minutes | **Not completed**: stopped at 2 min 21 s on request (all three devices SYNCED at −0.1 ms at that point). The longest continuous movie run is the 10-minute test C; a 30-minute run is still to do. |

**Bugs found by these tests and fixed:**

1. Scheduled chunks were removed when they finished *rendering*, about 50 ms before they were *heard*. 22 % of drift measurements found nothing, and in phase with the 250 ms drift tick the controller went blind for seconds, kept its last strong rate, and overshot. That produced a ±35 ms oscillation on one device. Chunks are now kept until well after they're heard, and the controller returns to the neutral rate after 1 s without measurements.
2. A hidden/minimised Master page stops frame callbacks, so no anchors were published. The clock now falls back to the media clock.
3. Timers in hidden pages run at about 1/s, which stalled movie extraction and would starve the 0.6 s scheduling lookahead. Extraction now waits on codec events, and the movie players tick from a Web Worker timer.
4. Pauses the app didn't initiate (the browser suspending a hidden video) now stop the sound everywhere.

---

## How the synchronization works

Synchronization and audio processing are separate layers. The sync engine decides **when** each sample should be heard; spatial gains and mute only change **how loud**.

### 1. Clock synchronization (every device ↔ laptop)

The Node server on the laptop is the **master clock** (`performance.timeOrigin + performance.now()`: monotonic, sub-ms). Every browser, including the laptop's own Master page, runs an NTP-style exchange over the WebSocket: a burst of 15 pings on (re)connect, then one per second:

```
device  t0 ──── {sync, t0} ────▶ t1  server
device  t3 ◀── {t0, t1, t2} ──── t2  server

round trip   rtt = (t3 − t0) − (t2 − t1)
clock offset θ   = ((t1 − t0) + (t2 − t3)) / 2          (master − device)
```

θ is exact when the trip out and the trip back take equally long; asymmetry is error, at most rtt/2. Wi-Fi delays are spiky, and a slow packet is almost always *asymmetrically* slow, so the estimator (`ClockSync` in `public/js/sync.js`) works like this:

1. Keeps the last 2 minutes of samples.
2. Trusts only **good** samples, with rtt ≤ 1.5 × (lowest rtt in the window) + 3 ms. One slow packet can't move the estimate (unit-tested).
3. With ≥ 8 good samples over ≥ 15 s, fits **θ(t) = a + b·(t − t̄)** by weighted least squares (weight 1/(rtt+1)²). **b** is the clock drift (ppm), and the offset used *now* is θ(now), so it doesn't lag when the two crystals run at slightly different speeds. Before that, it uses the median of the best quarter of samples.
4. Reports `uncertainty = best rtt / 2 + scatter of good samples around the fit`, an honest error bound.

In the unit test (2 minutes, 15 % of packets delayed 40–120 ms one way, 50 ppm drift), the offset error is < 1 ms and the drift estimate is within 15 ppm.

### 2. Scheduled start + latency compensation

The Master never sends "play now". It sends:

```json
{ "type": "play", "startAt": 1791103662966.4, "position": 0, "loop": false }
```

`startAt` is master time ≥ 1.5 s ahead (more on slow networks). Each device converts it to its own audio clock and shifts it by its **latency offset**:

```
target      = startAt + effectiveOffset            effectiveOffset = calibration + manual trim
local time  = target − θ(now)
audio time  = getOutputTimestamp mapping of local time   (includes the latency the browser reports)
source.start(audioTime, position)                         sample-accurate on the sound card's clock
```

`getOutputTimestamp()` pairs "the sample at context time c is leaving the speaker" with "performance.now() = p", so the output latency the browser *knows* about is compensated automatically. The **calibration** term covers what the browser doesn't know (see below). A device that receives the command late (joined mid-song, reconnected, resynced) starts 400 ms ahead at the correspondingly later track position, so it still lands on the timeline.

**Keep-alive.** Chrome (desktop and Android) moves a Web Audio output that has been digitally silent for a few seconds onto a "fake" sink to save power. Switching back to the real speaker takes ~1 s. In testing this made the first play after a pause start **970–1290 ms late on every device**, which was caught and fixed only by a resync. SyncWave now plays an inaudible −100 dBFS noise floor whenever the speaker is enabled, so the output never goes idle.

### 3. Continuous drift detection and correction

While playing, each device keeps an **exact model** of its position: `position(c) = anchorPos + (c − anchorCtx) · rate`, re-anchored at every rate change. Rate changes are scheduled at a known context time, so the model stays exact. Four times per second it measures:

```
error = position heard now − (position + (masterNow − startAt − effectiveOffset)) / 1000      (+ = ahead)
```

The `DriftController` (pure logic, unit-tested and simulated) then decides:

| Smoothed error | Music | Movie | Action |
|---|---|---|---|
| tiny | < 10 ms | < 4 ms | ignore (hysteresis: once correcting, continue until < 4 / 1.5 ms) |
| small | 10–50 ms | 4–25 ms | **fine correction**: rate = 1 − error/τ, capped at **±0.15 %** (Music) / ±0.2 % (Movie) |
| large | 50–200 ms | 25–80 ms | **strong correction**: same formula, capped at ±0.4 % / ±0.5 % |
| huge | > 200 ms | > 80 ms | **explicit resync** (re-schedule at the current timeline position). Needs two readings in a row; at most once per 5 s |

Details that keep it stable and inaudible:

- **Smoothing:** median of the last 5 readings, then an exponential average. A single bad reading (unit-tested with a 400 ms outlier) does nothing.
- **Slew limit:** the rate changes by at most 0.05 % per update, so there are no audible pitch jumps. ±0.15 % is about 2.6 cents of pitch, below what listeners notice in music, and it removes 1.5 ms of error per second.
- **Skew learning:** while no correction is active, the error should stay flat. If it slopes because this device's audio clock runs a few tens of ppm fast or slow, the slope is measured robustly (median of paired slopes, only if statistically clear) and fed forward as a constant rate bias. Steady skew is then cancelled continuously instead of building up.
- **It's a first-order loop** (error decays as e^(−t/τ), τ = 6 s Music / 4 s Movie) with ~1 s of smoothing lag. It is well damped and doesn't oscillate in simulation (see Testing).

**Repeat** (looping) is handled in the same model: the timeline wraps at the track length, and toggling Repeat while playing sends a `continuous` state update that devices adopt **without restarting**.

**Live mode** uses its own, equivalent controller per received chunk (±0.2 %, jump if > 25 ms off).

### 4. Latency calibration

**What software can and can't know.** A browser knows the output latency the OS *reports* (`outputLatency`, `getOutputTimestamp`), and SyncWave compensates it on every device automatically. It **cannot** know latency the OS doesn't report or misreports. That is common on Android, happens with some laptop drivers, and always applies to Bluetooth. The only way to measure that is to listen.

**Software calibration (automatic, always).** On join the device runs its clock-sync burst (state **CALIBRATING** until ≥ 10 samples), reads the reported output latency, and loads its **device profile** from the phone's storage: persistent device ID, name, last calibration, the reported latency at the time of that calibration, and the last clock offset. The previous calibration is used as the **initial estimate**. If the browser now reports a clearly different output latency (> 10 ms change: other output device, headphones, OS update), the old calibration is marked **stale** and the device is recalibrated.

**Acoustic calibration (laptop microphone).** Turned on with the tick-box (one microphone permission prompt); afterwards it runs automatically, only while nothing is playing.

1. The Master picks master-clock times about 0.9 s apart, devices interleaved, 3 rounds, and tells every device: *play a 50 ms chirp (1.2→6 kHz) at your Tᵢ*. The chirps go through the normal scheduler, including the device's current latency offset.
2. The laptop records its microphone (echo cancellation, noise suppression and AGC off) and finds each chirp's arrival with a matched filter (normalized cross-correlation, coarse at 24 kHz then refined at 48 kHz). It takes the **first** strong peak, so a louder room reflection doesn't fool it (unit-tested with an echo 15 % louder than the direct sound).
3. `residual = arrival − Tᵢ`. Every residual contains the laptop's own unknown mic input latency and speaker delay, so the laptop's own chirp is used as the reference:

   ```
   errorᵢ = median(residuals of device i) − median(residuals of laptop)      (+ = device heard later)
   ```

   This is the device's real audible offset relative to the laptop, **as heard at the laptop's position**. It includes ≈ 2.9 ms per metre of extra distance, which is also what a listener next to the laptop hears.
4. If the result is reliable (≥ 2 chirps heard, spread ≤ 4 ms), the device shifts its schedule by −errorᵢ. A second pass verifies, up to 2 passes.
5. Results appear in the calibration table and the CSV log. Devices that weren't heard are reported as such (*not heard — volume up / move closer*), never guessed.

Calibration is stored in the phone's profile and reused next time as a starting point.

### 5. Reconnection and resynchronization

- The WebSocket has a watchdog: no message for 6 s (sync replies arrive every second) means the link is treated as dead and the client reconnects, with exponential backoff up to 4 s. The server pings every 5 s and drops dead sockets.
- During the outage the phone **keeps playing** on its own audio clock.
- On reconnect it rejoins with the same device ID (the room shows one entry, not two), runs a fresh clock-sync burst, and receives the current room state. Same play command: it keeps playing, shows **RESYNCING** briefly, and the drift controller corrects any error, or resyncs if the error is large. New command (e.g. the Master paused meanwhile): it applies it. **Nobody else is affected.**
- A page reload or app switch re-joins playback mid-song through the late-start path, at the current position.

### 6. Device sync states

| State | Meaning |
|---|---|
| CONNECTING | Phone page open, not joined yet (shown on the phone) |
| CALIBRATING | Clock sync still settling, or an acoustic measurement is running |
| READY | Loaded and able to play, not playing |
| SYNCED | Playing, smoothed error within the mode's tolerance (±10 ms Music, ±5 ms Movie) |
| DRIFTING | Playing, outside tolerance, being corrected by rate |
| RESYNCING | (Re)starting at the current position, just reconnected, or error beyond the resync limit |
| DISCONNECTED | Gone from the room (kept for 2 minutes so it can rejoin) |

---

## Diagnostics and developer mode

**Connected Devices** (always visible) shows each device's state, estimated audio latency (reported + measured extra), and smoothed drift.

**Diagnostics → Sync Status** is built only from what devices report: the worst smoothed error, the clock-offset uncertainty, and how many phones have actually been calibrated acoustically this session. It says plainly when the remaining devices rely on browser-reported latency only.

**Developer mode** (tick-box on the Master) adds a card per device:

```
📱 Phone A                              SYNCED
Clock offset        −0.5 ms ± 0.3 ms
Network RTT          0.6 ms (best 0.4 ms)
Clock drift          +0 ppm
Audio latency        62 ms (reported 50 ms)      ← example values
Calibration         −12.0 ms — measured (mic)
Effective offset    −12.0 ms
Playback position    12.493 s
Playback drift      +0.6 ms / smoothed +0.4 ms
Correction          −0.015 % (0.99985×, hold)
Learned skew        +150 ppm
Resyncs / reconnects 0 / 1
Last clock sync      0.4 s ago (120 samples)
Timing method        outputTimestamp
```

plus the room, the master clock, the active tolerance, and **CSV logging**.

**CSV log.** *Start CSV log* writes one row per device per second (and one per device per acoustic measurement) to `logs/sync-ROOM-time.csv`. *Download CSV* fetches it. Columns:

```
timestamp,masterTimeMs,room,deviceId,deviceName,event,syncState,state,clockOffsetMs,rttMs,
clockUncertaintyMs,latencyMs,calibrationMs,effectiveOffsetMs,positionS,driftMs,smoothedDriftMs,
correction,correctionZone,resyncs,clockDriftPpm,skewBiasPpm,acousticErrorMs,note
```

**Phone page** shows its own full diagnostics. Opened as `…/join/ROOM?dev=1`, it also has test tools: **Simulate Wi-Fi drop (8 s)**, and a **simulated audio-clock skew** (ppm) that makes the device's measurements behave like a phone with a fast or slow crystal, so drift correction can be exercised on one laptop. That device's audio is not meaningful while skew ≠ 0. Every page exposes `window.syncwaveDebug` for console experiments.

---

## Testing

```bash
npm test
```

22 tests in three groups:

- **Unit:** clock sync with asymmetric packet loss and drift, the single-slow-packet case, drift-controller deadband / direction / caps / slew limit / outlier rejection / resync cooldown, loop-error wrapping, and acoustic calibration on synthetic recordings (sub-0.1 ms accuracy with a louder echo, "not heard", missing reference).
- **Movie Sync unit:** timeline math (position ↔ master time, offsets, rate, pause), the frame-anchor fit (exact to < 1.5 ms despite jittery and late frame timestamps), the PCM writer (gaps, overlaps, ordering), the MP4 scanner (finds `moov` behind a large `mdat` without reading it), and movie storage (out-of-order chunks, clock validation).
- **End-to-end protocol** (also a Movie Sync run: create, PCM upload with token, Range reads, clock relay and permissions, fine offset, source switch, late joiner): starts a real server and drives it like the Master and a phone through room creation, QR, clock ping, join with profile, upload (with and without token), media download, play with Repeat, phone-can't-control, a continuous Repeat toggle, pause/seek, Music/Movie broadcast, probe and calibration relay, status whitelist, CSV logging and authenticated download, reconnect with the same ID (one entry, state delivered), spatial config, and live-audio relay permissions.

```bash
npm run simulate-drift
```

Long-session simulation of the real `DriftController` for **5, 15, 30, 60, and 90 minutes**. Each run models one device with clock skew 0 / +30 / −80 / +200 ppm, ±1 ms measurement jitter, a wandering clock-offset estimate (±2 ms), 1 % outlier readings of ±30 ms, and a deliberate 40 ms audio glitch every 10 minutes. Results from the last run (true error = what a listener would get):

| Mode | Steady-state worst / RMS error | Time within tolerance | Explicit resyncs | Max rate change | Learned skew for +200 ppm |
|---|---|---|---|---|---|
| Music | ≤ 10.9 ms / ≤ 7.5 ms | 93–100 % | 0 | 0.17 % | 185–230 ppm |
| Movie | ≤ 5.9 ms / ≤ 3.5 ms | 93–100 % | 0 | 0.51 % (glitch recovery only) | 177–222 ppm |

There was no drift build-up between 5 and 90 minutes and no oscillation. The 40 ms glitches are corrected by rate, not resync, in both modes. *This tests the control loop, not real hardware.*

**Built-in sync test (real devices).** *Run sync test* (needs the laptop mic) plays 5 chirps per device and reports each device's measured audible offset vs the laptop. Run it before and after calibration to see the improvement, and enable the CSV log to keep the numbers.

**Browser soak test on one laptop (33 min).** A Master tab and two phone tabs over the LAN IP played a 30 s click track on Repeat for 33 minutes with the CSV log on (`npm run analyze-log` output). Phone B ran with **+150 ppm simulated audio-clock skew** the whole time, several times worse than a typical device. Events: a simulated Wi-Fi drop on Phone A at 10 min, and a switch from Music to Movie at 20 min.

| Device | Time SYNCED | Median / p95 error | Explicit resyncs | Learned skew |
|---|---|---|---|---|
| Laptop | 100 % | 0.7 / 4.9 ms | 1 (shared glitch, see below) | ~20–100 ppm |
| Phone A | 100 % | 1.0 / 5.6 ms | 1 (shared glitch) | ~20–80 ppm |
| Phone B (+150 ppm) | 100 % | 3.9 / 8.4 ms | 1 (shared glitch) | **148–230 ppm** (true: 150) |

- **No gradual drift** across 5-minute windows. With Phone B's +150 ppm skew, uncorrected error would have grown by ~300 ms over the run. Instead it stayed within ±9 ms, mostly through learned skew rather than visible rate corrections.
- **Wi-Fi drop:** Phone A kept playing during the 7 s outage and rejoined as the same device. Its error stayed below 0.6 ms throughout, with no resync and no effect on the others.
- **Movie mode:** with the tighter ±5 ms tolerance, devices at 6 ms were immediately flagged DRIFTING and pulled in with ≤ 0.2 % rate changes. The p95 error over the last 15 min was 2.4–3.9 ms.
- **One shared glitch:** at 18 min all three tabs (same sound card and browser) stalled ~300 ms at once. Each detected it within ~1 s and did a single resync. That is the intended response to a large error, and it would not hit separate phones simultaneously.
- **Bug found and fixed by this test:** without the keep-alive, every device started ~1 s late after a pause (Chrome's silent-output power saving). With it, after 115 s of silence all three started within 0.3–2.6 ms.
- **Known transient:** a phone that has just been reloaded and late-joins can start ~30–40 ms off while its audio output warms up. The drift controller removes this smoothly in ~20 s (Music) without a seek.

These numbers describe the software on one machine, where the "devices" shared a clock and a sound card. **They are not real-phone measurements.**

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
4. **Speaker Layout: Standard Sync** → **PLAY SYNCED**. All devices play the full mix together.
5. Switch **Speaker Layout** to **Experimental Spatial**. New phones are auto-placed: the first at −1 (left), the second at +1 (right); the laptop is at 0 (center). Adjust with the sliders or the **L / C / R** buttons, then press **APPLY**.
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

- **Sync matters even more here.** Because of the precedence (Haas) effect, our ears place a sound at whichever speaker it reaches **first**, even if it is only 1–5 ms early. With realistic phone-to-laptop errors of 10–50 ms, the image may lean toward the earliest device regardless of the gains. Run acoustic calibration (or check with the click track) before judging the spatial effect.
- Devices playing the same content with small time offsets can cause comb filtering (a hollow or phasey sound), especially with Center Mix high.
- Phone speakers are small: little bass, and often effectively mono. The laptop's own stereo speakers are summed to mono in spatial mode, since the laptop acts as one point.
- Many recordings have most energy in the center (vocals, bass, kick), so the left/right difference is clearest on tracks with hard-panned instruments, or with the test signal.
- Speaker loudness differs a lot between devices. Match the phone volumes by ear.
- Distance and room acoustics are not modeled. If a device sits far from its assigned position, the image is simply wrong.
- Spatial mode also works with **Live** sources: captured audio passes through the same renderer.

---

## Known limitations

- **Real-world accuracy has not been measured.** All tests ran on one laptop, so the "devices" shared a sound card and a clock. Expect real phones to be limited by (a) Wi-Fi clock-sync uncertainty, typically a few ms and shown per device, (b) audio latency the browser doesn't report, which only acoustic calibration fixes, and (c) audio-thread glitches under CPU load, which drift correction absorbs over seconds.
- **Acoustic calibration needs:** the Master opened as `http://localhost` (microphone access requires a secure page), a working laptop mic, a reasonably quiet room, and phones loud enough and within a few metres. Windows "audio enhancements" or a headset mic can distort the result. The calibration table shows how many chirps were heard and how consistent they were. It measures offsets **at the laptop's position**, so people sitting far from the laptop hear slightly different offsets (≈ 2.9 ms per metre of path difference).
- **Without the microphone,** compensation is limited to what each browser reports. That is often fine on iOS and desktop browsers, but can be off by tens of ms on some Android phones. The manual timing adjustment remains as a fallback.
- **Bluetooth speakers/headphones:** their latency is large (100–300 ms) and variable. Acoustic calibration measures it, but it can change during a session.
- **Rate correction changes pitch very slightly** (≤ 2.6 cents in Music mode, briefly up to ~9 cents in Movie mode while catching up after a glitch). Web Audio has no pitch-preserving rate for buffers.
- **Keep-alive costs battery:** the inaudible noise keeps each device's audio hardware awake while the page is open.
- **Background / screen lock:** mobile browsers suspend audio and timers when the screen locks. On return the phone resyncs automatically (one tap may be needed to re-enable audio). Keep screens on. Wake Lock needs HTTPS.
- **Autoplay:** phones must tap *Enable Speaker*; nothing bypasses this.
- **Memory:** file mode decodes the whole track into RAM (~10 MB per minute of stereo). Very long files (a full movie soundtrack) can fail on phones, so use **Live** mode for films. Upload limit 150 MB.
- **🎬 Movie Sync specifics:**
  - The sound follows the moment each frame is *handed to the screen*. Display processing delay (TV, projector, some monitors) is invisible to the browser, so use the lip-sync control.
  - Phones change pitch at speeds other than 1×.
  - Movie preparation needs Chrome or Edge (WebCodecs + MP4 demuxing). WebM/other formats use a whole-file decode limited to 600 MB with a less exact start.
  - Streaming services (Netflix etc.) can't be used as a movie file; use Live mode for those, with the live buffer's picture delay.
  - After reloading the Master page, choose the same file again (its prepared audio is reused).
  - The server stores the extracted audio as raw PCM: about 690 MB per hour of film, deleted when the room closes or a new movie is chosen.
  - A video stall of up to 80 ms is corrected by slewing over several seconds rather than an instant jump.
- **Plain HTTP** on a trusted home network: no TLS, no accounts. The master token protects control, upload and log download.

---

## Project structure

```
syncwave/
├── package.json
├── server/
│   ├── server.js          HTTP routes, upload validation, WebSocket handling, LAN IP detection, log download
│   ├── roomManager.js     In-memory rooms/devices/profiles/tracks, QR, reconnect/cleanup, live/spatial/sync-profile config
│   ├── syncEngine.js      Master clock, playback state machine (incl. Repeat), sync-ping replies
│   ├── syncLog.js         CSV sync-measurement log
│   └── movieStore.js      Movie audio (raw PCM, ranged reads) + the Master video clock state
├── public/
│   ├── master.html        Laptop page
│   ├── client.html        Phone page
│   ├── css/style.css
│   └── js/
│       ├── sync.js        Connection (watchdog), ClockSync, DriftController, SyncedPlayer (scheduling, latency offset, drift correction, keep-alive)
│       ├── calibration.js Acoustic calibration: chirps, matched-filter analysis, mic recorder, probe runner
│       ├── movie.js       🎬 Movie Sync: MasterVideoClock (rVFC anchors), MovieAudioPlayer (streamed, scheduled, drift-corrected)
│       ├── movie-extract.js  (ES module) MP4 demux + WebCodecs audio extraction with edit lists; whole-file fallback
│       ├── testmovie.js   (ES module) A/V test-movie generator: WebCodecs + a small MP4 writer
│       ├── master-movie.js   Master's Movie Sync: planned play/pause/seek/speed, diagnostics, movie calibration
│       ├── live.js        Live mode: LiveCapture (Master) and LiveReceiver (all devices)
│       ├── capture-worklet.js  AudioWorklet that chunks captured audio (live capture + calibration mic)
│       ├── spatial.js     EXPERIMENTAL: SpatialRenderer (gain curve), spatial test signal
│       ├── master.js      Room/QR, upload, controls, calibration, devices, developer panel, CSV log
│       └── client.js      Join + device profile, Enable Speaker, calibration, sync state, diagnostics, test tools
├── scripts/
│   ├── make-click-track.js
│   └── simulate-drift.js  Long-session drift-correction simulation
├── tests/
│   ├── sync.test.js       Unit tests (clock sync, drift controller, calibration analysis, Repeat)
│   ├── movie.test.js      Movie Sync unit tests (timeline math, anchor fit, PCM writer, MP4 scanner, storage)
│   └── server.test.js     End-to-end protocol regression test
├── uploads/               Uploaded tracks (wiped on server start)
├── logs/                  CSV sync logs (git-ignored)
└── README.md
```

**HTTP endpoints:** `GET /` (Master; only from the laptop itself unless `ALLOW_REMOTE_MASTER=1`), `GET /join/:room`, `GET /css/*`, `GET /js/*`, `POST /api/rooms/:room/track` (master token), `GET /media/:trackId`, `GET /api/rooms/:room/sync-log.csv` (master token), `POST /api/rooms/:room/movie/:id/pcm` (master token), `GET /movie-audio/:id` (Range), `GET /vendor/mp4box/*`, and WebSocket `/ws`. Nothing else is exposed.

**Dependencies:** `express`, `ws`, `qrcode`, and `mp4box` (MP4 demuxing for movie audio, BSD-3). No database, no framework, no build step.

---

## Next phase

- **Measure on real hardware:** run the sync test with 2–3 real phones before and after acoustic calibration, then long sessions with the CSV log. Use the data to tune the Music/Movie thresholds. They are currently starting values validated only in simulation.
- **Calibrate during playback:** inaudible or masked probes, so recalibration doesn't need a quiet, paused room.
- **Streamed decode for long files** (chunked decoding or a media-element path with rate correction), so 2-hour soundtracks work in file mode on phones.
- **Pitch-preserving correction** (small time-stretch) if the remaining pitch nudge ever proves audible.
- **Compressed live audio** (Opus via WebCodecs) to cut bandwidth by about 10×.
- **🎬 Movie Sync on real hardware:** test A–G with real phones and **by ear** (dialogue), and with the Master page visible (rVFC anchors). Measure the laptop display's own delay with the microphone and a light sensor, or by ear, to set a default lip-sync.
- Faster recovery from video stalls (detect anchor jumps and re-align at once when the picture visibly jumped).
- Time-stretching for speeds ≠ 1× on phones; compressed movie audio on the server.
