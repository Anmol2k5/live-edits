# Changelog

## Reconcile M1/M2 with feature/obs-reaction-mvp (2026-10-16)

- Integrated local M1 hardening (inference/camera/composer guards, model-load and compose error surfacing, `ErrorBoundary`, Tauri CSP, opener capability removal) and M2 contracts (trigger/effect schemas, registry, contract-emitting console + detector path) with the remote OBS relay (loopback SSE bridge, token auth, transparent overlay, `publishOverlayTrigger`, relay UI).
- Overlap resolution: `useMomentDetector` keeps the remote self-scheduling loop plus local config stabilisation, torn-stream rejection, idle reset and `modelsError` naming; `useCamera` keeps generation-gated restarts with stale-stream stop plus all-track disconnect surfacing; `useEditComposer` keeps latest-wins composition with synchronous capture-error fast path, dismiss invalidation and `composeError` (+ `error` alias); `overlayClient` accepts legacy or contract triggers (effect triggers resolve via registry); `App` keeps relay controls, `ErrorBoundary`, error banners, disabled-when-inactive console and contract events.
- `npm audit fix`: undici 8.10.0 → 8.12.2, source-map-js 1.2.1 → 1.2.2; `npm audit` now reports 0 vulnerabilities (both were transitive via jsdom/vite, test/build-time only).
- Not merged to main; no release claimed. Manual webcam/OBS/Tauri-packaging gates remain pending.

## M2 — Shared trigger + effect contracts (2026-10-16)

Scope: Master prompt Milestone 2 only. No OBS/backend/SaaS work.

### Added

- **`src/trigger/triggerSchemas.ts`**: validated `TriggerContract` discriminated union (`moment`/`template`/`effect`) with `id`, `source` (ai-detector/manual/timer/hotkey/api), `timestamp`, optional `sequenceNumber`/`workspaceId` (reserved for M7)/`expiresAt`/`dedupKey`/`metadata`. Factories `createMomentTrigger`/`createTemplateTrigger`/`createEffectTrigger`, `parseTriggerEvent`/`isTriggerContractEvent` boundaries, `isExpired`, bounded `TriggerDeduper` (500 entries), `toLegacyTrigger`/`fromLegacyTrigger` adapters. Scores are NOT emotion claims — `confidence` is a classifier score.
- **`src/effects/effectSchemas.ts`**: validated `EffectConfig` (`frame` kind V1; video/audio reserved for M3) with duration/delay/cooldown/priority/queue/enabled/zIndex/opacity, `TriggerRule` (enabled/allowedSources/overrides), `templateToEffect`, `decideQueueAction` (§6 queue/interrupt/replace/ignore/coexist), `shouldAcceptTrigger`, `isEffectInCooldown`.
- **`src/effects/registry.ts`**: template-backed registry (`EFFECTS`, `effect-<templateId>` 1:1, `getEffectById` loud failure, `getEffectsForMoment`, deterministic `pickRandomEffect`).
- **Vertical slice**: `TriggerConsole` emits contracts (`fireContract`), `App` detector path emits `createMomentTrigger`, `useEditPipeline.fireTrigger` accepts legacy or contract, resolves effect triggers via registry, drops expired (no compose). Legacy events still accepted.

### Tests added (all run)

- `triggerSchemas`: factories/validation, confidence range, expiry ordering, legacy round-trip, effect-refusal, dedup bound + dedupKey alias, id uniqueness (10 tests).
- `effectSchemas`: 1:1 mapping, range rejection, queue matrix, rule gating, cooldown (5 tests).
- `registry`: 6 effects / 2-per-moment, loud unknown lookup, deterministic pick, moment/template/effect resolution, expiry drop without compose, legacy compat (7 tests).

## M1 — Stabilise camera detection (2026-10-15)

Scope: Master prompt §4 (A–G), Milestones 0–1 only. No SaaS work.

### Fixed (verified defects)

