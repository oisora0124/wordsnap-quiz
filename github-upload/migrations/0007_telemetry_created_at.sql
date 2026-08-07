-- telemetry に保持期限（180日）を入れたので、その絞り込み用の索引を足す。
-- 索引が無いと DELETE ... WHERE created_at <= ? が全表走査になり、
-- **行が増えるほど遅くなる**＝掃除が必要になる場面でこそ重くなる。
-- states.updatedAt / feedback.created_at には既に同種の索引がある。
--
-- 追加型。既存の行は書き換えないので、本番へ再適用しても安全。
CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry (created_at);
