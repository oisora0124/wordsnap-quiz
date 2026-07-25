# フィードバックのメール通知 — 設定と運用

`POST /api/feedback` に投稿があると、オーナー宛に通知メールを1通送る。
投稿本体は従来どおり D1 の `feedback` テーブルに入る。メールはその**通知**であって
保存先ではない。メールが届かなくても投稿は失われない。

## 設定（すべて Pages のシークレット）

このリポジトリは公開なので、宛先アドレスもAPIキーもソースには書かない。
`functions/api/feedback.js` は次の環境変数からしか読まない。

| 名前 | 必須 | 内容 |
| --- | --- | --- |
| `FEEDBACK_MAIL_TO` | ○ | 宛先 |
| `FEEDBACK_MAIL_FROM` | ○ | 差出人。プロバイダで許可されたアドレス |
| `RESEND_API_KEY` | どちらか | Resend のAPIキー（優先） |
| `BREVO_API_KEY` | どちらか | Brevo のAPIキー |
| `FEEDBACK_RATE_LIMIT_SECRET` | — | 任意。送信上限のIPキーをHMAC化する |

設定・更新:

```bash
npx wrangler pages secret put FEEDBACK_MAIL_TO --project-name wordbank
npx wrangler pages secret list --project-name wordbank   # 値は表示されない
```

**シークレットを変更したら再デプロイが要る。** 既にビルド済みのデプロイには
反映されない（設定直後に投稿しても送信されないのはこれが原因）。

## なぜ外部のプロバイダを使うのか

Cloudflare 純正の `send_email` バインディングは、送信元ドメインが Cloudflare の
zone として登録されている必要がある。WordBank は `wordbank.pages.dev`（pages.dev の
サブドメイン）で動いていて独自ドメインを持たないため、この経路は使えない。

Resend は独自ドメインを検証していない場合、`onboarding@resend.dev` から
**アカウント所有者自身のアドレス宛にしか**送れない。今回は宛先がオーナー本人なので
これで足りる。独自ドメインを取ってドメイン検証すれば、その制約は外れる。

## 設計上の判断（変更するときはここを読む）

- **保存は fail-open、送信上限は fail-CLOSED。** 送信の失敗（ネットワーク・5xx・
  タイムアウト）は投稿を失わせないが、上限を確認できないときは送らない。
  `/api/feedback` は公開・無認証なので、上限なしで送れると受信箱へのフラッド経路に
  なる。見送っても投稿は D1 に残る。
- **上限は IP 5通/時 + 全体 60通/時**（`rate_limits` テーブル）。両方を先に読んで
  判定し、通ってから両方を消費する。片方だけ消費すると「送っていないのに枠が減る」。
- **IPは保存しない。** 上限判定に必要なのは「同じ相手か」だけなので、不可逆な
  ハッシュ8バイトをキーにする。窓が明けた `fb-mail:` の行は送信のたびに掃除する。
- **件名にユーザー入力を入れない。** ヘッダに本文が混ざる経路を作らないため。
- **申告された連絡先を Reply-To にも差出人にも使わない。** 未検証のアドレスを
  差出人相当に置くと、第三者を騙る踏み台になる。連絡先は本文にだけ載せる。

## 届かないとき

送信失敗は意図的に握り潰す（投稿を失わせないため）ので、症状は「静かに来ない」。
順に確認する。

1. `npx wrangler pages secret list --project-name wordbank` に4つ揃っているか
2. シークレット設定後に再デプロイしたか
3. 投稿が保存されているか
   ```bash
   npx wrangler d1 execute wordbank --remote \
     --command "SELECT id, datetime(created_at/1000,'unixepoch','+9 hours') AS jst, category, message FROM feedback ORDER BY created_at DESC LIMIT 5"
   ```
4. 送信を**試みた**か（枠を消費していれば mailConfig と上限は通っている）
   ```bash
   npx wrangler d1 execute wordbank --remote \
     --command "SELECT rl_key, count FROM rate_limits WHERE rl_key LIKE 'fb-mail%'"
   ```
   - 行が無い＝設定不足か宛先の形式不正で、送信を試みてすらいない
   - 行がある＝プロバイダまでは投げている。Resend のダッシュボードのログを見る
5. 上限に当たっていないか（同一IPから5通/時、全体60通/時）
6. 迷惑メールに入っていないか。`onboarding@resend.dev` からの差出人は特に弾かれやすい

## テスト

`scripts/feedback-mail.test.mjs`。レート制限は実SQLite（`node:sqlite`）に本番と
同じスキーマを載せ、実SQLをそのまま走らせる。UPSERTの条件やbind順を壊すと落ちる。
`scripts/feedback-contract.test.mjs`（投稿APIそのものの契約）は別ファイルで維持。
