# パスキーによる復旧（「パスキーで控える」）設計書

作成: 2026-10-21 / 状態: **rev5・未実装**。rev1 を orchestrated-review（Claude Sonnet ＋ Codex gpt-6.1-sol xhigh、
Haiku→上位モデルで反証）に掛け、生き残った 29 件（高 0・中 18・低 11）を rev2 で反映。rev2 を Codex gpt-6.1-sol xhigh で
再確認し、部分的 4 件と新規 6 件（高 3）を rev3 で反映。rev3 の再確認で残った高 3 件（既存 Undo・単語帳の合体・退避の再取り込み）を
rev4 で反映。rev4 の再確認で残った 2 件（別タブの Undo、復旧の 409 再送が既存マージを通る）を rev5 で反映し、設計書の確認はここで打ち切る
（以後は実装時のテストとレビューで検証する）。設計の担当は Fable。
リスク区分: **高**（同期・データ移行・セキュリティ。CLAUDE.md の高リスク領域）。

凡例: 【事実】はリポジトリの該当箇所または公式情報に根拠がある。【推測】は根拠が無い判断。
外部サービスの料金・仕様は **2026-10 時点の要確認** とし、本書では断定しない。
行番号は 1.0.139（コミット 8950ad2）時点の `publish/index.html` / `functions/api/wordsnap-state.js`。関数名を主、行番号を従として読む。

## 背景

端末内の保存（localStorage・IndexedDB）が丸ごと消えると、アプリは新規利用者と区別できず
新しい空の同期先を作る。サーバー側の元データ（`states` / `rooms`、無期限保持 =
`docs/data-retention.md:26-29`）は残るが、そこへ戻る鍵が端末の中にしか無い。

| 識別子 | 形式 | 置き場所 |
|---|---|---|
| legacy 個人キー | `ws_` + 60hex（ID と秘密を兼ねる） | URL `?w=`・`wordsnap-sync-id:v1`（`SYNC_ID_KEY`, `index.html:18355`） |
| V2 部屋 / 秘密 | `wr_` + 32hex / `wk_` + 60hex（`wordsnap-state.js:323-324`） | `wordsnap-sync-credential:v2`（`index.html:18358`）＋ IndexedDB ミラー（`recoverV2CredentialFromIdb`, `index.html:21009`） |
| 金庫鍵 | `wv_` + 64hex（AIキー封筒の鍵。**サーバーへ送らない** = `docs/ai-secret-sync-design.md:132-168`） | 同上。引き継ぎコード3要素目（`parseV2TransferCode`, `index.html:20990-21001`） |

1.0.139（PR #66）で、空で起動したときの復元案内（`showRecoveryPrompt`, `index.html:19609`）、
引き継ぎコードを iPhone のパスワードへ控える form、未控えの帯を入れた。これは**利用者が自分で控える**
ことに依存する暫定策である。本設計は「控えなくても戻れる」ための根本策で、同時に運営が
「この利用者の部屋はどれか」を知る手段にもなる。

## 1. 目的と非目的

**目的**

1. 端末の保存が消えても、本人が**自分で**自分の部屋（`wr_…`）へ戻れること。
2. 戻る操作が、サーバーの既存データを**一切消さず・空で上書きせず**行えること。端末側のデータも、
   利用者が明示的に選ばない限り捨てないこと。
3. 運営が、問い合わせを受けたとき「アカウントが存在し、どの部屋に結びついているか」を確認できること
   （鍵を手渡しする裏口は作らない。§5）。
4. アカウント無しで使い続ける人の**保存キー集合・送信 URL 集合**を変えないこと（§6.1 の 6）。

**非目的**

- ログイン必須化。「パスキーで控える」は**任意の追加機能**であり、同期の認可は今までどおり `wk_`。
- legacy `?sync=` 経路の変更（永久不変の原則 = `docs/sync-auth-v2-design.md:17-18`）。
- `wv_`（金庫鍵）の復旧。サーバーへ送らない設計（`ai-secret-sync-design.md:164-166`）を守る（§8 決定 6）。
- メールアドレスによる回復（§8 決定 1 で不採用。検討の記録は §2 に残す）。
- 運営に対する秘匿性の向上（`docs/sync-auth-v3-design.md:19-27`）。本設計は保存時の露出を増やすので、§5.3 で正直に扱う。
- 部屋の削除・失効機能（`../docs/FREE-OPERATIONS-HARDENING-SPEC.md` §6）。別設計。

## 2. 選択肢の比較

| 観点 | A. メール＋ワンタイムコード | B. パスキー（WebAuthn） | C. Sign in with Apple / Google | D. 現状維持＋キーチェーン（1.0.139） | E. 合言葉でクライアント側暗号化した退避 |
|---|---|---|---|---|---|
| 無料運用 | △ 送信手段が要る。Cloudflare 純正 `send_email` は pages.dev では使えない（【事実】`docs/feedback-mail.md:33-36`）。Resend は独自ドメイン未検証だと自分宛のみ（【事実】`feedback-mail.md:37-39`）→ 独自ドメインが必須。**Cloudflare 側の任意宛先送信の提供状況は 2026-10 時点で一次情報を再確認**（`feedback-mail.md` の前提は 2026-07） | ◎ 外部サービス不要。D1 に公開鍵と数行 | △ Apple は Developer Program（年 US$99【要確認】）。Google は無料だが管理画面設定が要る | ◎ 追加費用なし | ◎ 暗号文を D1 に置くだけ |
| iOS ホーム画面アプリ（standalone） | ○ 6桁コード。マジックリンクは不可（standalone は Safari と保存領域を共有しない） | ○ 【要検証・Phase A】iOS 16.4 以降は standalone でも `navigator.credentials` が使える認識。`window.confirm` が壊れる等の罠がある（`index.html:547`） | ✕〜△ リダイレクトが standalone から離脱する等、最も罠が多い | ○ 動作済み | ○ 通常の fetch だけ |
| 複数端末 | ○ | ○ Apple 端末間は iCloud で同期。Android/PC は QR のハイブリッド方式（手間） | ○ | △ Apple 端末間のみ | ○ 合言葉を覚えていればどこでも |
| プライバシー | ✕ メールアドレス＝個人情報を初めて持つ | ◎ 乱数のハンドルと公開鍵のみ | ✕ プロバイダの ID を受け取る | ◎ | ◎ 運営も復号できない（同一オリジンの限界は残る） |
| 復旧の確実さ | ○ メールを失わない限り | ○ パスキーを失わない限り。**端末固定のパスキー（iCloud キーチェーン無効・セキュリティキー）は端末紛失で失う** | ○ プロバイダ依存 | △ 控えた人だけ | △ **合言葉を忘れたら誰にも戻せない**。弱い合言葉は総当たりに弱い |
| 運営の本人確認 | ○ | △ アカウントと部屋の存在まで | ○ | ✕ | △ |
| 実装規模（【推測】） | 中＋ドメイン | 中〜大（CBOR/COSE・署名検証・UI・実機） | 中 | 済 | 中（鍵導出 PBKDF2/Argon2・UI） |

