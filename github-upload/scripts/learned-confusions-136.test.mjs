// 1.0.136: 取り違えた語の組を覚えて、次から誤答の選択肢に混ぜる。
// 純関数（記録・忘却・上限・並び）と、pickDistractors への反映、採点経路の更新判定を、
// 公開HTML内の実コードをvmで動かして検査する。アプリHTMLは変更しない。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Script } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "publish", "index.html"), "utf8");

// 波括弧の対応をとって関数本体を丸ごと切り出す（他のテストと同じ流儀）。
function extractFunction(name) {
  const start = html.indexOf(`function ${name}(`);
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

// `const NAME = 値;` の1行を切り出す
function extractConstLine(name) {
  const match = html.match(new RegExp(`^const ${name} = [^;\\n]*;`, "m"));
  if (!match) throw new Error(`const ${name} not found`);
  return match[0];
}

// 配列・オブジェクトは別レルム製なので、deepEqual 用に素の値へ戻す
const plain = (value) => JSON.parse(JSON.stringify(value));

// ---- 記録・忘却・保存の純関数 ----
function confusionSandbox({ stored = null, throwOnSet = false, throwOnGet = false, syncId = "" } = {}) {
  const sandbox = { __log: [] };
  new Script(
    [
      "const __store = {};",
      `let __syncId = ${JSON.stringify(syncId)};`,
      "const syncRequestRoute = () => ({ expectedSyncId: __syncId });",
      "const localStorage = {",
      `  getItem: (k) => { if (${throwOnGet}) throw new Error('blocked'); return k in __store ? __store[k] : null; },`,
      `  setItem: (k, v) => { if (${throwOnSet}) throw new Error('quota'); __store[k] = String(v); },`,
      "  removeItem: (k) => { delete __store[k]; },",
      "};",
      extractConstLine("CONFUSION_STORE_KEY"),
      extractConstLine("CONFUSION_MAX_COUNT"),
      extractConstLine("CONFUSION_MAX_PARTNERS"),
      extractConstLine("CONFUSION_MAX_WORDS"),
      extractFunction("shortKeyFingerprint"),
      extractFunction("confusedIdsWithinScope"),
      extractFunction("pruneConfusionStore"),
      extractFunction("recordConfusion"),
      extractFunction("relaxConfusion"),
      extractFunction("confusionPartnersFor"),
      extractFunction("confusionStoreKey"),
      extractFunction("loadConfusionStore"),
      extractFunction("saveConfusionStore"),
      extractFunction("confusionUpdateForAnswer"),
      `if (${JSON.stringify(stored)} !== null) __store[confusionStoreKey()] = ${JSON.stringify(stored)};`,
      "globalThis.__api = { pruneConfusionStore, recordConfusion, relaxConfusion, confusionPartnersFor, confusedIdsWithinScope," +
        " loadConfusionStore, saveConfusionStore, confusionUpdateForAnswer, confusionStoreKey," +
        " setSyncId: (id) => { __syncId = id; }, storageKeys: () => Object.keys(__store), raw: () => __store[confusionStoreKey()] };",
    ].join("\n"),
    { filename: "confusion-store.js" },
  ).runInNewContext(sandbox);
  return sandbox.__api;
}

test("recordConfusion: 正解Aと誤答Bの組を双方向に記録し、n と at を入れる", () => {
  const api = confusionSandbox();
  const next = plain(api.recordConfusion({}, "a", "b", 1000));
  assert.deepEqual(next, { a: { b: { n: 1, at: 1000 } }, b: { a: { n: 1, at: 1000 } } });
});

test("recordConfusion: 同じ組を重ねると n が増え、上限5で止まり、at は新しくなる", () => {
  const api = confusionSandbox();
  let store = {};
  for (let i = 1; i <= 7; i += 1) store = api.recordConfusion(store, "a", "b", 1000 + i);
  assert.equal(store.a.b.n, 5, "n は上限5");
  assert.equal(store.b.a.n, 5, "逆向きも同じ");
  assert.equal(store.a.b.at, 1007, "at は直近の時刻");
});

test("recordConfusion: 入力を変異させず、新しいオブジェクトを返す", () => {
  const api = confusionSandbox();
  const before = { a: { b: { n: 2, at: 10 } }, b: { a: { n: 2, at: 10 } } };
  const snapshot = JSON.stringify(before);
  const next = api.recordConfusion(before, "a", "c", 20);
  assert.equal(JSON.stringify(before), snapshot, "渡した記録を書き換えない");
  assert.notEqual(next, before);
  assert.equal(next.a.b.n, 2, "既存の組は保たれる");
  assert.equal(next.a.c.n, 1);
  assert.equal(next.c.a.n, 1);
});

test("recordConfusion: 自分自身・空の id は記録しない", () => {
  const api = confusionSandbox();
  assert.deepEqual(plain(api.recordConfusion({}, "a", "a", 1)), {});
  assert.deepEqual(plain(api.recordConfusion({}, "", "b", 1)), {});
  assert.deepEqual(plain(api.recordConfusion({}, "a", null, 1)), {});
});

test("recordConfusion: 1語あたり相手は5つまで。超えたら at が古い相手から落ち、いま記録した相手は残る", () => {
  const api = confusionSandbox();
  let store = {};
  for (let i = 1; i <= 5; i += 1) store = api.recordConfusion(store, "a", `p${i}`, 100 * i);
  assert.equal(Object.keys(store.a).length, 5);
  store = api.recordConfusion(store, "a", "p6", 600);
  assert.deepEqual(Object.keys(store.a).sort(), ["p2", "p3", "p4", "p5", "p6"], "最も古い p1 が落ちる");
  // 落ちた組は双方向に消える（a→p1 だけ消えて p1→a が残る、という片方向を作らない）
  assert.equal(store.p1, undefined, "p1→a も同時に消える");
  assert.ok(store.p2.a, "残った組は双方向のまま");
  // 同じ時刻で6つ目を足しても、いま記録した相手が消えない
  let tie = {};
  for (const partner of ["q1", "q2", "q3", "q4", "q5", "q6"]) tie = api.recordConfusion(tie, "x", partner, 5);
  assert.ok(tie.x.q6, "同時刻でも新しく記録した相手は残る");
  assert.equal(Object.keys(tie.x).length, 5);
});

test("pruneConfusionStore: 全体で500語を超えたら、最終 at が古い語から落とす", () => {
  const api = confusionSandbox();
  const store = {};
  for (let i = 0; i < 520; i += 1) store[`w${i}`] = { partner: { n: 1, at: 1000 + i } };
  const pruned = api.pruneConfusionStore(store);
  const keys = Object.keys(pruned);
  assert.equal(keys.length, 500);
  assert.equal(keys.includes("w0"), false, "最も古い語は落ちる");
  assert.equal(keys.includes("w19"), false);
  assert.equal(keys.includes("w20"), true, "500番目に新しい語は残る");
  assert.equal(keys.includes("w519"), true);
  assert.equal(Object.keys(store).length, 520, "入力は変異させない");
});

test("pruneConfusionStore: 壊れた項目・自分自身・n が0以下は捨て、n は5に丸める", () => {
  const api = confusionSandbox();
  const pruned = plain(
    api.pruneConfusionStore({
      a: { a: { n: 1, at: 1 }, b: { n: 99, at: 5 }, c: { n: 0, at: 5 }, d: "x", e: { n: 2 }, f: null },
      z: null,
      y: { x: { n: -1, at: 1 } },
    }),
  );
  assert.deepEqual(pruned, { a: { b: { n: 5, at: 5 } } });
  assert.deepEqual(plain(api.pruneConfusionStore(null)), {});
  assert.deepEqual(plain(api.pruneConfusionStore("oops")), {});
});

test("relaxConfusion: 選択肢に相手が居れば双方向に n を1つ減らし、0になったら削除する", () => {
  const api = confusionSandbox();
  let store = {};
  store = api.recordConfusion(store, "a", "b", 10);
  store = api.recordConfusion(store, "a", "b", 20); // n=2
  const once = api.relaxConfusion(store, "a", ["a", "b", "c"]);
  assert.equal(once.a.b.n, 1);
  assert.equal(once.b.a.n, 1, "逆向きも減る");
  assert.equal(once.a.b.at, 20, "at は変えない");
  const twice = api.relaxConfusion(once, "a", ["b"]);
  assert.deepEqual(plain(twice), {}, "0になった組は双方向とも消え、空の行も残らない");
  assert.equal(store.a.b.n, 2, "入力は変異させない");
});

test("relaxConfusion: 選択肢に相手が居なければ変化なし（他の相手の記録も触らない）", () => {
  const api = confusionSandbox();
  let store = api.recordConfusion({}, "a", "b", 10);
  store = api.recordConfusion(store, "a", "c", 11);
  const same = api.relaxConfusion(store, "a", ["a", "x", "y"]);
  assert.deepEqual(plain(same), plain(store));
  // 一部だけ居れば、居た相手だけ減る
  const partial = api.relaxConfusion(store, "a", ["c"]);
  assert.equal(partial.a.b.n, 1);
  assert.equal(partial.a.c, undefined);
  assert.equal(partial.c, undefined);
  // 記録の無い語・不正な選択肢でも例外を出さない
  assert.deepEqual(plain(api.relaxConfusion(store, "zzz", ["a"])), plain(store));
  assert.deepEqual(plain(api.relaxConfusion(store, "a", null)), plain(store));
});

test("confusionPartnersFor: n の大きい順→at の新しい順。記録の無い語は空", () => {
  const api = confusionSandbox();
  const store = {
    a: {
      old2: { n: 2, at: 100 },
      new2: { n: 2, at: 300 },
      big: { n: 4, at: 50 },
      one: { n: 1, at: 900 },
    },
  };
  assert.deepEqual(plain(api.confusionPartnersFor(store, "a")), ["big", "new2", "old2", "one"]);
  assert.deepEqual(plain(api.confusionPartnersFor(store, "none")), []);
  assert.deepEqual(plain(api.confusionPartnersFor({}, "a")), []);
  assert.deepEqual(plain(api.confusionPartnersFor(null, "a")), []);
});

test("saveConfusionStore: 成功なら true、保存できなければ false を返す", () => {
  assert.equal(confusionSandbox().saveConfusionStore({ a: { b: { n: 1, at: 1 } } }), true);
  assert.equal(confusionSandbox().saveConfusionStore({}), true, "空にする（キーを消す）のも成功");
  assert.equal(confusionSandbox({ throwOnSet: true }).saveConfusionStore({ a: { b: { n: 1, at: 1 } } }), false);
});

test("loadConfusionStore/saveConfusionStore: 往復でき、壊れた JSON・取得/保存の例外でも例外を出さない", () => {
  const ok = confusionSandbox();
  ok.saveConfusionStore(ok.recordConfusion({}, "a", "b", 7));
  assert.deepEqual(plain(ok.loadConfusionStore()), { a: { b: { n: 1, at: 7 } }, b: { a: { n: 1, at: 7 } } });
  ok.saveConfusionStore({});
  assert.equal(ok.raw(), undefined, "空にしたらキーごと消す");

  for (const broken of ["{oops", "123", '"str"', "[1,2]", "null"]) {
    const api = confusionSandbox({ stored: broken });
    assert.deepEqual(plain(api.loadConfusionStore()), {}, `壊れた値 ${broken} は空として扱う`);
  }
  const noRead = confusionSandbox({ throwOnGet: true });
  assert.deepEqual(plain(noRead.loadConfusionStore()), {});
  const noWrite = confusionSandbox({ throwOnSet: true });
  assert.doesNotThrow(() => noWrite.saveConfusionStore({ a: { b: { n: 1, at: 1 } } }));
});

test("pruneConfusionStore: 1語5相手の上限で A→B が落ちたら B→A も落とす（片方向を残さない）", () => {
  const api = confusionSandbox();
  let store = api.recordConfusion({}, "A", "B", 100);
  for (let i = 1; i <= 5; i += 1) store = api.recordConfusion(store, "A", `x${i}`, 200 + i);
  assert.equal(store.A.B, undefined, "A に6つ目の相手を足すと、最も古い B が A の行から落ちる");
  assert.equal(store.B, undefined, "B→A も同時に消える");
  // 逆向きから見ても同じ（Aに正解してもB→Aが減らないという崩れが起きない）
  assert.equal(api.confusionPartnersFor(store, "B").includes("A"), false);
});

test("pruneConfusionStore: 全体500語の上限で語を落とすとき、その語を相手に持つ行からも消す", () => {
  const api = confusionSandbox();
  const store = { OLD: { NEW: { n: 1, at: 1 } }, NEW: { OLD: { n: 1, at: 99999 }, KEEP0: { n: 1, at: 99999 } } };
  for (let i = 0; i < 499; i += 1) store[`w${i}`] = { z: { n: 1, at: 1000 + i } };
  store.KEEP0 = { NEW: { n: 1, at: 99999 } };
  const pruned = api.pruneConfusionStore(store);
  assert.equal(Object.keys(pruned).length, 500);
  assert.equal(pruned.OLD, undefined, "最終 at が最も古い OLD の行が落ちる");
  assert.equal(pruned.NEW.OLD, undefined, "OLD を相手に持つ NEW の行からも消す");
  assert.ok(pruned.NEW.KEEP0, "他の相手は残る");
});

test("保存キーは同期の識別ごとに分かれ、別の識別の記録は見えず、キー名に生の識別子を含めない", () => {
  const api = confusionSandbox({ syncId: "personal-key-AAAA" });
  api.saveConfusionStore(api.recordConfusion({}, "a", "b", 1));
  assert.equal(api.loadConfusionStore().a.b.n, 1);
  const keyA = api.confusionStoreKey();
  api.setSyncId("room-BBBB");
  assert.deepEqual(plain(api.loadConfusionStore()), {}, "別の識別では空");
  api.saveConfusionStore(api.recordConfusion({}, "a", "c", 2));
  assert.notEqual(api.confusionStoreKey(), keyA);
  assert.equal(api.confusionPartnersFor(api.loadConfusionStore(), "a")[0], "c");
  api.setSyncId("personal-key-AAAA");
  assert.deepEqual(plain(api.confusionPartnersFor(api.loadConfusionStore(), "a")), ["b"], "元の識別に戻ると残っている");
  for (const key of api.storageKeys()) {
    assert.equal(key.includes("AAAA") || key.includes("BBBB"), false, "キー名に識別子を出さない");
    assert.match(key, /^wordsnap-confusions:v1:/);
  }
  // 識別が取れないとき（未同期）は local 扱いで、例外を出さず保存・読み出しできる
  api.setSyncId("");
  api.saveConfusionStore(api.recordConfusion({}, "x", "y", 3));
  assert.equal(api.loadConfusionStore().x.y.n, 1);
  assert.equal(api.storageKeys().length, 3);
});

test("旧キー wordsnap-confusions:v1（識別なし）は読まない", () => {
  const api = confusionSandbox();
  const keyed = api.confusionStoreKey();
  assert.notEqual(keyed, "wordsnap-confusions:v1");
});

// ---- 範囲外の相手を混ぜない ----
test("confusedIdsWithinScope: 選んだ範囲の語の id だけを残す", () => {
  const api = confusionSandbox();
  const scope = [{ id: "a" }, { id: "b" }, { id: 7 }];
  assert.deepEqual(plain(api.confusedIdsWithinScope(["x", "b", "7", "y", "a"], scope)), ["b", "7", "a"]);
  assert.deepEqual(plain(api.confusedIdsWithinScope(["x"], scope)), []);
  assert.deepEqual(plain(api.confusedIdsWithinScope(null, scope)), []);
  assert.deepEqual(plain(api.confusedIdsWithinScope(["a"], null)), []);
});

test("範囲が小さくて全単語へ広がる出題でも、範囲外の相手 X は優先されない（呼び出し元と同じ手順）", () => {
  const api = confusionSandbox();
  const p = pickSandbox();
  // 選んだ範囲は2語（<3）なので、呼び出し元は basePool を全単語へ広げる。X は範囲外の相手。
  const scope = [W("s1", "table", "机", "noun"), W("s2", "river", "川", "noun")];
  const everyone = [...scope, W("X", "balloon", "風船", "noun"), W("p3", "window", "窓", "noun"), W("p4", "garden", "庭", "noun"), W("p5", "pencil", "鉛筆", "noun")];
  const run = (confusedIds) => {
    p.reset();
    return ids(p.pickDistractorsWithFallback(everyone, everyone, ANSWER, false, confusedIds));
  };
  // 絞らずに渡すと X が必ず入ってしまう（これが直す前の問題）
  assert.ok(run(["X"]).includes("X"));
  // 範囲で絞れば X は渡らず、記録なしと完全に同じ結果になる
  assert.deepEqual(run(api.confusedIdsWithinScope(["X"], scope)), run([]));
  // 範囲内の相手は絞っても残り、必ず入る
  assert.ok(run(api.confusedIdsWithinScope(["X", "s1"], scope)).includes("s1"));
});

// ---- 選択肢への反映（pickDistractors） ----
function pickSandbox() {
  const sandbox = {};
  new Script(
    [
      "let __randCalls = 0;",
      "let __seed = 12345;",
      // 固定列の乱数。同じ列なら shuffle の結果は完全に同じになる
      "Math.random = () => { __randCalls += 1; __seed = (__seed * 1103515245 + 12345) % 2147483648; return __seed / 2147483648; };",
      extractFunction("shuffle"),
      extractFunction("normalizeMeaning"),
      extractFunction("normalizeTerm"),
      extractFunction("meaningsTooClose"),
      extractFunction("spellingDistance"),
      extractFunction("pickDistractors"),
      extractFunction("pickDistractorsWithFallback"),
      "globalThis.__p = { pickDistractors, pickDistractorsWithFallback, reset: () => { __randCalls = 0; __seed = 12345; }, calls: () => __randCalls };",
    ].join("\n"),
    { filename: "confusion-pick.js" },
  ).runInNewContext(sandbox);
  return sandbox.__p;
}

const W = (id, term, meaning, tag = "noun") => ({ id, term, meaning, pos: { tag } });
const ids = (list) => plain(list.map((word) => word.id));

// 答え: affect。effect は綴りが近い（引っかけ候補）、相手 far は綴りも訳も遠い語
const ANSWER = W("ans", "affect", "影響する", "verb");
function basePool() {
  return [
    W("eff", "effect", "効果", "verb"), // 綴りが近い
    W("aff2", "affirm", "断言する", "verb"),
    W("far", "balloon", "風船", "noun"), // 取り違えた相手（綴りも品詞も遠い）
    W("p1", "table", "机", "noun"),
    W("p2", "river", "川", "noun"),
    W("p3", "window", "窓", "noun"),
    W("p4", "garden", "庭", "noun"),
  ];
}

test("pickDistractors: confusedIds の語が pool にあれば、綴りの似た語より優先して必ず入る（引っかけは合計1つ）", () => {
  const p = pickSandbox();
  for (let round = 0; round < 40; round += 1) {
    const picked = p.pickDistractors(basePool(), ANSWER, 3, [], { confusedIds: ["far"] });
    assert.ok(ids(picked).includes("far"), `取り違えた語が入る（${round}回目）`);
    assert.equal(picked.length, 3);
    // 引っかけ枠は1つだけ＝取り違えた語が使っているので、綴りの似た effect は入らない
    assert.equal(ids(picked).includes("eff"), false, "綴りの似た語は同じ問題には入らない");
    assert.equal(ids(picked).includes("ans"), false);
  }
});

test("pickDistractors: 取り違えが複数あっても引っかけは1つ。渡された並びの先頭（強い相手）が選ばれる", () => {
  const p = pickSandbox();
  const pool = [W("c1", "balloon", "風船", "noun"), W("c2", "pencil", "鉛筆", "noun"), W("p1", "table", "机", "noun"), W("p2", "river", "川", "noun"), W("p3", "window", "窓", "noun")];
  for (let round = 0; round < 30; round += 1) {
    const picked = ids(p.pickDistractors(pool, W("ans", "garden", "庭", "noun"), 3, [], { confusedIds: ["c2", "c1"] }));
    assert.ok(picked.includes("c2"), "先頭の相手が入る");
    assert.equal(picked.includes("c1"), false, "2つ目の取り違えは同じ問題に入れない");
  }
});

test("pickDistractors: 候補が足りず制限を緩めるときも、記録相手は合計1つまで", () => {
  const p = pickSandbox();
  // B・C・D の3候補しかなく、制限を外して補充する経路（takeFrom(true)）に入る
  const tight = [W("B", "balloon", "風船", "noun"), W("C", "pencil", "鉛筆", "noun"), W("D", "window", "窓", "noun")];
  for (let round = 0; round < 30; round += 1) {
    const picked = ids(p.pickDistractors(tight, W("ans", "garden", "庭", "noun"), 3, [], { confusedIds: ["B", "C"] }));
    assert.ok(picked.includes("B"), "先頭の相手が入る");
    assert.equal(picked.includes("C"), false, "2つ目の記録相手は補充でも入れない");
    assert.ok(picked.includes("D"));
  }
  // 記録なしの従来の緩和は変わらない（候補が足りなければ綴りの近い語を複数入れて埋める）
  const near = [W("n1", "gardens", "庭園", "noun"), W("n2", "garder", "ガーダー", "noun"), W("n3", "gardeb", "ガーデブ", "noun")];
  assert.equal(p.pickDistractors(near, W("ans", "garden", "庭", "noun"), 3, [], {}).length, 3);
});

test("pickDistractors: confusedIds の語でも、意味が近すぎる語・同じ見出し語は入らない（正解が2つになる問題は作らない）", () => {
  const p = pickSandbox();
  const pool = [
    W("close", "influence", "影響する（人に）", "verb"), // 括弧を除くと「影響する」で完全一致
    W("same", "Affect", "感情", "noun"), // 同じ見出し語の別訳（大文字小文字違い）
    W("p1", "table", "机", "noun"),
    W("p2", "river", "川", "noun"),
    W("p3", "window", "窓", "noun"),
  ];
  const picked = ids(p.pickDistractors(pool, ANSWER, 3, [], { confusedIds: ["close", "same"] }));
  assert.equal(picked.includes("close"), false, "意味が近すぎる語は取り違え記録があっても入らない");
  assert.equal(picked.includes("same"), false, "同じ見出し語は入らない");
  assert.equal(picked.length, 3);
});

test("pickDistractors: confusedIds の語が pool に居なければ何もしない（範囲外から引っ張らない）", () => {
  const p = pickSandbox();
  p.reset();
  const withUnknown = ids(p.pickDistractors(basePool(), ANSWER, 3, [], { confusedIds: ["not-in-pool"] }));
  p.reset();
  const without = ids(p.pickDistractors(basePool(), ANSWER, 3, [], {}));
  assert.deepEqual(withUnknown, without);
  assert.equal(withUnknown.includes("not-in-pool"), false);
});

test("pickDistractors: confusedIds が空なら、同じ乱数列で従来と完全に同じ結果・同じ乱数消費", () => {
  const p = pickSandbox();
  const run = (options) => {
    p.reset();
    const picked = ids(p.pickDistractors(basePool(), ANSWER, 3, [], options));
    return { picked, calls: p.calls() };
  };
  const bare = run(undefined);
  assert.deepEqual(run({}), bare);
  assert.deepEqual(run({ confusedIds: [] }), bare);
  assert.deepEqual(run({ dedupeBy: "meaning", confusedIds: [] }), run({ dedupeBy: "meaning" }));
  // この固定乱数列での従来の結果（1.0.135 の pickDistractors で取得した値）。綴りの近い語が優先される
  assert.deepEqual(bare.picked, ["eff", "aff2", "p4"]);
  assert.equal(bare.calls, 7, "shuffle が語数ぶんだけ乱数を使う");
});

test("pickDistractors: 日→英（dedupeBy: term）でも取り違えた語が入り、見出し語の重複排除は保たれる", () => {
  const p = pickSandbox();
  const pool = [
    W("far", "balloon", "風船", "noun"),
    W("dup", "balloon", "気球", "noun"), // 同じ見出し語（term）が2つ並ぶのは防ぐ
    W("eff", "effect", "効果", "verb"),
    W("p1", "table", "机", "noun"),
    W("p2", "river", "川", "noun"),
  ];
  for (let round = 0; round < 30; round += 1) {
    const picked = p.pickDistractors(pool, ANSWER, 3, [], { dedupeBy: "term", confusedIds: ["far"] });
    const terms = picked.map((word) => word.term);
    assert.ok(ids(picked).includes("far") || ids(picked).includes("dup"), "取り違えた語（の見出し語）が入る");
    assert.equal(new Set(terms).size, terms.length, "同じ見出し語は並ばない");
    assert.equal(ids(picked).includes("eff"), false, "引っかけは1つだけ");
  }
});

test("pickDistractorsWithFallback: 範囲内の相手は混ぜ、範囲内で0件のときの全単語フォールバックでは相手を持ち込まない", () => {
  const p = pickSandbox();
  // 範囲内に相手が居れば、第5引数の confusedIds が効く
  for (let round = 0; round < 20; round += 1) {
    const inRange = ids(p.pickDistractorsWithFallback(basePool(), basePool(), ANSWER, false, ["far"]));
    assert.ok(inRange.includes("far"));
    assert.equal(inRange.includes("eff"), false);
  }
  // 範囲内の語がすべて正解と同じ訳 → 誤答0件 → 全単語から選び直す。このとき相手は優先しない
  const sameMeaning = [W("s1", "impact", "影響する", "verb"), W("s2", "sway", "影響する", "verb")];
  const everyone = [...sameMeaning, ...basePool()];
  p.reset();
  const withPartner = ids(p.pickDistractorsWithFallback(sameMeaning, everyone, ANSWER, false, ["far"]));
  p.reset();
  const without = ids(p.pickDistractorsWithFallback(sameMeaning, everyone, ANSWER, false));
  assert.deepEqual(withPartner, without, "範囲外から引っ張る形では相手を優先しない");
  // 引数を省いた従来の呼び方も動く
  assert.equal(p.pickDistractorsWithFallback(basePool(), basePool(), ANSWER, false).length, 3);
});

// ---- 採点経路の更新判定 ----
test("confusionUpdateForAnswer: 4択の誤答は記録、正解は忘却、dontKnow・フラッシュカード・例文は何もしない", () => {
  const api = confusionSandbox();
  const base = { answerId: "a", choiceIds: ["a", "b", "c", "d"], dontKnow: false, mode: "meaning-choice" };
  assert.deepEqual(plain(api.confusionUpdateForAnswer({ ...base, choiceId: "b" })), { type: "record", a: "a", b: "b" });
  assert.deepEqual(plain(api.confusionUpdateForAnswer({ ...base, choiceId: "a" })), {
    type: "relax",
    a: "a",
    shownIds: ["b", "c", "d"],
  });
  assert.deepEqual(plain(api.confusionUpdateForAnswer({ ...base, mode: "term-choice", choiceId: "c" })), {
    type: "record",
    a: "a",
    b: "c",
  });
  assert.equal(api.confusionUpdateForAnswer({ ...base, choiceId: "b", dontKnow: true }), null, "わからないは対象外");
  assert.equal(api.confusionUpdateForAnswer({ ...base, choiceId: "a", dontKnow: true }), null);
  assert.equal(api.confusionUpdateForAnswer({ ...base, choiceId: "b", mode: "flashcard" }), null);
  assert.equal(api.confusionUpdateForAnswer({ ...base, choiceId: "b", mode: "context-choice" }), null);
  assert.equal(api.confusionUpdateForAnswer({ ...base, choiceId: "zzz" }), null, "選択肢に無い id は誤答として扱わない");
  assert.equal(api.confusionUpdateForAnswer({ ...base, choiceId: undefined }), null);
});

// gradeQuiz から呼ぶ learnConfusionFromAnswer を、保存まで含めて動かす
function learnSandbox({ words, throwOnSet = false }) {
  const sandbox = {};
  new Script(
    [
      "const __store = {};",
      "const localStorage = {",
      "  getItem: (k) => (k in __store ? __store[k] : null),",
      `  setItem: (k, v) => { if (${throwOnSet}) throw new Error('quota'); __store[k] = String(v); },`,
      "  removeItem: (k) => { delete __store[k]; },",
      "};",
      `const appState = { words: ${JSON.stringify(words)} };`,
      "const syncRequestRoute = () => ({ expectedSyncId: '' });",
      extractFunction("shortKeyFingerprint"),
      extractConstLine("CONFUSION_STORE_KEY"),
      extractConstLine("CONFUSION_MAX_COUNT"),
      extractConstLine("CONFUSION_MAX_PARTNERS"),
      extractConstLine("CONFUSION_MAX_WORDS"),
      extractFunction("pruneConfusionStore"),
      extractFunction("recordConfusion"),
      extractFunction("relaxConfusion"),
      extractFunction("confusionPartnersFor"),
      extractFunction("confusionStoreKey"),
      extractFunction("loadConfusionStore"),
      extractFunction("saveConfusionStore"),
      extractFunction("confusionUpdateForAnswer"),
      extractFunction("currentQuizPromptMode"),
      extractFunction("learnConfusionFromAnswer"),
      "globalThis.__l = { learn: learnConfusionFromAnswer, store: () => loadConfusionStore() };",
    ].join("\n"),
    { filename: "confusion-learn.js" },
  ).runInNewContext(sandbox);
  return sandbox.__l;
}

const LEARN_WORDS = [
  { id: "a", term: "affect", meaning: "影響する" },
  { id: "b", term: "effect", meaning: "効果" },
  { id: "c", term: "table", meaning: "机" },
];
const forwardQuiz = (extra = {}) => ({
  answer: { id: "a", term: "affect", meaning: "影響する" },
  choices: LEARN_WORDS,
  ...extra,
});

test("learnConfusionFromAnswer: 誤答で双方向に記録して相手の語を返し、正解で選択肢にいた相手を減らして外す", () => {
  const l = learnSandbox({ words: LEARN_WORDS });
  const partner = l.learn(forwardQuiz(), "b", false);
  assert.equal(partner.term, "effect", "案内文に使う相手の語を返す");
  assert.deepEqual(plain(l.store()).a.b.n, 1);
  assert.deepEqual(plain(l.store()).b.a.n, 1, "双方向");
  // 正解し、選択肢に相手（b）が居たので外れる
  assert.equal(l.learn(forwardQuiz(), "a", false), null, "正解では案内用の語を返さない");
  assert.deepEqual(plain(l.store()), {});
});

test("learnConfusionFromAnswer: 日→英（{id,label}の選択肢）でも記録でき、dontKnow・フラッシュカード・例文は記録しない", () => {
  const l = learnSandbox({ words: LEARN_WORDS });
  const reverse = forwardQuiz({
    reverse: true,
    choices: LEARN_WORDS.map((word) => ({ id: word.id, label: word.term })),
  });
  assert.equal(l.learn(reverse, "c", false).term, "table");
  assert.equal(plain(l.store()).a.c.n, 1);

  const fresh = learnSandbox({ words: LEARN_WORDS });
  assert.equal(fresh.learn(forwardQuiz(), "b", true), null, "わからないは記録しない");
  assert.equal(fresh.learn(forwardQuiz({ flashcard: true }), "b", false), null, "フラッシュカードは記録しない");
  assert.equal(
    fresh.learn(forwardQuiz({ context: { en: "x", ja: null, src: "" } }), "b", false),
    null,
    "例文（空所補充）は記録しない",
  );
  assert.deepEqual(plain(fresh.store()), {});
});

test("learnConfusionFromAnswer: 相手の語が見つからなければ案内用の語は返さず、保存できなくても例外を出さない", () => {
  const l = learnSandbox({ words: [LEARN_WORDS[0]] }); // b が appState に居ない
  assert.equal(l.learn(forwardQuiz(), "b", false), null);
  const blocked = learnSandbox({ words: LEARN_WORDS, throwOnSet: true });
  assert.doesNotThrow(() => blocked.learn(forwardQuiz(), "b", false));
  // 保存に失敗したときは「次から並べて出します」の案内用の語を返さない
  assert.equal(blocked.learn(forwardQuiz(), "b", false), null);
});

// ---- 配線（実コードの該当箇所が繋がっていること） ----
test("配線: 通常クイズ・復習セッションは取り違えの相手を渡し、採点は記録を呼び、案内文を添える", () => {
  const review = extractFunction("buildReviewQuiz");
  const normal = extractFunction("buildQuiz");
  for (const body of [review, normal]) {
    assert.match(body, /confusedIdsWithinScope\(\s*confusionPartnersFor\(loadConfusionStore\(\), answer\.id\),/);
  }
  // 範囲を全単語へ広げる前の語（復習は scopeWords、通常クイズは pool）を基準にしている
  assert.match(review, /const scopeWords = pool;[\s\S]*?if \(pool\.length < 3\) pool = others;/);
  assert.match(review, /answer\.id\), scopeWords\)/);
  assert.match(normal, /answer\.id\), pool\)/);
  const grade = extractFunction("gradeQuiz");
  assert.match(grade, /learnConfusionFromAnswer\(currentQuiz, choiceId, dontKnow\)/);
  assert.equal((grade.match(/\+= confusionNote;/g) || []).length, 2, "復習・通常の誤答フィードバックの両方に添える");
  assert.match(html, /（次から「\$\{confusedWord\.term\}」と並べて出します）/);
  // 例文の作問（buildContextChoices）は別経路で、今回は触らない
  assert.equal(extractFunction("buildContextChoices").includes("confusedIds"), false);
});

test("案内: クイズ開始画面の「？ 詳しく」に取り違えた語の項目がある", () => {
  const details = html.slice(html.indexOf('id="quizSetupDetails"'));
  const list = details.slice(0, details.indexOf("</ul>"));
  assert.ok(
    list.includes(
      "<li><strong>取り違えた語：</strong>間違えて選んだ語の組を覚えて、次から選択肢に1つ混ぜます。正解が続くと外れます（この端末だけに保存）。</li>",
    ),
  );
});

test("同期しない: 取り違えの記録は appState・同期データに入れず、専用の localStorage キーだけを使う", () => {
  assert.match(html, /const CONFUSION_STORE_KEY = "wordsnap-confusions:v1";/);
  const uses = html.split("CONFUSION_STORE_KEY").length - 1;
  assert.equal(uses, 2, "定義と、識別つきのキーを作る関数だけ（同期やエクスポートの経路に出てこない）");
});
