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

test("PC表示: 学習の記録は十分に広い画面でだけ2段組にする", () => {
  const block = extractMediaBlock("min-width: 1000px");
  assert.ok(block, "@media (min-width: 1000px) のまとまりが見つからない");
  // カレンダーは7列の正方形なので広げても情報が増えない。幅は成績側に回す。
  assert.match(
    block,
    /\.streak-panel\s*\{[^}]*grid-template-columns:\s*minmax\(0, 400px\) minmax\(0, 1fr\)/,
    "カレンダーの列幅を抑えて成績へ回していない",
  );
  assert.match(block, /\.streak-panel \.stats-block\s*\{[^}]*grid-column:\s*2/, "成績を右列に置いていない");
});

test("PC表示: カレンダー一式は1つのまとまりで置く（行が引き伸ばされない）", () => {
  // バラバラの要素を左列に並べると、背の高い成績に合わせて各行が引き伸ばされ、
  // カレンダーの間に大きな空白ができる。まとまりにして1行へ置く。
  assert.match(streakHtml, /<div class="streak-cal-block">/, "カレンダー一式がまとまりになっていない");
  assert.match(
    streakHtml,
    /\.streak-cal-block\s*\{[^}]*display:\s*grid;[^}]*gap:\s*12px/,
    "まとまりの中の積み方がパネル本体と違う＝1段組の見え方が変わる",
  );
  const block = extractMediaBlock("min-width: 1000px");
  assert.match(block, /\.streak-cal-block\s*\{[^}]*grid-row:\s*3/, "成績と同じ行に置いていない");
  assert.match(block, /\.streak-panel \.stats-block\s*\{[^}]*grid-row:\s*3/, "成績と同じ行に置いていない");
  assert.doesNotMatch(block, /grid-row:\s*3 \/ span/, "行をまたがせると左列の行が引き伸ばされる");
});

test("PC表示: 2段組の指定はメディアクエリの中だけにある（スマホを巻き込まない）", () => {
  // 1段組のままにしたいので、メディアクエリの外に 2列指定があってはいけない。
  const block = extractMediaBlock("min-width: 1000px");
  const outside = streakHtml.replace(block, "");
  assert.doesNotMatch(
    outside,
    /\.streak-panel\s*\{[^}]*grid-template-columns/,
    "メディアクエリの外で .streak-panel に列指定がある＝スマホでも2段組になる",
  );
});

test("PC表示: 成績カードは段組で上から詰める（行の穴を作らない）", () => {
  // カードの高さはまちまち（単語帳の冊数、CEFR判定済みの語数、苦手語の有無で変わる）。
  // 格子だと行の高さが一番背の高いカードに決まり、短いカードの下に穴が空く。
  const block = extractMediaBlock("min-width: 1000px");
  assert.match(
    block,
    /\.streak-panel \.stats-grid\s*\{[^}]*display:\s*block;[^}]*columns:\s*3 240px/,
    "段組にしていない（格子のままだと行の穴が残る）",
  );
  // 240px は「学習量の推移」「レベル別（CEFR）」の見出しが省略されない幅。
  assert.match(block, /\.streak-panel \.stats-grid > \*\s*\{[^}]*break-inside:\s*avoid/,
    "カードが段をまたいで割れる");
});

test("PC表示: 段組で全幅にするのは、先頭に固まる案内カードだけ", () => {
  const block = extractMediaBlock("min-width: 1000px");
  // 復帰・確信度・今日の復習は「いま何をすればよいか」の帯。並びの先頭側に固まっていて
  // 出たり出なかったりするので、まとめて全幅にする。1枚だけ全幅にすると、
  // 他の2枚が出た回にその2枚が段組へ入り、3列のうち1枚ぶんが空く。
  for (const cls of ["is-recovery", "is-confidence", "is-review"]) {
    assert.match(
      block,
      new RegExp(`\\.streak-panel \\.stats-card\\.${cls}[^{]*\\{[^}]*column-span:\\s*all`),
      `${cls} を全幅にしていない`,
    );
  }
  // CEFRの説明は中ほどにある折りたたみ。全幅にすると開いた瞬間に成績全体が伸びる。
  assert.match(block, /\.streak-panel \.stats-card-wide\s*\{[^}]*column-span:\s*none/,
    "中ほどの折りたたみを全幅にすると、開いたときに後続のカードが飛ぶ");
});

