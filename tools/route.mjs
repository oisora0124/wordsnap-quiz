#!/usr/bin/env node
// WordBank 開発オーケストレーションのルーター兼実績ログ。
//
// これは「利用者のブラウザで動く多モデルルーター」ではない。WordBank を開発・監査・
// バッチ処理するときに、タスクをモード A〜E のどれで回すかを決定論的に決め、実績を
// 追記して後で見直すための開発ツールである（ロードマップ Phase 5 の実体化）。
//
// 使い方:
//   node tools/route.mjs decide '<task json>'     経路を決めてログへ decision を追記、task_id を出力
//   node tools/route.mjs record <task_id> '<json>' 実績（pass/fail・retry・token 等）を追記
//   node tools/route.mjs stats [task_type]         集計（一発合格率・平均再実行・件数）
//   node tools/route.mjs show <task_id>            そのタスクの decision と outcome を表示
//   node tools/route.mjs help
//
// task json の項目（すべて任意。無い項目は安全側=より上位の経路へ倒す）:
//   { "task_type": "impl|review|generate|analyze|experiment|migrate|fix|chore",
//     "goal": "...",                     一行の目的
//     "risk": "low|medium|high",         失敗時の影響（学習履歴/同期/教材/秘密情報は high 寄り）
//     "testable": true|false,            自動検査で合否を機械判定できるか
//     "spec_known": true|false,          受入条件が明確か
//     "novel": true|false,               前例のない設計判断を含むか
//     "bulk": true|false,                大量の構造化処理か
//     "context": "small|medium|large",   必要なコード・履歴の範囲
//     "avoid_models": ["..."] }          使わないモデル（ユーザー指定を必ず優先）
//
// JSON は引数で渡すか、省略して stdin からも読める。

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(HERE, "../docs/orchestration/routing-log.jsonl");

// ---- モデルの役割。ユーザー方針: Codex系を主軸、Claudeは最小限。 ----
// worker=実作業、reviewer=差分レビュー/監査、orchestrator=難所の直接処理。
const ROLES = {
  worker_default: ["gpt-5.6-terra", "gpt-5.6-luna"], // 主力実装・整形・量産
  worker_hard: ["gpt-5.6-sol"], // 技術難所の実装
  reviewer: ["gpt-5.6-sol"], // 差分レビュー（別モデルで反証）
  orchestrator: ["gpt-5.6-sol"], // 直接処理する場合の旗艦
  bulk: ["gpt-5.6-luna"], // 高ボリューム・cost-sensitive
};

// 推奨トークン幅（上限ではなく運用レンジ）。憲法どおり長文常用を避ける。
const TOKEN_BUDGET = {
  A: { input: [4000, 40000], output: [1000, 8000] },
  B: { input: [1000, 20000], output: [500, 6000] },
  C: { input: [4000, 32000], output: [1000, 8000] },
  D: { input: [2000, 24000], output: [800, 6000] },
  E: { input: [0, 2000], output: [0, 500] },
};

const norm = (v, def = "") => (v == null ? def : String(v).trim().toLowerCase());
const withoutAvoided = (models, avoid) =>
  models.filter((m) => !avoid.some((a) => m.includes(a) || a.includes(m)));

// ---- 決定論的ルーティング。上から順に最初に当たった規則を採る。 ----
function decideMode(t) {
  const risk = norm(t.risk, "medium");
  const testable = t.testable === true;
  const specKnown = t.spec_known !== false; // 既定は「仕様あり」
  const novel = t.novel === true;
  const bulk = t.bulk === true;
  const type = norm(t.task_type, "impl");

  // E: 型・ルール・テスト・SQLで機械的に処理でき、新規設計判断を含まない
  if (testable && !novel && ["chore", "analyze", "migrate"].includes(type) && risk !== "high") {
    return { mode: "E", why: "自動検査で合否判定でき、新規設計判断を含まない機械的処理" };
  }
  // A/C: 前例のない設計・未確定仕様。比較価値が高ければ C（並列比較）、そうでなければ A
  if (novel || (!specKnown && risk === "high")) {
    if (type === "experiment" || type === "analyze") {
      return { mode: "C", why: "新規性が高く、独立案の比較がトークン増を上回る" };
    }
    return { mode: "A", why: "前例のない設計・未確定仕様を高位モデルが直接処理" };
  }
  // D: 高リスクだが受入条件が明確 → 作成者と差分レビュアーを分ける
  if (risk === "high" && specKnown) {
    return { mode: "D", why: "高リスクだが仕様は明確。作成者と差分レビュアーを分離" };
  }
  // B(+E): 低〜中リスクで委任可能。量産は bulk 経路
  if (bulk) {
    return { mode: "B", why: "大量の構造化処理。単一モデルへ委任し、検査はE（バッチ）" };
  }
  return { mode: "B", why: "低〜中リスクで受入条件あり。単一モデルへ委任" };
}

