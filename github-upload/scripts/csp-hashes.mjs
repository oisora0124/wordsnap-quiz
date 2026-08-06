import { createHash } from "node:crypto";

// HTML内の全インライン<script>本体のSHA-256をCSPソース形式で返す。
// sync-html.mjs（_headersの自動更新）と check-release.mjs（照合）で共用する。
//
// 【なぜここを雑に書けないか】
// 壊れても**ローカルでは何も起きない**。_headers は Cloudflare が配信するときに
// しか効かないので、手元でHTMLを開いても npm test を回しても素通りする。
// 気づくのは公開後、利用者の画面が動かなくなってから。
//
// しかも生成側(sync-html)と照合側(check-release)は同じこの関数を使う。
// この関数の取りこぼしは**両方の目を同時に塞ぐ**ので、
// 「ハッシュは全部揃っている」と判定したまま本番だけが壊れる。
//
// そのため、正規表現で当てにいくのではなく、ブラウザのHTMLパースに必要な
// 部分だけを写した小さなトークナイザにしてある。過去に踏んだ／踏みかけた形:
//   /<script>...<\/script>/  … 属性付き（type="module" 等）を丸ごと取りこぼす
//   属性の終わりを [^>]* で探す … 属性値の中の '>' でタグが終わったことになる
//   src= を正規表現で探す     … 属性値の中の "src=" を外部scriptと誤認する
//   <!-- を無条件に探す       … 属性値や <style> の中の "<!--" で本物を飛ばす
//   閉じタグをEOFで許す       … 成立しないタグを本文の終わりとして扱う
//   改行の正規化をしない       … CRLFのファイルでブラウザとハッシュが食い違う

/** 本文をHTMLとして解釈しない要素（この中の "<" はタグではない）。 */
const RAW_TEXT_ELEMENTS = new Set([
  "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes",
]);

/** タグ名の直後に来てよい文字。ここで区切らないと <scriptx> を script と誤認する。 */
const TAG_NAME_END = /[\s/>]/;

/**
 * ブラウザは入力ストリームの CRLF と単独 CR を LF へ正規化してから解析し、
 * CSPのハッシュはその**正規化後の本文**に対して計算される。
 * ここで揃えておかないと、ファイルがCRLFになった瞬間に全ハッシュが食い違う。
 */
function normalizeNewlines(html) {
  return html.replace(/\r\n?/g, "\n");
}

/**
 * 開始タグの `>` を探す。**引用符の中の `>` はタグを終わらせない。**
 * 見つからない（EOF）場合は -1。HTMLの仕様上、EOFで閉じないタグは成立しない。
 */
function findTagEnd(html, from) {
  let quote = null;
  for (let i = from; i < html.length; i += 1) {
    const c = html[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ">") return i;
  }
  return -1;
}

/**
 * 開始タグの属性部分から属性名だけを取り出す。
 * 正規表現で `src=` を探すと、`<script data-note="x src=/a.js">` のように
 * **属性値の中に書かれた文字列**を属性と誤認し、実行される本文のハッシュを落とす。
 */
function attributeNames(attrs) {
  const names = [];
  let i = 0;
  while (i < attrs.length) {
    while (i < attrs.length && /[\s/]/.test(attrs[i])) i += 1;
    const start = i;
    while (i < attrs.length && !/[\s/=]/.test(attrs[i])) i += 1;
    if (i === start) { i += 1; continue; }
    names.push(attrs.slice(start, i).toLowerCase());
    while (i < attrs.length && /\s/.test(attrs[i])) i += 1;
    if (attrs[i] !== "=") continue;
    i += 1;
    while (i < attrs.length && /\s/.test(attrs[i])) i += 1;
    const quote = attrs[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      while (i < attrs.length && attrs[i] !== quote) i += 1;
      i += 1;
    } else {
      while (i < attrs.length && !/\s/.test(attrs[i])) i += 1;
    }
  }
  return names;
}

