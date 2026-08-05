// サンプル単語のCEFRレベルを、ビルド時に一度だけ Datamuse から取って表にする。
//
// アプリは実行時に md=f（使用頻度）を引き、levelFromFrequency() でレベルへ落としている。
// 同じ計算をここで先に済ませておけば、利用者の端末は通信せずにレベルを表示できる。
// サンプルは1集1500語あるので、実行時に引かせると「保存した単語」画面を
// 何度もめくらせることになり、実質ほとんど未判定のままになる。
//
// 使い方: node scripts/cefr/build-cefr.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HTML_PATH = path.join(DIR, "..", "..", "publish", "index.html");
const HTML = fs.readFileSync(HTML_PATH, "utf8");
const cachePath = path.join(DIR, "datamuse-freq-cache.json");
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

const SETS = [
  "SAMPLE_TEXT",
  "SAMPLE_TEXT_JHS",
  "SAMPLE_TEXT_EIKEN",
  "SAMPLE_TEXT_SOUKEI",
  "SAMPLE_TEXT_TOEIC",
  "SAMPLE_TEXT_IELTS",
];

function readTerms() {
  const terms = new Set();
  for (const name of SETS) {
    const start = HTML.indexOf(`const ${name} = \``);
    if (start < 0) throw new Error(`${name} が見つからない`);
    const open = HTML.indexOf("`", start);
    const body = HTML.slice(open + 1, HTML.indexOf("`;", open + 1));
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (t) terms.add(t.slice(0, t.indexOf(" ")).toLowerCase());
    }
  }
  return [...terms].sort();
}

// アプリ側の levelFromFrequency と同じしきい値。ずれると表示が食い違うので、
// HTMLから実際の関数本体を読み出して一致を確かめる。
function levelFromFrequency(f) {
  if (f >= 100) return "A1";
  if (f >= 30) return "A2";
  if (f >= 8) return "B1";
  if (f >= 2) return "B2";
  if (f >= 0.5) return "C1";
  return "C2";
}
{
  const body = /function levelFromFrequency\(f\) \{([\s\S]*?)\n  \}/.exec(HTML)[1];
  const thresholds = [...body.matchAll(/f >= ([\d.]+)\) return "(\w+)"/g)].map(
    (m) => `${m[1]}:${m[2]}`,
  );
  const mine = ["100:A1", "30:A2", "8:B1", "2:B2", "0.5:C1"];
  if (thresholds.join(",") !== mine.join(",")) {
    throw new Error(`しきい値がアプリと食い違う: ${thresholds.join(",")}`);
  }
}

const terms = readTerms();
const CONCURRENCY = 6;
let done = 0;

async function lookup(term) {
  if (cache[term] !== undefined) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(
        `https://api.datamuse.com/words?sp=${encodeURIComponent(term)}&md=f&max=1`,
      );
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return;
      const data = await res.json();
      const entry = Array.isArray(data) ? data[0] : null;
      if (!entry || entry.word !== term || !Array.isArray(entry.tags)) {
        cache[term] = null; // 該当語なし。実行時に引かせても同じなので焼かない。
        return;
      }
      const fTag = entry.tags.find((t) => t.startsWith("f:"));
      cache[term] = fTag ? parseFloat(fTag.slice(2)) : null;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

const queue = terms.slice();
async function worker() {
  for (;;) {
    const t = queue.shift();
    if (!t) return;
    await lookup(t);
    done += 1;
    if (done % 500 === 0) {
      process.stderr.write(`  ${done}/${terms.length}\n`);
      fs.writeFileSync(cachePath, JSON.stringify(cache));
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
fs.writeFileSync(cachePath, JSON.stringify(cache));

const byLevel = { A1: [], A2: [], B1: [], B2: [], C1: [], C2: [] };
let skipped = 0;
for (const t of terms) {
  const f = cache[t];
  if (typeof f !== "number") {
    skipped += 1;
    continue;
  }
  byLevel[levelFromFrequency(f)].push(t);
}
const covered = Object.values(byLevel).reduce((s, a) => s + a.length, 0);
console.error(
  `語数 ${terms.length} / レベルを付けた ${covered} (${((covered / terms.length) * 100).toFixed(1)}%) / ` +
    `頻度が取れず見送り ${skipped}`,
);
console.error(
  "内訳: " + Object.entries(byLevel).map(([k, v]) => `${k}=${v.length}`).join(" "),
);

fs.writeFileSync(path.join(DIR, "cefr-builtin.json"), JSON.stringify(byLevel, null, 0));
