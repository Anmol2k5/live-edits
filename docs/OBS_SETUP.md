# OBS Studio setup (Windows)

Target: a streamer on Windows 10/11 with OBS Studio 30+ installed.

## 1. Start the relay

In a terminal (Node.js 22+):

```powershell
npm ci
npm run relay
```

Keep this terminal open. It prints two secrets — do not share them:

- **PUBLISH token** → paste into the desktop app under **OBS Bridge**.
- **OBS Browser Source URL** (`http://127.0.0.1:4190/overlay?token=…`) → or fetch it
  from the desktop app with **Copy OBS URL** once the publish token is set.

The relay binds loopback only (`127.0.0.1:4190`). Tokens die with the process.

## 2. Add the Browser Source

1. OBS → Sources → **+** → **Browser**.
2. Paste the private overlay URL. Start with **1920 × 1080**.
3. Put the source **above** the camera source.
4. Idle state is fully transparent — verify against a scene background.
5. Append `&debug=1` to the URL while setting up to see connection status.

## 3. Trigger without a webcam

1. In the desktop app, expand **OBS Bridge** and paste the publish token.
2. Health should read “Relay up · N overlay(s)”.
3. Press any manual reaction button (works with no camera), or **Send test
   reaction**.
4. The reaction appears in OBS, then cleans up automatically.

## 4. Webcam-expression mode (optional)

Grant camera access in the desktop app. A supported gesture (wide-eyed
surprise, broad laugh from neutral, frown) fires the same effect engine.
Camera pixels never leave the desktop app — only reaction metadata goes to
the relay.

## 5. Custom video/audio

1. Drop files into `public/reactions/` (MP4/WebM/MP3/WAV/OGG/PNG/JPEG/WebP/GIF,
   plain filenames, ≤128 chars, ≤50 MB) and restart the relay.
2. Use **Check relay media** in the desktop app to confirm the relay sees them.
3. Enter the filename in the OBS Bridge panel before triggering.

Licensed samples: do not ship copyrighted clips. Generate your own:

- `sting.wav`: any DAW export, or the sine fixture the e2e suite synthesises
  (`tests/e2e/helpers.ts` `makeWav` — 440 Hz, 0.6 s, public-domain by construction).
- `clip.webm`: record your own screen/cam clip in OBS itself
  (Remux to MP4/WebM), or reuse the canvas-recorded fixture generator in
  `tests/e2e/helpers.ts` (`makeWebm`).

## 6. Audio troubleshooting

1. In the desktop app, press **Probe audio**: `running` means this Chromium
   stack can play sound.
2. In OBS: select the Browser Source → check **Control audio via OBS**.
3. Unmute the source in the OBS audio mixer.
4. Visible (non-hidden) sources render audio more reliably; hidden sources may
   stay silent.
5. `&debug=1` shows “Media playback blocked: …” when autoplay is denied.

## 7. Manual verification checklist (record results, do not assume)

- [ ] Transparent idle over a live scene (no black box).
- [ ] Image / video / audio reaction each appear and auto-dismiss.
- [ ] Volume slider is honoured (video + audio).
- [ ] Rapid button spam obeys the visible queue (no pile-up, no stuck frame).
- [ ] Relay terminal restarted mid-stream → overlay shows “resynchronised” and
      new triggers play (re-paste nothing; same port).
- [ ] 15+ minute session: no growth in OBS memory for the source, no ghost frames.
- [ ] Closing the desktop app + relay leaves no `node` processes behind
      (`Get-Process node` in PowerShell).

## 8. Known bridge limits (by design, local MVP)

- Triggers published while zero overlays are connected are accepted but not
  stored — the desktop status line says so (“no OBS overlay connected”).
  Reconnect first, then trigger.
- The desktop PNG preview still needs a webcam frame; the OBS path does not.
- No accounts, no hosted backend, no Twitch, no billing.
