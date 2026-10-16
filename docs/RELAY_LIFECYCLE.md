# Relay lifecycle investigation (M4/M5)

Question: can the desktop app start/stop the Node relay itself so a normal
user never touches a terminal?

## Short answer

Not yet. The relay stays an explicit `npm run relay` terminal process. The
desktop **OBS Bridge** panel covers everything around it that works over
HTTP today: health polling, one-click OBS-URL copy, test reactions, media
inventory, audio probing, and mode indication.

## Why not spawned from the webview

- The frontend runs inside a Tauri WebView. It has no process API. Spawning
  Node requires either the `tauri-plugin-shell` / sidecar mechanism (Rust
  side) or a bundled Node runtime — both are packaging work, not frontend
  work.
- This repo has no verified Rust change path in this environment (no
  `cargo`/`rustc`; `tauri-cli` only). Adding a sidecar target, shell-plugin
  permissions, and a process-supervision UI without the ability to run
  `cargo check` / `cargo test` / `tauri build` would be unverifiable and
  risks bricking the desktop build. Deliberately deferred.

## What a Tauri-native relay would look like (future)

1. **Sidecar (recommended):** compile the relay (or a tiny Rust port of its
   routes) as a Tauri sidecar binary; spawn on app start with a random
   publish/view token pair per launch; kill on app exit; surface port +
   tokens to the frontend via an event. Requires: `tauri.conf.json`
   sidecar entry, `capabilities` shell scope limited to that binary,
   frontend start/stop wiring to real process state, and Windows smoke tests
   (`tauri build` on a machine with Rust stable + WebView2 + VS Build Tools).
2. **Rust HTTP service:** reimplement the ~300-line relay with an embedded
   server (e.g. axum) behind `127.0.0.1` with an ephemeral port. Same
   token model. Removes the Node dependency for end users entirely.
3. Either way, keep the invariants this milestone established: loopback
   only, separate view/publish tokens, bounded queues/caches, streaming
   file responses, no camera pixels over the bridge.

## Windows packaging prerequisites (for whoever runs `tauri build`)

- Windows 10 1803+ / 11, WebView2 Runtime (ships with the OS / Edge).
- Rust stable via rustup, plus the Tauri v2 Windows prerequisites
  (Microsoft C++ Build Tools with the Windows 10/11 SDK).
- `npm ci`, then `npm run tauri build`. Expect the 1.6 MB JS bundle (face-api)
  to dominate build time, not size limits.

## Process hygiene today

- Relay: one `node scripts/overlay-relay.mjs` process; Ctrl+C ends it.
  `close()` destroys SSE clients and all connections, so restarts rebind
  the same port immediately (covered by the e2e restart test).
- Desktop: closing the Tauri window ends the frontend; no background workers
  are spawned by this app (detection timers and object URLs are released on
  unmount — see M1 notes).
- Verify with `Get-Process node` after closing everything.
