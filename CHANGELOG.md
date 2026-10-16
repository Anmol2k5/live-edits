# Changelog

## M7 — Hosted SaaS foundation (branch feature/obs-reaction-mvp)

Scope: account → pack → media → overlay vertical slice only. No Twitch, no billing, no merge of PR #1, no deploy, no release claim. Local Tauri app, loopback relay, packs, editor, triggers, and playback are preserved and still fully tested.

### Backend (`server/`, zero new runtime deps)

- `createSaasApp`: auth (register/login/logout, scrypt passwords, opaque 7-day sessions over cookie + Bearer, single-use expiring recovery, account settings), workspaces with owner/admin/member roles and membership-checked routes (unknown/non-member → 404, denied attempts audited), versioned pack CRUD + collision-safe import/export byte-compatible with local JSON, streaming workspace media (allowlist, 50 MB, magic-byte sniff, atomic rename, 409 duplicates, versioned replace, quotas, signed URLs), named/revocable/rotatable overlay sessions with workspace-isolated SSE plus trigger validation (expiry/dedup/media/effect resolution through the active pack), history + audit. `npm run saas`.
- Persistence: `server/migrations/001_init.sql` (Postgres 15+, all entities, constraints, indexes); `MemoryStore` mirrors every constraint for tests/dev; `PostgresStore` loads `pg` only when `DATABASE_URL` is set (not verified here — no server available; documented in `docs/SAAS_ARCHITECTURE.md`).
- Storage: `FilesystemStorage` (tests/dev, temp dirs in tests) + S3-compatible config from `LIVE_EDITS_S3_*` with credentials server-side only (config path tested; byte-level S3 NOT verified).
- Hosted overlay page reuses the shared scheduler core and queue/coexist/expiry/dedup semantics; local relay untouched (still loopback-only, never exposed publicly).

### Dashboard (`src/saas/`, Cloud view in `src/App.tsx`)

- Sign in/register/recovery-aware account panel, workspace create/select, cloud packs (create, save-local-to-cloud, load-into-editor round-trip, activate, delete), cloud media upload/inventory/delete, overlay create/copy-URL/revoke/rotate, fire-by-effect with delivery status. Local Live/Editor flows unchanged.

### Verification (actual runs, this environment)

- `npm run typecheck` clean; `npm run test` green (incl. 6 new server suites: auth/workspaces/packs/media/overlays/security + CloudPanel render); `npm run test:relay` green; `npm run test:e2e` green incl. new `saas.spec.ts` (real backend on ephemeral port, real Chromium: register → workspace → pack → upload → configure → overlay → trigger plays on correct overlay → rival isolated → revoke → reload keeps packs); `npm run build` success; `npm audit` 0 vulnerabilities.
- NOT verified here: production Postgres run, byte-level S3, physical OBS/webcam, Tauri packaging, long soak — gates stay open.

## M6.1 — Finish the reaction-pack workflow (branch feature/obs-reaction-mvp)

Scope: master-prompt Milestone 6.1 only (recovered after an interrupted session; no restart from scratch). No merge of PR #1, no deploy, no SaaS/billing/Twitch, no release claim.

### Automatic media transfer (no manual copying)

- Relay `POST /api/media/:name` (publish-token auth, 50 MB cap, filename allowlist, traversal containment, magic-byte content sniffing, streaming to temp file with bounded memory, atomic rename, 409 on duplicates or in-flight uploads, empty/oversize rejected, temp fragments cleaned on abort) plus `GET /api/media` inventory and `DELETE /api/media/:name` explicit removal. User-writable media directory via `LIVE_EDITS_MEDIA_DIR` / `--media-dir` (defaults to `public/reactions`). Covered by relay tests including 1 MB streaming and abort cleanup.
- Client `src/relay/mediaTransfer.ts`: streaming `uploadMedia`, `deleteRelayMedia`, `fetchRelayInventory` with typed `MediaTransferError`; never buffers whole files client-side.
- Editor wiring: imports stream to the relay automatically when the publish token is set; without a token they stay local with a manual Send to relay retry. Per-file status (sending / on relay / local only / conflict / error), confirmed Replace (delete-then-upload) on 409, confirmed Delete from relay, Refresh relay files inventory, reload-aware preview messaging (relay copies still fire after reload; local preview needs reimport). `src/editor/ReactionEditor.tsx`, `src/editor/MediaLibraryPanel.tsx`, `src/App.tsx` passes `relayBase` + `publishToken` into the editor.

