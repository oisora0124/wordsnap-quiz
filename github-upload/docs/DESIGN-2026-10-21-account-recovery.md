# アカウントによる復旧（パスキー主・メール副）設計案

作成: 2026-10-21 / 状態: **草案 rev1・未実装・レビュー前**。下書きは設計サブエージェント、確認と加筆（§3 の方式選定理由、§4.5）は Fable。
実装前に orchestrated-review（Claude Sonnet ＋ Codex gpt-6.1-sol max の別視点）を通す。
リスク区分: **高**（同期・データ移行・セキュリティ。CLAUDE.md の高リスク領域）。

凡例: 【事実】はリポジトリの該当箇所または公式情報に根拠がある。【推測】は根拠が無い判断。
外部サービスの料金・仕様は **2026-10 時点の要確認** とし、本書では断定しない。

## 背景

端末内の保存（localStorage・IndexedDB）が丸ごと消えると、アプリは新規利用者と区別できず
新しい空の同期先を作る。サーバー側の元データ（`states` / `rooms`、無期限保持 =
`docs/data-retention.md:26-29`）は残るが、そこへ戻る鍵が端末の中にしか無い。

| 識別子 | 形式 | 置き場所 |
|---|---|---|
| legacy 個人キー | `ws_` + 60hex（ID と秘密を兼ねる） | URL `?w=`・`wordsnap-sync-id:v1`（`publish/index.html:18343`） |
| V2 部屋 / 秘密 | `wr_` + 32hex / `wk_` + 60hex（`functions/api/wordsnap-state.js:323-324`） | `wordsnap-sync-credential:v2`（`index.html:18346`）＋ IndexedDB ミラー（`recoverV2CredentialFromIdb`, `index.html:20994`） |
| 金庫鍵 | `wv_` + 64hex（AIキー封筒の鍵。**サーバーへ送らない** = `docs/ai-secret-sync-design.md:132-168`） | 同上。引き継ぎコード3要素目（`parseV2TransferCode`, `index.html:20975-20978`） |

1.0.139（PR #66）で、空で起動したときの復元案内（`showRecoveryPrompt`, `index.html:19594`）、
引き継ぎコードを iPhone のパスワードへ控える form（`index.html:6949-6996`）、未控えの帯を入れた。
これは**利用者が自分で控える**ことに依存する暫定策である。アカウントは「控えなくても戻れる」
ための根本策で、同時に運営が「この人の部屋はどれか」を知る手段にもなる。

## 1. 目的と非目的

**目的**

1. 端末の保存が消えても、本人が**自分で**自分の部屋（`wr_…`）へ戻れること。
2. 戻る操作が、サーバーの既存データを**一切消さず・空で上書きせず**行えること。
3. 運営が、問い合わせを受けたとき「アカウントが存在し、どの部屋に結びついているか」を
   確認できること（鍵を手渡しする裏口は作らない。後述 §5）。
4. アカウント無しで使い続ける人の挙動を **1ビットも変えない**（V2 導入時と同じ原則 =
   `docs/sync-auth-v2-design.md:15-21`）。

**非目的**

- ログイン必須化。アカウントは**任意の追加機能**であり、同期の認可は今までどおり `wk_`。
- legacy `?sync=` 経路の変更（永久不変の原則 = `sync-auth-v2-design.md:17-18`）。
- `wv_`（金庫鍵）の復旧。サーバーへ送らない設計（`ai-secret-sync-design.md:164-166`）を守るため、
  アカウントで戻るのは単語データまで。AIキーは再入力になる（§8 Q6）。
- 運営に対する秘匿性の向上。同一オリジン PWA では運営は既に信頼境界の内側にいる
  （`docs/sync-auth-v3-design.md:19-27`）。本設計はそれを悪化させないが、改善もしない。
- 部屋の削除・失効機能（`../docs/FREE-OPERATIONS-HARDENING-SPEC.md` §6）。別設計。

## 2. 選択肢の比較