**結論**: 「安い・匿名・端末消去に耐える・控えの操作が要らない」を同時に満たすのは B。
E は運営から秘匿でき `wv_` も退避できる長所があるが、「合言葉を忘れる」が今の「コードを控え忘れる」と同じ失敗様式で、
本設計の動機（控え忘れを無くす）に合わない。**B の次の候補として記録し、本書では採らない**。
A は決定 1 で不採用。C は費用か罠を必ず抱える。D は残す。
補足: `navigator.storage.persist()` は既に起動時に呼んでいる（`recoverPersisted`, `index.html:38352`）。それでも消えた事例があるので、D の強化ではなく B が要る。

## 3. 推奨案

**パスキーを主、引き継ぎコードを最後の手段として残す**2層。

```
層1  引き継ぎコード（wr_.wk_.wv_）   ← 今まで通り。全環境で動く最後の手段。wv_ はここにしか無い
層2  パスキー ＝「パスキーで控える」   ← iCloud キーチェーンに自動で入る。控え忘れを無くす
```

- 「パスキーで控える」＝パスキーを登録し、**いま使っている部屋を結びつける**。1 アカウントに複数のパスキー・複数の部屋。
- 復旧＝空の端末でパスキー認証 → 結びついた部屋の一覧（語数付き）→ 選ぶ → **復旧専用の合流処理**（§4.4。
  既存の `joinV2Room` の中身を切り出して共用する）で合流する。端末に語があるときは、必ず先に選ばせる。
- サーバーは部屋の秘密 `wk_` を**封筒（AES-GCM、鍵は環境変数の鍵リング）**で持つ。平文保存しない原則
  （`sync-auth-v2-design.md:20`）は守る。rekey（秘密の張り替え）は採らない：他端末の `wk_` が無効になり締め出し合う。
- `wv_` は持たない。復旧後の AI キー同期は「2要素コードで合流した」場合と同じ分岐（`ai-secret-sync-design.md` §5.2）。

**なぜ「秘密を返す」方式か（アカウントを同期の認可主体にしない）**

もう一つの作り方として「`account_rooms` を権限表とみなし、同期 API が `wk_` の代わりにアカウントのトークンでも認可する」がある。
秘密を保存せずに済む利点はあるが、採らない。

- 同期本体（`wordsnap-state.js` の認可、`verifyRoomSecret` → `auth_hash`）に新しい認可主体を混ぜることになり、
  「legacy 経路は 1 行も変えない」「アカウント無しの端末は変更前と一致」（§6.1）を守る検査が難しくなる。
- 復旧した端末は結局 `wk_` を持たなければ、以後の同期のたびにパスキー認証が要る。長期セッションを持つか、`wk_` を返すかのどちらかになる。
- 秘密を返す方式なら、復旧後の端末は「引き継ぎコードを貼った端末」と区別が付かず、既存の同期・AI キー同期の分岐をそのまま使える。

## 4. データモデルと API

### 4.1 D1（`migrations/0008_accounts.sql`、追加型。既存テーブルは ALTER しない）

```sql
CREATE TABLE IF NOT EXISTS accounts (
  account_id   TEXT PRIMARY KEY NOT NULL,  -- 'wa_' + 32hex。サーバー生成。利用者に見せる ID
  user_handle  TEXT NOT NULL UNIQUE,       -- WebAuthn user.id（32byte 乱数の base64url）。メールや名前ではない
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS passkeys (
  credential_id TEXT PRIMARY KEY NOT NULL,  -- base64url
  account_id    TEXT NOT NULL,              -- accounts.account_id（FK は張らない。D1 の既存流儀に合わせる）
  public_key    TEXT NOT NULL,              -- COSE 公開鍵（base64url）。登録時に alg -7 (ES256) / -257 (RS256) のみ受理
  alg           INTEGER NOT NULL,
  sign_count    INTEGER NOT NULL DEFAULT 0,
  backup_eligible INTEGER NOT NULL DEFAULT 0, -- 登録時の BE フラグ（同期できるパスキーか。以後の認証で一致を検査）
  backed_up     INTEGER NOT NULL DEFAULT 0, -- 最後に見た authenticatorData の BS フラグ（同期済みパスキーか）
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_passkeys_account ON passkeys (account_id);
CREATE TABLE IF NOT EXISTS account_rooms (
  account_id  TEXT NOT NULL,
  room_id     TEXT NOT NULL,                -- rooms.room_id（wr_…）。legacy ws_ は結びつけない（§4.4）
  secret_env  TEXT NOT NULL,                -- AES-GCM(wk_)。鍵は ACCOUNT_KEK 鍵リング、AAD = account_id||room_id
  env_kid     TEXT NOT NULL,
  linked_at   INTEGER NOT NULL,
  PRIMARY KEY (account_id, room_id)
);
CREATE TABLE IF NOT EXISTS auth_challenges (
  challenge   TEXT PRIMARY KEY NOT NULL,    -- 32byte 乱数 base64url
  purpose     TEXT NOT NULL,                -- 'register' | 'login' | 'add-passkey'
  account_id  TEXT,                         -- 'add-passkey' のとき対象アカウント。'register' のとき予約した ID
  user_handle TEXT,                         -- 'register' / 'add-passkey' のときサーバーが発行した user.id（§4.2 register）
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_challenges_created ON auth_challenges (created_at); -- 掃除を全表走査にしない（0007 の教訓）
```

- セッションテーブルは**作らない**。アカウント操作は稀なので、無状態トークン（§4.5）をメモリにだけ持つ。
- `rooms` / `states` / `state_revisions` は**無変更**。部屋は無期限保持なので孤児は構造的に起きない。
- 保持方針（`docs/data-retention.md` の表へ追記）: `accounts` / `passkeys` / `account_rooms` は**無期限**。
  `auth_challenges` は **10 分で期限切れ**。掃除は `*-options` の呼び出しごとに
  `DELETE FROM auth_challenges WHERE created_at < ? LIMIT 100`（上限付き。`telemetry` の刈り込みと同じ）。
  期限の判定は掃除に頼らず、**消費時に必ず行う**（§4.3）。
- `migrations/README.md`・`wrangler.jsonc` のコメントに 0008 を追記。`scripts/d1-integration.test.mjs` は
  `tableNames` の完全一致（:49-51）、`indexNames` の完全一致（:52-57）、**テーブル数 6 → 10**（:68）の 3 か所を更新する。

