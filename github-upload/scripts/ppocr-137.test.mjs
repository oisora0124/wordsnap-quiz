// 1.0.137: 端末内OCRを Tesseract.js から PP-OCRv6（onnxruntime-web）へ差し替えた。
//
// 実際の推論（モデル約31MB・WebAssembly）は Node のテストでは動かさない。実ブラウザでの確認は
// docs/browser-e2e.md の手順で行う。ここでは推論の前後にある、アプリ自身が書いた処理を
// 実コードを切り出して動かし、固定する。
//   1. 検出の後処理（確率マップ → 回転矩形）: 閾値・膨張・最小外接矩形・unclip
//   2. 認識の後処理（CTC の貪欲デコード）: blank と連続の畳み込み、空白クラス
//   3. 箱から入力欄の文字列への組み立て: 行のまとめ方・傾き・段組の自動判定
//   4. 写真の向きの判定: 縦長の箱が多いときだけ 90°/270° を試す
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// 関数を宣言ごと切り出す。from を渡すと、その位置より後ろで最初に見つかったものを返す
// （Worker 本体の中の入れ子の関数を取り出すため）。
function extractFunction(name, from = 0) {
  const start = html.indexOf(`function ${name}(`, from);
  if (start < 0) throw new Error(`function ${name} not found`);
  const paramOpen = html.indexOf("(", start);
  let paren = 0;
  let paramEnd = paramOpen;
  for (let i = paramOpen; i < html.length; i += 1) {
    if (html[i] === "(") paren += 1;
    else if (html[i] === ")") {
      paren -= 1;
      if (paren === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  const bodyBrace = html.indexOf("{", paramEnd);
  let depth = 0;
  for (let i = bodyBrace; i < html.length; i += 1) {
    if (html[i] === "{") depth += 1;
    else if (html[i] === "}") {
      depth -= 1;
      if (depth === 0) return html.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces for ${name}`);
}

const workerStart = html.indexOf("function ppocrWorkerMain(");
const workerSource = extractFunction("ppocrWorkerMain");

// Worker 本体の中の定数（const X = ...;）を、本物の値のまま取り出す。
function workerConst(name) {
  const match = workerSource.match(new RegExp(`const ${name} = [^;]+;`));
  if (!match) throw new Error(`worker const ${name} not found`);
  return match[0];
}

function loadWorkerPieces(names, consts, extra = "") {
  const pieces = [
    ...consts.map(workerConst),
    ...names.map((name) => extractFunction(name, workerStart)),
    extra,
    `globalThis.__w = { ${names.join(", ")} };`,
  ];
  const sandbox = { Math, Infinity, Int32Array, Uint8Array, Float32Array };
  new Script(pieces.join("\n\n"), { filename: "ppocr-worker-pieces.js" }).runInNewContext(sandbox);
  return sandbox.__w;
}

// ---- 1. 検出の後処理 ----

const detection = loadWorkerPieces(
  ["convexHull", "minAreaRect", "rectScore", "dilatedBitmap", "detectBoxes"],
  ["DET_THRESH", "DET_BOX_THRESH", "DET_UNCLIP_RATIO", "DET_MIN_SIZE"],
);

function probMap(width, height, fill) {
  const prob = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) prob[y * width + x] = fill(x, y);
  }
  return prob;
}

test("検出: 確率マップの文字領域ごとに、unclip で広げた回転矩形を1つ返す", () => {
  const width = 200;
  const height = 80;
  // 2つの横長の文字領域（1行目: x=20..119, y=10..21 / 2行目: x=30..169, y=50..61）
  const prob = probMap(width, height, (x, y) =>
    (x >= 20 && x < 120 && y >= 10 && y < 22) || (x >= 30 && x < 170 && y >= 50 && y < 62) ? 0.9 : 0.02,
  );
  const boxes = detection.detectBoxes(prob, width, height).sort((a, b) => a.cy - b.cy);
  assert.equal(boxes.length, 2);
  const [first, second] = boxes;
  // 膨張（2×2）で右下へ1画素広がる: 101×13 → unclip で 面積×1.6÷周長 ずつ外へ。
  const expected = (w, h) => {
    const d = (w * h * 1.6) / (2 * (w + h));
    return { w: w + 2 * d, h: h + 2 * d };
  };
  const e1 = expected(101, 13);
  assert.ok(Math.abs(first.w - e1.w) < 0.01 && Math.abs(first.h - e1.h) < 0.01, JSON.stringify(first));
  assert.ok(Math.abs(first.cx - 70.5) < 0.01 && Math.abs(first.cy - 16.5) < 0.01);
  assert.ok(Math.abs(second.cx - 100.5) < 0.01 && Math.abs(second.cy - 56.5) < 0.01);
  // 横書きなので幅方向 u は x 軸に一致する（向きの判定・切り出しがこれを前提にする）。
  for (const box of boxes) {
    assert.equal(box.ux, 1);
    assert.equal(box.uy, 0);
    // 膨張で広がった縁（確率0.02）も平均に入るので、領域内の0.9より少し下がる。
    assert.ok(box.score > 0.8);
  }
});

test("検出: 傾いた行は傾いたまま、幅方向を横に近い軸へそろえて返す", () => {
  const width = 240;
  const height = 120;
  const angle = (8 * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const prob = probMap(width, height, (x, y) => {
    const dx = x + 0.5 - 120;
    const dy = y + 0.5 - 60;
    const u = dx * cos + dy * sin;
    const v = -dx * sin + dy * cos;
    return Math.abs(u) <= 80 && Math.abs(v) <= 7 ? 0.95 : 0;
  });
  const [box] = detection.detectBoxes(prob, width, height);
  assert.ok(box);
  assert.ok(Math.abs(Math.atan2(box.uy, box.ux) - angle) < 0.03, `angle ${Math.atan2(box.uy, box.ux)}`);
  assert.ok(box.w > box.h * 3, "幅と高さが入れ替わっている（行が縦長として扱われる）");
});

test("検出: 小さすぎる点や、確率の低い領域は箱にしない", () => {
  const width = 60;
  const height = 40;
  const prob = probMap(width, height, (x, y) => {
    if (x >= 5 && x < 7 && y >= 5 && y < 7) return 0.9; // 2×2 の点（ノイズ）
    if (x >= 20 && x < 50 && y >= 20 && y < 30) return 0.35; // 閾値は越えるが箱の平均が低い
    return 0;
  });
  // vm の中で作った配列は別レルムなので、deepEqual ではなく長さで比べる。
  assert.equal(detection.detectBoxes(prob, width, height).length, 0);
});

test("検出: 縦横の閾値と unclip の値は RapidOCR の PP-OCRv6 既定と同じ", () => {
  // 値を変えると読み取りの結果が変わる。変えるなら実画像で比べ直すこと（assets/ppocr/VENDOR.md）。
  assert.match(workerSource, /const DET_MEAN = 0\.5;/);
  assert.match(workerSource, /const DET_STD = 0\.5;/);
  assert.match(workerSource, /const DET_THRESH = 0\.3;/);
  assert.match(workerSource, /const DET_BOX_THRESH = 0\.5;/);
  assert.match(workerSource, /const DET_UNCLIP_RATIO = 1\.6;/);
  assert.match(workerSource, /const REC_HEIGHT = 48;/);
});

// ---- 2. 認識の後処理（CTC） ----

const ctc = loadWorkerPieces(["decodeCtc"], [], 'let dictionary = ["", "a", "p", "l", "e", "り", " "];');

function ctcFrames(indices, classes = 7) {
  const data = new Float32Array(indices.length * classes);
  indices.forEach((index, t) => {
    for (let c = 0; c < classes; c += 1) data[t * classes + c] = c === index ? 0.9 : 0.1 / (classes - 1);
  });
  return data;
}

test("CTC: 連続する同じ番号は1文字、blank を挟めば2文字。末尾の空白クラスは半角スペース", () => {
  // a p p _ p l e ␣ り  → "apple り"
  const indices = [1, 2, 2, 0, 2, 3, 4, 6, 5];
  const result = ctc.decodeCtc(ctcFrames(indices), indices.length, 7, 0);
  assert.equal(result.text, "apple り");
  assert.ok(Math.abs(result.score - 0.9) < 1e-6);
});

test("CTC: すべて blank なら空文字・確信度0（その箱は結果から落とす）", () => {
  const result = ctc.decodeCtc(ctcFrames([0, 0, 0]), 3, 7, 0);
  assert.deepEqual({ ...result }, { text: "", score: 0 });
  assert.match(workerSource, /\.filter\(\(box\) => box\.text\)/);
});

// ---- 3. 箱 → 入力欄の文字列 ----

const layoutNames = ["ppocrPageSkew", "ppocrRows", "ppocrRowsText", "ppocrColumnGutter", "ppocrColumnsText", "assemblePpocrText", "ppocrConfidence"];
const metricsNames = ["isOcrHeadwordLine", "isOcrMeaningLine", "isOcrPairLine", "ocrTextMetrics"];
const layout = (() => {
  const pieces = [...layoutNames, ...metricsNames].map((name) => extractFunction(name));
  pieces.push(`globalThis.__l = { ${[...layoutNames, ...metricsNames].join(", ")} };`);
  const sandbox = { Math };
  new Script(pieces.join("\n\n"), { filename: "ppocr-layout.js" }).runInNewContext(sandbox);
  return sandbox.__l;
})();

// 箱を作る。x0 は左端、y は行の中心、傾き angle（ラジアン）は行の向き。
function box(text, x0, y, w, { h = 30, angle = 0, score = 0.98 } = {}) {
  const ux = Math.cos(angle);
  const uy = Math.sin(angle);
  const cxLocal = x0 + w / 2;
  // ページ全体を原点まわりに angle だけ回した位置へ置く（傾いた写真の再現）。
  return { text, cx: cxLocal * ux - y * uy, cy: cxLocal * uy + y * ux, w, h, ux, uy, score };
}

const assemble = (boxes, mode, width = 1000, height = 1400) =>
  layout.assemblePpocrText(boxes, mode, width, height, layout.ocrTextMetrics);

test("組み立て: 同じ高さの箱を1行にまとめ、左から並べる（番号・見出し語・訳）", () => {
  const boxes = [
    box("りんご", 400, 100, 120),
    box("apple", 120, 102, 150),
    box("1", 60, 99, 20, { h: 26 }),
    box("abandon", 120, 160, 190),
    box("2", 60, 160, 20, { h: 26 }),
    box("捨てる、見捨てる", 400, 158, 300),
  ];
  assert.equal(assemble(boxes, "auto"), "1 apple りんご\n2 abandon 捨てる、見捨てる");
});

test("組み立て: 写真が傾いていても、行の向きの中央値で打ち消して同じ行にまとめる", () => {
  const angle = (3 * Math.PI) / 180;
  const words = [["apple", "りんご"], ["ability", "能力"], ["absorb", "吸収する"], ["accurate", "正確な"]];
  const boxes = words.flatMap(([term, meaning], index) => [
    box(term, 100, 100 + index * 45, 160, { angle }),
    box(meaning, 700, 100 + index * 45, 160, { angle }),
  ]);
  // 横に600離れると、3°の傾きで高さが約31ずれる（行の間隔45の2/3）。打ち消さないと隣の行へ混ざる。
  assert.equal(assemble(boxes, "one"), words.map((pair) => pair.join(" ")).join("\n"));
});

test("組み立て: 自動は、2段組のときだけ左の段→右の段の順にする", () => {
  const left = [["apple", "りんご"], ["ability", "能力"], ["absorb", "吸収する"]];
  const right = [["benefit", "利益"], ["brief", "短い"], ["capable", "能力がある"]];
  const boxes = [];
  left.forEach(([term, meaning], index) => {
    boxes.push(box(term, 40, 100 + index * 45, 140), box(meaning, 220, 100 + index * 45, 160));
  });
  right.forEach(([term, meaning], index) => {
    boxes.push(box(term, 540, 100 + index * 45, 140), box(meaning, 720, 100 + index * 45, 160));
  });
  const expected = [...left, ...right].map((pair) => pair.join(" ")).join("\n");
  assert.equal(assemble(boxes, "auto"), expected);
  assert.equal(assemble(boxes, "two"), expected);
  // 1列を指定したら、行ごとに左右をつなげる（利用者の指定を優先）。
  assert.equal(assemble(boxes, "one").split("\n")[0], "apple りんご benefit 利益");
});

test("組み立て: 見出し語と訳の間の空白を段組と取り違えない（1列の単語表）", () => {
  // 見出し語の列と訳の列の間には、どの箱にもかからない縦の帯がある。
  // ここで分けると「見出し語だけの段」と「訳だけの段」になり、組が1つも取れない。
  const words = [["apple", "りんご"], ["abandon", "捨てる"], ["ability", "能力"], ["absorb", "吸収する"]];
  const boxes = words.flatMap(([term, meaning], index) => [
    box(term, 100, 100 + index * 45, 180),
    box(meaning, 500, 100 + index * 45, 160),
  ]);
  assert.equal(assemble(boxes, "auto"), words.map((pair) => pair.join(" ")).join("\n"));
});

test("組み立て: 確信度の低い箱は使わない。確信度は文字数で重み付けした平均（0〜100）", () => {
  const boxes = [box("apple", 100, 100, 150), box("りんご", 400, 100, 120), box("xq#", 700, 100, 60, { score: 0.3 })];
  assert.equal(assemble(boxes, "auto"), "apple りんご");
  const confidence = layout.ppocrConfidence([
    { text: "abcd", score: 1 },
    { text: "ab", score: 0.4 },
  ]);
  assert.ok(Math.abs(confidence - 80) < 1e-9);
});

// ---- 4. 写真の向き ----

function loadOrientation(readings) {
  const pieces = [
    ...[...layoutNames, ...metricsNames, "scoreOcrResult", "ocrResultText"].map((name) => extractFunction(name)),
    // 切り出しは "function" から始まるので、async を付け直す。
    `async ${extractFunction("detectOrientation")}`,
    `const OCR_PROBE_SIDE = 1024;`,
    `let ocrPhaseLabel = "";`,
    `function ensureOcrRunActive() {}`,
    `function setOcrRunStage() {}`,
    `function downscaleCanvas(canvas) { return canvas; }`,
    `function rotateCanvas(canvas, angle) { return { angle }; }`,
    `function releaseTemporaryCanvas() {}`,
    `globalThis.__o = detectOrientation;`,
  ];
  const sandbox = { Math };
  new Script(pieces.join("\n\n"), { filename: "ppocr-orientation.js" }).runInNewContext(sandbox);
  const asked = [];
  const engine = {
    async recognize(canvas, options) {
      asked.push(canvas.angle);
      assert.equal(options.maxBoxes, 16, "向きの判定は大きい箱だけを読む");
      return { width: 1000, height: 1400, boxes: readings[canvas.angle] || [] };
    },
  };
  return { detect: () => sandbox.__o(engine, { width: 1000, height: 1400 }, {}), asked };
}

const uprightPairs = [
  box("apple", 100, 100, 150),
  box("りんご", 400, 100, 120),
  box("ability", 100, 150, 160),
  box("能力", 400, 150, 80),
];

test("向き: 正立で読めていれば、ほかの向きは試さない", async () => {
  const { detect, asked } = loadOrientation({ 0: uprightPairs });
  assert.equal(await detect(), 0);
  assert.deepEqual(asked, [0]);
});

test("向き: 箱の大半が縦長なら 90°/270° を試し、読みの点数が高い方を採る", async () => {
  // 横倒しの写真では、行の箱が縦長（w < h）になり、正立のままでは読めない。
  const sideways = [
    { text: "ʎ", cx: 100, cy: 200, w: 30, h: 150, ux: 1, uy: 0, score: 0.3 },
    { text: "ɹ", cx: 150, cy: 200, w: 30, h: 160, ux: 1, uy: 0, score: 0.3 },
  ];
  const { detect, asked } = loadOrientation({ 0: sideways, 90: [], 270: uprightPairs });
  assert.equal(await detect(), 270);
  assert.deepEqual(asked, [0, 90, 270]);
});

test("向き: 横長でも確信度が低ければ 180° を試す", async () => {
  const garbled = [box("ǝlddɐ", 100, 100, 150, { score: 0.6 }), box("ぐんり", 400, 100, 120, { score: 0.6 })];
  const { detect, asked } = loadOrientation({ 0: garbled, 180: uprightPairs });
  assert.equal(await detect(), 180);
  assert.deepEqual(asked, [0, 180]);
});

// ---- 配線 ----

test("配線: Worker は関数の文字列から blob: で作り、版付きの自前アセットを渡す", () => {
  const create = extractFunction("createPpocrEngine");
  assert.match(create, /const source = `\(\$\{ppocrWorkerMain\.toString\(\)\}\)\(\);`;/);
  assert.match(create, /new Blob\(\[source\], \{ type: "text\/javascript" \}\)/);
  assert.match(create, /ortBase: ORT_ASSET_BASE,/);
  // 画像は複製せずに渡す（数十MBのコピーを避ける）。
  assert.match(create, /\[full\.data\.buffer, det\.data\.buffer\]/);
});

test("配線: スレッドを起動できない環境では1スレッドで作り直す", () => {
  const get = extractFunction("getOcrWorker");
  assert.match(get, /if \(threads > 1\) \{\s*threads = 1;\s*continue;\s*\}/);
  const count = extractFunction("ocrThreadCount");
  assert.match(count, /if \(!self\.crossOriginIsolated\) return 1;/);
});

test("配線: Worker 本体は外側の変数を使わない（blob: の Worker へは関数の文字列しか渡らない）", () => {
  // 使ってよいのは Worker 自身のグローバル（self・importScripts・fetch など）と、関数内で宣言したものだけ。
  // アプリ側の関数・定数（elements, setStatus, ORT_ASSET_BASE など）を参照すると、Worker では ReferenceError になる。
  for (const name of ["elements", "setStatus", "ORT_ASSET_BASE", "PPOCR_ASSET_BASE", "ocrTextMetrics", "activeOcrRun", "document", "window"]) {
    assert.ok(!new RegExp(`\\b${name}\\b`).test(workerSource), `Worker 本体が ${name} を参照している`);
  }
});