| 観点 | A. メール＋ワンタイムコード | B. パスキー（WebAuthn） | C. Sign in with Apple / Google | D. 現状維持＋キーチェーン（1.0.139） |
|---|---|---|---|---|
| 無料運用 | △ **送信手段が要る**。Cloudflare 純正 `send_email` は送信元ドメインが Cloudflare zone であることが必要で pages.dev では使えない（【事実】`docs/feedback-mail.md:33-36`）。さらに宛先が Email Routing の検証済みアドレスに限られるとの理解（【要確認】）＝任意の利用者へは送れない。Resend は独自ドメイン未検証だと**自分宛にしか送れない**（【事実】`feedback-mail.md:37-39`）→ 独自ドメイン（年 US$10 前後【要確認】）が必須。Resend 無料枠 3,000通/月・100通/日、Brevo 無料枠 300通/日、MailChannels の Workers 向け無料経路は 2024 年に終了（いずれも【要確認】） | ◎ 外部サービス不要。D1 に公開鍵と数行。無料枠（D1 読み 500万行/日・書き 10万行/日、Functions 10万req/日【要確認】）に対し、アカウント操作は稀で影響無し | △ Sign in with Apple は Apple Developer Program（年 US$99【要確認】）が必要。Google は無料だが Cloud プロジェクトと同意画面の設定が要る | ◎ 追加費用なし |
| iOS ホーム画面アプリ（standalone）での動作 | ○ 6桁コードなら Mail アプリと往復して入力するだけ。**マジックリンクは不可**（リンクは Safari で開き、standalone とは別の保存領域なので PWA 側にセッションが乗らない。【事実】iOS の standalone は Safari と storage を共有しない） | ○ 【推測・要検証】iOS 16.4 以降は standalone でも `navigator.credentials` が使える認識（それ以前は不可だった記憶があり、対応版の下限を実機で確かめる）。既に `window.confirm` が standalone で壊れる等の罠がある（`index.html:547, 22898`）ため、**Phase A の実機スパイクで確認**する。パスキーは iCloud キーチェーンに入るので「サイトデータ消去」で消えない（キーチェーン方式と同じ性質、ただし自動） | ✕〜△ リダイレクトが standalone から離脱し戻ってこない・ポップアップ不可・Google が WebView 系を拒否する等、**最も罠が多い**（【推測・要確認】）。`form-action 'self'`・`connect-src` の CSP（`publish/_headers:39`）にも穴を開ける必要 | ○ 動作済み（1.0.139）。ただし保存は利用者の任意操作 |
| 複数端末 | ○ メールが読めればどの端末でも | ○ Apple 端末間は iCloud で同期。Android/PC へは QR のハイブリッド方式になり手間（【要確認】） | ○ プロバイダのアカウントがあれば | △ iCloud キーチェーン内の Apple 端末間のみ |
| プライバシー | ✕ **メールアドレス＝個人情報**を初めて持つ。現状は完全匿名（テレメトリ匿名・要望フォームも連絡先欄を廃止 = `docs/VERSIONS.md` 1.0.89）。漏洩時の説明責任・保管規約が発生 | ◎ 乱数のユーザーハンドルのみ。公開鍵は個人を特定しない | ✕ プロバイダの ID・メールを受け取る。利用者の行動がプロバイダ側にも残る | ◎ 変化なし |
| 復旧の確実さ | ○ メールを失わない限り戻れる。メール乗っ取り＝部屋乗っ取り | ○ パスキーを失わない限り戻れる。**iCloud キーチェーンを使わない人・Apple 以外の人は端末紛失で失う**（端末内のパスキーは「サイトデータ消去」には耐える）。パスキー紛失時の救済が無い（→ A を回復用に組み合わせる） | ○ プロバイダ依存。プロバイダのアカウント停止で道連れ | △ 控えた人だけ。控えなかった人には何もできない |
| 運営の本人確認 | ○ 登録メールへ送ることで本人に到達できる | △ アカウント ID と結びついた部屋の存在は分かるが、本人へ連絡する手段は無い | ○ プロバイダの ID | ✕ 何も分からない |
| 実装規模（【推測】） | 中。テーブル2〜3・送信・レート制限・UI。ドメイン取得と DNS が別作業 | 中〜大。サーバーで CBOR/COSE の解釈と ECDSA 検証（Workers の WebCrypto で可）、チャレンジ管理、UI、実機検証 | 中。OIDC コード交換・JWKS 検証・CSP 変更・各社の管理画面設定 | 済 |

**結論**: 「安い・匿名・端末消去に耐える」を同時に満たすのは B だけ。A は**送信手段が無料で揃わない**
（独自ドメインが前提）が、B の弱点（パスキー紛失）を補う回復手段として価値がある。
C は費用か罠のどちらかを必ず抱えるため採らない。D は残す（B の無い環境の人のため）。

## 3. 推奨案

**パスキーを主、引き継ぎコードは残す**の2層（メール回復は §8 の決定 1 で**やらない**。
以下の Phase E・`account_emails` に関する記述は、検討した記録として残す）。

```
層1  引き継ぎコード（wr_.wk_.wv_）         ← 今まで通り。全環境で動く最後の手段
層2  パスキー ＝ 「アカウント」の本体        ← iCloud キーチェーンに自動で入る。控え忘れを無くす
（層3 メール回復は不採用。匿名を保つ。パスキーを失ったら層1 で戻る）
```

- 「アカウントを作る」＝パスキーを1つ登録し、**いま使っている部屋を結びつける**。それ以上は無い。
- 復旧＝空の端末でパスキー認証 → 結びついた部屋の一覧 → 選ぶ → 既存の合流処理（`joinV2Room`,
  `index.html:21886`）で**非破壊に**合流する。
