// レート制限のキーに使う送信元識別子の検査。
//
// CF-Connecting-IP をそのまま鍵にすると、IPv6ではアドレスを1つずらすだけで
// 別人として扱われ、上限が素通りする（IPv6は1契約者に /64 = 2^64個が割り当たる）。
// IPv6を /64 へ丸めることで、同一契約者からの試行を1つのバケツにまとめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { rateLimitClientKey as fromTelemetry } from "../functions/api/telemetry.js";
import { rateLimitClientKey as fromState } from "../functions/api/wordsnap-state.js";
import { rateLimitClientKey as fromFeedback } from "../functions/api/feedback.js";

// 3ファイルに同じ実装を置いているので、挙動が食い違わないことも固定する
// （共有モジュールが無い構成のため、コピーのずれが最大のリスク）。
const impls = [
  ["telemetry", fromTelemetry],
  ["wordsnap-state", fromState],
  ["feedback", fromFeedback],
];

test("IPv6は /64 へ丸める（アドレスを変えても同じバケツになる）", () => {
  for (const [name, key] of impls) {
    const a = key("2001:db8:85a3:1111:0:0:0:1");
    const b = key("2001:db8:85a3:1111:ffff:ffff:ffff:ffff");
    assert.equal(a, b, `${name}: /64が同じなら同じ鍵になるべき`);
    // /64 が違えば別のバケツ
    assert.notEqual(a, key("2001:db8:85a3:2222::1"), `${name}: 別の/64は別の鍵`);
  }
});

test("「::」の省略記法を正しく展開する", () => {
  for (const [name, key] of impls) {
    // 2001:db8::1 は 2001:0db8:0000:0000:0000:0000:0000:0001
    assert.equal(key("2001:db8::1"), key("2001:db8:0:0:0:0:0:2"), `${name}: 省略の有無で変わらない`);
    // 先頭の0埋めの有無でも変わらない
    assert.equal(key("2001:0db8:0000:0001::5"), key("2001:db8:0:1::9"), `${name}: 0埋めを吸収する`);
  }
});

test("IPv4はそのまま使う（NAT配下の巻き込みを広げない）", () => {
  for (const [name, key] of impls) {
    assert.equal(key("203.0.113.10"), "203.0.113.10", `${name}: IPv4はそのまま`);
    assert.notEqual(key("203.0.113.10"), key("203.0.113.11"), `${name}: 別アドレスは別の鍵`);
    // IPv4射影アドレスは末尾のIPv4として扱う
    assert.equal(key("::ffff:203.0.113.10"), "203.0.113.10", `${name}: IPv4射影`);
  }
});

test("ヘッダが無い・壊れているときも鍵を返す", () => {
  for (const [name, key] of impls) {
    assert.equal(key(null), "unknown", `${name}: 未設定`);
    assert.equal(key(""), "unknown", `${name}: 空文字`);
    assert.equal(key("   "), "unknown", `${name}: 空白のみ`);
    // 壊れた入力でも例外を出さず、何らかの鍵を返す（fail-openでも鍵は必要）
    for (const bad of ["1:2:3:4:5:6:7:8:9", ":::", "not an ip", "2001:db8:::1"]) {
      assert.equal(typeof key(bad), "string", `${name}: 壊れた入力 ${bad}`);
      assert.ok(key(bad).length > 0, `${name}: 空の鍵を返さない ${bad}`);
    }
  }
});

test("ゾーンID付き（fe80::1%eth0）でも丸められる", () => {
  for (const [name, key] of impls) {
    assert.equal(key("fe80::1%eth0"), key("fe80::2%eth1"), `${name}: ゾーンIDは無視する`);
  }
});

test("3ファイルの実装が一致している（コピーのずれを防ぐ）", () => {
  const samples = [
    "2001:db8:85a3:1111::1", "2001:db8::1", "203.0.113.10", "::ffff:198.51.100.7",
    "fe80::1%eth0", "", null, "壊れた値", "1:2:3:4:5:6:7:8",
  ];
  for (const s of samples) {
    const results = impls.map(([, key]) => key(s));
    assert.equal(new Set(results).size, 1, `入力 ${JSON.stringify(s)} で実装が食い違う: ${results.join(" / ")}`);
  }
});