### 4.2 API（新規ファイル `functions/api/account.js`。`wordsnap-state.js` の legacy 経路は 1 行も変えない）

すべて `POST`、JSON、同一オリジン確認（`Origin` を **許可リスト `ACCOUNT_ORIGINS`**（§4.6）と照合。`feedback.js` の M1 対策と同形）。
`ACCOUNTS_ENABLED !== "1"`、または `ACCOUNT_KEK` が未設定・解析不能なら全 op が 503（V2 の `SYNC_V2_ENABLED` と同じ既定 OFF = `wordsnap-state.js:589`）。

| op | 認証 | 動作 | 出力 |
|---|---|---|---|
| `register-options` | なし | `account_id`・`user_handle` を**サーバーで生成して challenge 行に保存** | `{rp:{id,name}, user:{id:user_handle, name:"WordBank", displayName:"WordBank"}, challenge, pubKeyCredParams:[-7,-257], authenticatorSelection:{residentKey:"required", userVerification:"required"}, attestation:"none", excludeCredentials:[]}` |
| `register` | なし | challenge 消費（§4.3）→ 検証（§5.2）→ `accounts`（`user_handle` は challenge 行の値）＋`passkeys` を **1 batch** で INSERT | `{accountId, token}` |
| `add-passkey-options` | token（**2 分以内**） | challenge 行に `account_id = token.accountId` を保存。`excludeCredentials` に既存の credential_id | 同上 |
| `add-passkey` | token（**2 分以内**） | challenge 消費の条件に `account_id = token.accountId` を含める（§4.3）→検証→`passkeys` INSERT（`user_handle` は accounts の既存値。**1 アカウント 10 本まで**、上限は INSERT 文の条件で原子的に） | `{ok}` |
| `login-options` | なし | challenge 保存。`allowCredentials` は**空**（discoverable credential。ユーザー名入力無し＝列挙不能） | `{challenge, rpId, userVerification:"required"}` |
| `login` | なし | challenge 消費→`credential_id` で passkey 取得→検証（§5.2。`userHandle` が `accounts.user_handle` と一致すること）→`sign_count`・`backed_up`・`last_used_at` 更新 | `{accountId, token, backedUp}` |
| `link-room` | token | `matchRoomSecret`（§4.4。**副作用の無い照合**）に通った部屋だけ `INSERT OR IGNORE INTO account_rooms ... SELECT ... WHERE EXISTS (SELECT 1 FROM accounts WHERE account_id=?) AND (SELECT COUNT(*) FROM account_rooms WHERE account_id=?) < 10`（アカウント存在と **1 アカウント 10 部屋まで**を同じ文で確認）。直後に封筒を開いて `wk_` と一致することを確かめてから `{ok}` | `{ok, backedUp}` |
| `rooms` | token | 結びついた部屋の一覧。各部屋の `states.state` を読み、**語数・単語帳数・最終更新**を返す（state 本体は返さない。最大 10 部屋） | `[{roomId, linkedAt, stateRev, updatedAt, wordCount, deckCount}]` |
| `recover-room` | token（**発行から 2 分以内**） | 自分に結びついた部屋なら封筒を開けて秘密を返す。アカウント存在を再確認 | `{roomId, secret}` |
| `passkeys` | token | 一覧 `[{credentialId, createdAt, lastUsedAt, backedUp}]` | |
| `remove-passkey` | token（2 分以内） | 最後の 1 つは消せない（アカウント削除を使う） | `{ok}` |
| `unlink-room` | token（2 分以内） | `account_rooms` の行だけ DELETE | `{ok}` |
| `delete-account` | token（2 分以内） | `accounts` / `passkeys` / `account_rooms` の行だけ DELETE（1 batch）。**`rooms` / `states` は触らない** | `{ok}` |

`wordsnap-state.js` からは何も import しない。`account.js` は自前の `matchRoomSecret`（§4.4）とレート制限（§4.6）を持つ。
`rateLimitClientKey` だけは既に export されているので使ってよい（挙動不変）。

### 4.3 challenge の発行と消費（原子的・期限付き・用途束縛）

- 発行: 32byte 乱数。`INSERT INTO auth_challenges (challenge, purpose, account_id, user_handle, created_at)`。
- 消費: **1 文で** `DELETE FROM auth_challenges WHERE challenge = ? AND purpose = ? AND created_at > ? [AND account_id = ?] RETURNING account_id, user_handle`
  （`?` = now − 10 分。`add-passkey` では `account_id = token.accountId` を条件に含める）を実行し、**返った行が 1 件**のときだけ続行
  （D1 は `RETURNING` に対応。`meta.changes` だけでは消費した行の値が取れない）。SELECT→DELETE に分けない（並行 2 リクエストで二重使用できる）。
  `purpose` 不一致・期限切れ・既消費・アカウント不一致はすべて同じ 403。
- `register` の `account_id`・`user_handle` は**返った行から取る**。クライアントの申告は使わない（登録応答に userHandle は含まれないため）。
  `add-passkey` の `user_handle` は `accounts` の既存値を使い、返った行の値と一致することも確かめる。

### 4.4 既存利用者への後方互換と移行

| 利用者の状態（`syncRequestRoute`, `index.html:21048-21076` の kind） | 控えるまで | 控えるとき | 復旧のとき |
|---|---|---|---|
| legacy のみ（`ws_`） | 変化なし | **先に既存の「新方式へ移行」（`op=upgrade`、`states.key` 不変）で部屋を得てから**結びつける。upgrade は **片道**（`rooms` に `upgraded_from_legacy=1` の行が増え、端末は V2 active になる）。UI にその旨を明記し、「パスキーを外しても upgrade は戻らない」と伝える | 空端末で復旧すると V2 として戻る。upgrade 済み部屋は legacy とも dual-accept なので他端末の `?w=` も引き続き動く |
| legacy＋V2 active / V2 ネイティブ | 変化なし | 現在の部屋を結びつける | 同上 |
| アカウント無しのまま | **永久に変化なし**（1.0.139 の案内・帯・キーチェーンもそのまま） | — | 引き継ぎコード |

**`matchRoomSecret`（副作用の無い照合）**

`verifyRoomSecret`（`wordsnap-state.js:478-498`）は、鍵リングの先頭以外で一致したときに `updateAuthHashLazily`
（`:464-476`、`UPDATE rooms SET auth_hash, auth_kid`）を呼ぶ。鍵ローテーション後にこれを流用すると `rooms` へ書き込みが起き、
不変条件 1 と矛盾する。`account.js` は**照合だけ**を行う `matchRoomSecret(room, secret, keyRing)`（timing-safe、書き込み無し）を
自前で持つ。再ハッシュは次に同期本体が通ったときに従来どおり行われる。