- サーバーは部屋の秘密 `wk_` を**封筒（AES-GCM、鍵は環境変数）**で持つ。平文保存しない原則
  （`sync-auth-v2-design.md:20`）は守る。運営が復号できる点は §5 で正直に書く。
  rekey（秘密の張り替え）は採らない：他端末の `wk_` が無効になり、端末どうしで締め出し合う。
- `wv_` は持たない。復旧後の AI キー同期は「2要素コードで合流した」場合と同じ分岐
  （`ai-secret-sync-design.md` §5.2）。

**なぜ「秘密を返す」方式か（アカウントを同期の認可主体にしない）**

もう一つの作り方として「`account_rooms` を権限表とみなし、同期 API が `wk_` の代わりにアカウントのトークンでも
認可する」がある。秘密を保存せずに済む利点はあるが、採らない。

- 同期本体（`wordsnap-state.js` の認可、`verifyRoomSecret` → `auth_hash`）に新しい認可主体を混ぜることになり、
  「legacy 経路は 1 行も変えない」「アカウント無しの端末は変更前と完全一致」（§6.1 の 5・6）を守る検査が難しくなる。
- 復旧した端末は結局 `wk_` を持っていなければ、以後の同期のたびにアカウント認証（パスキー）が要る。
  10 分トークンを長期セッションにするか、`wk_` を結局返すかのどちらかになる。
- 秘密を返す方式なら、復旧後の端末は「引き継ぎコードを貼った端末」と区別が付かず、既存の合流・同期・
  AI キー同期の分岐をそのまま使える（§4.4）。新しい状態を増やさない。

運営が `wk_` を復号できる点は、現状でも全リクエストで `wk_` を受け取っていることと等価（§5.1「運営」）。

## 4. データモデルと API

### 4.1 D1（`migrations/0008_accounts.sql`、追加型。既存テーブルは ALTER しない）

```sql
CREATE TABLE IF NOT EXISTS accounts (
  account_id  TEXT PRIMARY KEY NOT NULL,   -- 'wa_' + 32hex。サーバー生成の乱数。利用者に見せる ID
  user_handle TEXT NOT NULL UNIQUE,        -- WebAuthn user.id（32byte 乱数の base64url）。メールや名前ではない
  created_at  INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY NOT NULL, -- base64url
  account_id    TEXT NOT NULL,             -- accounts.account_id（FK は張らない。D1 の既存流儀に合わせる）
  public_key    TEXT NOT NULL,             -- COSE 公開鍵（base64url）。登録時に alg -7 (ES256) / -257 (RS256) のみ受理
  alg           INTEGER NOT NULL,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_passkeys_account ON passkeys (account_id);
CREATE TABLE IF NOT EXISTS account_rooms (
  account_id  TEXT NOT NULL,
  room_id     TEXT NOT NULL,               -- rooms.room_id（wr_…）。legacy ws_ は結びつけない（§4.4）
  secret_env  TEXT NOT NULL,               -- AES-GCM(wk_)。鍵は ACCOUNT_KEK 鍵リング、AAD = account_id||room_id
  env_kid     TEXT NOT NULL,
  linked_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, room_id)
);
CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge  TEXT PRIMARY KEY NOT NULL,    -- 32byte 乱数 base64url。1回使ったら DELETE（＝消費）
  purpose    TEXT NOT NULL,                -- 'register' | 'login'
  account_id TEXT,                         -- register 時のみ（新規 account の予約）
  created_at INTEGER NOT NULL
);
```

- セッションテーブルは**作らない**。アカウント操作は稀（登録・結びつけ・復旧）なので、
  `HMAC(SYNC_AUTH_SECRETS 相当の鍵リング, account_id||exp||nonce)` の**無状態トークン（有効 10 分）**
  をメモリにだけ持たせる。同期本体は従来どおり `wk_` で認可され、トークンを使わない。
- Phase E（メール）で `account_emails(account_id, email_hash UNIQUE, email_env, verified_at)` と
  `email_codes(code_hash PK, account_id, expires_at, attempts)` を 0009 で足す。本書では列を確定しない。
- `rooms` / `states` / `state_revisions` は**無変更**。`account_rooms.room_id` は `rooms.room_id` を指すだけ。
  部屋が消えることは無い（無期限保持）ので孤児は構造的に起きない。
- 保持方針（`docs/data-retention.md` の表へ追記）: `accounts` / `passkeys` / `account_rooms` は
  **無期限**（消すと復旧経路が消える）。`auth_challenges` は 10 分で掃除（`rate_limits` と同じ
  「窓が明けたときだけ・上限付き DELETE」の流儀）。

### 4.2 API（新規ファイル `functions/api/account.js`。`wordsnap-state.js` の legacy 経路は 1 行も変えない）

すべて `POST`（`GET` は `?op=rooms` のみ）、JSON、同一オリジン確認（`Origin` / `Sec-Fetch-Site`。
`feedback.js` の M1 対策と同じ）。`ACCOUNTS_ENABLED !== "1"` なら全 op が 503（V2 の
`SYNC_V2_ENABLED` と同じ既定 OFF の作法 = `wordsnap-state.js:589`）。

