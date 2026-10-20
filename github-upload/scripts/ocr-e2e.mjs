#!/usr/bin/env node
// 端末内OCR（PP-OCRv6）を実ブラウザで通す確認（1.0.137）。npm test には入れていない。
//
// 何をするか:
//   1. Chromium で単語帳風のページを描き、写真の代わりの画像を作る
//      （1列・2列・番号付き・傾き・ぼかし・影・JPEG劣化、さらに 90°/180°/270° 回転）
//   2. scripts/serve-local.mjs で配信したアプリを開き、画像を選んで「端末内OCRで読む」を押す
//   3. 入力欄に入った文字列のうち、「英単語と訳が同じ行に正しく並んだ組」を数える
//
// 使い方（先に別の端末で `node scripts/serve-local.mjs` を起動しておく）:
//   node scripts/ocr-e2e.mjs              既定の設定で全画像
//   HIACC=1 node scripts/ocr-e2e.mjs      高精度モードで
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/ocr-e2e.mjs
//
// 前提: Playwright と Chromium、日本語フォント（IPAGothic など）。
// モデルや前処理の値を変えたら必ず回し、全組が読めることを確かめる（assets/ppocr/VENDOR.md）。
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const APP_URL = process.env.APP_URL || "http://localhost:8788/";

const WORDS = [
  ["apple", "りんご"], ["abandon", "捨てる、見捨てる"], ["ability", "能力"], ["absorb", "吸収する"],
  ["accurate", "正確な"], ["achieve", "達成する"], ["acquire", "獲得する"], ["adapt", "適応する"],
  ["adequate", "十分な、適切な"], ["admire", "称賛する"], ["advantage", "利点、有利"], ["afford", "余裕がある"],
  ["agriculture", "農業"], ["ancient", "古代の"], ["anxiety", "不安、心配"], ["apparent", "明らかな"],
  ["appreciate", "感謝する、正しく理解する"], ["approach", "近づく、取り組み方"], ["argue", "主張する、議論する"],
  ["arrange", "手配する、並べる"], ["assume", "仮定する、思い込む"], ["attempt", "試みる"], ["attitude", "態度"],
  ["available", "利用できる"], ["avoid", "避ける"], ["behavior", "振る舞い、行動"], ["benefit", "利益、恩恵"],
  ["brief", "短い、簡潔な"], ["capable", "能力がある"], ["challenge", "挑戦、課題"], ["circumstance", "状況、事情"],
  ["colleague", "同僚"], ["commit", "犯す、約束する"], ["compare", "比較する"], ["concentrate", "集中する"],
  ["consequence", "結果、影響"], ["considerable", "かなりの"], ["contribute", "貢献する"], ["convenient", "便利な"],
  ["crucial", "極めて重要な"],
];

const VARIANTS = [
  { name: "one-col-numbered", cols: 1, n: 24, numbered: true, font: 18, rot: 0, blur: 0, shadow: false, quality: 92, scale: 2 },
  { name: "one-col-small", cols: 1, n: 40, numbered: false, font: 13, rot: 0, blur: 0, shadow: false, quality: 90, scale: 2 },
  { name: "two-col", cols: 2, n: 40, numbered: true, font: 15, rot: 0, blur: 0, shadow: false, quality: 90, scale: 2 },
  { name: "tilt-blur-shadow", cols: 1, n: 24, numbered: true, font: 17, rot: 2.5, blur: 0.9, shadow: true, quality: 70, scale: 2 },
  { name: "two-col-tilt-shadow", cols: 2, n: 40, numbered: false, font: 15, rot: -1.5, blur: 0.6, shadow: true, quality: 75, scale: 2 },
  { name: "one-col-lowres", cols: 1, n: 24, numbered: true, font: 11, rot: 0.8, blur: 0.5, shadow: false, quality: 60, scale: 1.2 },
  // ページの向きの判定（写真を横倒し・逆さに撮った場合）
  { name: "rot90-one-col-numbered", base: "one-col-numbered", turn: 90 },
  { name: "rot270-two-col", base: "two-col", turn: 270 },
  { name: "rot180-tilt-blur-shadow", base: "tilt-blur-shadow", turn: 180 },
];