test("PC表示: 全幅にする案内カードは、実際に並びの先頭側に固まっている", () => {
  // CSSだけでは「先頭側に固まっている」ことを保証できないので、生成側の並びも見る。
  const start = streakHtml.indexOf("const cards = [");
  const list = streakHtml.slice(start, streakHtml.indexOf("].filter(Boolean)", start));
  const order = [...list.matchAll(/stats(\w+)Card\(/g)].map((m) => m[1]);
  const banners = ["Recovery", "Confidence", "TodayReview"];
  // 3枚とも並びに居ることまで見る。1枚でも消えると「先頭に固まっている」は
  // 自動的に成り立ってしまい、この検査が意味を失う。
  for (const b of banners) {
    assert.ok(order.includes(b), `案内カード stats${b}Card() が並びから消えている: ${order.join(" → ")}`);
  }
  const lastBanner = Math.max(...banners.map((b) => order.indexOf(b)));
  const firstOther = order.findIndex((name) => !banners.includes(name));
  assert.ok(firstOther >= 0, "普通のカードが1枚も無い");
  assert.ok(
    lastBanner < firstOther,
    `案内カードの後ろに普通のカードが混ざると段に穴ができる: ${order.join(" → ")}`,
  );
});

test("PC表示: 広い画面では学習の記録だけ本文の幅を超えて広げる", () => {
  const block = extractMediaBlock("min-width: 1240px");
  assert.ok(block, "@media (min-width: 1240px) のまとまりが見つからない");
  assert.match(block, /\.streak-panel\s*\{[^}]*width:\s*min\(1400px, calc\(100vw - 40px\)\)/,
    "パネルを広げていない");
  // 本文（.shell）ごと広げると取り込み欄や単語一覧の行が長くなりすぎる。
  assert.doesNotMatch(block, /\.shell\s*\{/, "本文全体を広げてはいけない");
  // はみ出した分を左右へ均等に戻さないと、右にずれて横スクロールが出る。
  const rule = block.slice(block.indexOf(".streak-panel"));
  for (const side of ["margin-left", "margin-right"]) {
    assert.match(rule, new RegExp(`${side}:\\s*calc\\(\\(100% - min\\(1400px, 100vw - 40px\\)\\) / 2\\)`),
      `${side} で戻していない`);
  }
});

// 1.0.95 で入れたPC用の指定は、同じセレクタの基本ルールがCSSの後ろにあったため
// 後ろ勝ちで打ち消され、まったく効いていなかった（成績は3列200px固定のままだった）。
// 波括弧の対応も @規則の割り込みも正常なので、既存の検査では気づけなかった。
//
// ルールの手前にはコメントが付いているので、先にコメントを落としてから読む。
// 落とさないとセレクタにコメントが混ざり、後続ルールとの突き合わせが必ず外れて
// 何も検出しない検査になってしまう（Codexの指摘）。
function cssWithoutComments() {
  const css = streakHtml.slice(streakHtml.indexOf("<style>") + 7, streakHtml.indexOf("</style>"));
  return stripComments(css);
}

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// メディアクエリの中の各ルールを { セレクタ1つ, 宣言したプロパティ } に分解する。
// `.a, .b { ... }` は .a と .b の2件として扱う。コメントは先に落としてあること。
function mediaRuleDeclarations(block) {
  const out = [];
  for (const rule of block.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const props = [...rule[2].matchAll(/(^|;)\s*([a-z-]+)\s*:/g)].map((m) => m[2]);
    if (props.length === 0) continue;
    for (const selector of rule[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      if (selector.startsWith("@")) continue;
      out.push({ selector, props });
    }
  }
  return out;
}

// 検査の本体。CSS全体と、その中のメディアクエリのまとまりを受け取り、
// 「同じセレクタ・同じプロパティを、後ろの top-level ルールが打ち消している」組を返す。
// テストから直接呼べる形にしてあるのは、この関数が黙って空配列を返すようになっても
// 本番のCSSが正しい限りテストが緑のままになってしまうため（Codexの指摘）。
// 下の自己テストが、壊れたCSSを渡して非空が返ることを確かめる。
function findOverriddenDeclarations(css, block, label = "") {
  const problems = [];
  const at = css.indexOf(block);
  if (at < 0) return [`${label} のまとまりをCSSの中に見つけられない`];
  const after = css.slice(at + block.length);
  for (const { selector, props } of mediaRuleDeclarations(block)) {
    // 同じセレクタ「だけ」の後続ルール（＝同じ強さ）を探す。より詳しいセレクタは負けない。
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    for (const later of after.matchAll(new RegExp(`(^|\\}|,|;)\\s*${escaped}\\s*\\{([^{}]*)\\}`, "g"))) {
      for (const prop of props) {
        if (new RegExp(`(^|;)\\s*${prop}\\s*:`).test(later[2])) {
          problems.push(`${label} の ${selector} { ${prop} } が後ろの同名ルールに打ち消される`);
        }
      }
    }
  }
  return problems;
}

test("CSS: メディアクエリの指定が、後ろの同じセレクタに打ち消されていない", () => {
  const css = cssWithoutComments();
  const problems = [];
  for (const condition of ["min-width: 1000px", "min-width: 1240px"]) {
    const raw = extractMediaBlock(condition);
    assert.ok(raw, `@media (${condition}) が見つからない`);
    const block = stripComments(raw);
    assert.ok(mediaRuleDeclarations(block).length > 0, `@media (${condition}) からルールを読み取れていない`);
    problems.push(...findOverriddenDeclarations(css, block, condition));
  }
  assert.deepEqual(problems, [], problems.join(" / "));
});

// 上の検査そのものが機能しているかを、既知の壊れ方で確かめる。
// 1.0.95 では PC用の指定が後ろの基本ルールに打ち消されて丸ごと効いていなかったので、
// その形を作って、検査本体（findOverriddenDeclarations）が実際に見つけることを見る。
test("CSS: 打ち消しの検査は、実際に打ち消されている形を見つけられる", () => {
  const broken = stripComments(`
  /* ルールの手前のコメント */
  @media (min-width: 1000px) {
    /* ここにもコメント */
    .streak-panel .stats-grid { columns: 3 240px; }
    .stats-block, .foo { margin-top: 0; }
  }
  .stats-block {
    margin-top: 14px;
  }
  .streak-panel .stats-grid {
    columns: 2 100px;
  }
`);
  const block = broken.slice(broken.indexOf("@media"), broken.lastIndexOf("}", broken.indexOf(".stats-block {")) + 1);
  const found = findOverriddenDeclarations(broken, block, "自己テスト");
  assert.ok(
    found.some((m) => m.includes(".stats-block") && m.includes("margin-top")),
    `後ろの .stats-block { margin-top } を検出できていない: ${JSON.stringify(found)}`,
  );
  assert.ok(
    found.some((m) => m.includes(".streak-panel .stats-grid") && m.includes("columns")),
    `後ろの .streak-panel .stats-grid { columns } を検出できていない: ${JSON.stringify(found)}`,
  );
  // より詳しいセレクタ（クラス2つ）は、クラス1つの後続ルールに負けない＝検出しない
  assert.ok(!found.some((m) => m.includes(".foo")), `打ち消されていない .foo を誤検出している: ${JSON.stringify(found)}`);
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
