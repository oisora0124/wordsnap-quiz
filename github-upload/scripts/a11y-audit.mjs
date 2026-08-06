#!/usr/bin/env node
// publish/index.html のアクセシビリティ静的検査。npm依存を増やさないため自前の
// タグ走査で実装している（jsdom / axe-core は node_modules を持ち込むので使わない）。
//
// ここで見るのは「HTMLの構造だけで機械判定できるもの」に限る。
// フォーカス移動や aria-live の実際の読み上げは静的には判定できないので対象外。
// 検出できるのは WCAG 2.1 の 1.1.1(非テキスト), 2.4.6(見出しとラベル),
// 4.1.2(名前・役割・値) に対応する範囲。
//
// 使い方:
//   node scripts/a11y-audit.mjs            違反があれば exit 1
//   node scripts/a11y-audit.mjs --json     機械可読な出力

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// 検査対象は既定で公開版。検査そのものの変異テストのために引数で差し替えられる。
const override = process.argv.slice(2).find((a) => !a.startsWith("--"));
const TARGET = override || path.join(here, "..", "publish", "index.html");

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

// 内容をHTMLとして解釈しない要素。中のテキストは走査対象から外す。
const RAW_TEXT = new Set(["script", "style"]);

// テキストとして意味を持たない記号だけのラベルを弾くための判定。
// 絵文字・矢印・記号・空白しか無いボタンは、読み上げでは無音か記号名になる。
const MEANINGFUL_TEXT = /[\p{L}\p{N}]/u;

// role の許容値（WAI-ARIA 1.2 の抽象ロールを除いたもの）。
const VALID_ROLES = new Set([
  "alert", "alertdialog", "application", "article", "banner", "blockquote",
  "button", "caption", "cell", "checkbox", "code", "columnheader", "combobox",
  "complementary", "contentinfo", "definition", "deletion", "dialog",
  "document", "emphasis", "feed", "figure", "form", "generic", "grid",
  "gridcell", "group", "heading", "img", "insertion", "link", "list",
  "listbox", "listitem", "log", "main", "mark", "marquee", "math", "menu",
  "menubar", "menuitem", "menuitemcheckbox", "menuitemradio", "meter",
  "navigation", "none", "note", "option", "paragraph", "presentation",
  "progressbar", "radio", "radiogroup", "region", "row", "rowgroup",
  "rowheader", "scrollbar", "search", "searchbox", "separator", "slider",
  "spinbutton", "status", "strong", "subscript", "superscript", "switch",
  "tab", "table", "tablist", "tabpanel", "term", "textbox", "time", "timer",
  "toolbar", "tooltip", "tree", "treegrid", "treeitem",
]);

// ラベルを必要としない input の type。
const UNLABELED_INPUT_TYPES = new Set(["hidden", "submit", "reset", "button", "image"]);

