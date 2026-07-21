-- 0002 復元用の履歴テーブル（追加型・影運用）。
-- 上書きされる直前の状態を保存し、誤削除・破損から過去版へ戻せるようにする（仕様書 §5）。
-- 追加型: 既存 states には一切触れない。このマイグレーション未適用のままAPIをデプロイしても
--         同期は従来どおり動く（APIは履歴書き込みを best-effort とし、テーブル不在なら黙ってスキップ）。
--
-- key      = states.key（同期領域の識別子）
-- rev      = 保存した状態のリビジョン番号（＝上書きされる直前の states.rev）
-- state    = 現行と同じ gzip+base64 マーカー形式、またはプレーンJSON
-- created_at = 保存時刻(ms)
-- reason   = 保存理由（'pre-update' / 'pre-force' / 'pre-restore' 等）

CREATE TABLE IF NOT EXISTS state_revisions (
  key TEXT NOT NULL,
  rev INTEGER NOT NULL CHECK (rev >= 0),
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0),
  reason TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (key, rev)
);

-- 保持制約（直近N世代＋日次）を効率よく掃除するため、領域ごとの新しい順で引ける索引。
CREATE INDEX IF NOT EXISTS idx_state_revisions_key_created
  ON state_revisions (key, created_at DESC);