**復旧の合流処理（既存 `joinV2Room` の現実）**

`joinV2Room`（`index.html:21901`）は引数を取らず入力欄から読み、事前確認は「**別の active V2 部屋を使っているとき**の二度押し」
（`:21922-21932`）だけで、**ローカルの語数は見ない**。取得した remote を `appState` に**そのまま採用**し（`:21972-21989`）、
ローカルは `offerUndo` の 1 件に退避するだけ。その後に学習・同期・編集があると取り消しは消える（`performUndoOnce`, `:24341`）。
よって「既存の確認をそのまま使う」は成り立たない。次のように作る。

1. `joinV2Room` の中身を `adoptV2Room(credential, { onBeforeReplace })` に切り出し、`joinV2Room` はそれを呼ぶだけにする
   （高リスク関数のシグネチャは変えず、入力欄経由の挙動も不変。`scripts/ai-secret-sync.test.mjs:243-247` の既存テストで固定）。
2. 復旧は `recover-room` の `{roomId, secret}` から資格情報を組み立て、`adoptV2Room` を呼ぶ。**DOM の入力欄に秘密を書かない**。
3. `onBeforeReplace`: 端末に語が 1 つでもあれば、置き換える前に必ず選ばせる。
   「この端末の N 語を捨てて復旧先（M 語）を採用」／「この端末の語を復旧先へ**合流**」／「やめる」。
   - **合流の規則（復旧専用。`mergeAppStates` は使わない）**: `mergeAppStates`（`index.html:22274`）は和集合ではない。
     両側の削除の記録を統合して適用し（`:22298`）、さらに**単語帳を名前で合体**する（`:22243-22265`）ため、端末側で単語帳を
     改名していると復旧先の別の単語帳と合体し、その単語帳の削除記録が復旧先の生存語に読み替えられて消える反例がある。
     端末側の削除記録を捨てるだけでは防げない。復旧では次の **`appendLocalWords(remote, local)`** だけを行う。
     - 復旧先 `remote` を**正**とし、その単語帳・語・学習状態・削除記録・ゴミ箱・履歴は**一切変えない**。
     - `local` の語のうち、`normalizeTerm` で `remote` に存在しないものだけを、**新しい単語帳「復旧前のこの端末の単語（日付）」**
       （新規 ID）へ追加する。語の学習状態・履歴はその語に付いたまま持ち込む。
     - `local` の単語帳の名前・ID・削除記録・ゴミ箱は**使わない**（合体も適用もしない）。
     - **結果の送信は復旧専用の再送で行い、既存の 409 経路（`index.html:22843` 付近。`mergeAppStates` で取り込んで再送）は使わない。**
       既存の 409 マージは単語帳の名前対応表（`:22231`）に旧名が残るため、別端末が単語帳を改名・新設・削除した直後だと、復旧先由来の
       削除記録だけでも生存語が別の単語帳の語に読み替えられて消える反例がある。復旧の送信は
       「最新 `remote` を GET → `appendLocalWords(remote, pendingLocalWords)` を組み直す → その rev で PUT。409 なら繰り返す（最大 5 回、
       超えたら中止して退避だけ残す）」。再送の入力は常に「追加予定だった端末の語」だけで、前回の送信結果は使わない。
     - **復旧の確定では、端末に語が無くても（「採用」でも）必ず 1 回 PUT する**（内容が同じでも rev が進む）。これにより、
       古い rev を持つ別タブの送信は CAS（`wordsnap-state.js:1038`）で必ず 409 になる。
     テストは「端末に削除記録 X・改名した単語帳がある状態で、復旧先の生存語 X・Y が残り、端末だけの語 Z が新しい単語帳に入ること」と
     409 再送までを含める。
4. **復旧では `offerUndo` を呼ばず、確定時に既存の Undo を `clearUndo()` で消し、Undo を同期先に束縛する。** 既存の「元に戻す」（`performUndoOnce`,
   `index.html:24383`）は旧 `appState` だけを戻して通常送信を予約し、資格情報と rev は復旧先のままなので、復旧の直前に別の操作で
   作られた Undo（例: 空端末で引き継ぎコードから合流したときの「空へ戻す」Undo、`:21989`）が残っていると、復旧後に押すだけで
   通常 PUT の CAS（`wordsnap-state.js:1038`）が通り**復旧先を空で上書きできる**。よって、復旧の確定（置換または追加の直前）で
   `clearUndo()` を呼び（`index.html:24314`。メモリと `UNDO_STORAGE_KEY` の両方を消す）、復旧処理中は Undo ボタンを無効化する。
   **別タブ**のメモリに残った Undo はこれでは消えないので、Undo のスナップショットに**作成時の同期先（roomId または legacy キー）**を
   記録し、`performUndoOnce` は現在の同期先と違えば実行せず捨てる（既存の Undo にも効く小さな変更。同期先が変わった後の Undo は
   どのみち意味を持たない）。復旧後の必ず 1 回の PUT（上記）で rev も進むため、別タブの古い送信は二重に止まる。
   テストは「既存 Undo を持った状態から復旧し、再読込後も Undo が出ない」「同期先が変わった Undo は実行されない」を含める。
5. **退避**: 置換前の端末の状態を `wordsnap-recovery-backup:v1`（1 件、上書き）に保存し、設定の「データの保存・引き継ぎ」から
   **JSON で書き出す**ことと、**「退避の単語を今の単語帳へ追加」**（上の `appendLocalWords` と同じ規則）だけができる。
   「退避の単語を追加」の送信も上の復旧専用の再送を使う。書き出す JSON は `kind: "wordsnap-recovery-backup"` を持ち、**既存の JSON 取り込み（`index.html:37821` 付近、読み込んだ状態へ
   置換し消えた語に削除記録を付ける）では受け付けない**（この形式を検出したら「設定の『退避の単語を追加』から読み込んでください」と
   案内して何もしない）。0 語の退避を既存取り込みで読み戻すと、復旧先の全語に削除記録が付いて空上書きできるため。
   3 択の確認が主な安全装置で、退避は保険。
6. 復旧は recovery barrier が `settled` / `inconclusive` になってから、identity claim（`IDENTITY_CLAIM_KEY`, `index.html:38153`）を
   取って行う。起動時の自動実行はしない。

**自動発行された空の部屋との混同**

保存が消えた端末は起動時に空の V2 部屋を自動発行する（`SYNC_V2_NATIVE_DEFAULT`）。その状態で「パスキーで控える」を押すと
空の部屋が結びつく。復旧画面は `rooms` の語数で**語数の多い順**に並べ、0 語の部屋は「空（0 語）」と表示する。
「この端末で自動発行」の注記は、その `roomId` が端末の現在の資格情報（起動時に自動発行したもの）と一致するときだけ付ける
（別端末で作った空の部屋や、空にした既存の部屋と区別できないため、一律には付けない）。
さらに「控える」操作は**端末に語が 1 つ以上あるときだけ**出す（0 語の部屋を結びつける動機が無い）。

