// 配信物を変えたコミットでバージョンを進め忘れていないかを見る。
//
// check-release.mjs から分けてあるのは、こちらが git の履歴に依存するため。
// 手元では未コミットの変更があるのが普通で、そのとき HEAD と親を比べても意味がなく、
// npm test の結果が作業状態で変わってしまう。CI（clean な checkout）専用にしている。
//
// 判定: HEAD が publish/ か functions/ を変えているなら、package.json の version も
// 親と違っていなければならない。設計書・テスト・スクリプトだけの変更では要求しない。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectDir = resolve(scriptDir, "..");
const repoDir = resolve(projectDir, "..");

const git = (...args) =>
  execFileSync("git", args, { cwd: repoDir, encoding: "utf8" }).trim();

// 配信物＝利用者のブラウザに届くもの。ここが変わらない限りバージョンは据え置く。
const DEPLOYED_PATHS = ["github-upload/publish", "github-upload/functions"];
const VERSION_FILE = "github-upload/package.json";

let parent;
try {
  parent = git("rev-parse", "HEAD^");
} catch {
  console.log("親コミットがないため、バージョン進行の検査は省略しました。");
  process.exit(0);
}

const changed = git("diff", "--name-only", `${parent}..HEAD`).split("\n").filter(Boolean);
const touchedDeployed = changed.filter((path) =>
  DEPLOYED_PATHS.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
);

if (touchedDeployed.length === 0) {
  console.log("配信物に変更がないため、バージョンは据え置きで問題ありません。");
  process.exit(0);
}

const versionAt = (ref) => JSON.parse(git("show", `${ref}:${VERSION_FILE}`)).version;
const before = versionAt(parent);
const after = versionAt("HEAD");

assert.notEqual(after, before,
  `配信物を変えたコミットではバージョンを進めてください（${before} のままです）。`
    + ` 変更: ${touchedDeployed.slice(0, 5).join(", ")}`
    + `${touchedDeployed.length > 5 ? ` ほか${touchedDeployed.length - 5}件` : ""}`);

console.log(`バージョンを ${before} → ${after} へ進めています。`);
