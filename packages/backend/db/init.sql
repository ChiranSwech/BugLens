-- BugBuddy — PostgreSQL initialisation script
-- Run automatically by Docker on first container start.
-- Migrations (node-pg-migrate) handle subsequent schema changes.

-- ─── Extensions ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "pgcrypto"; -- gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- fuzzy text search on bug titles

-- ─── Enumerations ─────────────────────────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('viewer', 'reporter', 'qa-lead', 'admin');
CREATE TYPE session_status AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED');
CREATE TYPE bug_status AS ENUM (
  'OPEN', 'IN_PROGRESS', 'NEEDS_CLARIFICATION',
  'RESOLVED', 'WONT_FIX', 'DUPLICATE'
);
CREATE TYPE bug_severity AS ENUM ('P0', 'P1', 'P2', 'P3', 'P4');
CREATE TYPE step_action_type AS ENUM (
  'CLICK', 'INPUT', 'SCROLL', 'NAVIGATE', 'FOCUS', 'BLUR',
  'SCREENSHOT', 'ANNOTATION', 'PAUSE', 'RESUME',
  'NETWORK_FAILURE', 'CONSOLE_ERROR'
);
CREATE TYPE failure_type AS ENUM ('EXPECTED', 'UNEXPECTED', 'NONE');

-- ─── Organisations ────────────────────────────────────────────────────────────
CREATE TABLE orgs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL CHECK (length(name) BETWEEN 2 AND 255),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Users ────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  google_id     TEXT NOT NULL UNIQUE CHECK (length(google_id) > 0),
  email         TEXT NOT NULL UNIQUE CHECK (email ~* '^[^@]+@[^@]+\.[^@]+$'),
  name          TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 255),
  picture       TEXT CHECK (picture IS NULL OR length(picture) <= 2048),
  role          user_role NOT NULL DEFAULT 'reporter',
  org_id        UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

CREATE INDEX idx_users_org_id ON users(org_id);
CREATE INDEX idx_users_email ON users(email);

-- ─── Refresh Tokens ───────────────────────────────────────────────────────────
-- Tokens are stored as SHA-256 hashes — never the raw token
CREATE TABLE refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,  -- SHA-256(token) in hex
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,           -- NULL = still valid
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);
CREATE INDEX idx_refresh_tokens_hash ON refresh_tokens(token_hash);

-- ─── Sessions (recording sessions) ────────────────────────────────────────────
CREATE TABLE sessions (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status               session_status NOT NULL DEFAULT 'ACTIVE',
  device_fingerprint   JSONB NOT NULL,
  template_profile_id  UUID,          -- future: references template_profiles
  started_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at             TIMESTAMPTZ,
  -- Sessions auto-expire after 4 hours of inactivity
  expires_at           TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '4 hours'
);

CREATE INDEX idx_sessions_org_id ON sessions(org_id);
CREATE INDEX idx_sessions_user_id ON sessions(user_id);
CREATE INDEX idx_sessions_status ON sessions(status);

-- ─── Bugs ─────────────────────────────────────────────────────────────────────
CREATE TABLE bugs (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id                UUID NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
  org_id                    UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  reporter_id               UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assignee_id               UUID REFERENCES users(id) ON DELETE SET NULL,
  title                     TEXT NOT NULL CHECK (length(title) BETWEEN 5 AND 300),
  description               TEXT CHECK (description IS NULL OR length(description) <= 10000),
  severity                  bug_severity NOT NULL DEFAULT 'P2',
  status                    bug_status NOT NULL DEFAULT 'OPEN',
  reproduction_confidence   SMALLINT CHECK (reproduction_confidence BETWEEN 0 AND 100),
  network_logs              JSONB,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at                TIMESTAMPTZ  -- soft delete
);

CREATE INDEX idx_bugs_org_id ON bugs(org_id);
CREATE INDEX idx_bugs_reporter_id ON bugs(reporter_id);
CREATE INDEX idx_bugs_status ON bugs(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_bugs_severity ON bugs(severity) WHERE deleted_at IS NULL;
-- Full-text search
CREATE INDEX idx_bugs_title_trgm ON bugs USING gin(title gin_trgm_ops);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bugs_updated_at
  BEFORE UPDATE ON bugs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Steps ────────────────────────────────────────────────────────────────────
CREATE TABLE steps (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bug_id             UUID NOT NULL REFERENCES bugs(id) ON DELETE CASCADE,
  "order"            SMALLINT NOT NULL CHECK ("order" >= 0),
  action_type        step_action_type NOT NULL,
  element_label      TEXT NOT NULL CHECK (length(element_label) <= 500),
  css_selector       TEXT CHECK (css_selector IS NULL OR length(css_selector) <= 2000),
  x_path             TEXT CHECK (x_path IS NULL OR length(x_path) <= 2000),
  value_masked       TEXT CHECK (value_masked IS NULL OR length(value_masked) <= 1000),
  screenshot_id      UUID,
  "timestamp"        TIMESTAMPTZ NOT NULL,
  failure_type       failure_type NOT NULL DEFAULT 'NONE',
  edited_description TEXT CHECK (edited_description IS NULL OR length(edited_description) <= 1000),
  UNIQUE(bug_id, "order")
);

CREATE INDEX idx_steps_bug_id ON steps(bug_id);

-- ─── Attachments ──────────────────────────────────────────────────────────────
CREATE TABLE attachments (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  bug_id      UUID REFERENCES bugs(id) ON DELETE SET NULL,
  storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) <= 1024),
  phash       CHAR(16),          -- perceptual hash for dedup
  mime_type   TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  size_bytes  INT NOT NULL CHECK (size_bytes > 0),
  encrypted   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_attachments_session_id ON attachments(session_id);
CREATE INDEX idx_attachments_phash ON attachments(phash) WHERE phash IS NOT NULL;

-- ─── Audit Log (append-only) ──────────────────────────────────────────────────
CREATE TABLE audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id      UUID REFERENCES users(id) ON DELETE SET NULL,
  action        TEXT NOT NULL CHECK (length(action) <= 100),
  resource_type TEXT NOT NULL CHECK (length(resource_type) <= 50),
  resource_id   TEXT CHECK (resource_id IS NULL OR length(resource_id) <= 255),
  ip            INET,
  user_agent    TEXT CHECK (user_agent IS NULL OR length(user_agent) <= 500),
  metadata      JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_log_actor_id ON audit_log(actor_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX idx_audit_log_resource ON audit_log(resource_type, resource_id);

-- ─── Integration Configs ──────────────────────────────────────────────────────
CREATE TABLE integration_configs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL CHECK (type IN ('jira', 'slack', 'linear', 'azure_devops')),
  credentials_encrypted TEXT NOT NULL,   -- AES-256-GCM encrypted JSON blob
  enabled               BOOLEAN NOT NULL DEFAULT false,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(org_id, type)
);

CREATE TRIGGER integration_configs_updated_at
  BEFORE UPDATE ON integration_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ─── Security: revoke DELETE on audit_log from the app role ──────────────────
-- The application connects as 'bugbuddy' user.
-- This ensures audit entries can never be removed by application code.
-- (Run after granting standard privileges to bugbuddy)
-- REVOKE DELETE ON audit_log FROM bugbuddy;
-- REVOKE TRUNCATE ON audit_log FROM bugbuddy;
