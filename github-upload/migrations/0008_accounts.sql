-- 0008 パスキーによる復旧（docs/DESIGN-2026-10-21-account-recovery.md §4.1）。
-- 追加型。既存テーブル（states / rooms / state_revisions 等）には一切触れない。
CREATE TABLE IF NOT EXISTS accounts (
  account_id   TEXT PRIMARY KEY NOT NULL,  -- 'wa_' + 32hex。サーバー生成
  user_handle  TEXT NOT NULL UNIQUE,       -- WebAuthn user.id（32byte 乱数の base64url）
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY NOT NULL,  -- base64url
  account_id    TEXT NOT NULL,              -- FK は張らない（D1 の既存流儀）
  public_key    TEXT NOT NULL,              -- COSE 公開鍵（base64url）
  alg           INTEGER NOT NULL,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  backup_eligible INTEGER NOT NULL DEFAULT 0, -- 登録時の BE フラグ。以後の認証で一致を検査
  backed_up     INTEGER NOT NULL DEFAULT 0, -- 最後に見た BS フラグ
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_passkeys_account ON passkeys (account_id);
CREATE TABLE IF NOT EXISTS account_rooms (
  account_id  TEXT NOT NULL,
  room_id     TEXT NOT NULL UNIQUE,         -- 1 つの部屋は 1 つのアカウントにだけ結びつく（§8）
  secret_env  TEXT NOT NULL,                -- AES-GCM(wk_)。AAD = account_id||room_id
  env_kid     TEXT NOT NULL,
  linked_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, room_id)
);
CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge   TEXT PRIMARY KEY NOT NULL,    -- 32byte 乱数 base64url
  purpose     TEXT NOT NULL,                -- 'register' | 'login' | 'add-passkey'
  account_id  TEXT,
  user_handle TEXT,
  created_at  INTEGER NOT NULL
);
-- 掃除を全表走査にしない（0007 の教訓）
CREATE INDEX IF NOT EXISTS idx_auth_challenges_created ON auth_challenges (created_at);