### 4.5 トークン

- `token = base64url(payload) + "." + HMAC-SHA256(ACCOUNT_KEK[0], payload)`、`payload = {accountId, cid, iat, exp}`。
  `exp = iat + 10 分`。`cid` は認証に使った credential_id。
- **破壊的・秘密を返す・認証手段を増やす op**（`recover-room` / `remove-passkey` / `unlink-room` / `delete-account` /
  `add-passkey-options` / `add-passkey`）は `iat` が **2 分以内**のトークンだけ受け付ける。パスキーの追加を除外すると、
  盗まれた 3 分経過のトークンで攻撃者のパスキーを足し、その鍵で新しいトークンを得て復旧できる（短期トークンが恒久化する）。
- **すべての op で、`cid` が当該アカウントに現存するパスキーであることを確認する**（`remove-passkey` で消したパスキーが発行した
  トークンは、その時点で無効になる）。`accounts` 行の存在確認も兼ねる（`delete-account` 後の 10 分窓で孤児の封筒を作らせない。
  `link-room` は §4.2 の 1 文でも確認）。
- nonce は記録しない（無状態）。再生は 10 分窓の中で同じ op を繰り返せるだけで、各 op は §4.6 の上限で頭打ち。

### 4.6 配信元（origin）・rpId・レート制限

**配信元**

- 本番の配信元は **`https://wordbank.pages.dev` の一つだけ**（【事実】`DISTRIBUTION.md:3`。旧 Netlify は転送のみ）。
  `rpId` は **`wordbank.pages.dev`**（配信元のホストそのもの。PSL は「親ドメインへ広げる」ときだけ関係する）。
- `ACCOUNT_ORIGINS`（環境変数、既定 `https://wordbank.pages.dev`）を `clientDataJSON.origin` と `Origin` ヘッダの許可リストにする。
  プレビュー（`<branch>.wordbank.pages.dev`）は同じ Functions と同じ D1（`wrangler.jsonc:14-20`）を共有するので、
  **許可リストに無いプレビューからの登録は 403 で弾く**。プレビューで検証するときは一時的に追加する。
- パスキーは `rpId` ごとに別物。独自ドメインへ移すときは既存のパスキーが使えなくなる。WebAuthn Level 3 の
  Related Origin Requests（`/.well-known/webauthn`。対応ブラウザは【要確認】）で両ホストを同じ `rpId` に束ねる選択肢を、
  移行のときに比較する（本書の範囲外）。

**レート制限（`account.js` 自前。`consumeV2RateLimit` は流用しない）**

`consumeV2RateLimit`（`wordsnap-state.js:358-412`）は非公開で、規則表 `V2_RATE_LIMITS` に無い op は `rule` が undefined になり
TypeError を握り潰して**無制限**になる。また失敗時は常に「制限しない」。流用せず、`account.js` に次を持つ。

| 鍵 | 上限 | 窓 | 失敗時 |
|---|---|---|---|
| `acct-options:<ip/64>` | 20 | 10 分 | fail-open |
| `acct-register:<ip/64>` | 5 | 1 時間 | fail-open |
| `acct-login-fail:<ip/64>` | 10 | 10 分 | fail-open |
| `acct-link-fail:<ip/64>` | 10 | 10 分 | fail-open |
| `acct-recover-ip:<ip/64>` | 20 | 1 時間 | **fail-closed** |
| `acct-recover-acct:<account_id>` | 20 | **24 時間** | **fail-closed** |
| `acct-read:<account_id>`（`rooms` / `passkeys` の一覧） | 60 | 10 分 | fail-open |
| `acct-write:<account_id>`（`link-room` / `add-passkey` / `unlink-room` / `remove-passkey` の成功・失敗とも） | 30 | 1 時間 | fail-open |

- 鍵の接頭辞を op ごとに分け、窓明けの掃除 `DELETE ... WHERE rl_key LIKE '<接頭辞>:%' AND window_start <= ?` が
  **自分の窓の長さ**で行われるようにする（同じ接頭辞に 1 時間窓と 24 時間窓を混ぜない）。
- `link-room` の失敗を V2 同期の共有バケット `v2-auth-fail` に入れない（同一 IP の通常同期を 429 にしない）。
- `*-options` は行を作るので上限を持つ（D1 無料枠の書き込み 10 万行/日を同期と共用しているため。`legacy-create` の教訓 = `wordsnap-state.js:334-338`）。
- fail-closed の op は、`rate_limits` が読めない・書けないとき 503 を返す（`feedback-mail.md:42-45` と同じ理由）。
- 消費の時点は**処理の前**（成功・失敗にかかわらず数える。`v2-auth-fail` のように失敗時だけ数える鍵は `*-fail` だけ）。
- 件数の上限（パスキー 10 本・部屋 10 件／アカウント）は INSERT 文の条件で原子的に守る（§4.2）。`rooms` の一覧が読む
  `states` は最大 10 行。

## 5. セキュリティ

### 5.1 脅威モデル

| 脅威 | 対策 |
|---|---|
| パスキー認証の偽造 | §5.2 の検証手順。challenge は 1 文で消費（§4.3） |
| セッション窃取 | 10 分・メモリのみ・破壊的 op は 2 分以内・同期本体には使わない・アカウント単位の上限 |
| CSRF | Cookie を使わない（トークンはヘッダ）。`Origin` の許可リスト照合。CSP `form-action 'self'`（`_headers:39`） |
| 列挙攻撃 | `login-options` はユーザー名を取らない。`login` 失敗・未知の credential・結びつけ失敗・challenge 不正はすべて同じ 403 |
| D1 ダンプ・バックアップ | `secret_env` は `ACCOUNT_KEK` で封じる。**KEK も漏れると全封筒が一括で開く**（§5.3） |
| XSS | 既存のハッシュ型 CSP（`docs/csp-hashes.md`）。`npm run sync:html` でハッシュが追従 |
| 秘密の漏れ出し | テレメトリの `redactSecrets`（`functions/api/telemetry.js:57, 91`）と `feedback.js` の伏せ字、クライアント側の伏せ字処理（`index.html:20863` 付近）に `wa_`・トークン・challenge のパターンを追加（却下された指摘にあった「feedback.js は独立実装」も確認する） |
| 無料枠の消費攻撃 | `*-options` と `register` の上限（§4.6）、`auth_challenges` の上限付き掃除 |
| 端末固定のパスキー | `backed_up`（BS フラグ）を保存し、同期されていないパスキーしか無いアカウントには UI で警告（§7 Phase C） |

