# Codebase review and fixes

Reviewed on 2026-10-22. This review covers the fixes prepared on
`fix/minio-ci`, based on the PR branch `feature/obs-reaction-mvp`.

## Scope

Reviewed the React application, camera/detector lifecycle, editor and pack
persistence, local relay and OBS player, hosted API, authentication, SMTP,
PostgreSQL and S3 storage, tests, workflows, and setup documentation.
Independent reviews checked backend security, editor behavior, playback,
and the final authentication/storage changes.

## Confirmed defects corrected

| Area | Correction |
| --- | --- |
| CI services | Replaced the unavailable `minio/minio:latest` image with an immutable MinIO source revision, explicit server startup, a bounded readiness check, logs, and cleanup. |
| Integration credentials | Real-service tests use the configured S3 credentials both before and after backend restart. |
| Browser CI | Tests use the Chromium installed by CI; `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` supports an existing browser without requiring Google Chrome. |
| Signed media | HMAC verification uses `node:crypto`'s timing-safe comparison; valid signed URLs now work while invalid signatures remain rejected. |
| Recovery links | Production requires a validated `APP_BASE_URL`. Recovery emails no longer trust the request's Host header. |
| Password reset | Token consumption, password replacement, and session revocation are atomic. Concurrent confirmation accepts exactly one request. |
| Workspace ownership | The final owner cannot be demoted or removed. PostgreSQL serializes concurrent membership changes on the workspace row. |
| Denied workspaces | A nonexistent workspace returns 404 without inserting an invalid audit foreign key. |
| SMTP | STARTTLS commands use the upgraded TLS socket. Tests verify delivery with a trusted certificate and rejection before credentials with an untrusted certificate. |
| Media quotas | Workspace uploads, replacements, and deletions use a shared lock and current usage, preventing concurrent requests from exceeding quota. PostgreSQL uses one transaction-scoped connection. |
| S3 creates | Same-name uploads acquire their guard before awaiting metadata; conditional creation prevents independent clients from overwriting the winner. Unexpected metadata errors fail closed. |
| Cloud sessions | Cookie sessions restore after reload without storing a web bearer token. Local backend defaults stay on the browser's cookie site; desktop detection uses the Tauri API. |
| Cloud request races | Backend changes clear local session state; stale login, registration, logout, and inventory responses cannot restore a previous backend's state or send its bearer token to the new backend. Deleted saved workspaces no longer prevent loading accessible workspaces. |
| Editor history | Undo/redo updates history atomically, preserving correct behavior under React StrictMode. |
| Pack switching | Save-and-switch saves then switches; discard switches without saving. |
| Sequence preview | Pause/resume preserves admission and media position; replay resets the clock. Seeking and late timer ticks use the cue's actual offset. Consecutive cues using one file restart correctly. |
| Preview cleanup | Teardown pauses the previous media element rather than its replacement. Imported Files remain available across editor tab remounts. |
| OBS playback | Local and hosted players preserve mute/volume, apply trims after metadata, support end-only trims, stop media at the clip boundary, and cancel pending startup after removal. Hosted coexist layers retain artwork and audio fallback. |
| Relay identifiers | Safe custom pack effect IDs are accepted consistently with the hosted path. |
| Detector and persistence | Active detector configuration changes restart polling with the new settings. Disabled browser storage no longer crashes initial library loading. Camera refs clear when leaving Live; session media is released when the app unmounts. |
| Pack imports | Collision allocation reserves incoming IDs as well as existing ones, preserving assignment and sequence references. |
| Dependencies | Updated Vite to 7.3.7 and Vitest to 4.1.12, including their lockfile entries, to address the reported development-tool advisories. |

Behavioral regressions were reproduced before the corresponding fixes.
Documentation now reflects the implemented hosted backend and CI workflow.

## Validation

Final verification used a clean `npm ci`, Node 24.19.0, system Chromium,
PostgreSQL 16, and a local `moto_server` S3-compatible service.

| Check | Result |
| --- | --- |
| `npm test` | 292 passed; 2 opt-in real-service tests skipped in this command. |
| `npm run test:integration` | 55 passed against real PostgreSQL and S3-compatible HTTP storage, including the opt-in restart/persistence flow. |
| `npm run test:relay` | 19 passed. |
| `npm run test:e2e` | 16 passed across playback and default autoplay policy projects, including web cookie restoration. |
| `npm run typecheck` | Passed. |
| `npm run build` | Passed; bundle-size and dependency annotation warnings remain. |
| `npm audit` | 0 vulnerabilities reported. |
| Workflow YAML, shell syntax, `git diff --check` | Passed. |

For browser tests with the system browser:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e
```

## Limits of this verification

- The MinIO source-build workflow has not run on GitHub Actions. Local source
  compilation was blocked by this environment's network policy for large Go
  dependency archives at `storage.googleapis.com`; the integration suite was
  verified with the documented S3-compatible alternative. No verification was
  disabled to work around the restriction.
- Native Tauri packaging, physical webcam inference, actual OBS audio output,
  Windows desktop behavior, and long production-scale operation remain
  manual or platform-specific checks. Automated playback does not establish
  audible output.
- This review fixes demonstrated defects; it is not a claim that every
  possible defect or deployment condition has been exhaustively tested.
