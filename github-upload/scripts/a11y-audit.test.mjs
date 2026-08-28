// 検査スクリプト自身の検査。a11y-audit.mjs は npm test のゲートなので、
// 「見逃す（偽陰性）」と「無いものを報告してゲートを止める（偽陽性）」の
// どちらも本番の足を引っ張る。両方向を固定入力で押さえる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const AUDIT = join(here, "a11y-audit.mjs");
const work = mkdtempSync(join(tmpdir(), "wb-a11y-"));
process.on("exit", () => rmSync(work, { recursive: true, force: true }));

let seq = 0;
/** body の中身を持つ最小のHTMLを検査し、違反の配列を返す。 */
function audit(bodyHtml) {
  const file = join(work, `case-${(seq += 1)}.html`);
  writeFileSync(file, `<!doctype html><html lang="ja"><body>\n${bodyHtml}\n</body></html>\n`);
  try {
    return JSON.parse(execFileSync("node", [AUDIT, file, "--json"], { encoding: "utf8" }) || "[]");
  } catch (e) {
    // 違反があると exit 1 になるので、stdout から拾う。
    return JSON.parse(e.stdout || "[]");
  }
}
const rules = (bodyHtml) => audit(bodyHtml).map((f) => f.rule).sort();

// ---- 検出できること（偽陰性を防ぐ） ----

test("名前の無いボタン・リンクを検出する", () => {
  assert.deepEqual(rules("<button></button>"), ["button-no-name"]);
  assert.deepEqual(rules('<a href="/x"></a>'), ["link-no-name"]);
});

test("記号だけのボタンを検出する（読み上げで意味が伝わらない）", () => {
  assert.deepEqual(rules("<button>✕</button>"), ["button-symbol-only"]);
  assert.deepEqual(rules("<button>→</button>"), ["button-symbol-only"]);
});

test("ラベルの無い入力欄を検出する", () => {
  assert.deepEqual(rules('<input type="text">'), ["control-no-label"]);
  assert.deepEqual(rules("<select><option>a</option></select>"), ["control-no-label"]);
  assert.deepEqual(rules("<textarea></textarea>"), ["control-no-label"]);
});

test("壊れた参照・重複id・不正role・正のtabindexを検出する", () => {
  assert.deepEqual(rules('<div aria-labelledby="none"></div>'), ["broken-aria-reference"]);
  assert.deepEqual(rules('<label for="none">名前</label>'), ["broken-label-for"]);
  assert.deepEqual(rules('<p id="a"></p><p id="a"></p>'), ["duplicate-id", "duplicate-id"]);
  assert.deepEqual(rules('<div role="buttonn"></div>'), ["invalid-role"]);
  assert.deepEqual(rules('<div tabindex="3"></div>'), ["positive-tabindex"]);
});

test("alt の無い画像を検出する", () => {
  assert.deepEqual(rules('<img src="a.png">'), ["img-missing-alt"]);
});

test("aria-hidden の内側のフォーカス可能要素を検出する", () => {
  assert.deepEqual(rules('<div aria-hidden="true"><button>押す</button></div>'), ["focusable-in-aria-hidden"]);
  // 開始タグ直後に子が来る場合（過去に境界条件で取りこぼした）。
  assert.deepEqual(rules('<div aria-hidden="true"><a href="/x">行く</a></div>'), ["focusable-in-aria-hidden"]);
});

test("見出しレベルの飛びを検出する", () => {
  assert.deepEqual(rules("<h1>a</h1><h3>b</h3>"), ["heading-skip"]);
});

// ---- 検出してはいけないこと（偽陽性でゲートを止めない） ----

test("正しく書かれたUIは1件も報告しない", () => {
  assert.deepEqual(
    rules(
      '<label for="q">検索</label><input type="text" id="q">' +
      '<button aria-label="閉じる">✕</button>' +
      '<button>保存する</button>' +
      '<a href="/x">使い方</a>' +
      '<img src="a.png" alt="図">' +
      '<h1>見出し</h1><h2>小見出し</h2>' +
      '<div aria-hidden="true">飾り</div>',
    ),
    [],
  );
});

test("label で囲んだ入力欄はラベル済みとみなす（開始タグ直後でも）", () => {
  assert.deepEqual(rules('<label><input type="checkbox">音を鳴らす</label>'), []);
  assert.deepEqual(rules("<label>名前<input type=\"text\"></label>"), []);
});

test("ラベルの要らない input は報告しない", () => {
  assert.deepEqual(rules('<input type="hidden" name="a"><input type="submit" value="送信">'), []);
});

test("aria-hidden の中でも tabindex=-1 や disabled は報告しない", () => {
  assert.deepEqual(rules('<div aria-hidden="true"><button tabindex="-1">x</button></div>'), []);
  assert.deepEqual(rules('<div aria-hidden="true"><button disabled>x</button></div>'), []);
});