| op | 入力 | 動作 | 出力 |
|---|---|---|---|
| `register-options` | — | account_id・user_handle を**予約**し challenge を保存 | `{rp, user, challenge, pubKeyCredParams:[-7,-257], authenticatorSelection:{residentKey:"required", userVerification:"preferred"}}` |
| `register` | `{credential}`（attestation） | challenge を消費→`fmt` は `none` のみ受理→`rpIdHash`・`origin`・`UP` フラグ検証→`accounts`＋`passkeys` を **1 batch** で INSERT | `{accountId, token}` |
| `login-options` | — | challenge 保存。`allowCredentials` は**空**（discoverable credential。ユーザー名入力無し＝列挙不能） | `{challenge, rpId, userVerification}` |
| `login` | `{credential}`（assertion） | challenge 消費→`credential_id` で passkey 取得→署名検証→`sign_count` 更新 | `{accountId, token}` |
| `link-room` | token, `{roomId, secret}` | `verifyRoomSecret`（`wordsnap-state.js:478-498` と同じ timing-safe 照合）に通った部屋だけ `account_rooms` へ INSERT OR IGNORE。**`rooms.auth_hash` は触らない** | `{ok}` |
| `rooms` | token | 結びついた部屋の一覧（`stateRev` / `updatedAt` のみ。state 本体は返さない） | `[{roomId, linkedAt, stateRev, updatedAt}]` |
| `recover-room` | token, `{roomId}` | 自分に結びついた部屋なら封筒を開けて秘密を返す | `{roomId, secret}` |
| `unlink-room` | token, `{roomId}` | `account_rooms` の行だけ DELETE | `{ok}` |
| `delete-account` | token | `accounts` / `passkeys` / `account_rooms` の行だけ DELETE。**`rooms` / `states` は触らない** | `{ok}` |

`verifyRoomSecret` 等は現在 `wordsnap-state.js` 内の非公開関数。`account.js` から使うには
**export を足す**（追加のみ・挙動不変。`rateLimitClientKey` が既に export されているのと同じ）。
Pages Functions でルートにならない共有モジュールの置き方は【要確認】。

### 4.3 レート制限（既存 `rate_limits` と `consumeV2RateLimit` の流儀を流用。`wordsnap-state.js:330-407`）

| 操作 | 上限（IP、/64 丸め） | 根拠 |
|---|---|---|
| `register-options` / `register` | 5 回/時 | 行を作る操作。V2 create の 10/時より厳しく |
| `login` 失敗 | 10 回/10 分 | `v2-auth-fail` 30/10 分と同系。パスキーは総当たり不能なので主に異常検知 |
| `link-room` 失敗 | 10 回/10 分 | `wk_` の照合失敗＝V2 認証失敗と同じ性質 |
| `recover-room` | 20 回/時 ＋ **アカウント単位 20 回/日** | 秘密を返す唯一の経路。IP だけだと IPv6 で回避されうるのでアカウント軸も持つ |
| 全体（Phase E のメール送信） | `fb-mail` と同じ IP 5/時＋全体 60/時 | `feedback.js:307` |

テーブル未作成・D1 障害時は fail-open（既存と同じ）。ただし `recover-room` だけは **fail-closed**
（秘密を返す操作で上限を確認できないなら返さない。`feedback-mail.md:42-45` の「送信上限は fail-CLOSED」と同じ理由）。

### 4.4 既存利用者への後方互換と移行

| 利用者の状態（`syncRequestRoute`, `index.html:21033-21061` の kind） | アカウントを作るまで | アカウントを作るとき | 復旧のとき |
|---|---|---|---|
| legacy のみ（`ws_`） | 変化なし | **先に既存の「新方式へ移行」（`op=upgrade`、`states.key` 不変）で部屋を得てから**結びつける。legacy キーそのものは結びつけない（ID と秘密が同一で、封筒に入れると結局 `?w=` と同じ物が二つ目の置き場所に増えるだけ。upgrade は実績のある経路） | 空端末で復旧すると V2 として戻る。`?w=` は消えるが、upgrade 済み部屋は legacy とも dual-accept なので他端末の `?w=` も引き続き動く |
| legacy＋V2 active | 変化なし | 現在の部屋を結びつける | 同上 |
| V2 ネイティブ | 変化なし | 同上 | 同上 |
| アカウント無しのまま | **永久に変化なし**（1.0.139 の案内・帯・キーチェーンもそのまま） | — | 引き継ぎコード |

**両方向の整合**

- 部屋 → アカウント: `account_rooms` は「鍵のコピーの置き場所」であり真実は `rooms`。部屋の認可は変わらないので、
  アカウントを消しても・結びつけを外しても、部屋とすべての端末は何事も無く動く。
