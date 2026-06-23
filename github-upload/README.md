# WordSnap Quiz

写真から英単語クイズを作る学習ツール。Netlify Functions + Netlify Blobs で
各ユーザーの個人キーごとにサーバー保存します（データは混ざりません）。

- 静的サイト: `publish/`
- 保存API: `netlify/functions/wordsnap-state.mjs`（`/api/wordsnap-state`）
