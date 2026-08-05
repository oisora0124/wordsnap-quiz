# 内蔵品詞表の作り方

`publish/index.html` の `BUILTIN_POS_GROUPS` / `BUILTIN_POS_MULTI_GROUPS` を作り直す手順。
サンプル単語集を増やしたり訳を直したりしたら、ここを流し直す。

```bash
node scripts/pos/derive-pos.mjs   # 訳から品詞を導出 → pos-derived.json
node scripts/pos/verify-pos.mjs   # Datamuseで裏取り  → pos-verified.json
node scripts/pos/apply-pos.mjs    # index.html へ差しこむ
npm run sync:html && npm test
```

同じ入力なら何度流しても同じ結果になる（冪等）。

## なぜ品詞が要るのか

空所補充は「品詞が違うから、この語は空所に入らない」ことを誤答の根拠にする。
品詞が分からない語は根拠を作れず、通常の意味四択に落ちる。
逆に **品詞を間違えると、空所に入り得る語を「入らない」と誤って提示し、
正解が2つある問題ができてしまう**。だから精度が最優先で、
確信の持てない語は表に入れない（入れなければ従来どおり実行時にDatamuseへ聞くだけ）。

## 3つの段階

### 1. derive-pos.mjs — 訳から導出する

`publish/index.html` のサンプル単語集を唯一の出典として読み、日本語訳の語尾から品詞を推定する。

| 訳の形 | 品詞 | 例 |
| --- | --- | --- |
| 〜な / 〜の | adj | 正確な / 個々の |
| 〜い | adj | 騒々しい |
| 〜た | adj | 隣接した |
| 〜さ / 〜み | n | 鋭さ / 重み |
| 〜する | v | 廃止する |
| う段のかな + 漢字を含む | v | 見捨てる |
| 漢字で終わる / カタカナ語 | n | 教育 / メニュー |

例外（`〜違い`は名詞、`ふた`は名詞など）は、判定できなかった語を**全件読んで**
実在の反例だけを拾い出したもの。推測で足さないこと。規則を広げたら全件を読み直す。

集をまたいで品詞が食い違う語は多品詞語として扱う。

### 2. verify-pos.mjs — Datamuseで裏取りする

導出した品詞を、アプリが実行時に使うのと同じ `md=p` 照会で1語ずつ確かめる。

- 導出した品詞がDatamuseの品詞集合に無い → **表に入れない**（導出が誤っている疑い）
- 品詞が2つ以上 → 多品詞語として、取り得る品詞をすべて持たせる
- 品詞が1つ → その品詞で採用

`datamuse-pos-cache.json` に応答を貯めるので、2回目以降は通信しない。
新しい語を足したときだけ、その語ぶんが照会される。

### 3. apply-pos.mjs — index.html へ差しこむ

`hand-verified-pos.json`（拡張前の手検証済み300語）に載っている語は、
機械導出で**上書きしない**。この300語は人が品詞を確かめたもので、以後も正とする。

## 精度の確かめ方

手検証済み300語と導出結果を突き合わせる。導入時点では**不一致0件**だった。
規則を変えたら必ずこれを測り直すこと。0件でなくなったら規則が間違っている。

```bash
node -e '
const fs=require("fs");
const hand=JSON.parse(fs.readFileSync("scripts/pos/hand-verified-pos.json","utf8"));
const d=JSON.parse(fs.readFileSync("scripts/pos/pos-verified.json","utf8"));
const single=new Map(); for(const k of ["n","v","adj"]) for(const w of d.groups[k]) single.set(w,k);
let ok=0,ng=[];
for(const [tag,words] of Object.entries(hand.groups)) for(const w of words){
  const m=d.multi[w];
  if(m){ m.includes(tag)?ok++:ng.push(w+": 手="+tag+" 多品詞="+m.join(",")); continue; }
  if(!single.has(w)) continue;
  single.get(w)===tag?ok++:ng.push(w+": 手="+tag+" 単一="+single.get(w));
}
console.log("一致",ok,"/ 不一致",ng.length); ng.forEach(x=>console.log("  "+x));'
```

## 表に入らない語について

訳から品詞を判定できない語（副詞、かな書きで動詞と名詞が区別できないもの）と、
Datamuseと食い違った語は表に載せない。これらは従来どおり、例文モードで外部送信に
同意したときだけ実行時に補完される。品詞が無くても出題は成立する（品質が下がるだけ）。