// 利用可能な全モデル（役割の優先順を含めた候補プール）。avoid で全滅したときの拾い先。
const ALL_MODELS = [...new Set([
  ...ROLES.orchestrator, ...ROLES.worker_hard, ...ROLES.worker_default, ...ROLES.bulk, ...ROLES.reviewer,
])];

function routeModels(mode, t) {
  const avoid = Array.isArray(t.avoid_models) ? t.avoid_models.map((m) => norm(m)) : [];
  const notes = [];
  // preferred から選ぶ。exclude（別役割と被らないため）は通常の絞り込みで警告なし。
  // avoid（ユーザー指定の不使用）で第一希望が全滅したときだけ代替へ拾い、警告を残す。
  const pickOr = (preferred, roleLabel, exclude = []) => {
    const afterExclude = preferred.filter((m) => !exclude.includes(m));
    const afterAvoid = withoutAvoided(afterExclude, avoid);
    if (afterAvoid.length) return afterAvoid;
    // 第一希望が avoid で消えた。候補プール全体から拾う。
    const fallback = withoutAvoided(ALL_MODELS, avoid).filter((m) => !exclude.includes(m));
    if (fallback.length && afterExclude.length) {
      notes.push(`${roleLabel}: 第一希望が avoid 指定で除外されたため代替モデルを充てた`);
      return fallback;
    }
    if (!fallback.length) notes.push(`${roleLabel}: 使えるモデルが無い（avoid指定が広すぎる）`);
    return fallback;
  };
  const bulk = t.bulk === true;
  let result;
  switch (mode) {
    case "A":
      result = { orchestrator: pickOr(ROLES.orchestrator, "orchestrator"), worker: [], reviewer: [] };
      // レビュアーはオーケストレーターと別モデルにする（自己レビューを避ける）
      result.reviewer = pickOr(ROLES.reviewer, "reviewer", result.orchestrator);
      break;
    case "C":
      result = { orchestrator: pickOr(ROLES.orchestrator, "orchestrator"), worker: pickOr([...ROLES.worker_hard, ...ROLES.worker_default], "worker"), reviewer: [] };
      result.reviewer = pickOr(ROLES.reviewer, "reviewer", result.worker);
      break;
    case "D": {
      // 作成者は主力(terra/luna)、差分レビュアーは最強(sol)。強い側が弱い側の成果を検証する。
      // 提案の「Terra→Sol」に合わせ、作成者とレビュアーは必ず別モデルにする。
      const worker = pickOr(ROLES.worker_default, "worker");
      result = { orchestrator: [], worker, reviewer: pickOr(ROLES.reviewer, "reviewer", worker) };
      break;
    }
    case "E":
      result = { orchestrator: [], worker: [], reviewer: [] }; // 人手/コードのみ、モデル不使用
      break;
    case "B":
    default:
      result = { orchestrator: [], worker: pickOr(bulk ? ROLES.bulk : ROLES.worker_default, "worker"), reviewer: [] };
      break;
  }
  result.notes = notes;
  return result;
}

