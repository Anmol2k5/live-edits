# SaaS operations (M7.1): Postgres, S3, and local services

## Production PostgreSQL

Migrations live in `server/migrations/` and run automatically when the
backend connects with `DATABASE_URL` set (`PostgresStore.connect` →
`migrate()`; every statement is `IF NOT EXISTS`, so re-runs are safe):

```sh
# Manual equivalent:
psql "$DATABASE_URL" -f server/migrations/001_init.sql
```

Required dependency: `pg` (+ `@types/pg` for development) — declared in
`package.json`. The backend refuses production startup without
`DATABASE_URL` (see `validateProductionConfig`).

Backup and restore (point-in-time via WAL archiving is the real answer;
minimum viable pair):

```sh
pg_dump --format=custom --file=saas-backup.dump "$DATABASE_URL"
pg_restore --clean --if-exists --dbname="$DATABASE_URL" saas-backup.dump
```

Media objects live outside the database: back up the S3 bucket alongside
(`aws s3 sync s3://BUCKET s3://BUCKET-backup` or provider snapshots).
Uploads are content-validated before `PutObject`, so a restored bucket is
self-consistent with `media` rows by `(workspace_id, name)`.

## Production S3-compatible storage

```sh
export LIVE_EDITS_S3_ENDPOINT=https://s3.example.com
export LIVE_EDITS_S3_REGION=us-east-1
export LIVE_EDITS_S3_BUCKET=live-edits-media
export LIVE_EDITS_S3_ACCESS_KEY=...
export LIVE_EDITS_S3_SECRET_KEY=...
export LIVE_EDITS_S3_FORCE_PATH_STYLE=1   # MinIO / moto style addressing
```

Without these, the backend uses private filesystem storage
(`LIVE_EDITS_STORAGE_DIR`). Partial S3 config (endpoint without keys)
fails startup instead of silently downgrading. Delivery is proxied through
the app with tenant checks, so provider credentials never reach clients and
revocation takes effect immediately.

## Local verification services (what this repo actually ran)

No Docker is required. From an admin-capable shell:

```powershell
# PostgreSQL 17 (binaries via Maven embedded-postgres jars, extracted once):
# initdb once, then start on 5433:
pg_ctl -D <data> -l pg.log -o "-p 5433" start
# S3 API (moto_server over pip):
pip install "moto[server]"
moto_server -H 127.0.0.1 -p 5001
```

Then:

```sh
npm run test:integration   # full server suite on real PG + real S3, then the restart/persistence flow
```

`server/run-integration.mjs` points at `127.0.0.1:5433` / `:5001` by
default (overridable with `SAAS_TEST_DSN` / `SAAS_TEST_S3_ENDPOINT`).
Each test gets an isolated database (`saas_t_*`, dropped afterwards) and an
isolated bucket. CI (`.github/workflows/saas.yml`) runs the same suite
against a `postgres:16` service and a pinned MinIO source build. The workflow starts MinIO explicitly and waits for its readiness endpoint; it does not pull the unavailable `minio/minio:latest` image.

## Production startup checklist

```sh
export NODE_ENV=production
export LIVE_EDITS_SESSION_SECRET='<32+ random chars>'
export LIVE_EDITS_COOKIE_SECURE=1        # HTTPS-only cookies (+ HSTS)
export DATABASE_URL='postgres://...'
export SMTP_HOST=... SMTP_USER=... SMTP_PASS=... SMTP_FROM=...
export APP_BASE_URL='https://app.example.com'
npm run saas
```

Missing any of these aborts startup with an explicit error. Serve the
dashboard same-origin behind HTTPS so the HttpOnly session cookie flows and
CSRF double-submit (`le_csrf` cookie + `X-CSRF-Token` header) applies; the
Tauri desktop companion uses the separate Bearer path instead.
