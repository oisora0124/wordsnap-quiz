import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(scriptDir, "..", "publish", "index.html"), "utf8");

function sourceBetween(startNeedle, endNeedle) {
  const start = html.indexOf(startNeedle);
  assert.ok(start >= 0, `${startNeedle} が見つかること`);
  const end = html.indexOf(endNeedle, start);
  assert.ok(end > start, `${startNeedle} の終端が見つかること`);
  return html.slice(start, end);
}

function makeNormalizeWord() {
  const context = {
    Date,
    Math,
    Number,
    String,
    Boolean,
    sanitizeId: (value) => String(value || ""),
    normalizeCefr: (value) => value || null,
    normalizePos: (value) => value || null,
    normalizeEnrich: (value) => value || {},
    normalizeHistory: (value) => value || [],
    normalizeLearning: () => ({}),
  };
  const numberHelpers = sourceBetween(
    "function nonNegativeNumber",
    "\nfunction normalizeState",
  );
  const normalizeWord = sourceBetween(
    "function normalizeWord",
    "\nconst ENRICH_TYPES",
  );
  vm.runInNewContext(
    `${numberHelpers}\n${normalizeWord}\nglobalThis.__normalizeWord = normalizeWord;`,
    context,
  );
  return context.__normalizeWord;
}

function makeMergeWord() {
  const context = {
    Math,
    String,
    mergeHistory: (local, remote) => [...local, ...remote],
    mergeEnrichData: (local) => local,
    mergeLearningState: (local) => local,
  };
  const mergeWord = sourceBetween("function mergeWord", "\nfunction mergeHistory");
  vm.runInNewContext(`${mergeWord}\nglobalThis.__mergeWord = mergeWord;`, context);
  return context.__mergeWord;
}

function word({ favorite, favoriteUpdatedAt }) {
  return {
    id: "word-1",
    term: "apple",
    meaning: "りんご",
    addedAt: "2026-07-01T00:00:00.000Z",
    deckId: "deck-1",
    cefr: null,
    pos: null,
    enrich: {},
    favorite,
    favoriteUpdatedAt,
    stats: { correct: 0, wrong: 0 },
    history: [],
    learning: {},
  };
}

test("古い保存データのお気に入り更新時刻は0として正規化する", () => {
  const normalizeWord = makeNormalizeWord();
  assert.equal(normalizeWord({ term: "apple", meaning: "りんご", favorite: true }).favoriteUpdatedAt, 0);
  assert.equal(normalizeWord({ favoriteUpdatedAt: -1 }).favoriteUpdatedAt, 0);
  assert.equal(normalizeWord({ favoriteUpdatedAt: 12.9 }).favoriteUpdatedAt, 12);
});

test("新しい端末のお気に入り追加と解除を時刻順に採用する", () => {
  const mergeWord = makeMergeWord();
  const addedRemotely = mergeWord(
    word({ favorite: false, favoriteUpdatedAt: 100 }),
    word({ favorite: true, favoriteUpdatedAt: 200 }),
    "remote",
  );
  assert.equal(addedRemotely.favorite, true, "新しい追加を採用すること");
  assert.equal(addedRemotely.favoriteUpdatedAt, 200);

  const removedRemotely = mergeWord(
    word({ favorite: true, favoriteUpdatedAt: 300 }),
    word({ favorite: false, favoriteUpdatedAt: 400 }),
    "remote",
  );
  assert.equal(removedRemotely.favorite, false, "新しい解除を採用すること");
  assert.equal(removedRemotely.favoriteUpdatedAt, 400);
});

test("お気に入り更新時刻が同値またはローカルの方が新しければローカルを守る", () => {
  const mergeWord = makeMergeWord();
  for (const remoteUpdatedAt of [500, 499, 0]) {
    const merged = mergeWord(
      word({ favorite: true, favoriteUpdatedAt: 500 }),
      word({ favorite: false, favoriteUpdatedAt: remoteUpdatedAt }),
      "remote",
    );
    assert.equal(merged.favorite, true, `時刻${remoteUpdatedAt}でローカルを維持すること`);
    assert.equal(merged.favoriteUpdatedAt, 500);
  }
});

test("更新時刻を持たない既存データ同士はローカルのお気に入りを維持する", () => {
  const normalizeWord = makeNormalizeWord();
  const mergeWord = makeMergeWord();
  const local = normalizeWord(word({ favorite: true, favoriteUpdatedAt: undefined }));
  const remote = normalizeWord(word({ favorite: false, favoriteUpdatedAt: undefined }));
  const merged = mergeWord(local, remote, "remote");
  assert.equal(merged.favorite, true);
  assert.equal(merged.favoriteUpdatedAt, 0);
});

test("お気に入りのUI操作は値と更新時刻を同時に保存する", () => {
  const handlerSource = sourceBetween(
    '  const favoriteButton = event.target.closest("[data-favorite-word]");',
    "\n  const deleteButton",
  );
  const savedWord = word({ favorite: false, favoriteUpdatedAt: 0 });
  let saveCount = 0;
  const context = {
    appState: { words: [savedWord] },
    Date: { now: () => 987654321 },
    saveState: () => { saveCount += 1; },
    setStatus() {},
  };
  vm.runInNewContext(
    `globalThis.__handleFavorite = (event) => {\n${handlerSource}\n};`,
    context,
  );
  context.__handleFavorite({
    target: {
      closest: (selector) =>
        selector === "[data-favorite-word]"
          ? { dataset: { favoriteWord: "word-1" } }
          : null,
    },
  });
  assert.equal(savedWord.favorite, true);
  assert.equal(savedWord.favoriteUpdatedAt, 987654321);
  assert.equal(saveCount, 1);
});