- アカウント → 部屋: 復旧は `recover-room` が返した `{roomId, secret}` を **`parseV2TransferCode` 経由と同じ
  形で `joinV2Room` に渡す**。つまり UI 的には「引き継ぎコードを貼り付けた」のと同じ経路で、
  そこにある確認（`index.html:21908` 付近）・ローカル語数の確認（`:21960` 付近）・pending→active
  の昇格（`activateV2Credential`, `:21685`）をそのまま使う。**新しい合流経路を作らない**。
- 復旧は recovery barrier（`sync-v2-phase2-plan.md` 段階3）が `settled` または `inconclusive` に
  なってから、identity claim（`IDENTITY_CLAIM_KEY`, `index.html:38116`）を取って行う。
  起動時の自動実行はしない（利用者の明示操作のみ）。
- 1 アカウントに複数の部屋を結びつけられる。同じ部屋を複数アカウントが結びつけてもよい
  （結びつけには `wk_` が要るので、部屋に対する権限は増えない）。

### 4.5 配信元（origin）とパスキーの結びつき

- 本番の配信元は **`https://wordbank.pages.dev` の一つだけ**（【事実】`DISTRIBUTION.md:3`。旧 Netlify は
  `netlify.toml` で pages.dev へ転送しているだけで、そこで画面は動かない）。`rpId` は **`wordbank.pages.dev`
  （配信元のホストそのもの）**にする。`rpId` を配信元のホストと同じにする分には Public Suffix List は関係ない
  （PSL が効くのは `rpId = "pages.dev"` のように親ドメインへ広げるときで、それは禁止される）。
- パスキーは `rpId` ごとに別物。**デプロイ固有 URL（`<hash>.wordbank.pages.dev`）や Netlify のプレビューで登録した
  パスキーは本番では使えず、逆も同じ**。よって、
  - Phase A のスパイクは「API が動くか」をプレビューで確かめてよいが、「登録→消去→復元」の実機検証は
    **本番ホストで**行う（`docs/browser-e2e.md` の「実データに触れる」注意が当てはまる。検証用の部屋を作って行う）。
  - 将来、配信元を独自ドメインへ移すときは**既存のパスキーが全部使えなくなる**。移す前に、新旧両ホストで
    しばらく登録を受け付ける移行期間が要る（本書の範囲外だが、§8 Q1 の独自ドメイン購入とは別に考える）。
- `localhost` / `127.0.0.1` での開発では `rpId = "localhost"` になる。CSP や `syncServerAvailable()`
  （`index.html:20848`、http でも同期可と判定）の条件は変えない。

## 5. セキュリティ

### 5.1 脅威モデル

| 脅威 | 対策 | 備考 |
|---|---|---|
| メール乗っ取り（Phase E） | メールは**回復用の副経路**。乗っ取られれば部屋も取られることを UI に明記。追加できる緩和: 回復時に登録済みパスキー全部へ…は無理（通知先が無い）。**メール導入を任意にする**のが最大の緩和 | A 案固有の本質的弱点。導入可否は §8 Q1 |
| コードの総当たり（Phase E） | 6 桁・有効 10 分・5 回で失効（`attempts`）・`code_hash` のみ保存・IP と宛先の両軸で上限 | 10^6 / 5 回 で推測成功率 5e-6/回 |
| パスキー認証の偽造 | WebAuthn 署名検証（`rpIdHash` = SHA-256(rpId)、`origin` 一致、`type` 一致、challenge は D1 の行を消費して一度限り）。`fmt:"none"` のみ受理（デバイス証明は見ない＝AAGUID で機種を集めない） | iCloud のパスキーは `sign_count` を常に 0 で返す（【要確認】）ため、**減少は記録のみで拒否しない** |
| セッション窃取 | トークンは 10 分・メモリのみ（localStorage に書かない）・同期本体には使わない。盗まれても `recover-room` のアカウント単位上限が効く | 長期セッションを持たないことが最大の防御 |
| CSRF | Cookie を使わない（トークンはヘッダ）。`Origin` / `Sec-Fetch-Site` 同一オリジン確認。CSP `form-action 'self'`（`_headers:39`） | 既存 API と同じ |
| 列挙攻撃 | `login-options` はユーザー名を取らない（discoverable credential）。`login` 失敗・未知の credential・結びつけ失敗は**同一の 403**（V2 の 403 統一と同じ。`sync-auth-v2-design.md:50`）。Phase E のメール送信は存在有無で応答を変えない | `register` でメールの重複を教えない |
| D1 ダンプ | `secret_env` は環境変数の鍵リング `ACCOUNT_KEK` で封じる。公開鍵・ハッシュのみ平文 | `SYNC_AUTH_SECRETS` と同じ `[{kid, secret}]` 形式でローテーション可（lazy re-wrap） |
| 運営 | **運営は `wk_` を復号できる**。ただし運営は現在も全リクエストの `x-room-key` で `wk_` を受け取っている（`sync-auth-v3-design.md:19-27`）ので、信頼境界は変わらない。UI には「運営が読めません」とは書かない | 将来: パスキーの PRF 拡張（iOS 18 以降【要確認】）で封筒の鍵を端末側に移せば運営から秘匿できる。本書では採らない（対応環境が狭く、PRF が使えない端末で復旧不能になる） |
| XSS | 既存のハッシュ型 CSP（`docs/csp-hashes.md`）。新しい `<script>` を足せば `npm run sync:html` でハッシュが追従する | 変化なし |
| 秘密の漏れ出し | テレメトリの `redactSecrets`（`functions/api/telemetry.js:57, 91`）に `wa_`・トークン・challenge のパターンを追加。クライアント側の伏せ字処理（`index.html:20863` 付近の `wv_` 判定と同系）にも追加 | 1.0.42 の「`wv_` の redaction」と同じ漏れを繰り返さない |
| 無料枠の消費攻撃 | `register` は行を作るので 5/時。`auth_challenges` は 10 分で掃除し、作れる行数を IP 上限で頭打ちにする | `legacy-create` の教訓（`wordsnap-state.js:333-338`） |