### 5.2 WebAuthn 検証手順（サーバー。登録・認証に共通する部分は 1 つの関数にする）

1. `clientDataJSON` を受信バイト列のまま保持し、JSON として解釈。`type` が `webauthn.create` / `webauthn.get` のうち期待する方、
   `challenge` が消費した行の値、`origin` が `ACCOUNT_ORIGINS` に含まれること。
2. `authenticatorData`（登録時は `attestationObject` の CBOR から `authData`）: `rpIdHash == SHA-256(rpId)`、
   **UP = 1 と UV = 1**（`userVerification:"required"` と対にする）、BE/BS を読む。**BS = 1 なのに BE = 0 は拒否**
   （仕様上あり得ない組）。登録時は BE を `backup_eligible` に保存。認証時は BE が保存値と**一致**すること（違えば 403）、
   BS を `backed_up` に保存。`signCount` を読む。
3. 登録: `fmt` が `none` のみ。`attStmt` は空であること。COSE 公開鍵の `kty`/`alg` が `pubKeyCredParams` で許した組
   （EC2 P-256 ＋ ES256、または RSA ＋ RS256）に一致すること。`credential_id` の重複は 409 相当の同じ 403。
4. 認証: 署名対象は **`authenticatorData || SHA-256(clientDataJSON の受信バイト列)`**。ES256 の署名は **ASN.1 DER**
   なので **r||s（IEEE P1363、各 32 byte）へ変換してから** `crypto.subtle.verify`。RS256 はそのまま。
   `response.userHandle` が `accounts.user_handle` と一致すること。
5. `sign_count`: Apple のパスキーは常に 0 を返す（【要確認】Phase A で実測）。**減少しても拒否せず記録だけ**。
6. 失敗はすべて同じ 403。成功時だけ `last_used_at` 等を更新。

### 5.3 `ACCOUNT_KEK` の運用（信頼境界の変化を正直に書く）

- 形式は `SYNC_AUTH_SECRETS` と同じ `[{kid, secret}]` の鍵リング。封筒は先頭鍵で作り、開くときは `env_kid` で選ぶ。
  ローテーションは「新鍵を先頭に足す → 開けたときに先頭鍵で包み直す（lazy re-wrap）→ 全行が新 kid になったら旧鍵を外す」。
- **保管**: Cloudflare のシークレットは設定後に読み戻せない。生成した値は運営者のパスワードマネージャに控える。
  KEK を失うと全封筒が開けなくなり、復旧経路が一括で消える（部屋と単語は無傷。利用者は引き継ぎコードで戻れる）。
- **未設定・解析失敗**: 全 op を 503（登録だけ通す中途半端な状態を作らない）。
- **信頼境界**: 現状、D1 に残るのは `auth_hash`（HMAC）だけで、D1 のエクスポートやバックアップだけでは `wk_` は取れない。
  封筒を持つと「D1 ＋ KEK」の両方が漏れた場合に、休眠中を含む全結びつけ部屋の `wk_` が一括で復号できる。
  実行時の運営者は今も `x-room-key` で `wk_` を受け取っているので、**実行時**の境界は変わらないが、**保存時**の露出は増える。
  これを受け入れるのが本設計の前提（§8 決定 7 の文言で UI に反映）。
- `delete-account` で封筒を消しても、D1 の Time Travel／バックアップには残りうる（`data-retention.md` の削除の節と同じ注記を足す）。

### 5.4 既存設計との矛盾と更新箇所

| 既存の記述 | 本設計との関係 | 更新 |
|---|---|---|
| `sync-auth-v2-design.md:61`「サーバーが secret を発行・返却することはない」 | `recover-room` は本人認証後に保存済み secret を返す。発行はしない | 「create / upgrade では」と限定し本書を参照 |
| `sync-auth-v2-design.md:81`「localStorage 消去時は引き継ぎコードが唯一の復旧手段」 | パスキーが 2 つ目の手段 | 「唯一」を削り本書を参照 |
| `../docs/FREE-OPERATIONS-HARDENING-SPEC.md` §6 SYNCSEC-011「運営者による裏口復旧は設けない」 | 復旧は利用者自身の認証を通る。運営が手で鍵を渡す経路は無い | 「本人認証による復旧は裏口に当たらない」と注記 |
| `ai-secret-sync-design.md` §5「vault key はサーバーへ送らない」 | 守る。`account_rooms` に `wv_` 列は無い | §5.2 の表に 1 行追加 |
| `data-retention.md` の表・削除の節 | 新テーブルの保持方針と Time Travel の注記が無い | 4 行追加 |
| `migrations/README.md`・`wrangler.jsonc` | 0008 が無い | 行追加 |

## 6. データ保全

### 6.1 不変条件（1 つでも破れば出荷しない）

1. **`account.js` は `states` / `state_revisions` / `rooms` に一切書かない。** 読むのは `rooms`（照合）と `states`（一覧の語数）だけ。
   照合は副作用の無い `matchRoomSecret`（§4.4）で行う。削除文は自分の 4 テーブルにしか無い。
2. **結びつけ・復旧・外す・削除のどれも `rooms.auth_hash` を変えない**（rekey しない）。既存端末は締め出されない。
3. **復旧した端末が黙って送信・置換しない。** 端末に語があれば §4.4 の 3 択を必ず経る。空上書きの防御（`readRow` の破損判定、
   `wordsnap-state.js:220-233`）はそのまま効く。
4. **アカウントの操作は取り消せる。** 結びつけを外す／削除すると、`accounts` / `passkeys` / `account_rooms` は作る前と同じになる。
   部屋・単語・履歴は変わらない。**legacy 利用者の upgrade は片道**で、これは本不変条件の対象外（§4.4 で UI に明記）。
5. **legacy `?sync=` の応答はバイト同一**（既存の恒久ゲート。`sync-auth-v2-design.md:103`）。
6. **アカウント無しの端末の localStorage キー集合と送信 URL 集合は変更前と完全一致。** UI は「パスキーで控える」の節と
   復元案内のボタンが**対応環境でだけ**増える（`PublicKeyCredential` と `isUserVerifyingPlatformAuthenticatorAvailable()` の両方が真）。
   非対応環境（Safari 16 未満を含む。本リポジトリは Safari 13.1 系を下限に維持 = `check-release.mjs:1524-1528`）では要素数も不変。
   クライアントはサーバーのフラグを**探りに行かない**（送信 URL 集合を変えないため）。節を開いて操作したときの 503 で「準備中」を出す。
7. **フラグ OFF / KEK 未設定では新経路は 503 だけを返し、他の API に影響しない。**

### 6.2 テスト方針（`scripts/*.test.mjs` の流儀）

