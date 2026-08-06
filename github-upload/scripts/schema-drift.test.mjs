// Cloudflare Functions が使うSQLと、migrations/ のスキーマがずれていないか検査する。
//
// ここがずれると **本番の実行時エラーとしてしか現れない**。
// D1 はデプロイ時にSQLを検証しないので、存在しないテーブルや列を参照していても
// push は通り、その API が呼ばれた瞬間に初めて失敗する。
// 同期が落ちれば利用者のデータは端末に取り残され、フィードバックは黙って消える。
//
// 既存の検査は functions/api/*.js の**振る舞い**（api-contract 等）を FakeD1 で
// 見ているが、FakeD1 は与えられたSQLをそのまま解釈するわけではないので、
// 「そのテーブルが本当に存在するか」は誰も見ていなかった。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectDir = join(here, "..");
const migrationsDir = join(projectDir, "migrations");
const apiDir = join(projectDir, "functions", "api");

// SQLの予約語や、テーブル名・別名の位置に現れるが実体ではないもの。
const SQL_KEYWORDS = new Set([
  "select", "values", "set", "where", "from", "into", "on", "as", "and", "or", "not",
  "in", "is", "like", "group", "order", "by", "limit", "offset", "union", "all",
  "inner", "left", "right", "outer", "join", "using", "having", "do", "nothing",
  "update", "insert", "delete", "conflict", "when", "then", "else", "end", "case",
  "returning", "with", "distinct", "exists", "cast", "asc", "desc", "null",
]);

/** SQLのコメントを落とす。コメント内の "FROM x" を拾わないため。 */
function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** migrations/*.sql から「テーブル名 → 列名の集合」を作る。 */
function readMigrationSchema() {
  const tables = new Map();
  const files = readdirSync(migrationsDir).filter((name) => name.endsWith(".sql")).sort();
  assert.ok(files.length > 0, "migrations/ に .sql がない");
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\n\s*\);/gi;
    for (let m; (m = re.exec(sql)); ) {
      const name = m[1].toLowerCase();
      const columns = new Set();
      for (const rawLine of m[2].split("\n")) {
        // 行コメントを落としてから、行頭の識別子を列名として拾う。
        const line = rawLine.replace(/--.*$/, "").trim();
        if (!line) continue;
        // テーブル制約（PRIMARY KEY (...) / UNIQUE (...) / CHECK / FOREIGN KEY）は列ではない。
        if (/^(primary|unique|check|foreign|constraint)\b/i.test(line)) continue;
        const column = /^([a-z_][a-z0-9_]*)/i.exec(line);
        if (column) columns.add(column[1].toLowerCase());
      }
      // 後続のマイグレーションが同名テーブルを足しても列は上書きしない（合流させる）。
      const existing = tables.get(name) || new Set();
      for (const c of columns) existing.add(c);
      tables.set(name, existing);
    }
    // ALTER TABLE ... ADD COLUMN で足された列も取り込む。
    const alter = /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+(?:COLUMN\s+)?([a-z_][a-z0-9_]*)/gi;
    for (let m; (m = alter.exec(sql)); ) {
      const name = m[1].toLowerCase();
      if (!tables.has(name)) tables.set(name, new Set());
      tables.get(name).add(m[2].toLowerCase());
    }
  }
  return tables;
}

/**
 * `.prepare(...)` に渡されたSQL文字列だけを取り出す。
 * ファイル全体を正規表現で舐めると、JSの正規表現リテラルやコメントに書かれた
 * "FROM state_revisions" のような文字列まで拾ってしまう（実際に存在する）。
 */
function preparedStatements(source) {
  const statements = [];
  for (const region of prepareArgumentRegions(source)) {
    statements.push(...stringLiteralsIn(region));
  }
  return statements.filter((text) => /\b(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text));
}

