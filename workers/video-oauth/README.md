# video-oauth

動画の投稿で TikTok に接続するときの、トークンの交換だけをする小さな中継です（Cloudflare Worker）。旧 Solocut の `tools/oauth-worker` を移したもので、Worker の名前（`solocut-oauth`）は、すでに動いているものと同じです。Ferret のドメインの `https://ferretade.dev/oauth/tiktok` で受けます（アプリの既定の交換先。ビルド時の `FERRET_VIDEO_TIKTOK_TOKEN_URL` で変えられます）。`https://solocut-oauth.<subdomain>.workers.dev/oauth/tiktok` でも受けます。solocut.app は閉じました。

TikTok の Login Kit for Desktop は、トークンの口（`/v2/oauth/token/`）にクライアントシークレットを要ります。シークレットはアプリに入れられないので、アプリ（`src/video/app/main/publish/tiktok.ts`）は認可の code（PKCE）かリフレッシュトークンをここへ送り、この Worker が `client_key` と `client_secret` を足して TikTok へ送ります。

| 口 | 本文（form か JSON） | すること |
| --- | --- | --- |
| `POST /oauth/tiktok/token` | `client_key`・`code`・`code_verifier`・`redirect_uri` | 認可の code をトークンに替える。リダイレクトは登録した2つ（`http://127.0.0.1:47823/tiktok/callback`・`http://localhost:47823/tiktok/callback`）だけ |
| `POST /oauth/tiktok/refresh` | `client_key`・`refresh_token` | リフレッシュ |
| `POST /oauth/tiktok/revoke` | `client_key`・`token` | 取り消し（接続の解除） |

- アプリが送る `client_key` で、本番（`TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET`）かサンドボックス（`TIKTOK_SANDBOX_CLIENT_KEY` / `TIKTOK_SANDBOX_CLIENT_SECRET`）かを選びます。どちらでもないキーは 400 です。
- TikTok の JSON を状態コードごとそのまま返します。ログにも出さず、保存もしません（`Cache-Control: no-store`、observability はオフ）。
- 本文は 8KB まで。CORS は出しません（アプリの main から呼びます）。

テストは `test/unit/video/publish/worker.test.ts` です。本物の TikTok は呼びません。

## 公開（統括がまとめて行う。手元の確認だけなら不要）

1. `npx wrangler login`（Ferret の Cloudflare アカウント）
2. 秘密を4つ: `npx wrangler secret put TIKTOK_CLIENT_KEY --config workers/video-oauth/wrangler.jsonc`（`TIKTOK_CLIENT_SECRET`・`TIKTOK_SANDBOX_CLIENT_KEY`・`TIKTOK_SANDBOX_CLIENT_SECRET` も同じ）
3. `node scripts/release-tools.mjs wrangler deploy --config workers/video-oauth/wrangler.jsonc`

手元で試すときは `npx wrangler dev --config workers/video-oauth/wrangler.jsonc`（値は `workers/video-oauth/.dev.vars`。コミットしない）。アプリの開発版は `FERRET_VIDEO_TIKTOK_TOKEN_URL=http://127.0.0.1:8787/oauth/tiktok` で向け先を変えられます。