| 検査 | 手段 | 既存の手本 |
|---|---|---|
| migrations が実 SQLite に当たる・再適用で壊れない | `createTestDatabase()` | `d1-integration.test.mjs:46-72`。`tableNames`・`indexNames`・件数 6→10 の 3 か所を更新 |
| スキーマ参照のずれ | `schema-drift.test.mjs` が `account.js` の SQL を自動で拾う | 追加作業なし |
| API 契約 | **実 SQLite で `account.js` の `onRequest` を直接呼ぶ**（FakeD1 は新 SQL を解釈できない = `data-retention.md:113-118`） | `d1-integration.test.mjs`、`feedback-mail.test.mjs` |
| WebAuthn 検証 | **Phase A で実機から採った登録・認証データ**（DER 署名のまま）をフィクスチャとして保存し、それが通ること。加えて FakeAuthenticator（Node の WebCrypto で P-256 鍵を作り、CBOR の `attestationObject` を組み立て、**署名は r\|\|s から DER へ変換して**出す）で、`rpIdHash` 不一致・`origin` 不一致・challenge 再利用・`purpose` 不一致・期限切れ・`type` 不一致・未知 `fmt`・UP/UV 無し・`userHandle` 不一致・`alg` 不一致・`sign_count` 減少（拒否しない）を網羅 | 新規 |
| challenge の原子性 | 同じ challenge で 2 リクエストを同時に流し、1 つだけ通る | 新規 |
| トークン | `delete-account` 後の `link-room` が 403、`iat` 2 分超の `recover-room` / `add-passkey` が 403、`remove-passkey` 後にその `cid` のトークンが 403、A の challenge ＋ B のトークンの `add-passkey` が 403 | 新規 |
| 復旧の合流 | `appendLocalWords`: 端末に削除記録 X・ゴミ箱 Y・復旧先と同名に改名した単語帳がある状態で、復旧先の生存語 X・Y が残り、端末だけの語 Z が新しい単語帳に入る。復旧先の単語帳 ID・削除記録が変わらない。**初回 PUT の前に別端末が単語帳を改名・新設し旧名の単語帳で語を削除した状態で 409 → 再送**しても、最新 remote の生存語が残る。「採用」でも PUT が 1 回行われ rev が進む | 新規 |
| Undo と退避 | 既存 Undo を持った状態から復旧→確定で Undo が消え、再読込後も出ない。退避 JSON（`kind: "wordsnap-recovery-backup"`）を既存の JSON 取り込みに渡すと何もせず案内が出る。「退避の単語を追加」が `appendLocalWords` の規則で動く | 新規 |
| 不変条件 1・2 | 全 SQL を記録し、`states` / `rooms` への INSERT/UPDATE/DELETE が **0 件**。**鍵リングを 2 本にして旧鍵で作った部屋**でも 0 件。ソースの静的 grep も併用（対象は `account.js` 全文） | `data-retention.md:100-103` |
| KEK | 鍵リングのローテーションで lazy re-wrap が起き、旧鍵を外した後も開けること。KEK 未設定で全 op が 503 | 新規 |
| 不変条件 3・4 | `adoptV2Room` の `onBeforeReplace` が端末に語があるとき必ず呼ばれ、「やめる」で何も変わらないこと。`joinV2Room` 経由の既存挙動が不変（`ai-secret-sync.test.mjs:243-247`） | `empty-start-recovery.test.mjs` |
| 不変条件 6 | 非対応環境（`PublicKeyCredential` 無し）での表示要素数・localStorage キー集合・fetch URL 集合が変更前と同一 | `sync-v2-phase2-plan.md` 段階 2 |
| レート制限 | 実 SQLite 上で各鍵の上限到達→429、`recover-room` の fail-closed（`rate_limits` を読めない状況で 503） | `feedback-mail.test.mjs` |
| テレメトリ | `account-register` / `account-link` / `account-recover-success` / `account-recover-fail` を `USAGE_NAMES`（`index.html:7444`）に追加。`telemetry-contract.test.mjs` の許可リスト検査 | 既存 |
| リリース検査 | `package.json` `scripts.test` への列挙、`type="button"`、後読み正規表現禁止、CSP ハッシュ照合 | 既存ゲート |
| ブラウザ E2E | Chrome DevTools の virtual authenticator（Playwright の `WebAuthn` CDP）で 登録→保存消去→復元 | `docs/browser-e2e.md` |
| 実機 | iPhone ホーム画面アプリで 登録→サイトデータ消去→復元 を**本番ホスト**で検証用の部屋を使って通す（§4.6）。フッターの版表示で配信版を確かめる | `docs/browser-e2e.md` |

## 7. 段階的なリリース計画

版番号は `docs/VERSIONS.md:7-8` の規則どおり、`publish/` か `functions/` を変える段階だけ `z` を進める。各段階は単独でデプロイ・検証・ロールバックできる。

| Phase | 内容 | 受入条件 | ロールバック |
|---|---|---|---|
| **A. スパイク（本番に出さない）— 2026-10-23 完了・合格** | ブランチ `spike/passkey` の検証ページを iPhone ホーム画面アプリで操作: `create/get` が動くか（対応 iOS の下限）、Apple のパスキーの `sign_count`、BE/BS の値、**通信を挟んだ `get`**（click → fetch → get で transient activation が切れないか）、**バックグラウンドから戻った直後の `get`**、iCloud キーチェーンを切った状態の登録。採った生データを Node（Workers と同じ WebCrypto）で検証し、DER→r\|\|s 変換込みで署名が通ること | 上記が実機で確認でき、結果と生データ（フィクスチャ）を §2・§5.2・§6.2 に反映 | 捨てる。失敗なら B を落として §2 E 案を再検討 |
| **B. サーバー（フラグ OFF）** | 0008、`account.js`、レート制限、redaction 追加、テスト。`ACCOUNTS_ENABLED` 未設定のまま配信 | `npm test` 緑。legacy スナップショット同一。本番で全 op が 503。不変条件 1・2 の記録テスト（鍵ローテーション込み）が緑 | Function を戻す（テーブルは残してよい） |
| **C. クライアント（任意機能・試験的）** | 設定「データの保存・引き継ぎ」に「パスキーで控える（試験的・iPhone で最も確実）」節（対応環境のみ）。`adoptV2Room` の切り出しと 3 択の確認。復元案内に「パスキーで復元」（対応環境のみ）。パスキーの追加・一覧・削除。端末固定のパスキーしか無いときの警告。フラグ ON | 不変条件 1〜7 のテスト緑。非対応端末の表示要素数が不変。実機で 登録→消去→復元 成功。復元後の `stateRev` が消去前と一致。語のある端末で 3 択が出る | フラグ OFF（既存アカウントの復旧は 503。部屋は無傷。引き継ぎコードで戻れる）。クライアントの節は 503 を受けて「準備中」表示。**未控えの帯は §7.1 の規則で自動的に戻る** |
| **D. 導線** | 初回同期成功後の「引き継ぎコードを控えてください」の提示に「パスキーで控える」を第一候補として並べる。結びつけ成功と帯の関係は §7.1 | テレメトリで `account-register` / `account-recover-success` を観測。1 週間で復旧失敗の報告が無い | 提示順を戻すだけ |

