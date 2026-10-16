# Gates: Streamer Moment Overlay V1

OWNS: src/**, public/templates/**, public/models/**

Scope: A working Tauri 2 desktop app that detects facial expressions from a webcam and composites instant meme-frame overlays.

- [x] G1: TypeScript compiles with zero `any` and strict mode
  CHECK: npx tsc --noEmit
  EXPECT: no output (clean compilation)
  EVIDENCE: 2026-10-15 `npm run typecheck` clean (pre- and post-M1).

- [x] G2: MomentDetector state machine unit tests pass (GitHub Actions run 38750311593)
  CHECK: npx vitest run src/detector/__tests__/MomentDetector.test.ts
  EXPECT: Tests passed
  EVIDENCE: 2026-10-15 `npm run test` 30/30 passed incl. MomentDetector suite; M1 adds MomentDetector.regression (4 tests).

- [ ] G3: Camera denied or missing shows clear error state, not crash
  EVIDENCE: pending

- [ ] G4: Live camera preview renders at native aspect ratio
  EVIDENCE: pending

- [ ] G5: Each of the three moment types can be reliably triggered by a real facial expression
  EVIDENCE: pending

- [x] G6: A neutral face held for 30 seconds produces zero triggers (simulation only; GitHub Actions run 38750311593)
  CHECK: npx vitest run src/detector/__tests__/MomentDetector.test.ts --reporter=verbose
  EXPECT: neutral face produces no triggers
  EVIDENCE: 2026-10-15 suite case "30 seconds of neutral face = zero triggers" passed; M1 adds sustained-high no-fire regression.

- [ ] G7: All 6 templates render correctly with a real screenshot in the photo slot
  EVIDENCE: pending

- [x] G8: Cooldown blocks re-triggering for at least 4 seconds (unit test; GitHub Actions run 38750311593)
  CHECK: npx vitest run src/detector/__tests__/MomentDetector.test.ts --reporter=verbose
  EXPECT: blocks triggers during cooldown
  EVIDENCE: 2026-10-15 cases "blocks triggers during cooldown" + "can trigger again after cooldown" passed; M1 regression re-covers immediate re-trigger block.

- [ ] G9: Template registry validates at startup — malformed templates fail loudly
  EVIDENCE: pending

- [ ] G10: All state is discriminated unions, template registry uses satisfies, Zod parses boundaries
  EVIDENCE: pending

## OBS local MVP gates

- [x] Local HTTP relay authentication/validation and SSE event delivery test — `npm run test:relay` passed in [GitHub Actions run 38750311593](https://github.com/Anmol2k5/live-edits/actions/runs/38750311593)
- [x] Frontend TypeScript strict compile, Vitest, and Vite build — same GitHub Actions run
- [ ] Face-triggered real OBS playback with a physical webcam — MANUAL TEST PENDING
- [ ] OBS video/audio autoplay and transparent background on Windows — MANUAL TEST PENDING
- [ ] Rust/Tauri desktop package build on Windows — MANUAL TEST PENDING
- [ ] Dependency security audit — `npm audit fix` applied 2026-10-16 (undici 8.10.0 → 8.12.2, source-map-js 1.2.1 → 1.2.2); `npm audit` now reports 0 vulnerabilities. Manual-gate status otherwise unchanged.
- [ ] Streaming stability with repeated effects (1h+) — PENDING
- [ ] SaaS identity, billing, hosted backend, and tenant isolation — NOT STARTED

CI passing does not close hardware/manual gates.

## Milestone 3 gates — real-time video/audio reaction engine (OBS target)

- [x] Tauri CSP allows only the loopback relay (`http://127.0.0.1:4190`, `http://localhost:4190`) in `connect-src`; all other M1 restrictions unchanged — `src-tauri/tauri.conf.json`
- [x] Manual OBS triggers work without webcam access (relay publish decoupled from camera frame capture; console enabled with a relay token and no camera) — `src/App.tsx`, `hasValidFrame` guard in `src/compose/EditComposer.ts`
- [x] Camera PNG capture stays disabled without a valid frame — `hasValidFrame` unit test
- [x] M2 contract fields (triggerId/dedupKey/expiresAt/effectId/queue/priority) travel desktop → relay; relay validates, expires (400) and deduplicates (202 duplicate, no broadcast) at its boundary — `src/relay/overlayClient.ts`, `scripts/overlay-relay.mjs`, `npm run test:relay`
- [x] Legacy `{moment,templateId}` triggers and PNG templates still accepted end to end — relay + overlay + pipeline backwards-compat tests
- [x] Discriminated media effect kinds (frame/image/video/audio/cutaway/popup) with duration, trim, volume, position, entrance/exit, priority and queue policies — `src/effects/effectSchemas.ts`; V1 frame behavior unchanged
- [x] Reusable bounded playback scheduler core (priority order, queue/replace/interrupt/ignore/coexist, expiry, dedup, cooldown, 1000-submit burst bound) — `src/effects/scheduler.ts`
- [x] Relay HTTP Range (206/416) for media seeking; bootId + SSE ids for restart/resync; 20-client cap; `/api/media` inventory; traversal containment — relay tests
- [x] Overlay: policy-aware player, failed-media skip, reconnect resync, resource release, transparent idle — jsdom browser-engine tests (`src/relay/__tests__/overlayDom.test.ts`)
- [ ] Physical webcam facial-expression → video-meme-with-audio → OBS Browser Source → auto-cleanup demo — MANUAL TEST PENDING (no webcam/OBS on this machine)
- [ ] OBS video/audio autoplay and transparent compositing on Windows — MANUAL TEST PENDING
- [ ] Rust/Tauri desktop package build — BLOCKED (no Rust toolchain; `cargo`/`rustc` absent, tauri-cli 2.11.4 present)
- [ ] 1h+ streaming stability soak — PENDING
