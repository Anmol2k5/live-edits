# SaaS security (M7 foundation)

## Authentication

- Passwords: `scrypt` (N=16384, r=8, p=1, 64-byte derived key, 16-byte salt),
  verified with `timingSafeEqual`. Minimum length 10, maximum 200.
- Sessions: opaque 64-hex-char tokens, stored as SHA-256, 7-day TTL
  (`LIVE_EDITS_SESSION_TTL_MS` override for tests), revocable per-device
  (`GET/DELETE /api/auth/sessions`), revoked on logout, password change,
  and recovery confirm.
- Web dashboard: session travels in an `HttpOnly; SameSite=Lax` cookie
  (`le_session`) with CSRF double-submit (`le_csrf` cookie + `X-CSRF-Token`
  header required on cookie-authenticated POST/PUT/PATCH/DELETE; missing or
  wrong token → `403`). Bearer tokens carry no ambient credentials and are
  CSRF-exempt. Production sets `LIVE_EDITS_COOKIE_SECURE=1` (HTTPS-only
  cookies + HSTS) and serves the dashboard same-origin.
- Desktop companion (Tauri): separate Bearer path. Tokens live in memory
  only; the browser `localStorage` entry is an explicit, documented
  stand-in for OS secure storage used by automated tests.
- Recovery: 1-hour single-use reset tokens (SHA-256 stored) delivered by a
  real `EmailProvider` (SMTP over raw sockets with STARTTLS + AUTH in
  production; append-only logging fallback in dev; in-memory capture in
  tests). API responses never contain tokens — always `{ ok: true }` — and
  unknown addresses behave identically (no enumeration).
- Auth endpoints are rate-limited per IP (register/login 10/min, recovery
  5/min, triggers 120/min per workspace) with `429` + `Retry-After`.
  Failures return generic `401`/`409`.
- Production startup is fail-closed (`validateProductionConfig`): missing
  session secret, insecure cookies, absent `DATABASE_URL`, memory store, or
  unconfigured recovery mail abort boot with explicit errors.

## Authorization

- Workspace ids from clients are never trusted: each request checks the
  `memberships` row. Unknown workspace and non-member both yield `404` so
  ids cannot be probed. Denied attempts are audit-logged.
- Role hierarchy `owner > admin > member`. Member add/remove is owner-only;
  the last owner cannot be removed. Pack/media/overlay writes need
  `admin+`; triggering and reads need any membership; audit reads need
  `admin+`.
- Overlay view tokens are per-session secrets (SHA-256 stored, shown once).
  Revoke disconnects live SSE clients immediately; rotate invalidates the old
  token. Revoked sessions get `403` on page, events, and media.

## Media and storage

- Filename allowlist `^[A-Za-z0-9][A-Za-z0-9._-]*$` (≤128 chars, allowlisted
  extensions), path-traversal containment (`resolve` + prefix check), 50 MB
  cap, magic-byte sniffing matched to the extension, empty rejected.
- Uploads stream to `.<rand>.part` temp files (bounded memory), validated,
  then atomically renamed. Duplicates get `409` (never overwrite); explicit
  `PUT` replacement re-validates and bumps a version counter. Failures clean
  temp files and record no row. Per-workspace quota (500 MB default).
- Storage credentials are never exposed: S3 keys live only in server env
  (`LIVE_EDITS_S3_ACCESS_KEY/SECRET_KEY`); clients get either same-origin
  streams (membership-checked) or 15-minute HMAC-signed URLs
  (`workspace:name:expiry` under the session secret).
- Overlay media URLs are workspace-scoped: the overlay id → workspace lookup
  gates every byte, so a token from workspace B cannot fetch workspace A's
  files even with a valid signature for another scope.

## Transport and triggers

- Baseline headers on every API response: `nosniff`, `no-referrer`,
  `DENY` framing, `frame-ancestors 'none'`; HSTS when production cookies
  are secure. CORS allowlist (dashboard origins only) with credentials.
  JSON bodies capped at 256 KB; media uses the raw streaming path.
- Triggers: schema-validated (moment/template consistency, effect-id shape,
  volume/trim/position/queue/priority/cooldown ranges), expired rejected
  (`400`), `triggerId`/`dedupKey` deduplicated per workspace (in-memory ring
  of 500 + history lookup), unknown effects and missing media rejected
  (`400`), never broadcast to other workspaces. History rows distinguish
  `accepted`/`duplicate`/`rejected`.
- Media delivery supports HTTP Range (`200`/`206`/`416`) on both dashboard
  and overlay endpoints; failed streams destroy the response instead of
  hanging; slow SSE readers are dropped past 64 KB lag (they reconnect and
  resync via `hello`).

## What is verified, and what is NOT

- Verified here: Postgres 17 constraint behavior (unique races, last-owner
  guard, dedup lookup) and the full hosted flow on real Postgres + real S3
  (`npm run test:integration`); SMTP delivery against a live socket server;
  CSRF accept/reject/exempt paths; rate-limit `429`s; session expiry and
  revocation; Range/416 behavior; revocation during playback; burst
  ordering across workspaces; the real-browser slice with reconnect, rotate,
  revoke, and reload.
- S3 provider path runs against `moto_server` locally and `minio/minio` in
  CI — both genuine S3-protocol services, not in-process mocks.
- NOT verified here: production Postgres operations at scale, S3 at scale,
  SSO/MFA, multi-instance rate-limit sharing (in-memory buckets need sticky
  sessions or Redis), physical OBS/webcam, Tauri packaging, long soak —
  gates stay open.
