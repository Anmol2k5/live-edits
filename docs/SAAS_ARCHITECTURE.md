# SaaS architecture (M7 foundation)

Target: a hosted multi-user streamer SaaS built next to — not instead of —
the local Tauri desktop app, loopback OBS relay, reaction packs, visual
editor, and playback engine. All of those keep working with no backend.

## Layout

| Path | What |
|---|---|
| `server/src/app.ts` | HTTP API + hosted overlay surface (`createSaasApp`) |
| `server/src/store.ts` | `Store` interface, `MemoryStore` (tests/dev), `PostgresStore` (production via `DATABASE_URL` + `pg`) |
| `server/migrations/001_init.sql` | Postgres DDL: users, resets, sessions, workspaces, memberships, packs (+ normalized children), media, overlay sessions, trigger history, audit |
| `server/src/storage.ts` | Private media storage: `FilesystemStorage` (tests/dev) + `S3Storage` (production providers like MinIO) behind one `MediaStorage` contract; identical validation (allowlist, 50 MB, magic-byte sniff, atomic publish, 409s, quotas) on both |
| `server/src/email.ts` | Recovery mail: `EmailProvider` interface, real `SmtpEmailProvider` (raw sockets, STARTTLS, AUTH), `LoggingEmailProvider` (dev), `InMemoryEmailProvider` (tests). Tokens travel by email only, never in API responses |
| `server/src/packs.ts` | Versioned pack validation (`PACK_VERSION = 1`), integrity checks, collision-safe import — byte-compatible with local `serializePack` JSON |
| `server/src/overlays.ts` | Overlay sessions, SSE hub (workspace-isolated), trigger validation, hosted overlay page reusing the shared scheduler |
| `server/src/index.ts` | CLI: `npm run saas` (env: `LIVE_EDITS_SAAS_PORT/HOST`, `DATABASE_URL`, `LIVE_EDITS_STORAGE_DIR`, `LIVE_EDITS_SESSION_SECRET`, `LIVE_EDITS_CORS_ORIGINS`) |
| `src/saas/api.ts` | Typed dashboard client (Bearer token in `localStorage`, base URL configurable) |
| `src/saas/CloudPanel.tsx` | Dashboard: account, workspaces, cloud packs, cloud media, hosted overlays, fire |
| `src/App.tsx` | Third `Cloud` view; `Live`/`Editor` + loopback relay untouched |

## Request flow

Browser dashboard (`vite dev :1420`, CORS-allowlisted) → SaaS backend
(`:4290` default). Web sessions use the `HttpOnly` cookie plus CSRF
double-submit (`le_csrf` cookie + `X-CSRF-Token` header); the desktop
companion uses Bearer tokens instead (no ambient credentials, CSRF-exempt).
`POST /api/...` with either credential; overlay/media delivery uses
per-session view tokens or HMAC-signed URLs. Postgres when `DATABASE_URL`
is set (migrations auto-run), memory store otherwise; filesystem media dir
or the configured S3 provider (`createStorageFromEnv`).

OBS Browser Source → `GET /o/:overlayId?token=<viewToken>` (transparent page)
→ `GET /o/:overlayId/events?token=` (SSE) + `GET /o/:overlayId/media/:name?token=`
(same-workspace files only). View tokens are random 48-hex strings stored as
SHA-256; the plaintext is shown once at create/rotate.

Triggers: dashboard/editor `POST /api/workspaces/:id/trigger` (membership
checked, effect resolved through the workspace active pack with V1 fallback —
assigned effects supply the full playback config, caller fields override,
media existence checked, expiry/dedup enforced, 120/min per workspace+IP)
→ persisted to history+audit → broadcast to that workspace's connected
overlays only (slow SSE readers are dropped past 64 KB lag and reconnect).

## Data model

Users → sessions (7-day TTL, revocable) + password resets (1h, single-use).
Workspaces → memberships (`owner`/`admin`/`member`). Packs carry
`pack_uid` (== local pack `id`) with full validated JSON in `data` plus
normalized `effects`/`assignments`/`sequence_steps` rows for constraints and
indexes. Media rows point at `storage_key`s under `<storage>/<workspace>/`.
Overlay rows hold `view_token_hash` + `revoked_at`. Trigger history and
audit events are append-only per workspace.

## Verification

- `npm run test` — full suite with the memory store + filesystem storage.
- `npm run test:integration` — the same server suite plus the
  restart/persistence flow against **real PostgreSQL + real S3**
  (`server/run-integration.mjs`; local: Postgres :5433, S3 :5001;
  CI: `postgres:16` + `minio/minio` via `.github/workflows/saas.yml`).
  Each test gets an isolated database and bucket.
- `npm run test:e2e` — includes `saas.spec.ts` (real backend, real
  Chromium: register → workspace → pack → upload → configure → overlay →
  trigger plays on the correct overlay → rival isolated → reconnect →
  rotate → revoke → reload keeps packs).
- Operations (migrations, backup/restore, production checklist):
  `docs/SAAS_OPERATIONS.md`.

## Tenancy rule

Every `/api/workspaces/:id/...` route loads the workspace, then requires a
membership row for the caller. Missing workspace and non-member both return
`404` (no id enumeration). Roles: `owner` manages members; `admin` manages
packs/media/overlays; `member` triggers and reads. All mutations append an
audit event.

## Local vs hosted

- Local mode is the default: no backend needed, loopback relay on `:4190`,
  packs in `localStorage`, media in-session. Nothing phones home.
- Cloud mode is opt-in per view: paste the backend URL, register/sign in,
  create a workspace. Cloud packs round-trip through the visual editor via
  `Load into editor` (collision-safe local import) and per-pack
  `Save to cloud`. Cloud media uploads stream with `X-Filename` + raw body,
  validated exactly like the relay (allowlist, 50 MB, magic-byte sniffing,
  atomic rename, 409 on duplicates).
- The local Node relay is never exposed publicly: it still binds loopback
  only. Hosted delivery is a separate SSE implementation with per-workspace
  isolation; the overlay player reuses the same scheduler core and
  queue/coexist/expiry/dedup semantics.