/**
 * `.prepare( ... )` の引数全体を返す。
 * 直後の文字列リテラルだけを見ると
 * `prepare(includeState ? "SELECT ... FROM states" : "SELECT ...")`
 * のような三項演算子を丸ごと取りこぼす（実際に wordsnap-state.js にある）。
 */
function prepareArgumentRegions(source) {
  const regions = [];
  const marker = ".prepare(";
  for (let at = source.indexOf(marker); at >= 0; at = source.indexOf(marker, at + 1)) {
    const open = at + marker.length - 1;
    let depth = 0;
    let quote = null;
    for (let i = open; i < source.length; i += 1) {
      const c = source[i];
      if (quote) {
        if (c === "\\") { i += 1; continue; }
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
      if (c === "(") depth += 1;
      else if (c === ")") {
        depth -= 1;
        if (depth === 0) { regions.push(source.slice(open + 1, i)); break; }
      }
    }
  }
  return regions;
}

/** コード片に含まれる文字列・テンプレートリテラルの中身を返す。 */
function stringLiteralsIn(code) {
  const out = [];
  for (let i = 0; i < code.length; i += 1) {
    const quote = code[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") continue;
    i += 1;
    let text = "";
    for (; i < code.length; i += 1) {
      const c = code[i];
      if (c === "\\") { text += code[i + 1] ?? ""; i += 1; continue; }
      if (c === quote) break;
      // テンプレートの ${...} は値の埋め込み。SQLの構造ではないので落とす。
      if (quote === "`" && c === "$" && code[i + 1] === "{") {
        let depth = 1;
        i += 2;
        while (i < code.length && depth > 0) {
          if (code[i] === "{") depth += 1;
          else if (code[i] === "}") depth -= 1;
          i += 1;
        }
        i -= 1;
        continue;
      }
      text += c;
    }
    out.push(text);
  }
  return out;
}

/**
 * CTE名（`WITH x AS (`）と派生表の別名（`) AS x`）を集める。
 * これらは実テーブルではないので、テーブル検査からも列検査からも外す。
 * 外さないと `WITH recent AS (...) SELECT ... FROM recent` が
 * 「migrations に無いテーブル」として**正しいSQLを弾いてしまう**。
 */
function derivedNames(sql) {
  const derived = new Set();
  for (const m of sql.matchAll(/\bWITH\s+([a-z_][a-z0-9_]*)\s+AS\s*\(/gi)) {
    derived.add(m[1].toLowerCase());
  }
  for (const m of sql.matchAll(/\)\s*(?:AS\s+)?([a-z_][a-z0-9_]*)/gi)) {
    const name = m[1].toLowerCase();
    if (!SQL_KEYWORDS.has(name)) derived.add(name);
  }
  return derived;
}

/** SQL文から、参照している実テーブル名を取り出す。 */
function referencedTables(sql) {
  const derived = derivedNames(sql);
  const found = new Set();
  const re = /\b(?:FROM|JOIN|INTO|UPDATE|DELETE\s+FROM)\s+([a-z_][a-z0-9_]*)/gi;
  for (let m; (m = re.exec(sql)); ) {
    const name = m[1].toLowerCase();
    if (SQL_KEYWORDS.has(name) || derived.has(name)) continue;
    found.add(name);
  }
  return found;
}

/**
 * 別名 → 実テーブル の対応を作る。`FROM state_revisions AS daily_row` のような
 * 書き方は実在し、解決しないと `daily_row.存在しない列` を素通りさせる。
 */
function aliasMap(sql) {
  const derived = derivedNames(sql);
  const map = new Map();
  const re = /\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)(?:\s+(?:AS\s+)?([a-z_][a-z0-9_]*))?/gi;
  for (let m; (m = re.exec(sql)); ) {
    const table = m[1].toLowerCase();
    if (SQL_KEYWORDS.has(table) || derived.has(table)) continue;
    map.set(table, table);
    const alias = m[2]?.toLowerCase();
    if (alias && !SQL_KEYWORDS.has(alias)) map.set(alias, table);
  }
  return { map, derived };
}

/** `INSERT INTO t (a, b, c)` から、テーブルと列の対応を取り出す。 */
function insertedColumns(sql) {
  const out = [];
  const re = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+([a-z_][a-z0-9_]*)\s*\(([^)]*)\)/gi;
  for (let m; (m = re.exec(sql)); ) {
    const columns = m[2]
      .split(",")
      .map((c) => c.trim().toLowerCase())
      .filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
    out.push({ table: m[1].toLowerCase(), columns });
  }
  return out;
}

