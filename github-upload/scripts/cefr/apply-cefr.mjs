// build-cefr.mjs が作ったCEFR表を publish/index.html へ差しこむ。
// 何度流しても同じ結果になる（既存のブロックがあれば丸ごと置き換える）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(DIR, "..", "..", "publish", "index.html");
const byLevel = JSON.parse(fs.readFileSync(path.join(DIR, "cefr-builtin.json"), "utf8"));

let html = fs.readFileSync(HTML, "utf8");

const lines = ["A1", "A2", "B1", "B2", "C1", "C2"]
  .map((lv) => `    ${lv}: "${byLevel[lv].sort().join(" ")}",`)
  .join("\n");

const block = `  // 内蔵サンプル単語のCEFRレベル。Datamuseのmd=f（使用頻度）から
  // levelFromFrequency() と同じ計算でビルド時に求めたもの（scripts/cefr/）。
  // 実行時に引かせると、1集1500語では「保存した単語」画面を何度もめくらない限り
  // ほとんど未判定のままになるため、先に焼きこんで通信ゼロで表示できるようにする。
  // 判定の中身は実行時に引いた場合と同じなので、estimated は true のまま。
  const BUILTIN_LEVEL_GROUPS = {
${lines}
  };
  const BUILTIN_LEVELS = (() => {
    const map = new Map();
    for (const [level, terms] of Object.entries(BUILTIN_LEVEL_GROUPS)) {
      for (const term of terms.split(" ")) map.set(term, level);
    }
    return map;
  })();

`;

const anchor = "  let cache = load();";
if (html.includes("const BUILTIN_LEVEL_GROUPS")) {
  html = html.replace(
    /  \/\/ 内蔵サンプル単語のCEFRレベル。[\s\S]*?\n  \}\)\(\);\n\n/,
    block,
  );
} else {
  if (!html.includes(anchor)) throw new Error("差しこみ位置が見つからない");
  html = html.replace(anchor, block + anchor);
}

// peek() が内蔵表も見るようにする。
const oldPeek = `  function peek(term) {
    const k = key(term);
    if (!k) return null;
    if (OVERRIDES[k]) return { level: OVERRIDES[k], estimated: false };
    if (cache[k]) return cache[k];
    return null;
  }`;
const newPeek = `  function peek(term) {
    const k = key(term);
    if (!k) return null;
    if (OVERRIDES[k]) return { level: OVERRIDES[k], estimated: false };
    if (cache[k]) return cache[k];
    // 内蔵表は最後に見る。実行時に取り直した値（cache）があればそちらを優先する。
    const builtin = BUILTIN_LEVELS.get(k);
    if (builtin) return { level: builtin, estimated: true };
    return null;
  }`;
if (html.includes(oldPeek)) html = html.replace(oldPeek, newPeek);
else if (!html.includes("BUILTIN_LEVELS.get(k)")) throw new Error("peek() を書き換えられない");

fs.writeFileSync(HTML, html);
const total = Object.values(byLevel).reduce((s, a) => s + a.length, 0);
console.log(
  `差しこみ完了: ${total}語 ` +
    Object.entries(byLevel).map(([k, v]) => `${k}=${v.length}`).join(" "),
);
