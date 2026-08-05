// 検証済みの品詞データを publish/index.html の内蔵品詞表へ差しこむ。
// 既存の手検証済み300語はそのまま残し、重複する語は新データ側から除く
// （手で確かめた表を機械導出で上書きしない）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(DIR, "..", "..", "publish", "index.html");

let html = fs.readFileSync(HTML, "utf8");
const verified = JSON.parse(fs.readFileSync(path.join(DIR, "pos-verified.json"), "utf8"));

// --- 手検証済み表は固定ファイルから読む ---
// 現在のHTMLから読むと、一度差しこんだあとは機械導出の結果まで
// 「手検証済み」と誤認してしまう（再実行で基準が壊れる）。
const handData = JSON.parse(
  fs.readFileSync(path.join(DIR, "hand-verified-pos.json"), "utf8"),
);
const handGroups = handData.groups;
const hand = new Map();
for (const [tag, words] of Object.entries(handGroups)) for (const w of words) hand.set(w, tag);
console.log(`手検証済み: ${hand.size}語`);

// --- 新データから手検証済みの語を除く ---
const addSingle = { n: [], v: [], adj: [] };
for (const tag of ["n", "v", "adj"]) {
  for (const w of verified.groups[tag]) if (!hand.has(w)) addSingle[tag].push(w);
}
const addMulti = {};
for (const [w, tags] of Object.entries(verified.multi)) if (!hand.has(w)) addMulti[w] = tags;

// --- 単一品詞は既存グループへ併合（重複排除・辞書順） ---
const mergedGroups = {};
for (const tag of ["n", "v", "adj"]) {
  mergedGroups[tag] = [...new Set([...(handGroups[tag] || []), ...addSingle[tag]])].sort();
}
const groupsBlock =
  "const BUILTIN_POS_GROUPS = {\n" +
  ["n", "v", "adj"].map((t) => `  ${t}: "${mergedGroups[t].join(" ")}",`).join("\n") +
  "\n};";
html = html.replace(/const BUILTIN_POS_GROUPS = \{[\s\S]*?\n\};/, groupsBlock);

// --- 多品詞は品詞の組み合わせごとにまとめる ---
const byCombo = new Map();
for (const [w, tags] of Object.entries(addMulti)) {
  const key = tags.join(" ");
  if (!byCombo.has(key)) byCombo.set(key, []);
  byCombo.get(key).push(w);
}
const comboLines = [...byCombo]
  .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
  .map(([combo, words]) => `  "${combo}": "${words.sort().join(" ")}",`);

const multiBlock = `// 複数の品詞を取る語（Datamuseのmd=pで実測）。単一の品詞として登録すると
// 「品詞が違うから空所に入らない」という根拠を誤って作り、正解が2つある問題に
// なってしまう。取り得る品詞をそのまま持たせ、根拠判定はその全体で行う。
// キーは品詞の並び。先頭が代表の品詞（訳から導出したもの）。
const BUILTIN_POS_MULTI_GROUPS = {
${comboLines.join("\n")}
};
const BUILTIN_POS_MULTI = (() => {
  const map = new Map();
  for (const [combo, terms] of Object.entries(BUILTIN_POS_MULTI_GROUPS)) {
    const tags = combo.split(" ");
    for (const term of terms.split(" ")) map.set(term, tags);
  }
  return map;
})();

`;

// BUILTIN_POS の直後（= BUILTIN_POS_NOUN_AND_VERB のコメントの前）に挿入する。
const anchor = "// 名詞としても動詞としても普通に使う語。";
if (!html.includes("const BUILTIN_POS_MULTI_GROUPS")) {
  html = html.replace(anchor, multiBlock + anchor);
} else {
  html = html.replace(
    /\/\/ 複数の品詞を取る語（Datamuse[\s\S]*?\n\}\)\(\);\n\n/,
    multiBlock,
  );
}

fs.writeFileSync(HTML, html);
const totalSingle = ["n", "v", "adj"].reduce((s, t) => s + mergedGroups[t].length, 0);
console.log(
  `差しこみ完了: 単一品詞 ${totalSingle}語 ` +
    `(n=${mergedGroups.n.length} v=${mergedGroups.v.length} adj=${mergedGroups.adj.length}) / ` +
    `多品詞 ${Object.keys(addMulti).length}語 / 組み合わせ ${byCombo.size}種`,
);