### Active-pack trigger resolution (V1 fallback preserved)

- Manual buttons and facial-expression detector events resolve through `findAssignment` / `resolveTemplateTrigger` with the same pack-first rule as the pipeline; frame assignments compose the assigned template, media assignments publish an effect trigger with no local PNG fakery, unmatched triggers keep exact V1 behavior. Source wildcards (assignments with no moment) match any moment for their source after exact rules, so timer/hotkey generic entries work without shadowing specifics.

### Effect settings survival (no global overrides)

- Pack media effects publish full playback config (media file, duration, volume, trim, position, queue, priority, cooldown, effect identity); frame effects keep the legacy template path with relay defaults. Blank Live-panel volume/duration/media fields mean no override. Pinned by overlay-client mapping tests.

### Collision handling

- Duplicate pack IDs get a fresh ID plus "(imported)" suffix so reimports never collide; colliding effect IDs take `-imported-N` with assignment/sequence references rewritten. Reimported filenames release stale object URLs; async probe results apply only to the still-current URL (stale rejected). Destructive relay replaces and used-media/pack/effect deletes use two-step confirms.

### Verification (actual runs, this environment)

- `npm run typecheck` clean; `npm run test` 164/164 passed (28 files); `npm run test:relay` 17/17 passed; `npm run test:e2e` 14/14 passed (playback 12 incl. new transfer + reload-persistence workflow, autoplay-default 2); `npm run build` success; `npm audit` 0 vulnerabilities (see below); Tauri packaging BLOCKED (no cargo/rustc); physical OBS/webcam NOT TESTED here.
- End-to-end workflow proven in real Chromium: create pack, import transfer.wav (outside the relay dir), auto-transfer, effect, manual wow assignment, save, activate, Live wow-1 trigger plays `/media/transfer.wav` on the real overlay, cleanup delete, reload plays again with no reimport.

## M6 — Reaction packs & effect editor (branch feature/obs-reaction-mvp)

Scope: master-prompt Milestone 6 only. No SaaS accounts/billing, no merge, no deploy, no release claim. Foundation (M0–M5) preserved; editor is additive (`src/editor/`, `src/packs/`) plus narrow pack-aware wiring in the pipeline, publisher and App.

### Automation gaps closed

- New `.github/workflows/checks.yml` (ci, typecheck, vitest, relay+conformance, build, audit) and `e2e.yml` (Playwright on `ubuntu-latest` with real Chromium install; failure artifacts).
- `playwright.config.ts` now splits `playback` (autoplay-permissive, `overlay.spec.ts` + `editor.spec.ts`) from `autoplay-default` (stock policy, `policy.spec.ts`). The permissive suite asserts `paused === false` (allowed to play) — audibility is explicitly never claimed headless; the default-policy suite asserts refusal degrades to a status message + timed cleanup + idle transparency.
- `vite.config.ts` ignores ephemeral dirs (`.tmp-pw`, e2e output) so local browser profiles never crash the dev watcher (fixed a real EBUSY crash).

### Reaction packs

- `src/packs/packSchemas.ts`: versioned (`version: 1`) packs with effects, trigger assignments (source + optional moment → effect) and sequence steps; `parsePack` enforces referential integrity; create/rename/duplicate/serialize/import with id-collision rewrite.
- `src/packs/packStore.ts`: localStorage JSON only — filenames, never binaries/object URLs (quota-safe); corrupt data starts clean without destroying the raw value; active-pack tracking.
- `src/packs/resolve.ts`: pack-first, static-registry-fallback resolution for effects and moment triggers; disabled pack effects fall back to the V1 pick, so pre-pack behavior is byte-identical without a pack.

