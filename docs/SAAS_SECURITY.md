# SaaS security (M7 foundation)

## Authentication

- Passwords: `scrypt` (N=16384, r=8, p=1, 64-byte derived key, 16-byte salt),
  verified with `timingSafeEqual`. Minimum length 10, maximum 200.
- Sessions: opaque 64-hex-char tokens, stored as SHA-256, 7-day TTL
  (`LIVE_EDITS_SESSION_TTL_MS` override for tests), revoked on logout,
  password change, and recovery confirm. Transported as `Authorization:
  Bearer` (dashboard `localStorage`) and an `HttpOnly; SameSite=Lax` cookie
  (`le_session`). Production must serve HTTPS and set
  `LIVE_EDITS_COOKIE_SECURE=1`.
- Recovery: 1-hour single-use reset tokens (SHA-256 stored). The plaintext
  is returned in the request response only when `NODE_ENV !== "production"`
  (tests/dev); production must deliver it out of band (email) — the code path
  is marked and the response omits it there.
- Auth endpoints are rate-limited (20/min/IP) to slow credential stuffing.
  Register/login failures return generic `401`/`409` without distinguishing
  unknown users on recovery request (always `200 ok`).

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

- CORS allowlist (dashboard origins only), `Vary: Origin`, credentials
  supported. JSON bodies capped at 256 KB; media uses the raw streaming path.
- Triggers: schema-validated (moment/template consistency, effect-id shape,
  volume/trim/position/queue/priority/cooldown ranges), expired rejected
  (`400`), `triggerId`/`dedupKey` deduplicated per workspace (in-memory ring
  of 500 + history lookup), unknown effects and missing media rejected
  (`400`), never broadcast to other workspaces. History rows distinguish
  `accepted`/`duplicate`/`rejected`.

## What is NOT yet done

- No SSO/OAuth, no MFA, no device management; scrypt parameters are a
  starting point (Argon2id recommended before production scale).
- No per-IP throttling beyond auth endpoints, no WAF, no backup/restore
  runbook for Postgres beyond the migration file.
- S3 provider path is configured but exercised only as config validation in
  tests; byte-level S3 integration needs provider credentials and is NOT
  claimed verified (filesystem backend is what tests prove).
- Physical OBS, Tauri packaging, webcam, and soak gates remain open.
