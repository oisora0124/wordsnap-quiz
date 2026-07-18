// WordSnap Quiz の保存データをサーバー（Netlify Blobs）に保管するAPI。
// 各ユーザーの「個人キー(sync)」ごとに独立した保管場所を持つので、
// 他人のデータと混ざらない。room-sync-server.js と同じ契約に合わせている。
//
//   GET  /api/wordsnap-state?sync=KEY        -> { syncId, state, stateRev, updatedAt }
//   PUT  /api/wordsnap-state?sync=KEY  body: { baseRev, state }
//        baseRev が最新と一致 -> 保存して { ok, syncId, stateRev, updatedAt }
//        一致しない          -> 409 { error, syncId, state, stateRev, updatedAt }
import { getStore } from "@netlify/blobs";

// サーバーが認識している最新の learning スキーマ版（D1版 functions/api/wordsnap-state.js と同一）。
// 新しい learning スキーマを出すたびに +1 する。これ未満の版で来たPUTだけ、保存済みより
// 低い版（＝未知フィールドを落とすダウングレード）でないかを確認する。
const HIGHEST_LEARNING_VERSION = 1;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

// キーは英数字・ハイフン・アンダーバーのみ、最大64文字に正規化（不正入力対策）
function cleanSyncId(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 64);
}

export default async (req) => {
  const url = new URL(req.url);
  const syncId = cleanSyncId(url.searchParams.get("sync"));
  if (!syncId) return json({ error: "sync id required" }, 400);

  // consistency:"strong" にしないと、保存直後の読み取りが古い値を返し（保存が消えたように見える）、
  // 競合判定(baseRev)も壊れて上書き事故が起きる。強整合にして必ず最新を読む。
  const store = getStore({ name: "wordsnap", consistency: "strong" });
  const key = `state:${syncId}`;
  const existing = (await store.get(key, { type: "json", consistency: "strong" })) || null;
  const currentRev = Number(existing?.stateRev) || 0;

  if (req.method === "GET") {
    return json({
      syncId,
      state: existing?.state ?? null,
      stateRev: currentRev,
      updatedAt: Number(existing?.updatedAt) || 0,
    });
  }

  if (req.method === "PUT") {
    let body = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }
    // 楽観的ロック：基準リビジョンが食い違うときは衝突として最新を返す
    if (body.baseRev !== undefined && body.baseRev !== null && Number(body.baseRev) !== currentRev) {
      return json(
        {
          error: "conflict",
          syncId,
          state: existing?.state ?? null,
          stateRev: currentRev,
          updatedAt: Number(existing?.updatedAt) || 0,
        },
        409,
      );
    }
    // ダウングレード保護（D1版と同じ契約）: SRS対応stateを保存済みのキーへ、古い版の
    // クライアントが未知フィールドを落としたstateで上書きするのを防ぐ。
    const incomingLearningVersion = Math.max(0, Math.floor(Number(body.state?.learningSchemaVersion) || 0));
    if (incomingLearningVersion < HIGHEST_LEARNING_VERSION) {
      const storedLearningVersion = Math.max(
        0,
        Math.floor(Number(existing?.state?.learningSchemaVersion) || 0),
      );
      if (incomingLearningVersion < storedLearningVersion) {
        return json(
          {
            error: "アプリが古いため保存できません。ページを開き直して最新版に更新してください。",
            code: "downgrade_conflict",
            syncId,
            state: existing?.state ?? null,
            stateRev: currentRev,
            updatedAt: Number(existing?.updatedAt) || 0,
          },
          409,
        );
      }
    }
    const entry = {
      state: body.state ?? null,
      stateRev: currentRev + 1,
      updatedAt: Date.now(),
    };
    await store.setJSON(key, entry);
    return json({ ok: true, syncId, stateRev: entry.stateRev, updatedAt: entry.updatedAt });
  }

  return json({ error: "method not allowed" }, 405);
};

// ルーティングは netlify.toml の redirect で /api/wordsnap-state → この関数に割り当てる
// （/.netlify/functions/wordsnap-state がこの関数の既定のエンドポイント）。