### Editor (all four areas, webcam-free)

- Left `MediaLibraryPanel`: import (validated), search/filter, previews + metadata, usage counts, two-step remove for used media; files list instantly with metadata filling in (probe never blocks import).
- Center `PreviewStage`: transparent 16:9 stage rendering the shared `effectToPlayback` mapping (parity with the OBS player, pinned by matrix tests), progress bar, idle restore, teardown release.
- Right `EffectPropertiesPanel`: every field from the brief (name/kind/media/position/duration/trim/volume/priority/cooldown/queue/entrance/exit/enabled/assignments) with per-field Zod errors, Preview + Fire-to-OBS, missing-token guidance.
- Bottom `SequencePanel`: visual track with proportional bars, add/remove/reorder, per-step delay edit, play/pause/seek-slider/reset, active + skipped states.
- `useSequencePlayback`: timed cues admitted through the shared scheduler core (same engine as OBS) — refused cues are reported, never faked; fixed a real re-admission spam bug and a render-loop reset bug found by tests.
- `useUndoable` (50-step) + dirty tracking + save/discard/cancel switch guard; two-step confirms for pack/effect/used-media deletes; full keyboard reachability with live regions; responsive single-column collapse.
- Media binaries live in the session `MediaRegistry` only; reloads mark entries for reimport. App-data directory migration investigated in `docs/EDITOR.md` (needs Rust fs scope — not verifiable here, schemas already shaped for it).

### Engine connection (no second scheduler)

- `publishOverlayTrigger` and `useEditPipeline.fireTrigger` accept an optional pack: effect triggers resolve pack-first; media effects publish full playback config (media/duration/volume/trim/position/queue/priority/cooldown) with caller overrides winning; frame effects keep the exact V1 template path and relay timing.
- Detector path: pack moment assignments route to pack effects (media → OBS-only publish, frame → local compose + publish); manual console unchanged.
- Relay: `effectId` is now opaque (shape-validated) instead of requiring `effect-<template>` form — the e2e run caught the old rule rejecting every editor-built effect. Template↔moment consistency still enforced.
- `POST /api/overlay-url` and relay base URL configurability (RelayPanel field, default loopback :4190) came out of the same e2e debugging (hardcoded port).

### Verification (actual runs, this environment)

- `npm ci` clean; `npm run typecheck` clean (now also covers `tests/e2e`).
- `npm run test`: full Vitest suite green, including new pack/media/undo/sequence/playback/panel suites and the 5-test editor workflow (pack→import→effect→preview→fire, invalid trims, undo/redo + switch guard, export/import round-trip, token gating).
- `npm run test:relay`: relay + conformance green (opaque effect ids, template-moment consistency).
- `npm run test:e2e`: `playback` green (overlay suite + new editor→OBS workflow: build pack headlessly, fire, real overlay plays the file), `autoplay-default` green (graceful refusal).
- `npm run build` success; `npm audit` 0 vulnerabilities; Tauri packaging still BLOCKED (no cargo/rustc).
- Manual Windows/OBS/webcam results: never faked — gaps listed below.

## M4/M5 — OBS integration, companion reliability, streaming verification (2026-10-16, branch feature/obs-reaction-mvp)

Scope: master-prompt Milestones 4–5 only. No SaaS auth/billing/Twitch work. No merge, no release claim.

### Verified M3 defects fixed