（Phase E メール回復は §8 決定 1 で不採用。）

**Phase A の結果（2026-10-23、iPhone iOS 18.7 / Safari 27.0.1、ホーム画面アプリ）**

| 項目 | 結果 |
|---|---|
| standalone で `navigator.credentials.create/get` | 動く（`platformAuthenticator: true`、`conditionalMediation: true`） |
| 登録 | `fmt: none`、ES256（alg -7）、`transports: internal, hybrid`、UP=UV=1、**BE=BS=1**（iCloud キーチェーンへ同期済み） |
| 認証 3 回（直後・再度・通信＋3 秒待ちのあと） | すべて署名検証 OK（Node の WebCrypto。DER→r\|\|s 変換で `crypto.subtle.verify` が通る）。`userHandle` 一致、discoverable credential で `allowCredentials: []` が動く |
| `sign_count` | 登録・認証とも **常に 0**（設計どおり「減少しても拒否しない」） |
| 通信を挟んだ `get` | `fetch` → 3 秒待ち → `get` で `NotAllowedError` は出なかった（transient activation は切れない） |
| 所要時間 | 登録 5.3 秒、認証 1.9〜3.8 秒（Face ID 操作込み） |

生データは `scripts/fixtures/passkey-iphone-2026-10-23.json`（公開鍵・署名のみ。秘密は含まない）。
未確認のまま残るもの: 対応 iOS の下限（16.4 と推定）、iCloud キーチェーンを切った状態の登録（BE=0 のケース）、バックグラウンド復帰直後の `get`。
いずれも Phase B の設計には影響しない（BE=0 は §5.2 の規則で扱う）。

デプロイ順序は `migrations/README.md`「適用手順」と同じ: ローカル→`--remote` で 0008 → Function。

### 7.1 未控えの帯と「控え済み」の扱い（§8 決定 3 の具体化）

- 結びつけ成功は **`V2_CODE_SAVED_KEY`（`index.html:21454`）には書かない**。この印は `wv_` を含む引き継ぎコードの保管状態を表し、
  アカウントは `wv_` を持たないので、立てると「AI キーの封筒が復号不能になる」警告まで消してしまう。
- 代わりに `wordsnap-passkey-linked:v1`（`{roomId, backedUp, checkedAt}`）を持ち、帯は次のときだけ隠す:
  **現在の部屋が結びつき済み、かつ `backedUp` が真（iCloud 等へ同期されたパスキー）、かつ `checkedAt` が 7 日以内**。
  `checkedAt` は結びつけ成功・`rooms` 一覧の成功で更新する（設定の節を開いたときに静かに `rooms` を呼ぶ。これはアカウントを
  持つ端末だけの通信で、不変条件 6 には触れない）。**503 を観測したら記録を即座に無効化**し、`unlink-room` / `delete-account`
  でも消す。期限切れ・無効化のときは帯が戻る（フラグ OFF や端末固定のパスキーしか無い状態で「守られている」と誤認させない）。
- `wv_` の注意（`shouldPromptVaultKeyBackup`）は従来どおり引き継ぎコードの保管でしか消えない。
- 設定の引き継ぎコード節に「パスキーを失うと戻れません。引き継ぎコードも別に控えると安心です」を 1 行残す（決定 3）。

## 8. 論点と決定（決める人＝利用者。2026-10-21 に 1・2・3・6 を決定）

| # | 決定 | 設計への反映 |
|---|---|---|
| 1 | **メール回復はやらない**。匿名を保つ。パスキーを失ったら引き継ぎコード頼みと割り切る | Phase E を落とす。`account_emails` 等は作らない。代わりに複数パスキーの追加（§4.2）を冗長化の手段にする |
| 2 | 対応環境なら誰でも使えるが、**「iPhone（iCloud キーチェーン）で最も確実」と明記** | Phase C の説明文。非対応なら節を出さない |
| 3 | 結びつけたら未控えの帯と注意を**消す**。「パスキーを失うと戻れない」旨は設定に残す | §7.1（同期済みパスキーのときだけ消す。`wv_` の注意は別） |
| 6 | **`wv_` は復旧対象外** | §3 のとおり。復旧後の AI キーは再入力 |
| 5・7・8 | 本書の提案どおり（削除は結びつけと封筒だけ／「運営も読めません」とは書かず「同期サーバーは今までも鍵を受け取っています。保存のしかたが 1 つ増えます」とする／呼び名は「パスキーで控える」） | — |

**まだ決めていないこと（Phase B までに確認）**

- `ACCOUNT_KEK` の保管者（運営者本人のパスワードマネージャでよいか）と、紛失時の方針（「全員が引き継ぎコードで戻る」でよいか）。
- 1 つの部屋を複数アカウントが結びつけてよいか（結びつけには `wk_` が要るので権限は増えないが、`wk_` 漏洩時に攻撃者のアカウントが
  恒久的に結びつく。提案: 許容するが、設定の「結びつき一覧」で部屋側から見えるようにはしない＝仕様外）。
- 検証用の部屋を本番ホストで作る手順（`docs/browser-e2e.md` の注意に従う）。

## 9. 概算の作業量（【推測】。実装＋テスト＋レビュー対応を含む）

| Phase | 作業量 | 主な不確実性 |
|---|---|---|
| A | 0.5〜1 日（利用者の実機操作を含む） | 実機でしか分からない。失敗すれば以降が変わる |
| B | 4〜6 日 | CBOR/COSE・DER 変換・FakeAuthenticator・自前のレート制限・KEK ローテーション |
| C | 4〜6 日 | `adoptV2Room` の切り出しと 3 択、3.8 万行の `index.html` への UI 追加、standalone 固有の罠、a11y、不変条件 6 のテスト |
| D | 1〜2 日 | 文言と提示順 |
| 合計 | **10〜15 日** | |

実装の分担（記憶 `model-roles` のとおり）: B・C は高リスク実装として **Opus が実装**、Codex gpt-6.1-sol max ＋ Sonnet でレビュー、Fable が判断。

---

本書で確認していないこと: 対応 iOS の下限、Related Origin Requests の対応状況、Cloudflare 側のメール送信機能の現状。
Phase A で確認済み: iOS 18.7 standalone での WebAuthn、Apple パスキーの `sign_count`（常に 0）と BE/BS（ともに 1）、Workers と同じ WebCrypto での DER 署名の検証。