test("コメントアウトしたマークアップを実要素として拾わない", () => {
  // これが崩れると「消したはずの要素」で検査が落ち、原因が分からなくなる。
  assert.deepEqual(rules('<!-- <button></button> <img src="x.png"> <input type="text"> -->'), []);
  assert.deepEqual(rules("<!-- <button>\n  複数行\n</button> -->"), []);
});

test("コメントを潰しても行番号がずれない", () => {
  const found = audit("<!-- <button></button>\n     複数行のコメント -->\n<p>本文</p>\n<button></button>");
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, "button-no-name");
  // body の中身は2行目から始まるので、4行目の button は 5行目になる。
  assert.equal(found[0].line, 5, "コメントを空白で潰す際に改行を消すと行番号がずれる");
});

test("script の中の文字列にある <!-- でHTMLを壊さない", () => {
  const body = '<script>const s = "<!-- これはJSの文字列";</' + "script>\n<button></button>";
  assert.deepEqual(rules(body), ["button-no-name"], "script内の <!-- を境にHTMLを読み飛ばしてはいけない");
});

test("script / style の中身は走査しない", () => {
  // JSのテンプレート文字列に書かれたHTMLは静的な要素ではない。
  const body = "<script>const t = `<button></button><img src=\"a.png\">`;</" + "script>";
  assert.deepEqual(rules(body), []);
  assert.deepEqual(rules("<style>/* <button></button> */</style>"), []);
});

// ---- 公開HTML本体 ----

test("公開版 index.html に違反が無い", () => {
  let out = "";
  let code = 0;
  try {
    out = execFileSync("node", [AUDIT, "--json"], { encoding: "utf8" });
  } catch (e) {
    out = e.stdout || "";
    code = e.status;
  }
  const found = JSON.parse(out || "[]");
  assert.deepEqual(found, [], `違反: ${JSON.stringify(found, null, 2)}`);
  assert.equal(code, 0, "違反ゼロなら終了コードは0であるべき");
});

// ---- 学習の記録パネルのPC表示（1.0.95） -------------------------------------
// PC幅ではパネルが1080pxあるのにカレンダーは380pxしか使わず、左右に大きな空白が
// できていた。成績も下へ流れるため、カレンダーと同時に見られなかった。
// 広い画面のときだけ左右2段組にする。スマホ（1段組）は変えない。

const streakHtml = readFileSync(new URL("../publish/index.html", import.meta.url), "utf8");

function extractMediaBlock(condition) {
  const start = streakHtml.indexOf(`@media (${condition}) {`);
  if (start < 0) return "";
  let depth = 0;
  for (let i = streakHtml.indexOf("{", start); i < streakHtml.length; i += 1) {
    if (streakHtml[i] === "{") depth += 1;
    else if (streakHtml[i] === "}") {
      depth -= 1;
      if (depth === 0) return streakHtml.slice(start, i + 1);
    }
  }
  return "";
}

test("PC表示: 学習の記録は広い画面でだけ2段組にする", () => {
  const block = extractMediaBlock("min-width: 900px");
  assert.ok(block, "@media (min-width: 900px) のまとまりが見つからない");
  assert.match(
    block,
    /\.streak-panel\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) minmax\(0, 1fr\)/,
    "パネルを2列にしていない",
  );
  assert.match(block, /\.stats-block\s*\{[^}]*grid-column:\s*2/, "成績を右列に置いていない");
});

test("PC表示: 2段組の指定はメディアクエリの中だけにある（スマホを巻き込まない）", () => {
  // 1段組のままにしたいので、メディアクエリの外に 2列指定があってはいけない。
  const block = extractMediaBlock("min-width: 900px");
  const outside = streakHtml.replace(block, "");
  assert.doesNotMatch(
    outside,
    /\.streak-panel\s*\{[^}]*grid-template-columns/,
    "メディアクエリの外で .streak-panel に列指定がある＝スマホでも2段組になる",
  );
});

test("PC表示: 成績カードは列幅の下限で並べる（最後の行が欠けない）", () => {
  const block = extractMediaBlock("min-width: 900px");
  assert.match(
    block,
    /\.stats-grid\s*\{[^}]*repeat\(auto-fit, minmax\(200px, 1fr\)\)/,
    "3列固定のままだと5枚で 1+3+1 になり最後の行が欠ける",
  );
});

test("CSSの波括弧が対応している（セレクタの途中に割り込んでいない）", () => {
  const css = streakHtml.slice(streakHtml.indexOf("<style>") + 7, streakHtml.indexOf("</style>"));
  let depth = 0;
  for (const ch of css) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    assert.ok(depth >= 0, "閉じ括弧が多い");
  }
  assert.equal(depth, 0, "波括弧の対応が崩れている＝どこかのルールが壊れている");
});

