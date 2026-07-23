-- V2領域テーブル。legacyのstatesには一切触れない（ALTERもしない）。
CREATE TABLE IF NOT EXISTS rooms (
  room_id   TEXT PRIMARY KEY NOT NULL,
  state_key TEXT NOT NULL UNIQUE,
  auth_hash TEXT NOT NULL,
  auth_kid  TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  upgraded_from_legacy INTEGER NOT NULL DEFAULT 0
);