### 5.2 既存設計との矛盾と更新箇所

| 既存の記述 | 本設計との関係 | 更新 |
|---|---|---|
| `sync-auth-v2-design.md:61`「サーバーが secret を発行・返却することはない」 | `recover-room` は**本人認証後に**保存済み secret を返す。発行はしない | 「create / upgrade では」と限定し、本書を参照させる |
| `sync-auth-v2-design.md:81`「localStorage 消去時は引き継ぎコードが唯一の復旧手段」 | パスキーが2つ目の手段になる | 「唯一」を削り本書を参照 |
| `../docs/FREE-OPERATIONS-HARDENING-SPEC.md` §6 SYNCSEC-011「運営者による裏口復旧は設けない」 | 復旧は**利用者自身の認証**を通る。運営が手で鍵を渡す経路は作らない。矛盾しないが、誤読されやすい | 「アカウント経由の本人認証による復旧は裏口に当たらない」と注記。§6 自体は V2 実装（`wr_`/`wk_`）で部分的に置き換わっており、その旨も追記 |
| `ai-secret-sync-design.md` §5「vault key はサーバーへ送らない」 | 守る。`account_rooms` に `wv_` 列は無い | §5.2 の表に「アカウント復旧＝2要素コードで合流と同じ」を1行追加 |
| `data-retention.md` の表 | 新テーブルの保持方針が無い | 4 行追加（§4.1） |
| `migrations/README.md`・`wrangler.jsonc` のコメント | 0008 が無い | 行追加 |

## 6. データ保全

### 6.1 不変条件（1つでも破れば実装は出荷しない）

1. **`account.js` は `states` / `state_revisions` / `rooms` に書かない。** 読むのは `rooms`（照合）と
   `states`（`stateRev` / `updatedAt`）だけ。削除文は `accounts` / `passkeys` / `account_rooms` /
   `auth_challenges` にしか無い。
2. **結びつけ・復旧・外す・アカウント削除のどれも `rooms.auth_hash` を変えない**（rekey しない）。
   よって既存端末が締め出されることは無い。
3. **復旧した端末が自動で PUT しない。** 復旧は `joinV2Room` の既存経路を通り、ローカルに語がある
   ときの確認、`readRow` の破損判定（`wordsnap-state.js:220-233`、空で上書きしない）をそのまま使う。
4. **取り消せる。** 結びつけを外す／アカウントを削除すると、サーバーも端末も「アカウントを作る前」と
   同じ状態になる。部屋・単語・履歴は一切変わらない。
5. **legacy `?sync=` の応答はバイト同一**（既存の恒久ゲート。`sync-auth-v2-design.md:103`）。
6. **アカウント無しの端末の localStorage キー集合・送信 URL・UI 表示は変更前と完全一致**
   （Phase 2 の受入条件 1 と同じ流儀。`sync-v2-phase2-design.md:74`）。
7. **フラグ OFF（`ACCOUNTS_ENABLED` 未設定）では新経路は 503 だけを返し、他の API に影響しない。**

### 6.2 テスト方針（`scripts/*.test.mjs` の流儀）

