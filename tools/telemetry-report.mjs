#!/usr/bin/env node
// WordBank テレメトリの定期レビュー用レポート生成（ロードマップ 2026-07 の C）。
//
// docs/telemetry.md の閲覧SQLを 1 回で流し、Markdown のレポートと生の JSON を書き出す。
// 利用者のブラウザで動くものではない。開発者が Cloudflare の権限で D1 を読むための道具。
//
// 使い方:
//   node tools/telemetry-report.mjs --out <dir> [--since 2026-07-26] [--days 30]
//       wrangler（npx wrangler d1 execute wordbank --remote --json）で本番 D1 を読む。
//       CLOUDFLARE_API_TOKEN（D1 読み取り）と CLOUDFLARE_ACCOUNT_ID、または wrangler login が要る。
//   node tools/telemetry-report.mjs --out <dir> --sqlite <file.sqlite>
//       手元の SQLite（migrations 適用済み）に対して同じ SQL を流す（SQL の検証・エクスポートの再集計用）。
//   node tools/telemetry-report.mjs --print-sql
//       SQL だけを表示する（手で wrangler に貼るとき）。
//
// 読むのは telemetry テーブルだけ。rate_limits（IP を含む）には触れない（docs/telemetry.md「匿名性の設計」）。

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGES_DIR = resolve(HERE, "../github-upload");
const D1_NAME = "wordbank";

// ---- 引数 ----
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const has = (name) => args.includes(name);
const SINCE = opt("--since", "2026-07-26"); // 計測の起点（ROADMAP-2026-07.md C）
const DAYS = Number(opt("--days", "30"));
const OUT = opt("--out", null);
const SQLITE = opt("--sqlite", null);

if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE) || !Number.isInteger(DAYS) || DAYS <= 0) {
  console.error("--since は YYYY-MM-DD、--days は正の整数");
  process.exit(2);
}
const sinceMs = Date.parse(`${SINCE}T00:00:00Z`);
const recentMs = Date.now() - DAYS * 86400000;

// ---- SQL（docs/telemetry.md の例＋導線の観測。created_at はミリ秒）----
// 文字列連結は数値（ms）だけ。利用者由来の値は埋め込まない。
const QUERIES = [
  {
    key: "coverage",
    title: "データの範囲（行数・最古・最新）",
    sql: `SELECT COUNT(*) AS rows_total, SUM(count) AS events_total,
                 datetime(MIN(created_at) / 1000, 'unixepoch') AS oldest,
                 datetime(MAX(created_at) / 1000, 'unixepoch') AS newest
          FROM telemetry`,
  },
  {
    key: "app_rev",
    title: `版の分布（${SINCE} 以降・行数）`,
    sql: `SELECT app_rev, COUNT(*) AS rows_, SUM(count) AS events,
                 MAX(datetime(created_at / 1000, 'unixepoch')) AS last_seen
          FROM telemetry WHERE created_at > ${sinceMs}
          GROUP BY app_rev ORDER BY MAX(created_at) DESC`,
  },
  {
    key: "usage_total",
    title: `利用回数の多い機能（${SINCE} 以降）`,
    sql: `SELECT name, SUM(count) AS total, COUNT(*) AS reports,
                 MIN(date(created_at / 1000, 'unixepoch')) AS first_day,
                 MAX(date(created_at / 1000, 'unixepoch')) AS last_day
          FROM telemetry WHERE kind = 'usage' AND created_at > ${sinceMs}
          GROUP BY name ORDER BY total DESC`,
  },
  {
    key: "usage_recent",
    title: `利用回数の多い機能（直近 ${DAYS} 日）`,
    sql: `SELECT name, SUM(count) AS total, COUNT(*) AS reports
          FROM telemetry WHERE kind = 'usage' AND created_at > ${recentMs}
          GROUP BY name ORDER BY total DESC`,
  },
  {
    key: "usage_weekly",
    title: `利用回数の週別推移（${SINCE} 以降・月曜始まり）`,
    sql: `SELECT date(created_at / 1000, 'unixepoch', '-6 days', 'weekday 1') AS week_start,
                 name, SUM(count) AS total
          FROM telemetry WHERE kind = 'usage' AND created_at > ${sinceMs}
          GROUP BY week_start, name ORDER BY week_start DESC, total DESC`,
  },
  {
    key: "active_days",
    title: `送信のあった日数（${SINCE} 以降。利用回数は原則 1 日 1 回まとめて送られる）`,
    sql: `SELECT COUNT(DISTINCT date(created_at / 1000, 'unixepoch')) AS days_with_usage,
                 COUNT(*) AS usage_reports
          FROM telemetry WHERE kind = 'usage' AND created_at > ${sinceMs}`,
  },
  {
    key: "funnel_recovery",
    title: `復元・引き継ぎの導線（${SINCE} 以降）`,
    sql: `SELECT name, SUM(count) AS total, MAX(date(created_at / 1000, 'unixepoch')) AS last_day
          FROM telemetry WHERE kind = 'usage' AND created_at > ${sinceMs}
            AND (name LIKE 'recovery-prompt-%' OR name LIKE 'account-%'
                 OR name LIKE 'sync-v2-%' OR name LIKE 'v2-announce-%' OR name LIKE 'ai-key-sync-%')
          GROUP BY name ORDER BY name`,
  },
  {
    key: "errors_by_name",
    title: `エラー種別ごとの件数（${SINCE} 以降）`,
    sql: `SELECT name, SUM(count) AS total, COUNT(*) AS reports,
                 MIN(datetime(created_at / 1000, 'unixepoch')) AS first_seen,
                 MAX(datetime(created_at / 1000, 'unixepoch')) AS last_seen,
                 GROUP_CONCAT(DISTINCT app_rev) AS app_revs
          FROM telemetry WHERE kind = 'error' AND created_at > ${sinceMs}
          GROUP BY name ORDER BY total DESC`,
  },
  {
    key: "errors_daily",
    title: `エラーの日別推移（直近 ${DAYS} 日）`,
    sql: `SELECT date(created_at / 1000, 'unixepoch') AS day, SUM(count) AS errors, COUNT(DISTINCT name) AS kinds
          FROM telemetry WHERE kind = 'error' AND created_at > ${recentMs}
          GROUP BY day ORDER BY day DESC`,
  },
  {
    key: "errors_recent",
    title: "直近のエラー（最新 100 件・detail 付き）",
    sql: `SELECT datetime(created_at / 1000, 'unixepoch') AS occurred_at, name, detail, app_rev, count
          FROM telemetry WHERE kind = 'error' ORDER BY created_at DESC LIMIT 100`,
  },
];