function apiSources() {
  return readdirSync(apiDir)
    .filter((name) => name.endsWith(".js"))
    .map((name) => ({ name, source: readFileSync(join(apiDir, name), "utf8") }));
}

const schema = readMigrationSchema();
const sources = apiSources();

/** すべての Function の、コメントを落としたSQLを列挙する。 */
function* allStatements() {
  for (const { name, source } of sources) {
    for (const raw of preparedStatements(source)) {
      yield { name, sql: stripSqlComments(raw) };
    }
  }
}

test("前提: migrations と Functions を読めている", () => {
  assert.ok(schema.size >= 5, `テーブルが少なすぎる: ${[...schema.keys()].join(", ")}`);
  assert.ok(sources.length >= 3, `Functions が少なすぎる: ${sources.map((s) => s.name).join(", ")}`);
  const total = sources.reduce((n, s) => n + preparedStatements(s.source).length, 0);
  assert.ok(total >= 25, `prepare() の抽出が効いていない（${total}件）`);
});

test("SQLの取り出しに漏れがない（prepare の引数を丸ごと見ている）", () => {
  // 直後の文字列リテラルだけを見ると
  //   prepare(cond ? "SELECT ... FROM states" : "SELECT ...")
  // のような形を丸ごと取りこぼす。実際に wordsnap-state.js にあり、
  // 取りこぼすと「検査したつもりで何も見ていない」状態になる。
  for (const { name, source } of sources) {
    const prepareCount = source.split(".prepare(").length - 1;
    const captured = preparedStatements(source).length;
    assert.ok(
      captured >= prepareCount - 2, // ラッパー関数など、SQLを直に持たない呼び出しの分だけ許容
      `${name}: prepare が ${prepareCount} 箇所あるのに ${captured} 件しか取り出せていない`,
    );
  }
  // 三項演算子の中のSQLを実際に拾えていること
  const state = sources.find((s) => s.name === "wordsnap-state.js");
  assert.ok(state, "wordsnap-state.js が見つからない");
  const all = preparedStatements(state.source).join("\n");
  assert.match(all, /SELECT state, rev, updatedAt FROM states/,
    "三項演算子の中のSQLを取り出せていない");
});

test("Functions が参照するテーブルは、すべて migrations に存在する", () => {
  const missing = [];
  for (const { name, sql } of allStatements()) {
    for (const table of referencedTables(sql)) {
      if (!schema.has(table)) missing.push(`${name}: ${table}  （SQL: ${sql.slice(0, 70).replace(/\s+/g, " ")}…）`);
    }
  }
  assert.deepEqual(missing, [], `migrations に無いテーブルを参照している:\n${missing.join("\n")}`);
});

test("INSERT が並べる列は、すべて migrations の定義に存在する", () => {
  const missing = [];
  for (const { name, source } of sources) {
    for (const sql of preparedStatements(source)) {
      for (const { table, columns } of insertedColumns(sql)) {
        const known = schema.get(table);
        if (!known) continue; // テーブル自体の欠落は上のテストが報告する
        for (const column of columns) {
          if (!known.has(column)) missing.push(`${name}: ${table}.${column}`);
        }
      }
    }
  }
  assert.deepEqual(missing, [], `migrations に無い列へ INSERT している:\n${missing.join("\n")}`);
});