| 検査 | 手段 | 既存の手本 |
|---|---|---|
| migrations が実 SQLite に当たる・何度当てても壊れない | `createTestDatabase()`（`scripts/sqlite-d1.mjs`） | `d1-integration.test.mjs:46-72`。**`tableNames` の完全一致リストを 10 テーブルへ更新**（`:49-51`） |
| スキーマ参照のずれ | `schema-drift.test.mjs` が `account.js` の SQL を自動で拾う | 追加作業なし（`functions/api/*.js` を走査） |
| API 契約 | **実 SQLite（`node:sqlite`）で `account.js` の `onRequest` を直接呼ぶ**。FakeD1 は新 SQL を解釈できず「スタブが防御を素通りさせる」（`data-retention.md:113-118`）ため、新規テーブルは実 SQLite を主にする | `d1-integration.test.mjs`、`feedback-mail.test.mjs:78-80` |
| WebAuthn 検証 | テスト内に **FakeAuthenticator**（Node の WebCrypto で P-256 鍵を作り、`authenticatorData`・`clientDataJSON`・CBOR の `attestationObject` を組み立てて署名）。正常系、`rpIdHash` 不一致、`origin` 不一致、challenge 再利用、`type` 不一致、未知 `fmt`、`UP` 無し、`sign_count` 減少（拒否しないこと） | 新規 |
| 不変条件 1・2 | FakeD1 流に全 SQL を記録し、`states` / `rooms` への INSERT/UPDATE/DELETE が **0 件**であることを断定。加えてソースの静的 grep（`telemetry-contract.test.mjs` の「対象が telemetry だけ」検査と同じ） | `data-retention.md:100-103` |
| 不変条件 3・4 | クライアント: `extractFunction` で復旧ハンドラを切り出し、`joinV2Room` を呼ぶこと・`localStorage.setItem` / `syncState.* =` を直接行わないことを `assert.doesNotMatch` | `empty-start-recovery.test.mjs:88-91` |
| 不変条件 6 | アカウント UI 要素の `data-identity-visible` 相当の計数が、legacy / legacy+V2 / native で変更前と同数 | `sync-v2-phase2-plan.md` 段階2「表示要素数の実測」 |
| レート制限 | 実 SQLite 上で上限到達→429、`recover-room` の fail-closed | `feedback-mail.test.mjs` |
| リリース検査 | `package.json` `scripts.test` への列挙（`check-release.mjs:62`）、`type="button"`（`:368`）、後読み正規表現禁止（`:1528`）、CSP ハッシュ照合 | 既存ゲート |
| 実機 | iPhone ホーム画面アプリで 登録→サイトデータ消去→復元 を通す。パスキーは `rpId` ごとなので**本番ホストで検証用の部屋を使う**（§4.5）。SW が旧 HTML を配る罠（`sync-v2-phase2-plan.md:60-61`）は、フッターの版表示で配信版を確かめて避ける | `docs/browser-e2e.md` |

## 7. 段階的なリリース計画

版番号は `docs/VERSIONS.md:7-8` の規則どおり、`publish/` か `functions/` を変える段階だけ `z` を進める。
Phase A と設計書は進めない。各段階は単独でデプロイ・検証・ロールバックできる。

| Phase | 内容 | 受入条件 | ロールバック |
|---|---|---|---|
| **A. スパイク（コード配信なし）** | デプロイ固有 URL に最小ページを置き、iPhone ホーム画面アプリで `navigator.credentials.create/get` が動くか（対応 iOS の下限も）、Apple のパスキーが返す `sign_count` の挙動、Workers で CBOR/COSE→`crypto.subtle.verify` が通るかを確認。`rpId` はプレビューではそのホスト名になる（§4.5） | 3 点が実機で確認でき、結果を本書 §2 の【要確認】に反映 | 捨てる。失敗なら本設計は B を落として再検討 |
| **B. サーバー（フラグ OFF）** | 0008 適用、`account.js`、`wordsnap-state.js` への export 追加、テスト、redaction 追加。`ACCOUNTS_ENABLED` 未設定のまま配信 | `npm test` 緑。legacy スナップショット同一。本番で全 op が 503。`rooms`/`states` 無変更の静的検査が緑 | Function を戻す（テーブルは残してよい。追加型） |
| **C. クライアント（任意機能・試験的）** | 設定「データの保存・引き継ぎ」に「パスキーで控える（試験的）」節。`PublicKeyCredential` 非対応なら節ごと非表示。復元案内（`showRecoveryPrompt`）に「パスキーで復元」を追加（対応環境のみ）。フラグ ON | 不変条件 1〜7 のテスト緑。アカウント無し端末の表示要素数が不変。実機で 登録→消去→復元 成功。復元後の `stateRev` が消去前と一致（空上書きが起きていない） | フラグ OFF（既存アカウントの復旧は 503 になるが部屋は無傷。利用者は引き継ぎコードで戻れる）。クライアントの節は非表示に戻す |
| **D. 導線の既定化** | 初回同期成功後の「引き継ぎコードを控えてください」提示（段階4）に「パスキーで控える」を**第一候補**として並べる。結びつけ成功を `markV2CodeSavedFor` 相当の「控え済み」とみなすかは §8 Q3 | テレメトリで `account-register` / `account-recover-success` を観測。1 週間で復旧失敗の報告が無い | 提示順を戻すだけ |
| **E. メール回復（任意・別途判断）** | 独自ドメイン取得・Resend/Brevo の設定後、0009・`account_emails`・送信・コード検証。**本書の rev1 として再レビュー** | §8 Q1 が Yes のときだけ着手 | フラグで送信停止 |