function nowIso() {
  return new Date().toISOString();
}
function genId() {
  const stamp = nowIso().replace(/[-:TZ.]/g, "").slice(2, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `WB-${stamp}-${rand}`;
}

function appendLog(record) {
  mkdirSync(dirname(LOG_PATH), { recursive: true });
  appendFileSync(LOG_PATH, JSON.stringify(record) + "\n");
}
function readLog() {
  if (!existsSync(LOG_PATH)) return [];
  return readFileSync(LOG_PATH, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function readJsonArg(arg) {
  if (arg && arg.trim()) return JSON.parse(arg);
  const stdin = readFileSync(0, "utf8");
  return stdin.trim() ? JSON.parse(stdin) : {};
}

function cmdDecide(arg) {
  const t = readJsonArg(arg);
  const { mode, why } = decideMode(t);
  const models = routeModels(mode, t);
  const taskId = t.task_id || genId();
  const budget = TOKEN_BUDGET[mode];
  const record = {
    kind: "decision",
    task_id: taskId,
    ts: nowIso(),
    task_type: norm(t.task_type, "impl"),
    goal: t.goal || "",
    risk: norm(t.risk, "medium"),
    testable: t.testable === true,
    spec_known: t.spec_known !== false,
    novel: t.novel === true,
    bulk: t.bulk === true,
    context: norm(t.context, "medium"),
    mode,
    rationale: why,
    models,
    token_budget: budget,
    avoid_models: Array.isArray(t.avoid_models) ? t.avoid_models : [],
  };
  appendLog(record);
  console.log(`task_id: ${taskId}`);
  console.log(`mode:    ${mode}  — ${why}`);
  if (models.orchestrator.length) console.log(`orchestrator: ${models.orchestrator.join(", ")}`);
  if (models.worker.length) console.log(`worker:       ${models.worker.join(", ")}`);
  if (models.reviewer.length) console.log(`reviewer:     ${models.reviewer.join(", ")}`);
  if (mode === "E") console.log(`(モデル不使用: ルール/テスト/SQL/型で処理)`);
  for (const n of models.notes || []) console.log(`⚠ ${n}`);
  console.log(`token幅: 入力 ${budget.input[0]}–${budget.input[1]} / 出力 ${budget.output[0]}–${budget.output[1]}`);
  console.log(`記録:    ${LOG_PATH}  → node tools/route.mjs record ${taskId} '{...}'`);
}

function cmdRecord(taskId, arg) {
  if (!taskId) throw new Error("task_id が必要: node tools/route.mjs record <task_id> '<json>'");
  const o = readJsonArg(arg);
  const record = {
    kind: "outcome",
    task_id: taskId,
    ts: nowIso(),
    chosen_model: o.chosen_model || "",
    input_tokens: Number(o.input_tokens) || null,
    output_tokens: Number(o.output_tokens) || null,
    retries: Number(o.retries) || 0,
    handoffs: Number(o.handoffs) || 0,
    pass_fail: norm(o.pass_fail) || "unknown", // pass | fail | partial
    human_edit_distance: o.human_edit_distance == null ? null : Number(o.human_edit_distance),
    downstream_bug: o.downstream_bug === true,
    notes: o.notes || "",
  };
  appendLog(record);
  console.log(`recorded outcome for ${taskId}: ${record.pass_fail} (retries ${record.retries})`);
}

function cmdStats(filterType) {
  const log = readLog();
  const decisions = new Map();
  for (const r of log) if (r.kind === "decision") decisions.set(r.task_id, r);
  const rows = new Map(); // key = task_type|mode
  for (const r of log) {
    if (r.kind !== "outcome") continue;
    const d = decisions.get(r.task_id);
    if (!d) continue;
    if (filterType && d.task_type !== norm(filterType)) continue;
    const key = `${d.task_type}|${d.mode}`;
    const row = rows.get(key) || { type: d.task_type, mode: d.mode, n: 0, pass: 0, retries: 0, bugs: 0 };
    row.n += 1;
    if (r.pass_fail === "pass") row.pass += 1;
    row.retries += r.retries || 0;
    if (r.downstream_bug) row.bugs += 1;
    rows.set(key, row);
  }
  if (!rows.size) {
    console.log("まだ集計できる outcome がない（record で実績を追記すると集計される）。");
    console.log(`decisions のみ: ${[...decisions.values()].length} 件`);
    return;
  }
  console.log("task_type | mode | 件数 | 一発合格率 | 平均再実行 | 後工程バグ");
  console.log("----------|------|------|-----------|-----------|----------");
  for (const row of [...rows.values()].sort((a, b) => b.n - a.n)) {
    const passRate = row.n ? Math.round((row.pass / row.n) * 100) : 0;
    const avgRetry = row.n ? (row.retries / row.n).toFixed(1) : "0";
    console.log(
      `${row.type.padEnd(9)} | ${row.mode.padEnd(4)} | ${String(row.n).padStart(4)} | ${String(passRate + "%").padStart(9)} | ${String(avgRetry).padStart(9)} | ${String(row.bugs).padStart(8)}`,
    );
  }
  console.log("\n目安: 同じ task_type で 30 件以上たまったら、一発合格率が高くトークンの小さい経路へ寄せる。");
}

function cmdShow(taskId) {
  const log = readLog().filter((r) => r.task_id === taskId);
  if (!log.length) return console.log(`${taskId} の記録はない。`);
  for (const r of log) console.log(JSON.stringify(r, null, 2));
}

const HELP = `WordBank 開発オーケストレーションのルーター兼実績ログ

  node tools/route.mjs decide '<task json>'      経路(A〜E)を決めてログに記録し task_id を出力
  node tools/route.mjs record <task_id> '<json>' 実績(pass_fail/retries/tokens 等)を追記
  node tools/route.mjs stats [task_type]         一発合格率・平均再実行・後工程バグを集計
  node tools/route.mjs show <task_id>            そのタスクの decision/outcome を表示

task json 例:
  { "task_type":"impl", "goal":"CSVをsense形式へ変換", "risk":"medium",
    "testable":true, "spec_known":true, "novel":false, "bulk":false, "context":"medium" }

モード: A=高位直接 / B=単一委任 / C=並列比較 / D=作成者+レビュアー分離 / E=ルール・テストのみ
方針は docs/orchestration/ を参照。`;

function main() {
  const [cmd, a, b] = process.argv.slice(2);
  try {
    switch (cmd) {
      case "decide":
        return cmdDecide(a);
      case "record":
        return cmdRecord(a, b);
      case "stats":
        return cmdStats(a);
      case "show":
        return cmdShow(a);
      case "help":
      case "--help":
      case "-h":
      case undefined:
        return console.log(HELP);
      default:
        console.error(`unknown command: ${cmd}\n`);
        console.log(HELP);
        process.exit(2);
    }
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
}

main();
