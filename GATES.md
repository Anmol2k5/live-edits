# Gates: Streamer Moment Overlay V1

OWNS: src/**, public/templates/**, public/models/**

Scope: A working Tauri 2 desktop app that detects facial expressions from a webcam and composites instant meme-frame overlays.

- [ ] G1: TypeScript compiles with zero `any` and strict mode
  CHECK: npx tsc --noEmit
  EXPECT: no output (clean compilation)
  EVIDENCE: pending

- [ ] G2: MomentDetector state machine unit tests pass
  CHECK: npx vitest run src/detector/__tests__/MomentDetector.test.ts
  EXPECT: Tests passed
  EVIDENCE: pending

- [ ] G3: Camera denied or missing shows clear error state, not crash
  EVIDENCE: pending

- [ ] G4: Live camera preview renders at native aspect ratio
  EVIDENCE: pending

- [ ] G5: Each of the three moment types can be reliably triggered by a real facial expression
  EVIDENCE: pending

- [ ] G6: A neutral face held for 30 seconds produces zero triggers (tested in unit test)
  CHECK: npx vitest run src/detector/__tests__/MomentDetector.test.ts --reporter=verbose
  EXPECT: neutral face produces no triggers
  EVIDENCE: pending

- [ ] G7: All 6 templates render correctly with a real screenshot in the photo slot
  EVIDENCE: pending

- [ ] G8: Cooldown blocks re-triggering for at least 4 seconds (tested in unit test)
  CHECK: npx vitest run src/detector/__tests__/MomentDetector.test.ts --reporter=verbose
  EXPECT: blocks triggers during cooldown
  EVIDENCE: pending

- [ ] G9: Template registry validates at startup — malformed templates fail loudly
  EVIDENCE: pending

- [ ] G10: All state is discriminated unions, template registry uses satisfies, Zod parses boundaries
  EVIDENCE: pending