function pageHtml(variant) {
  const list = WORDS.slice(0, variant.n);
  const perColumn = Math.ceil(list.length / variant.cols);
  const columns = [];
  for (let column = 0; column < variant.cols; column += 1) {
    const rows = list
      .slice(column * perColumn, (column + 1) * perColumn)
      .map(([term, meaning], index) =>
        `<tr>${variant.numbered ? `<td class=n>${column * perColumn + index + 1}</td>` : ""}<td class=t>${term}</td><td class=m>${meaning}</td></tr>`,
      )
      .join("");
    columns.push(`<table>${rows}</table>`);
  }
  const shadow = variant.shadow
    ? `<div style="position:absolute;inset:0;background:linear-gradient(110deg,rgba(0,0,0,.35),rgba(0,0,0,0) 45%,rgba(0,0,0,.12))"></div>`
    : "";
  return `<html><body style="margin:0;background:#777"><div id=page style="width:${variant.cols === 2 ? 900 : 620}px;padding:40px;margin:30px;background:#fbf8f0;transform:rotate(${variant.rot}deg);filter:blur(${variant.blur}px);font-family:'IPAGothic',sans-serif;font-size:${variant.font}px;color:#222;position:relative;display:flex;gap:40px">${columns.join("")}${shadow}</div><style>td{padding:${variant.font * 0.25}px ${variant.font * 0.6}px} td.n{color:#666} td.t{font-weight:bold;font-family:'DejaVu Serif',serif} table{border-collapse:collapse}</style></body></html>`;
}

async function makeImages(browser, directory) {
  const images = {};
  const truth = {};
  for (const variant of VARIANTS.filter((item) => !item.base)) {
    const page = await browser.newPage({ deviceScaleFactor: variant.scale, viewport: { width: 1200, height: 2000 } });
    await page.setContent(pageHtml(variant));
    const box = await (await page.$("#page")).boundingBox();
    const buffer = await page.screenshot({
      type: "jpeg",
      quality: variant.quality,
      clip: { x: 0, y: 0, width: box.x + box.width + 40, height: box.y + box.height + 40 },
    });
    await page.close();
    images[variant.name] = buffer;
    truth[variant.name] = WORDS.slice(0, variant.n);
  }
  // 回転した画像はブラウザの Canvas で作る（外部の画像処理ツールに頼らない）。
  const page = await browser.newPage();
  for (const variant of VARIANTS.filter((item) => item.base)) {
    const base64 = images[variant.base].toString("base64");
    const rotated = await page.evaluate(async ({ base64, turn }) => {
      const image = new Image();
      image.src = `data:image/jpeg;base64,${base64}`;
      await image.decode();
      const swap = turn === 90 || turn === 270;
      const canvas = document.createElement("canvas");
      canvas.width = swap ? image.height : image.width;
      canvas.height = swap ? image.width : image.height;
      const ctx = canvas.getContext("2d");
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((turn * Math.PI) / 180);
      ctx.drawImage(image, -image.width / 2, -image.height / 2);
      return canvas.toDataURL("image/jpeg", 0.88).split(",")[1];
    }, { base64, turn: variant.turn });
    images[variant.name] = Buffer.from(rotated, "base64");
    truth[variant.name] = truth[variant.base];
  }
  await page.close();
  const paths = {};
  for (const [name, buffer] of Object.entries(images)) {
    paths[name] = join(directory, `${name}.jpg`);
    writeFileSync(paths[name], buffer);
  }
  return { paths, truth };
}

function countPairs(text, pairs) {
  const compact = (value) => value.replace(/\s+/g, "");
  const lines = text.split("\n");
  let count = 0;
  for (const [term, meaning] of pairs) {
    const termPattern = new RegExp(`(^|[^A-Za-z])${term}([^A-Za-z]|$)`);
    if (lines.some((line) => termPattern.test(line) && compact(line).includes(compact(meaning)))) count += 1;
  }
  return count;
}

const browser = await chromium.launch();
const directory = mkdtempSync(join(tmpdir(), "wordbank-ocr-e2e-"));
const { paths, truth } = await makeImages(browser, directory);
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const problems = [];
page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
await page.goto(APP_URL);
console.log(`crossOriginIsolated: ${await page.evaluate(() => crossOriginIsolated)}`);
await page.evaluate(() => {
  document.querySelector(".ocr-details").open = true;
});
if (process.env.HIACC === "1") {
  await page.evaluate(() => {
    const toggle = document.querySelector("#hiAccToggle");
    if (!toggle.checked) toggle.click();
  });
}
let total = 0;
let read = 0;
for (const [name, path] of Object.entries(paths)) {
  await page.evaluate(() => {
    document.querySelector("#ocrText").value = "";
  });
  await page.setInputFiles("#imageInput", path);
  await page.waitForFunction(() => !document.querySelector("#ocrButton").disabled, null, { timeout: 30000 });
  const startedAt = Date.now();
  await page.evaluate(() => document.querySelector("#ocrButton").click());
  await page.waitForFunction(
    () => document.querySelector("#ocrProgress").hidden && !document.querySelector("#ocrButton").disabled,
    null,
    { timeout: 300000, polling: 250 },
  );
  const text = await page.evaluate(() => document.querySelector("#ocrText").value);
  const pairs = countPairs(text, truth[name]);
  total += truth[name].length;
  read += pairs;
  console.log(`${name.padEnd(26)} ${String(pairs).padStart(2)}/${truth[name].length}  ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
}
console.log(`合計 ${read}/${total}`);
if (problems.length) console.log(problems.join("\n"));
await browser.close();
process.exit(read === total && problems.length === 0 ? 0 : 1);
