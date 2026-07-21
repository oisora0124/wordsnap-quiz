-- 0001 初期スキーマ: 現行の states テーブル。
-- 既存の本番DBにも安全に適用できる（IF NOT EXISTS。行の削除・書き換えをしない）。
-- 新しい空DBへこのマイグレーションだけを流すと、現行本番と同じ states になる。

CREATE TABLE IF NOT EXISTS states (
  key TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 0 CHECK (rev >= 0),
  updatedAt INTEGER NOT NULL DEFAULT 0 CHECK (updatedAt >= 0)
);

CREATE INDEX IF NOT EXISTS idx_states_updated_at ON states (updatedAt);