test("CSS: セレクタの並びの途中に @規則 が割り込んでいない", () => {
  // 波括弧の対応だけでは、`.a,` の直後に `@media {...}` を差し込む壊し方を検出できない
  // （括弧は釣り合ったまま、セレクタの並びが壊れて後続のルールが丸ごと無効になる）。
  // 実際にこの壊し方をして、追加したスタイルが一切効かない状態を作ってしまったので、
  // その形を直接見る。カンマの次に来てよいのはセレクタだけで、@ は来ない。
  const css = streakHtml.slice(streakHtml.indexOf("<style>") + 7, streakHtml.indexOf("</style>"));
  const broken = /,\s*(?:\/\*[\s\S]*?\*\/\s*)*@/.exec(css);
  assert.equal(
    broken,
    null,
    broken ? `セレクタの並びに @規則 が割り込んでいる: ${css.slice(Math.max(0, broken.index - 60), broken.index + 60)}` : "",
  );
});

// ---------------------------------------------------------------------------
// CEFRの説明（1.0.96）
// A1〜C2は成績タブ・保存した単語の絞り込み・やさしい順の3か所に出るが、
// 記号だけでは何を意味するか分からない。レベル表を出す成績タブに説明を置き、
// 単語一覧のバッジはツールチップで同じ内容を出す。
// ---------------------------------------------------------------------------

test("CEFR: 6段階すべてに日本語の説明がある", () => {
  const start = streakHtml.indexOf("const CEFR_LEVEL_GUIDE = {");
  assert.ok(start > 0, "レベルの説明表が見つからない");
  const table = streakHtml.slice(start, streakHtml.indexOf("};", start));
  for (const level of ["A1", "A2", "B1", "B2", "C1", "C2"]) {
    assert.match(table, new RegExp(`${level}:\\s*\\{\\s*title:\\s*"[^"]+",\\s*detail:\\s*"[^"]+"`),
      `${level} の説明が無い`);
  }
});

test("CEFR: 説明は成績タブのレベル別カードのすぐ下に、全幅で出す", () => {
  // レベル別カードが出ていない（＝A1〜C2が画面に無い）ときは説明も出さない。
  assert.match(streakHtml, /function cefrGuideCard\(\)\s*\{\s*if \(statsCefrWords\(\)\.length === 0\) return "";/,
    "レベル別カードが無いときにも説明が出てしまう");
  assert.match(streakHtml, /statsCefrCard\(\),\s*\n\s*cefrGuideCard\(\),/,
    "レベル別カードの直後に置いていない");
  // 説明は横に長い文章なので、200px幅のカード列に押し込めず全幅にする。
  assert.match(streakHtml, /\.stats-card-wide\s*\{\s*grid-column:\s*1 \/ -1;/, "全幅にしていない");
  assert.match(streakHtml, /<summary>CEFR（A1〜C2）とは<\/summary>/, "説明の見出しが無い");
});

test("CEFR: 推定値であることを説明に明記する（公式のレベル表ではない）", () => {
  const start = streakHtml.indexOf("function cefrGuideMarkup()");
  const body = streakHtml.slice(start, streakHtml.indexOf("\n}", start));
  assert.match(body, /出現頻度からの推定/, "推定である旨が書かれていない");
  assert.match(body, /復習の間隔には影響しません/, "SRSに影響しないことが書かれていない");
});

test("CEFR: 英検の級は断定せず、1対1でないことを添える", () => {
  // 英検の各級のCEFR算出範囲は重なっていて、レベルと級は1対1に対応しない。
  // 「A2＝準2級の範囲」と言い切ると誤解を招くので、見当をつける目安として書く。
  const start = streakHtml.indexOf("const CEFR_LEVEL_GUIDE = {");
  const table = streakHtml.slice(start, streakHtml.indexOf("};", start));
  assert.doesNotMatch(table, /英検[^"]*級の範囲/, "級を断定している");
  assert.match(table, /英検でいえば準1級あたり/, "目安としての書き方になっていない");
  const guide = streakHtml.indexOf("function cefrGuideMarkup()");
  const body = streakHtml.slice(guide, streakHtml.indexOf("\n}", guide));
  assert.match(body, /1対1では対応しません/, "1対1でない旨の注記が無い");
});

test("CEFR: 単語一覧のバッジのツールチップにも同じ説明を出す", () => {
  const start = streakHtml.indexOf("function cefrTitle(");
  const body = streakHtml.slice(start, streakHtml.indexOf("\n}", start));
  assert.match(body, /cefrGuideText\(level\)/, "バッジのツールチップに説明を添えていない");
});
