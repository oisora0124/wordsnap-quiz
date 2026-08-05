// サンプル単語集の日本語訳から品詞を機械導出する。
//
// 誤った品詞は空所補充の「品詞が違うから空所に入らない」という根拠を壊し、
// 解けない問題を作ってしまう。したがって精度優先で、確信の持てない語は
// 表に入れない（入れなければ従来どおり Datamuse 照会か品詞なしに落ちるだけ）。
//
// 使い方: node scripts/pos/derive-pos.mjs [--report]
// サンプル単語集は publish/index.html を唯一の出典として読む（別置きのコピーを持たない）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const HTML = fs.readFileSync(path.join(DIR, "..", "..", "publish", "index.html"), "utf8");
const SETS = [
  "SAMPLE_TEXT",
  "SAMPLE_TEXT_JHS",
  "SAMPLE_TEXT_EIKEN",
  "SAMPLE_TEXT_SOUKEI",
  "SAMPLE_TEXT_TOEIC",
  "SAMPLE_TEXT_IELTS",
];

function readSet(name) {
  const start = HTML.indexOf(`const ${name} = \``);
  if (start < 0) throw new Error(`${name} が見つからない`);
  const open = HTML.indexOf("`", start);
  const body = HTML.slice(open + 1, HTML.indexOf("`;", open + 1));
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf(" ");
      return { term: line.slice(0, i).toLowerCase(), meaning: line.slice(i + 1) };
    });
}

const KANJI = /[一-鿿々]/;
const KATAKANA_ONLY = /^[ァ-ヶー]+$/;
// 動詞の終止形になり得る「う段」のかな。
const U_ROW = /[うくぐすずつぬふぶむる]$/;

// 語尾規則の例外。見送り一覧を全件読んで拾い出した実在の反例だけを並べている
// （推測で足さない。規則を広げるたびに全件を読み直して更新する）。
// 「〜た」で終わるが形容詞ではないもの。
const TA_NOT_ADJ = new Set(["もまた", "ふた", "ぶた", "おおかた", "かた", "した"]);
// 「〜い」で終わるが形容詞ではないもの（かな書きの名詞・副詞）。
const I_NOT_ADJ = new Set(["はい", "へい", "かんがい", "まちがい", "たいてい", "きょうだい"]);
// 「〜い」で終わる名詞の語尾（連用形＋い）。「食い違い」「支払い」など。
const I_NOUN_SUFFIX = /(違い|合い|払い|行い|勢い|扱い|願い|争い|戦い|匂い)$/;

// 訳から品詞を1つ推定する。確信が持てなければ null。
export function tagFromMeaning(meaning) {
  const m = meaning.trim();
  if (!m) return null;

  // --- 形容詞・連体修飾 ---
  // 「〜な」「〜の」で終わるものは、日本語側が連体形＝英語側も形容詞。
  if (/[なの]$/.test(m)) {
    // 「〜もの」「〜こと」は名詞。「〜ためのもの」等を誤って形容詞にしない。
    if (/(もの|こと)$/.test(m)) return "n";
    return "adj";
  }
  // 「〜ない」（決してない等）は副詞になりがちなので除外する。
  if (/ない$/.test(m)) return null;

  // 「〜い」＝イ形容詞。ただし連用形＋い の名詞（食い違い・支払い）と、
  // かな書きの名詞・副詞（はい・へい・たいてい）は除く。
  if (/い$/.test(m)) {
    if (I_NOT_ADJ.has(m) || I_NOUN_SUFFIX.test(m)) return I_NOT_ADJ.has(m) && m === "たいてい" ? null : "n";
    return "adj";
  }
  // 「〜た」＝過去分詞的な連体修飾（隣接した・指定された）。
  // 「ふた」「かた」のような短いかな名詞と「おおかた」は除く。
  if (/た$/.test(m)) {
    if (TA_NOT_ADJ.has(m)) return /^(ふた|ぶた|かた|した)$/.test(m) ? "n" : null;
    return "adj";
  }
  // 「〜さ」「〜み」＝形容詞語幹の名詞化（鋭さ・重み）。動詞・形容詞にはならない。
  if (/[さみ]$/.test(m)) return "n";

  // --- 動詞 ---
  // 「〜する」は最も確実な動詞の印。
  if (/する$/.test(m)) return "v";
  // 「〜せる」「〜れる」など、かなの「う段」で終わる語。ただし
  // 「たる」「かご」のような仮名書きの名詞と区別できないため、
  // 漢字を1文字以上含むものだけを動詞と見なす（精度優先）。
  if (U_ROW.test(m) && KANJI.test(m)) return "v";

  // --- 名詞 ---
  // 漢字で終わる、またはカタカナ語まるごと＝名詞と見てよい。
  if (KANJI.test(m.slice(-1))) return "n";
  if (KATAKANA_ONLY.test(m)) return "n";

  // それ以外（純粋なかな書き、「〜さ」「〜み」など）は判定しない。
  return null;
}

// 全集を走査し、term ごとに導出タグを集める。
const byTerm = new Map();
for (const set of SETS) {
  for (const { term, meaning } of readSet(set)) {
    const tag = tagFromMeaning(meaning);
    if (!byTerm.has(term)) byTerm.set(term, { tags: new Set(), samples: [] });
    const e = byTerm.get(term);
    e.samples.push(`${set}:${meaning}${tag ? "" : "(不明)"}`);
    if (tag) e.tags.add(tag);
  }
}

const groups = { n: [], v: [], adj: [] };
const nounAndVerb = [];
const skipped = [];

for (const [term, { tags, samples }] of [...byTerm].sort()) {
  const t = [...tags];
  if (t.length === 0) {
    skipped.push({ term, why: "訳から品詞を判定できない", samples });
    continue;
  }
  if (t.length === 1) {
    groups[t[0]].push(term);
    continue;
  }
  // 集をまたいで違う品詞に見える＝多品詞語。名詞と動詞の兼用だけを扱い、
  // それ以外（形容詞が混ざるもの）は根拠として使えないので表に入れない。
  if (t.length === 2 && tags.has("n") && tags.has("v")) {
    groups.n.push(term);
    nounAndVerb.push(term);
    continue;
  }
  skipped.push({ term, why: `品詞が集ごとに食い違う (${t.join("/")})`, samples });
}

const total = byTerm.size;
const covered = groups.n.length + groups.v.length + groups.adj.length;
console.error(
  `語数 ${total} / 判定できた ${covered} (${((covered / total) * 100).toFixed(1)}%) / ` +
    `見送り ${skipped.length}  [n=${groups.n.length} v=${groups.v.length} adj=${groups.adj.length} n+v=${nounAndVerb.length}]`,
);

if (process.argv.includes("--report")) {
  fs.writeFileSync(
    path.join(DIR, "pos-skipped.txt"),
    skipped.map((s) => `${s.term}\t${s.why}\t${s.samples.join(" | ")}`).join("\n"),
  );
  for (const g of ["n", "v", "adj"]) {
    fs.writeFileSync(path.join(DIR, `pos-${g}.txt`), groups[g].join("\n"));
  }
  fs.writeFileSync(path.join(DIR, "pos-nv.txt"), nounAndVerb.join("\n"));
  console.error("pos-*.txt を書き出しました");
}

fs.writeFileSync(
  path.join(DIR, "pos-derived.json"),
  JSON.stringify({ groups, nounAndVerb }, null, 0),
);