デプロイ順序は `migrations/README.md`「適用手順」と同じ: ローカル→`--remote` で 0008 を当ててから Function を配信
（`account.js` はテーブル不在時に 503 を返すので逆順でも壊れないが、順序は固定する）。

## 8. 論点と決定（決める人＝利用者。2026-10-21 に 1・2・3・6 を決定）

| # | 決定 | 設計への反映 |
|---|---|---|
| 1 | **メール回復はやらない**。匿名を保つ。パスキーを失ったら引き継ぎコード頼みと割り切る | Phase E を落とす。§3 は「パスキー主・引き継ぎコードが最後の手段」の2層になる。`account_emails` 等は作らない |
| 2 | 対応環境なら誰でも使えるが、**「iPhone（iCloud キーチェーン）で最も確実」と明記** | Phase C の説明文に入れる。`PublicKeyCredential` 非対応なら節を出さない |
| 3 | 結びつけたら未控えの帯と注意を**消す**。「パスキーを失うと戻れない」旨は設定に残す | 結びつけ成功で `markV2CodeSavedFor` 相当の控え済みにする。設定の引き継ぎコード節に注意文を1行足す |
| 6 | **`wv_` は復旧対象外**（サーバーへ送らない設計を守る） | §3 のとおり。復旧後の AI キーは再入力 |
| 5・7・8 | 本書の提案どおり（削除は結びつけと封筒だけ／「運営も読めません」とは書かない／呼び名は「パスキーで控える」） | — |

以下は決定前の論点の記録。

1. **メールアドレスを持ってよいか。** 現状の完全匿名を捨てることになる。持つなら独自ドメイン（年 US$10 前後【要確認】）を
   買う意思があるか。→ No なら Phase E を落とし、パスキー紛失＝引き継ぎコード頼みと割り切る。
2. **Apple 以外の利用者をどう扱うか。** Android/PC ではパスキーの保存先が Google パスワードマネージャ等になり、
   復旧の確実さは環境次第。「iPhone 向けの機能」と明記して出すか。
3. **アカウントを結びつけたら、未控えの帯（`V2_CODE_SAVED_KEY`, `index.html:21439`）を消すか。**
   提案: 消す。ただし「パスキーを失うと戻れない」旨を設定に残す。
4. **運営の本人確認をどこまで求めるか。** パスキーのみだと運営は「アカウント `wa_…` に部屋が結びついている」までしか
   分からず、本人へ連絡もできない。問い合わせ対応で何をしたいか（例: 「私の部屋はまだありますか」に答えるだけなら
   roomId を聞けば今でも答えられる）。
5. **アカウント削除の意味。** 提案: 結びつけと鍵の封筒だけ消し、部屋と単語は残す（部屋の削除は別機能）。
   「アカウントを消したのにデータが残っている」と誤解されないよう文言を要確認。
6. **`wv_`（AIキー封筒）を諦めてよいか。** 復旧後は AI キーを再入力し、金庫鍵を新規生成する（他端末は新しい
   引き継ぎコードが要る）。これを受け入れるか、PRF 拡張の普及を待って別設計にするか。
7. **運営が `wk_` を復号できることを UI にどう書くか。** 提案: 「同期サーバーは今までも鍵を受け取っています。
   アカウントでそれが増えることはありません」。「運営も読めません」とは書かない（`sync-auth-v3-design.md` 2.1）。
8. **呼び名。** 「アカウント」はログイン必須を連想させる。「パスキーで控える」「iPhone に鍵を預ける」など、
   任意機能であることが伝わる言い方にするか。

## 9. 概算の作業量（【推測】。人日は実装＋テスト＋レビュー対応を含む）

| Phase | 作業量 | 主な不確実性 |
|---|---|---|
| A | 0.5〜1 日 | 実機でしか分からない。失敗すれば以降が変わる |
| B | 3〜5 日 | CBOR/COSE 解釈と FakeAuthenticator の作り込み。既存 helper の export 判断 |
| C | 3〜5 日 | 3.8 万行の `index.html` への UI 追加、standalone 固有の罠、a11y 検査、CSP ハッシュ追従、表示要素数の不変テスト |
| D | 1〜2 日 | 文言と提示順の調整 |
| E | 3〜4 日 ＋ ドメイン取得・DNS・送信プロバイダ設定（別作業） | 到達率（迷惑メール判定）、プライバシー表記 |
| 合計（E 除く） | **8〜13 日** | |

---

本書で確認していないこと: iOS standalone での WebAuthn 可否（対応版の下限）、Apple パスキーの `sign_count` 挙動、
Cloudflare `send_email` の宛先制約、各メール送信サービスの無料枠。いずれも Phase A または Phase E 着手前に一次情報で確かめる。
