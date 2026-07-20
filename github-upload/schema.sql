-- WordBank / Cloudflare D1 initial schema
-- Safe to apply to an existing database: no rows are deleted or rewritten.

CREATE TABLE IF NOT EXISTS states (
  key TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  updatedAt INTEGER NOT NULL DEFAULT 0 CHECK (updatedAt >= 0)
);

CREATE INDEX IF NOT EXISTS idx_states_updated_at ON states (updatedAt);
