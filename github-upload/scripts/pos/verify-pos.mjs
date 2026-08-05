// 訳から導出した品詞を Datamuse で独立に検証する（ビルド時に1回だけ走らせる補助）。
// アプリが実行時に使うのと同じ md=p 照会。導出とDatamuseが食い違う語は表に入れない。
//
// 判定:
//   - Datamuseの品詞集合に導出タグが無い → 落とす（誤りの疑い）
//   - 品詞がちょうど {n,v} → 採用し、名詞動詞兼用の集合へ入れる
//   - 品詞が2つ以上で adj を含む → 落とす（今の表構造では表現できない）
//   - 品詞が1つだけ → その品詞で採用
//   - Datamuseが品詞を返さない → 導出をそのまま採用（照合できないため）
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const derived = JSON.parse(fs.readFileSync(path.join(DIR, "pos-derived.json"), "utf8"));
const cachePath = path.join(DIR, "datamuse-pos-cache.json");
const cache = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, "utf8")) : {};

const terms = [];
for (const tag of ["n", "v", "adj"]) for (const t of derived.groups[tag]) terms.push([t, tag]);

const POS = new Set(["n", "v", "adj", "adv"]);
const CONCURRENCY = 6;
let done = 0;

async function lookup(term) {
  if (cache[term] !== undefined) return cache[term];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(
        `https://api.datamuse.com/words?sp=${encodeURIComponent(term)}&md=p&max=1`,
      );
      if (res.status === 429) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const entry = Array.isArray(data) ? data[0] : null;
      const tags =
        entry && entry.word === term && Array.isArray(entry.tags)
          ? entry.tags.filter((t) => POS.has(t))
          : [];
      cache[term] = tags;
      return tags;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  return null; // 照合不能
}

const queue = terms.slice();
async function worker() {
  for (;;) {
    const item = queue.shift();
    if (!item) return;
    await lookup(item[0]);
    done += 1;
    if (done % 250 === 0) {
      process.stderr.write(`  ${done}/${terms.length} 照合済み\n`);
      fs.writeFileSync(cachePath, JSON.stringify(cache));
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
fs.writeFileSync(cachePath, JSON.stringify(cache));

const groups = { n: [], v: [], adj: [] };
const nounAndVerb = [];
const multi = {};
const dropped = [];
let unchecked = 0;

for (const [term, tag] of terms) {
  const tags = cache[term];
  if (tags === undefined || tags === null) {
    unchecked += 1;
    groups[tag].push(term);
    continue;
  }
  if (tags.length === 0) {
    unchecked += 1;
    groups[tag].push(term);
    continue;
  }
  if (!tags.includes(tag)) {
    dropped.push(`${term}\t導出=${tag}\tDatamuse=${tags.join(",")}`);
    continue;
  }
  if (tags.length === 1) {
    groups[tag].push(term);
    continue;
  }
  // 多品詞語。取り得る品詞をそのまま持たせる（単一の品詞にまとめると
  // 「品詞が違うから空所に入らない」という根拠を誤って作ってしまう）。
  // 導出した品詞を先頭に置き、代表の品詞として使えるようにする。
  const ordered = [tag, ...tags.filter((x) => x !== tag)];
  multi[term] = ordered;
}

const multiCount = Object.keys(multi).length;
const total = groups.n.length + groups.v.length + groups.adj.length;
console.error(
  `検証後: 単一品詞 ${total} (n=${groups.n.length} v=${groups.v.length} adj=${groups.adj.length})` +
    ` / 多品詞 ${multiCount} / 落とした ${dropped.length} / 照合できず ${unchecked}`,
);
fs.writeFileSync(path.join(DIR, "pos-dropped.txt"), dropped.join("\n"));
fs.writeFileSync(
  path.join(DIR, "pos-verified.json"),
  JSON.stringify({ groups, nounAndVerb, multi }, null, 0),
);