/** 属性文字列を { name: value } へ。値なし属性は空文字。 */
function parseAttrs(raw) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(raw))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/** HTMLを走査して要素の一覧を作る。開始/終了の対応が取れた要素だけ range を持つ。 */
function parse(html) {
  const tagRe = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/)?>/g;
  const elements = [];
  const stack = [];
  let m;
  let skipUntil = null; // script/style の終わりまで読み飛ばす

  while ((m = tagRe.exec(html))) {
    const [full, closing, rawName, rawAttrs, selfClose] = m;
    const name = rawName.toLowerCase();

    if (skipUntil) {
      if (closing && name === skipUntil) skipUntil = null;
      continue;
    }

    if (closing) {
      // 対応する開始タグを探して閉じる。見つからない終了タグは無視する。
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === name) {
          stack[i].innerEnd = m.index;
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const el = {
      name,
      attrs: parseAttrs(rawAttrs),
      start: m.index,
      innerStart: m.index + full.length,
      innerEnd: m.index + full.length, // 閉じタグが来たら更新
      line: 0,
    };
    elements.push(el);

    if (RAW_TEXT.has(name)) { skipUntil = name; continue; }
    if (VOID.has(name) || selfClose) continue;
    stack.push(el);
  }

  // 行番号を後付け（毎要素で数え直すと O(n^2) になるので一度だけ走査する）。
  const lineStarts = [0];
  for (let i = 0; i < html.length; i++) if (html[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (offset) => {
    let lo = 0, hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const el of elements) el.line = lineOf(el.start);

  return elements;
}

/** 要素の中身からタグとコメントを落として可視テキストだけを取り出す。 */
function textOf(html, el) {
  return html
    .slice(el.innerStart, el.innerEnd)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&[a-zA-Z]+;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function run() {
  const html = fs.readFileSync(TARGET, "utf8");
  const elements = parse(html);
  const findings = [];
  const add = (rule, el, detail) =>
    findings.push({ rule, line: el.line, tag: el.name, detail });

  // --- id の索引（参照の妥当性検査に使う） ---
  const idCount = new Map();
  for (const el of elements) {
    const id = el.attrs.id;
    if (id) idCount.set(id, (idCount.get(id) || 0) + 1);
  }
  const ids = new Set(idCount.keys());

  // --- label for="..." の索引 ---
  const labelledIds = new Set();
  for (const el of elements) {
    if (el.name === "label" && el.attrs.for) labelledIds.add(el.attrs.for);
  }

  // --- label で囲まれている部品の索引 ---
  const wrappedByLabel = new Set();
  for (const el of elements) {
    if (el.name !== "label" || el.innerEnd <= el.innerStart) continue;
    for (const child of elements) {
      if (child === el) continue;
      // 開始タグ直後に子が来る場合 start === innerStart になるので >= で比較する。
      if (child.start >= el.innerStart && child.start < el.innerEnd) wrappedByLabel.add(child);
    }
  }

  /** aria-label / aria-labelledby / title のいずれかで名前が付いているか。 */
  const hasAriaName = (el) => {
    if (el.attrs["aria-label"]?.trim()) return true;
    if (el.attrs["aria-labelledby"]?.trim()) return true;
    if (el.attrs.title?.trim()) return true;
    return false;
  };

  for (const el of elements) {
    const a = el.attrs;

    // 1. 重複 id — getElementById が先勝ちになり、aria参照も壊れる。
    if (a.id && idCount.get(a.id) > 1) {
      add("duplicate-id", el, `id="${a.id}" が ${idCount.get(a.id)} 箇所にある`);
    }

    // 2. aria-labelledby / aria-describedby / aria-controls の参照先が無い。
    for (const attr of ["aria-labelledby", "aria-describedby", "aria-controls", "aria-owns"]) {
      const v = a[attr];
      if (!v) continue;
      for (const ref of v.trim().split(/\s+/)) {
        if (ref && !ids.has(ref)) add("broken-aria-reference", el, `${attr}="${ref}" の参照先が存在しない`);
      }
    }

    // 3. label for="..." の参照先が無い。
    if (el.name === "label" && a.for && !ids.has(a.for)) {
      add("broken-label-for", el, `for="${a.for}" の参照先が存在しない`);
    }

    // 4. role の値が不正 — 不正なroleは無視され、暗黙のroleも失われる。
    if (a.role) {
      for (const r of a.role.trim().split(/\s+/)) {
        if (r && !VALID_ROLES.has(r.toLowerCase())) add("invalid-role", el, `role="${r}" は未定義`);
      }
    }

    // 5. 正の tabindex — DOM順と食い違うフォーカス順を作る。
    if (a.tabindex && Number(a.tabindex) > 0) {
      add("positive-tabindex", el, `tabindex="${a.tabindex}"`);
    }

    // 6. img の alt 欠落。
    if (el.name === "img" && a.alt === undefined && !hasAriaName(el) && a.role !== "presentation" && a.role !== "none") {
      add("img-missing-alt", el, `src="${(a.src || "").slice(0, 60)}"`);
    }

    // 7. ボタンにアクセシブル名が無い / 記号だけ。
    if (el.name === "button" || (el.name === "input" && (a.type || "").toLowerCase() === "button")) {
      if (!hasAriaName(el)) {
        const text = el.name === "button" ? textOf(html, el) : (a.value || "");
        if (!text) add("button-no-name", el, `id="${a.id || "(なし)"}"`);
        else if (!MEANINGFUL_TEXT.test(text)) {
          add("button-symbol-only", el, `表示は "${text}" のみ（読み上げで意味が伝わらない）`);
        }
      }
    }

    // 8. リンクにアクセシブル名が無い。
    if (el.name === "a" && a.href !== undefined && !hasAriaName(el)) {
      const text = textOf(html, el);
      if (!text) add("link-no-name", el, `href="${(a.href || "").slice(0, 60)}"`);
      else if (!MEANINGFUL_TEXT.test(text)) {
        add("link-symbol-only", el, `表示は "${text}" のみ`);
      }
    }

    // 9. フォーム部品にラベルが無い。
    if (el.name === "select" || el.name === "textarea" ||
        (el.name === "input" && !UNLABELED_INPUT_TYPES.has((a.type || "text").toLowerCase()))) {
      const named = hasAriaName(el) ||
        (a.id && labelledIds.has(a.id)) ||
        wrappedByLabel.has(el);
      if (!named) {
        add("control-no-label", el, `id="${a.id || "(なし)"}" type="${a.type || "text"}"`);
      }
    }

    // 10. aria-hidden="true" の中に操作可能な要素があると、フォーカスは行くのに
    //     読み上げには存在しない状態になる（WCAG 4.1.2 の典型的な違反）。
    if (a["aria-hidden"] === "true" && el.innerEnd > el.innerStart) {
      for (const child of elements) {
        if (child === el) continue;
        // 開始タグ直後に子が来る場合 start === innerStart になるので >= で比較する。
        if (child.start < el.innerStart || child.start >= el.innerEnd) continue;
        const focusable = ["button", "a", "input", "select", "textarea"].includes(child.name) &&
          child.attrs.tabindex !== "-1" && child.attrs.disabled === undefined &&
          !(child.name === "a" && child.attrs.href === undefined);
        if (focusable) add("focusable-in-aria-hidden", child, `aria-hidden="true" の内側（${el.line}行目）にある`);
      }
    }
  }

  // 11. 見出しレベルの飛び（h1 → h3 など）。読み上げの目次が壊れる。
  const headings = elements
    .filter((el) => /^h[1-6]$/.test(el.name))
    .sort((a, b) => a.start - b.start);
  let prev = 0;
  for (const h of headings) {
    const level = Number(h.name[1]);
    if (prev && level > prev + 1) {
      add("heading-skip", h, `h${prev} の次が h${level}`);
    }
    prev = level;
  }

  return findings;
}

const findings = run();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(findings, null, 2));
} else {
  const byRule = new Map();
  for (const f of findings) {
    if (!byRule.has(f.rule)) byRule.set(f.rule, []);
    byRule.get(f.rule).push(f);
  }
  if (findings.length === 0) {
    console.log("アクセシビリティ検査: 違反なし");
  } else {
    console.log(`アクセシビリティ検査: ${findings.length}件の違反\n`);
    for (const [rule, list] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`■ ${rule} (${list.length}件)`);
      for (const f of list.slice(0, 25)) {
        console.log(`   ${path.relative(path.join(here, ".."), TARGET)}:${f.line}  <${f.tag}>  ${f.detail}`);
      }
      if (list.length > 25) console.log(`   ... 他 ${list.length - 25} 件`);
      console.log("");
    }
  }
}

process.exit(findings.length > 0 ? 1 : 0);