if (has("--print-sql")) {
  for (const q of QUERIES) console.log(`-- ${q.title}\n${q.sql.replace(/\s+/g, " ").trim()};\n`);
  process.exit(0);
}
if (!OUT) {
  console.error("--out <dir> が要る（--print-sql なら不要）");
  process.exit(2);
}

// ---- 実行 ----
function runRemote(sql) {
  const out = execFileSync(
    "npx",
    ["--yes", "wrangler", "d1", "execute", D1_NAME, "--remote", "--json", "--command", sql.replace(/\s+/g, " ").trim()],
    { cwd: PAGES_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 },
  );
  // wrangler --json は [{ results, success, meta }] を返す。前後にログが混ざることがあるので最初の '[' から読む。
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!first || first.success === false) throw new Error(`wrangler の応答が success ではない: ${out.slice(0, 400)}`);
  return first.results ?? [];
}

let localDb = null;
async function runLocal(sql) {
  if (!localDb) {
    const { DatabaseSync } = await import("node:sqlite");
    localDb = new DatabaseSync(SQLITE, { readOnly: true });
  }
  return localDb.prepare(sql).all().map((r) => ({ ...r }));
}

const toCell = (v) => (v == null ? "" : String(v).replace(/\|/g, "\\|").replace(/\r?\n/g, " "));
function table(rows) {
  if (!rows.length) return "_（行なし）_\n";
  const cols = Object.keys(rows[0]);
  const head = `| ${cols.join(" | ")} |\n| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => toCell(r[c])).join(" | ")} |`).join("\n");
  return `${head}\n${body}\n`;
}

const results = {};
const errors = {};
for (const q of QUERIES) {
  try {
    results[q.key] = SQLITE ? await runLocal(q.sql) : runRemote(q.sql);
  } catch (e) {
    errors[q.key] = String(e?.message || e).split("\n")[0];
    results[q.key] = [];
  }
}

const today = new Date().toISOString().slice(0, 10);
mkdirSync(OUT, { recursive: true });
const md = [
  `# WordBank テレメトリ レポート ${today}`,
  "",
  `- 対象: ${SQLITE ? `ローカル SQLite ${SQLITE}` : `本番 D1 \`${D1_NAME}\`（--remote）`}`,
  `- 計測の起点: ${SINCE} / 直近: ${DAYS} 日`,
  "- 読んだのは `telemetry` テーブルだけ（IP を含む `rate_limits` には触れていない）",
  "- 読み方と判断の枷は `docs/TELEMETRY-REVIEW-2026-11.md`",
  "",
  ...QUERIES.flatMap((q) => [
    `## ${q.title}`,
    "",
    errors[q.key] ? `**取得失敗**: ${errors[q.key]}\n` : table(results[q.key]),
  ]),
].join("\n");

writeFileSync(resolve(OUT, `telemetry-report-${today}.md`), md);
writeFileSync(resolve(OUT, `telemetry-report-${today}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), since: SINCE, days: DAYS, results, errors }, null, 2));
console.log(`書き出し: ${resolve(OUT, `telemetry-report-${today}.md`)}`);
if (Object.keys(errors).length) {
  console.error(`取得に失敗した問い合わせ: ${Object.keys(errors).join(", ")}`);
  process.exit(1);
}