/**
 * raw text 要素の閉じタグを探す。`</name` の直後が空白 / '/' / '>' のときだけ成立する
 * （`</scriptx>` は閉じタグではない）。返り値は { start, end }、無ければ null。
 */
function findRawTextEnd(html, lower, from, name) {
  const needle = `</${name}`;
  for (let i = lower.indexOf(needle, from); i >= 0; i = lower.indexOf(needle, i + 1)) {
    const next = html[i + needle.length];
    // EOF（next === undefined）はタグとして成立しない。
    if (next !== undefined && TAG_NAME_END.test(next)) {
      const gt = findTagEnd(html, i + needle.length);
      if (gt < 0) return null; // 閉じタグが `>` を持たずEOF
      return { start: i, end: gt + 1 };
    }
  }
  return null;
}

/**
 * HTML内の script 要素を走査する。
 * 返り値: { inline: [{ body, index }], external: number }
 * index は改行正規化後の位置（診断用）。
 *
 * 解釈できない形（閉じないタグ・閉じない script）は例外にする。
 * 黙って続けると、残り全部を本文としたハッシュが載って本番が壊れる。
 */
export function scanScriptElements(rawHtml) {
  const html = normalizeNewlines(rawHtml);
  const lower = html.toLowerCase();
  const inline = [];
  let external = 0;
  let i = 0;

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) break;

    // HTMLコメント。ここに来る時点でタグの外・raw text の外なので、本物のコメント。
    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      // 閉じないコメントは、以降すべてがコメント扱い（ブラウザも同じ）。
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    // DOCTYPE・処理命令などは `>` まで読み飛ばす。
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const end = html.indexOf(">", lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }

    const closing = html[lt + 1] === "/";
    const nameStart = lt + (closing ? 2 : 1);
    const nameMatch = /^[a-zA-Z][^\s/>]*/.exec(html.slice(nameStart, nameStart + 64));
    if (!nameMatch) {
      i = lt + 1; // タグではないただの "<"
      continue;
    }
    const name = nameMatch[0].toLowerCase();
    const attrsStart = nameStart + nameMatch[0].length;
    const tagEnd = findTagEnd(html, attrsStart);
    if (tagEnd < 0) {
      throw new Error(`閉じられていないタグ <${name}> があります（位置 ${lt}）。`);
    }

    if (!closing && name === "script") {
      const bodyStart = tagEnd + 1;
      const close = findRawTextEnd(html, lower, bodyStart, "script");
      if (!close) {
        throw new Error(
          `閉じられていない <script> があります（位置 ${lt}）。CSPハッシュを計算できません。`,
        );
      }
      if (attributeNames(html.slice(attrsStart, tagEnd)).includes("src")) {
        // 外部scriptは本文を持たない。ハッシュではなく 'self' 等で許可する対象。
        external += 1;
      } else {
        inline.push({ body: html.slice(bodyStart, close.start), index: lt });
      }
      // 閉じタグの先から再開する。本文の途中から再開すると、JSの文字列や
      // コメントに書かれた "<script>" を要素と誤認する（実際に本体に存在する）。
      i = close.end;
      continue;
    }

    if (!closing && RAW_TEXT_ELEMENTS.has(name)) {
      // <style> や <textarea> の中身はHTMLではない。ここを解釈すると、
      // 中に書かれた "<!--" や "<script>" に引きずられて本物を取りこぼす。
      const close = findRawTextEnd(html, lower, tagEnd + 1, name);
      i = close ? close.end : html.length;
      continue;
    }

    i = tagEnd + 1;
  }

  return { inline, external };
}

/** HTML内の全インライン<script>本体のSHA-256をCSPソース形式で返す。 */
export function inlineScriptHashes(html) {
  return scanScriptElements(html).inline.map(
    ({ body }) => `'sha256-${createHash("sha256").update(body, "utf8").digest("base64")}'`,
  );
}