- **Coexist leak (`public/obs-overlay.html`)**: layered plays never removed their `layers` entry on completion or load failure, so the 3-layer cap wedged permanently after 3 plays. All layer exits (success, load failure, playback error, preemption, boot resync) now go through `try/finally` + `cleanupMain`, each deleting its reference. Proven by a 100-sequential-coexist test (10 drained waves of 3 + 70-burst past the cap + follow-up play) asserting `layers() === 0` and an empty stage.
- **Range buffering (`scripts/overlay-relay.mjs`)**: `serve()` did `readFile` of the whole file per request (up to the 50 MB cap per hit). Now streams with `createReadStream({start,end})` — constant memory regardless of file size — with 200/206/416, mid-file seek, open-ended, suffix, EOF-edge and malformed→200 handling. Fixed two real bugs found while testing: suffix ranges computed a wrong end, and shutdown hung on undrained clients (streaming only finishes when the peer drains, so `close()` now calls `closeAllConnections()` first and destroys streams on connection close). Relay tests drain bodies.
- **Duplicated scheduling**: one dependency-free implementation, `src/effects/scheduler-core.js`, consumed three ways — the typed TS wrapper (`src/effects/scheduler.ts`, same public API plus `reset()`/`clearWaiting()`), the overlay player over HTTP (`/obs-player.js` route + `script-src 'self'`), and both test harnesses. `shared/scheduler-cases.json` (9 scenarios) runs in vitest (wrapper) and node:test (raw core) with identical expectations. The overlay delegates submit/finish/clear/reset to the core and keeps only DOM work inline.

### Real-browser playback (Playwright + system Chrome 155, NOT jsdom)

- New `tests/e2e/` suite (9 tests, all passing): self-generated fixtures (440 Hz WAV in Node; canvas-recorded WebM via MediaRecorder — no binaries committed, no licensed media), real relay on loopback, real overlay page. Covers video load/play/seek/finish + `src` disposal, audio volume/playback + fallback art, transparent idle (`rgba(0,0,0,0)` + empty stage), priority-ordered consecutive effects, layer cleanup, replace interruption, malformed/expired rejection, relay restart on the same port with reconnect-then-publish, and a 50-mixed-effect soak asserting idle + `<30 MB` heap growth + no malformed events. Chromium was used from the system install (`channel: "chrome"`) because C: has no room for a Playwright download; jsdom tests are retained but no longer described as media-decoding tests.
- Test-only fixes from real failures: fixture recorder retries until >2 KB (cold-start flakes), soak durations respect the 250 ms relay minimum, restart test waits for overlay reattach before publishing (broadcasts are not persisted — also documented in `docs/OBS_SETUP.md`).

### Desktop workflow

- New `src/relay/RelayPanel.tsx` (wired into `App`, replacing the bare settings block): live health polling, **Copy OBS URL** (`POST /api/overlay-url`, publish-auth, loopback only), **Send test reaction** (validated contract, no camera needed), **Check relay media** (inventory with kind/size + missing-selection flags), **Probe audio** (real `AudioContext` state + OBS-specific checklist), and an explicit webcam-free vs expression-mode indicator. All controls hit real endpoints; nothing is a placeholder.
- Relay additions: `POST /api/overlay-url`, `GET /obs-player.js` (shared core), `cooldownMs` accepted and forwarded end to end (overlay enforces per-effect cooldowns via the shared core).
- `docs/OBS_SETUP.md`: Windows 10/11 + OBS 30+ setup, webcam-free and expression modes, custom media, audio checklist, manual verification list, bridge limits. `docs/RELAY_LIFECYCLE.md`: why in-app start/stop needs a Tauri sidecar (no cargo here to verify one — investigation, not implementation), Windows packaging prerequisites, process hygiene.

### Verification (actual runs, this environment)

- `npm ci` clean; `npm run typecheck` clean (now also covers `tests/e2e` and shared fixtures; M4/M5 added `@playwright/test` and `scripts/overlay-relay.d.mts`).
- `npm run test`: full Vitest suite green (incl. new scheduler-core delegation, conformance, RelayPanel, hasValidFrame).
- `npm run test:relay`: relay tests + scheduler conformance green.
- `npm run test:e2e`: 9/9 green on system Chrome 155 headless.
- `npm run build`: success. `npm audit`: 0 vulnerabilities.
- Tauri packaging: BLOCKED (no cargo/rustc; tauri-cli 2.11.4 present). OBS Studio launch, physical webcam, and 1h+ soak: NOT TESTED here — steps and sample-media guidance in docs/OBS_SETUP.md.

## M3 — Real-time video/audio reaction engine (2026-10-16, branch feature/obs-reaction-mvp)

### Integration blockers fixed

