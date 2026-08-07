// 実SQLite（node:sqlite）で D1 のAPIを再現する薄い層。
//
// なぜ要るか:
//   契約テストの FakeD1 は「期待するSQLの意味」を JavaScript で再実装したもので、
//   **与えられたSQLを解釈していない**。つまり
//     - SQLの構文エラー
//     - 制約違反（NOT NULL / UNIQUE / CHECK）
//     - migrations の適用漏れ（存在しない列・テーブル）
//     - ON CONFLICT や LIMIT 付きサブクエリの実際の挙動
//   のどれも通してしまう。本番だけが失敗する経路が残っていた（レビュー記録の M7）。
//
//   node:sqlite は Node 22 以降の標準機能なので、npm依存を増やさずに
//   「本物のSQLite」で migrations を適用し、Functions の実SQLをそのまま流せる。
//
// D1 と SQLite の違いで、ここで埋められないもの:
//   - ネットワーク越しの遅延・タイムアウト・30秒上限
//   - 同時実行の直列化やキューの詰まり
//   - Cloudflare 側のエラー形（D1_ERROR など）
//   これらは実D1でしか出ない。ここが守るのは「SQLとスキーマの正しさ」まで。
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

/**
 * node:sqlite は行を null プロトタイプで返すが、D1 は通常のオブジェクトを返す。
 * そのまま渡すと assert.deepEqual がプロトタイプ違いで落ち、
 * 「実装が正しいのにテストが落ちる」状態になる。実物へ寄せておく。
 */
const plainRow = (row) => ({ ...row });

/** migrations/*.sql を番号順に返す。 */
export function migrationFiles() {
  return readdirSync(migrationsDir)
    .filter((name) => /^\d{4}_.*\.sql$/.test(name))
    .sort();
}

/**
 * D1 互換の薄いラッパ。Functions が使う分だけを実装する:
 *   prepare().bind().first() / .run() / .all()
 *   batch([...])
 */
class SqliteD1 {
  constructor(db) {
    this.db = db;
    this.log = []; // 実行したSQLの記録（検査用）
  }

  prepare(sql) {
    const owner = this;
    return {
      sql,
      args: [],
      bind(...args) {
        // D1 は undefined を受け付けない。null へ寄せるのは実D1と同じ扱い。
        this.args = args.map((a) => (a === undefined ? null : a));
        return this;
      },
      /** 1行目を返す。無ければ null（D1と同じ）。 */
      async first(column) {
        owner.log.push(sql);
        const row = owner.db.prepare(sql).get(...this.args);
        if (row === undefined) return null;
        return column === undefined ? plainRow(row) : row[column];
      },
      /** 変更系。D1 と同じ形の meta を返す。 */
      async run() {
        owner.log.push(sql);
        const info = owner.db.prepare(sql).run(...this.args);
        return {
          success: true,
          meta: {
            changes: Number(info.changes ?? 0),
            last_row_id: Number(info.lastInsertRowid ?? 0),
          },
        };
      },
      /** 全行。D1 は { results: [...] } を返す。 */
      async all() {
        owner.log.push(sql);
        return { success: true, results: owner.db.prepare(sql).all(...this.args).map(plainRow) };
      },
    };
  }

  /**
   * D1 の batch は**単一トランザクション**。1つでも失敗したら全部巻き戻る。
   * 同期V2の作成が「states と rooms を孤児にしない」ためにこれへ依存している。
   */
  async batch(statements) {
    this.db.exec("BEGIN");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.db.exec("COMMIT");
      return results;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }
}

/**
 * migrations を実際に適用したメモリ内DBを作る。
 * @param {object} options
 * @param {string[]} [options.only] 適用するmigrationのファイル名（既定は全部）
 */
export function createTestDatabase({ only } = {}) {
  const db = new DatabaseSync(":memory:");
  const files = only ?? migrationFiles();
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    try {
      db.exec(sql);
    } catch (error) {
      throw new Error(`migration が適用できない: ${file}\n${error.message}`);
    }
  }
  return new SqliteD1(db);
}

/** そのDBに存在するテーブル名。 */
export function tableNames(d1) {
  return d1.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

/** そのDBに存在する索引名。 */
export function indexNames(d1) {
  return d1.db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.name);
}

/** テーブルの列名。 */
export function columnNames(d1, table) {
  return d1.db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
}
