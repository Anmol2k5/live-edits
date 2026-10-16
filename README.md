# Live Edits — Streamer Reaction Prototype

Live Edits is a Tauri 2 + React + TypeScript webcam reaction prototype. It detects three expression categories (wow/funny/sad) with locally loaded face-api models, captures the current frame and composites one of six PNG templates. Manual buttons also trigger reactions.

This branch adds a **local-only OBS development bridge**. It is **not** a deployed multi-tenant SaaS. The OBS renderer is a separate transparent webpage served by a Node.js relay. The local desktop UI can optionally publish reaction metadata to that relay; webcam images are not sent through it.

## Development

Prerequisites: Node.js 22 and npm. Tauri packaging also needs Rust and platform-specific dependencies.

1. Run \`npm ci\`.
2. Run \`npm run relay\` in terminal A. Keep this terminal open.
3. Run \`npm run dev\` in terminal B, or \`npm run tauri dev\` if your Tauri toolchain is installed.
4. Open the local UI and expand **OBS Bridge**.
5. Copy the **PUBLISH** token from terminal A to the OBS Bridge field.
6. In OBS Studio, add a **Browser Source** with the private URL printed by terminal A. Use width 1920, height 1080 as a starting point. Put the source above your camera.
7. Press a manual reaction button, or grant camera access and try a supported expression gesture.
8. Reactions should appear in the OBS overlay. The source is transparent when idle.

For debugging, append \`&debug=1\` to the Browser Source URL to display connection status in the overlay. Never show that URL publicly.

By default the bridge shows the existing PNG meme frame with a small locally generated tone. To play a custom MP4/WebM/GIF/image/audio file, put a media file in \`public/reactions/\` and enter **just the filename** in the OBS Bridge UI. The relay enforces a filename allowlist and a 50 MB media limit. A video includes its own audio when OBS permits playback. Configure OBS Browser Source audio capture as needed.

This bridge binds only to \`127.0.0.1:4190\`; it is intended to run on the same machine as OBS. It generates separate read and publish tokens at startup. The tokens expire when the relay exits. It is not suitable for hosting on a public interface or for SaaS accounts.

## Reaction editor

The **Editor** tab builds validated reaction packs with no webcam: import
media, create effects, tune every property, chain timed sequences, preview on
a transparent 16:9 stage, then fire straight to OBS. Packs persist as JSON in
localStorage (media stays in-session; reimport after reload), export/import
as `.live-edits.json`, and the active pack resolves live camera and manual
triggers first. Full guide: `docs/EDITOR.md`. Audible output is only ever
claimed after the manual check in `docs/OBS_SETUP.md` — automated tests
assert play *permission* (`paused === false`), never heard sound.

## Checks

- `npm run typecheck` — TypeScript (app + e2e + shared fixtures)
- `npm run test` — Vitest unit + jsdom browser-engine tests
- `npm run test:relay` — Node relay tests + shared scheduler conformance
- `npm run test:e2e` — Playwright real-Chromium tests: `playback` project (overlay suite + editor→OBS workflow) and `autoplay-default` project (graceful refusal, never an audibility claim). Needs system Chrome or `playwright install`; point TEMP at a writable disk if C: is full
- `npm run build` — frontend production build
- `npm run tauri build` — desktop packaging (requires Rust and desktop toolchain)
- `npm audit` — dependency audit (currently 0 vulnerabilities)

## Known limitations

- Browser-based OBS overlays cannot read or alter an existing OBS camera source. The desktop application captures its own webcam; OBS effects are layered separately.
- The default meme effects are static PNGs with animation; true video reactions require the streamer to supply playable media files.
- The relay must run as a separate Node process, and local tokens must be entered each session.
- No user accounts, hosted backend, Twitch integration, cloud media storage, or billing are implemented.
- Autoplay with sound, webcam inference, Windows Tauri packaging, and actual OBS compatibility all require manual hardware/application verification.
- BrowserSource performance and long-stream stability have not been benchmarked.
- Expression classifications should be treated as imperfect gesture signals, not ground-truth feelings.
- The current Tauri CSP and permissions need hardening before public distribution.

## Security / privacy

The relay listens on loopback only and uses separate randomized view and publish tokens. Keep both private. This is a local MVP, not a general-purpose hosted credential design. Camera frames remain in the local desktop application; the relay receives reaction type, template identifier and optional filename, not webcam pixels. Only use media for which you have streaming rights.
