-- 0003 ユーザーからの要望・フィードバックを保管するテーブル（追加型）。
-- 開発者だけが読める運用にするため、APIは「書き込み専用」(POST のみ)。
-- 読み取り用の公開エンドポイントは作らず、閲覧は Cloudflare D1 ダッシュボードの
-- SQL（＝Cloudflareアカウント所有者だけが実行できる）で行う。
--
-- 追加型: 既存の states / state_revisions には一切触れない。このマイグレーション
--         未適用のまま feedback API をデプロイしても、通常の同期は従来どおり動く
--         （feedback API はテーブル不在なら 503 を返すだけで、他機能に影響しない）。
--
-- 保存しないもの（プライバシー方針）:
--   - 同期キー（?w= の値。実質的にデータのパスワード）
--   - IPアドレス
-- 保存するもの:
--   - category   要望 / 不具合 / その他
--   - message    本文（サーバー側で最大2000文字に制限）
--   - contact    任意の連絡先（空可・最大200文字）
--   - app_version クライアントのビルド識別（デバッグ用・任意）
--   - user_agent ブラウザ種別（デバッグ用・最大300文字に切り詰め）

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL DEFAULT 0 CHECK (created_at >= 0),
  category TEXT NOT NULL DEFAULT 'other',
  message TEXT NOT NULL,
  contact TEXT NOT NULL DEFAULT '',
  app_version TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);

-- 新しい順に読み出すための索引（ダッシュボードで最近の投稿から見るため）。
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback (created_at DESC);