- **Tauri CSP**: `connect-src` now adds only `http://127.0.0.1:4190` and `http://localhost:4190` for the loopback relay; every other M1 restriction is byte-identical (`src-tauri/tauri.conf.json`).
- **Manual triggers without webcam**: the OBS publish path no longer touches any video element. `TriggerConsole` stays enabled with a relay token and no camera; local PNG composition is skipped via the new `hasValidFrame()` guard instead of throwing (`src/App.tsx`, `src/compose/EditComposer.ts`).
- **Contract preservation**: `publishOverlayTrigger` forwards `triggerId`/`dedupKey`/`expiresAt`/`sequenceNumber`/`effectId` plus `queue`/`priority` resolved from the effect registry; legacy triggers keep working (`src/relay/overlayClient.ts`).
- **Receiving-boundary enforcement**: the relay rejects expired triggers (400), dedupes `triggerId`/`dedupKey` with a 500-entry bound (202 duplicate, no broadcast), validates `queue`/`priority`/`volume`/`clipStartMs`/`clipEndMs`/`position`, and still accepts legacy `{moment,templateId}` payloads (`scripts/overlay-relay.mjs`).

### Media engine

- `src/effects/effectSchemas.ts`: new discriminated `image`/`video`/`audio`/`cutaway`/`popup` kinds (duration 250–30000ms, trim points with end>start, volume 0–1, position, entrance/exit, priority, queue). `frame` shape and `templateToEffect` are untouched — V1 PNG behavior is unchanged.
- `src/effects/scheduler.ts` (new): DOM-free `EffectScheduler` — bounded waiting queue (default 6), priority-ordered insert, queue/replace/interrupt/ignore/coexist decisions, expiry, dedup, per-effect cooldowns, `finish()` promotion, `clear()`.
- `public/obs-overlay.html`: policy-aware player (preempt on replace/interrupt, drop on ignore, priority queue, layered coexist up to 3), trim/volume/position handling, `hello`-event boot-id resync, SSE `id:` fields, media-error skip (never hangs), pause + `src` removal + element teardown per effect, empty transparent stage when idle.

### Relay hardening

- HTTP Range seeks (206 with `Content-Range`, `Accept-Ranges: bytes`, 416 on unsatisfiable) for `/media/` and `/templates/`.
- Per-boot `bootId` in health, `hello` and reaction events; overlay drops stale waiters on boot change.
- 20-client SSE cap (503), dead-client eviction on write failure, 4KB body limit retained.
- `GET /api/media` token-gated inventory (view or publish token) with basename + directory-containment checks; traversal still 404/400.
- `public/reactions/.gitkeep` documents the local media drop folder.

### Tests (all run, see report)

- Vitest: 16 files / 89 tests — new `mediaEffects` (6), `scheduler` (7), `overlayClient` (5), `overlayDom` browser-engine (7), `hasValidFrame` (2); all M0–M2 suites still green.
- `test:relay` (node:test): 3 passed — original bridge test untouched plus contract-field validation (expiry/dedup/queue/volume/trim/effect resolution) and Range/media-list/50-trigger ordering.
- Browser engine: jsdom (installed dependency, real DOM + CSS), with stubbed `EventSource` and media `play()` — video/audio element lifecycles, policies, expiry/dedup, reconnect, transparency and cleanup are asserted against the actual served `obs-overlay.html`. Real decode, physical webcam and OBS compositing remain MANUAL TEST PENDING.
- `npm ci` clean, `typecheck` clean, `build` success, `npm audit` 0 vulnerabilities. Added `@types/node` + `@types/jsdom` dev deps for the DOM harness.
- Tauri: `cargo`/`rustc` absent (tauri-cli 2.11.4 present) — desktop packaging verification BLOCKED, recorded in GATES.md.

### Acceptance path (automated portion)

Manual button (contract event, no camera) → `publishOverlayTrigger` → relay validate/expire/dedup → SSE to Browser Source → video-with-audio playback → timed auto-cleanup is covered by `overlayClient` + relay + overlay DOM tests. Facial-expression triggers feed the same pipeline when a webcam is present (`App` detector path unchanged). Live OBS on Windows is NOT claimed.

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