- **Inference concurrency (`useMomentDetector`)**: the `setInterval(async …)` loop could start a new `detect()` while the previous one was still pending (overlap), commit out-of-order results, and keep committing after unmount. Now: in-flight skip guard, monotonic sequence so only the latest inference commits, `cancelled` flag on cleanup, `srcObject === null` early-out, inference faults caught per-tick so one bad frame never breaks the loop. Model-load failures now surface as `modelsError` in the header instead of hanging on “Loading AI…”.
- **Model loader (`ExpressionModel`)**: concurrent mounts shared nothing and a rejected load was cached. Now: module-level `loadPromise` dedup with reset-on-failure, `EMPTY_SCORES` returned as a fresh object per call, inference exceptions mapped to empty scores (treated as “no face”).
- **Camera lifecycle (`useCamera`, `CameraFeed`)**: rapid `restart()` calls raced — a slow earlier `getUserMedia` could overwrite the newer stream. Now: monotonic `requestId` with stale-result rejection (stale streams are stopped, not leaked), `mounted` guard, track-`ended` listener surfaces physical disconnection as `not-found: "Camera was disconnected."`. `requestCamera` now handles missing `navigator.mediaDevices` (insecure context), structural `name` reads for non-DOMException errors (`OverconstrainedError`, `SecurityError`, `TrackStartError`), and keeps `listCameras` total-failure → `[]`.
- **Viewfinder churn**: effect depended on the whole `cameraState` object and reset `srcObject` on every parent re-render. Now: attaches only when the stream identity changes, explicit `play()` with rejection swallow, detach only the stream it attached.
- **Composition races (`useEditComposer`, `EditComposer`)**: two rapid triggers let the slower compose overwrite the newer edit; a synchronous `captureFrame` throw left `isComposing: true` forever; `URL.revokeObjectURL` ran inside a state updater; unmount leaked object URLs. Now: monotonic request id (stale composes dropped), sync-capture errors surface as `composeError` + `isComposing: false`, single `setEdit` path with `currentUrlRef` revocation outside render, unmount invalidates in-flight work and revokes the URL. `captureFrame` throws clearly on zero-dimension video; `compose` validates slot/screenshot dimensions.
- **Detector baseline (`MomentDetector`)**: `happyHistory` survived triggers, so a pre-`wow` happiness rise stayed in the window and could phantom-fire `funny` after cooldown on sparse ticks. Now: history resets to `[currentHappy]` on every trigger. Behaviour on the steady 400ms cadence is unchanged (the 4s cooldown already slides the window), verified by existing + new tests.
- **Error handling (App)**: no boundary for render crashes; model/compose errors invisible. Now: `ErrorBoundary` around preview + overlay with recover action, `modelsError`/`composeError` banners with `role="alert"`.
- **Security (Tauri)**: `csp: null` (unrestricted) replaced with a least-privilege policy allowing `self` + `asset:` + `blob:`/`data:` for composed PNG object URLs and Google Fonts (`style`/`font` https:). `opener:default` capability removed (frontend never calls the opener plugin). Rust registration + npm dep left in place until a `cargo`-equipped environment can verify their removal — no behaviour change without verification.

### Docs

- `NOTES.md`: rate window corrected to 4 stored samples ≈ 1.2s + baseline-reset note.
- `GATES.md`: G1/G2/G6/G8 evidence updated with the actual commands run in M0/M1.

### Tests added (all run, see report)

- `MomentDetector.regression`: cross-moment baseline leak, zero-frame gap, sustained-high no-fire, cooldown block.
- `useCamera.lifecycle`: stale-restart rejection + leak-stop, denied-error surfacing.
- `useEditComposer.race`: slow-stale dropped, sync-capture error path.
- `useMomentDetector.guards`: model-error surfacing, in-flight skip.
- `ErrorBoundary`: crash → fallback + recover, healthy passthrough.

## M0 — Baseline audit (2026-10-15)

- `npm run typecheck`: clean.
- `npm run test`: 30/30 passed (3 files).
- `npm run build`: success (vite, ~1.6 MB bundle, chunk-size warning only).
- `cargo check/test`: BLOCKED — no Rust toolchain in this environment.
- Architecture mapped (entry `src/main.tsx` → `App`; camera → detector → pipeline → composer → overlay; templates validated with Zod at startup). Unused-in-`src` deps noted: `@tauri-apps/api`, `@tauri-apps/plugin-opener` (backend still registers opener; removal deferred pending cargo verification).
