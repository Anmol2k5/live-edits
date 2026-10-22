-- Live Edits SaaS foundation (Milestone 7).
-- Production target: PostgreSQL 15+. Tests/dev use the memory store
-- (server/src/store.ts) which mirrors these constraints; run this file
-- against a real Postgres with: psql "$DATABASE_URL" -f 001_init.sql
-- Requires pgcrypto for gen_random_uuid().

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  email_norm TEXT NOT NULL UNIQUE GENERATED ALWAYS AS (lower(email)) STORED,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_len CHECK (char_length(email) BETWEEN 3 AND 254),
  CONSTRAINT users_display_len CHECK (char_length(display_name) <= 80)
);
CREATE INDEX IF NOT EXISTS users_created_idx ON users (created_at);

CREATE TABLE IF NOT EXISTS password_resets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_user_idx ON password_resets (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_id UUID NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  active_pack_uid TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspaces_name_len CHECK (char_length(name) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS workspaces_owner_idx ON workspaces (owner_id);

CREATE TABLE IF NOT EXISTS memberships (
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id),
  CONSTRAINT memberships_role CHECK (role IN ('owner', 'admin', 'member'))
);
CREATE INDEX IF NOT EXISTS memberships_user_idx ON memberships (user_id);

-- Reaction packs: pack_uid is the client-visible pack id (compatible with
-- local pack JSON `id`). One row per (workspace, pack_uid); full validated
-- JSON lives in `data`, normalized children below carry constraints/indexes.
CREATE TABLE IF NOT EXISTS packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  pack_uid TEXT NOT NULL,
  name TEXT NOT NULL,
  version INT NOT NULL DEFAULT 1,
  data JSONB NOT NULL,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, pack_uid),
  CONSTRAINT packs_name_len CHECK (char_length(name) BETWEEN 1 AND 80),
  CONSTRAINT packs_version CHECK (version >= 1)
);
CREATE INDEX IF NOT EXISTS packs_workspace_idx ON packs (workspace_id);

CREATE TABLE IF NOT EXISTS effects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id UUID NOT NULL REFERENCES packs (id) ON DELETE CASCADE,
  effect_uid TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  moment TEXT NOT NULL,
  data JSONB NOT NULL,
  UNIQUE (pack_id, effect_uid)
);
CREATE INDEX IF NOT EXISTS effects_pack_idx ON effects (pack_id);

CREATE TABLE IF NOT EXISTS assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id UUID NOT NULL REFERENCES packs (id) ON DELETE CASCADE,
  assignment_uid TEXT NOT NULL,
  source TEXT NOT NULL,
  moment TEXT,
  effect_uid TEXT NOT NULL,
  UNIQUE (pack_id, assignment_uid)
);
CREATE INDEX IF NOT EXISTS assignments_pack_idx ON assignments (pack_id);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id UUID NOT NULL REFERENCES packs (id) ON DELETE CASCADE,
  step_uid TEXT NOT NULL,
  effect_uid TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  delay_ms INT NOT NULL DEFAULT 0,
  UNIQUE (pack_id, step_uid),
  CONSTRAINT sequence_delay CHECK (delay_ms BETWEEN 0 AND 30000)
);
CREATE INDEX IF NOT EXISTS sequence_pack_idx ON sequence_steps (pack_id);

CREATE TABLE IF NOT EXISTS media (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  bytes BIGINT NOT NULL,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT '',
  version INT NOT NULL DEFAULT 1,
  storage_key TEXT NOT NULL,
  uploaded_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name),
  CONSTRAINT media_bytes CHECK (bytes > 0 AND bytes <= 52428800),
  CONSTRAINT media_kind CHECK (kind IN ('video', 'audio', 'image'))
);
CREATE INDEX IF NOT EXISTS media_workspace_idx ON media (workspace_id);

CREATE TABLE IF NOT EXISTS overlay_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  view_token_hash TEXT NOT NULL UNIQUE,
  revoked_at TIMESTAMPTZ,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rotated_at TIMESTAMPTZ,
  CONSTRAINT overlay_name_len CHECK (char_length(name) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS overlay_workspace_idx ON overlay_sessions (workspace_id);

CREATE TABLE IF NOT EXISTS trigger_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  effect_uid TEXT,
  moment TEXT NOT NULL,
  template_id TEXT,
  dedup_key TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',
  delivered INT NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users (id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT trigger_status CHECK (status IN ('accepted', 'duplicate', 'rejected'))
);
CREATE INDEX IF NOT EXISTS trigger_history_ws_time_idx ON trigger_history (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS trigger_history_dedup_idx ON trigger_history (workspace_id, dedup_key);

CREATE TABLE IF NOT EXISTS audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces (id) ON DELETE CASCADE,
  actor_id UUID REFERENCES users (id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  meta JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_ws_time_idx ON audit_events (workspace_id, created_at DESC);
