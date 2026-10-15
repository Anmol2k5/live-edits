# Gates: Streamer Moment Overlay V1

OWNS: src/**, public/templates/**, public/models/**

Scope: A working Tauri 2 desktop app that detects facial expressions from a webcam and composites instant meme-frame overlays.

- [ ] G1: TypeScript compiles with zero `any` and strict mode
  CHECK: npx tsc --noEmit
  EXPECT: no output (clean compilation)
  EVIDENCE: pending

- [x] G2: MomentDetector state machine unit tests pass (GitHub Actions run 38750311593)
  CHECK: npx vitest run src/detector/__tests__/MomentDetector.test.ts
  EXPECT: Tests passed
  EVIDENCE: pending

- [ ] G3: Camera denied or missing shows clear error state, not crash
  EVIDENCE: pending

- [ ] G4: Live camera preview renders at native aspect ratio
  EVIDENCE: pending

- [ ] G5: Each of the three moment types can be reliably triggered by a real facial expression
  EVIDENCE: pending

- [x] G6: A neutral face held for 30 seconds produces zero triggers (simulation only; GitHub Actions run 38750311593)
  CHECK: npx vitest run src/detector/__tests__/MomentDetector.test.ts --reporter=verbose
  EXPECT: neutral face produces no triggers
  EVIDENCE: pending

- [ ] G7: All 6 templates render correctly with a real screenshot in the photo slot
  EVIDENCE: pending

- [x] G8: Cooldown blocks re-triggering for at least 4 seconds (unit test; GitHub Actions run 38750311593)
  CHECK: npx vitest run src/detector/__tests__/MomentDetector.test.ts --reporter=verbose
  EXPECT: blocks triggers during cooldown
  EVIDENCE: pending

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
- [ ] Dependency security audit — npm ci reported 2 high vulnerabilities; triage before release
- [ ] Streaming stability with repeated effects (1h+) — PENDING
- [ ] SaaS identity, billing, hosted backend, and tenant isolation — NOT STARTED

CI passing does not close hardware/manual gates.