test("WHERE / SET で使う列も migrations の定義に存在する", () => {
  // 列名は文脈が広いので、テーブルが1つに定まる文だけを見る。
  const missing = [];
  for (const { name, source } of sources) {
    for (const sql of preparedStatements(source)) {
      const tables = [...referencedTables(sql)].filter((t) => schema.has(t));
      if (tables.length !== 1) continue;
      const known = schema.get(tables[0]);
      const re = /\b([a-z_][a-z0-9_]*)\s*(?:=|<=|>=|<>|!=|<|>|LIKE|IS|IN)\s*\?/gi;
      for (let m; (m = re.exec(sql)); ) {
        const column = m[1].toLowerCase();
        // `table.column = ?` の形は前半がテーブル名なので除く
        if (schema.has(column)) continue;
        if (!known.has(column)) missing.push(`${name}: ${tables[0]}.${column}`);
      }
    }
  }
  assert.deepEqual(missing, [], `migrations に無い列を条件に使っている:\n${missing.join("\n")}`);
});

test("`テーブル.列` / `別名.列` の参照が、すべて定義に存在する", () => {
  // 修飾された参照はテーブルが一意に定まるので、いちばん確実に検査できる。
  // 別名を解決しないと `FROM state_revisions AS daily_row` の
  // `daily_row.存在しない列` を素通りさせる（実際にこの書き方がある）。
  const missing = [];
  for (const { name, sql } of allStatements()) {
    const { map, derived } = aliasMap(sql);
    const re = /\b([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\b/gi;
    for (let m; (m = re.exec(sql)); ) {
      const qualifier = m[1].toLowerCase();
      const column = m[2].toLowerCase();
      if (qualifier === "excluded") continue; // SQLite の擬似テーブル
      if (derived.has(qualifier)) continue; // 派生表・CTE の列は定義できない
      const table = map.get(qualifier);
      if (!table) continue;
      const known = schema.get(table);
      if (known && !known.has(column)) missing.push(`${name}: ${qualifier}(${table}).${column}`);
    }
  }
  assert.deepEqual(missing, [], `migrations に無い列を参照している:\n${missing.join("\n")}`);
});

test("SET の代入先の列が、その表の定義に存在する", () => {
  // `ON CONFLICT ... DO UPDATE SET window_start = CASE …` の左辺は修飾が無く、
  // `列 = ?` の形でもないので、これまでどの検査も触れていなかった。
  const missing = [];
  for (const { name, sql } of allStatements()) {
    const target = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+([a-z_][a-z0-9_]*)/i.exec(sql)
      || /\bUPDATE\s+([a-z_][a-z0-9_]*)/i.exec(sql);
    if (!target) continue;
    const known = schema.get(target[1].toLowerCase());
    if (!known) continue;
    const setAt = /\bSET\b/i.exec(sql);
    if (!setAt) continue;
    const clause = sql.slice(setAt.index + 3);
    // SET の直後、またはカンマの直後に来る識別子が代入先。
    const re = /(?:^|,)\s*([a-z_][a-z0-9_]*)\s*=/gi;
    for (let m; (m = re.exec(clause)); ) {
      const column = m[1].toLowerCase();
      if (SQL_KEYWORDS.has(column)) continue;
      if (!known.has(column)) missing.push(`${name}: ${target[1]}.${column}`);
    }
  }
  assert.deepEqual(missing, [], `定義に無い列へ代入している:\n${missing.join("\n")}`);
});

test("単一表の SELECT が並べる列が、定義に存在する", () => {
  // `SELECT room_id, state_key, … FROM rooms` の形は誤記を機械的に見つけられる。
  // 関数呼び出しや `*` を含む選択リストは意味が広いので対象外にする。
  const missing = [];
  let checked = 0;
  for (const { name, sql } of allStatements()) {
    const re = /\bSELECT\s+([^]*?)\s+FROM\s+([a-z_][a-z0-9_]*)/gi;
    for (let m; (m = re.exec(sql)); ) {
      const list = m[1];
      const table = m[2].toLowerCase();
      const known = schema.get(table);
      if (!known) continue;
      if (/[(*]/.test(list)) continue; // 関数・ワイルドカードを含む選択リストは対象外
      const columns = list.split(",").map((c) => c.trim().toLowerCase());
      if (!columns.every((c) => /^[a-z_][a-z0-9_]*$/.test(c))) continue;
      checked += 1;
      for (const column of columns) {
        if (SQL_KEYWORDS.has(column)) continue;
        if (!known.has(column)) missing.push(`${name}: ${table}.${column}`);
      }
    }
  }
  assert.ok(checked >= 3, `検査できた SELECT が少なすぎる（${checked}件）。抽出が効いていない可能性`);
  assert.deepEqual(missing, [], `SELECT が定義に無い列を並べている:\n${missing.join("\n")}`);
});

test("ON CONFLICT の対象列が、その表の定義に存在する", () => {
  const missing = [];
  for (const { name, source } of sources) {
    for (const sql of preparedStatements(source)) {
      const insert = /INSERT(?:\s+OR\s+\w+)?\s+INTO\s+([a-z_][a-z0-9_]*)/i.exec(sql);
      if (!insert) continue;
      const known = schema.get(insert[1].toLowerCase());
      if (!known) continue;
      const conflict = /ON\s+CONFLICT\s*\(([^)]*)\)/i.exec(sql);
      if (!conflict) continue;
      for (const raw of conflict[1].split(",")) {
        const column = raw.trim().toLowerCase();
        if (!/^[a-z_][a-z0-9_]*$/.test(column)) continue;
        if (!known.has(column)) missing.push(`${name}: ${insert[1]}.${column}`);
      }
    }
  }
  assert.deepEqual(missing, [], `ON CONFLICT が定義に無い列を指している:\n${missing.join("\n")}`);
});

test("schema.sql は migrations/0001 と同じ初期スキーマを指す", () => {
  // schema.sql は「最初の1枚」で、以後の変更は migrations/ にある。
  // ここがずれると、新しいD1を作るときにどちらを信じるべきか分からなくなる。
  const initial = readFileSync(join(migrationsDir, "0001_initial.sql"), "utf8");
  const schemaSql = readFileSync(join(projectDir, "schema.sql"), "utf8");
  const tablesIn = (sql) =>
    [...sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)]
      .map((m) => m[1].toLowerCase())
      .sort();
  assert.deepEqual(tablesIn(schemaSql), tablesIn(initial),
    "schema.sql と migrations/0001_initial.sql のテーブルが食い違っている");
});

test("migrations は連番で、飛びや重複がない", () => {
  const numbers = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .map((name) => {
      const m = /^(\d{4})_/.exec(name);
      assert.ok(m, `migrations のファイル名が連番形式ではない: ${name}`);
      return Number(m[1]);
    })
    .sort((a, b) => a - b);
  assert.deepEqual(numbers, numbers.map((_, i) => i + 1),
    `migrations の連番に飛びか重複がある: ${numbers.join(", ")}`);
});

test("migrations は既存の行を壊さない（DROP / 破壊的ALTER を含まない）", () => {
  // 既存利用者のデータ保全が最優先。取り返しのつかない操作を混ぜていないことを固定する。
  for (const file of readdirSync(migrationsDir).filter((n) => n.endsWith(".sql"))) {
    const sql = stripSqlComments(readFileSync(join(migrationsDir, file), "utf8"));
    for (const forbidden of [/\bDROP\s+TABLE\b/i, /\bDROP\s+COLUMN\b/i, /\bTRUNCATE\b/i, /\bDELETE\s+FROM\b/i]) {
      assert.ok(!forbidden.test(sql), `${file} に破壊的な操作が含まれている: ${forbidden}`);
    }
  }
});
