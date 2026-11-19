# feedback-cloud

メールアドレスでログインして、自分の指摘を PC をまたいで、チームの指摘をメンバーをまたいで見られるようにする Worker です（`https://account.ferretade.dev`）。ログインはメールに届く 6 桁のコードだけです（パスワードなし）。Ferret のアプリは各 PC の指摘を置き換えで送り、自分の全部の PC の分と、入っているチームのメンバーの分を読みます。同じオリジンの Web 画面で、ログイン・チームの作成と招待・指摘の一覧を扱えます。

形・大きさ・code の正本はアプリと共有する `src/shared/feedbackCloud.ts`、頻度の上限は `src/limits.ts`、表は `migrations/` です。テストは `test/unit/feedback-cloud.test.ts`（D1 は `node:sqlite` で本物の migration を流す。本物の Cloudflare は呼ばない）。

## API

一覧は `src/index.ts` の先頭にあります。アプリは `Authorization: Bearer <token>`（Origin なし）、Web 画面は cookie `__Host-ferret_session` で送ります。

## 守り（要点）

- コードは 15 分・5 回まで。D1 に置くのは `AUTH_SECRET` の HMAC だけです。試みの回数は比べる前に数え、合ったコードは消してから使います。
- トークン（256 bit）は SHA-256 だけを置きます。アプリは 1 年、Web は 30 日。cookie は HttpOnly・Secure・SameSite=Lax です。
- Origin が `PUBLIC_BASE` 以外の要求は断ります。Bearer に Origin が付いていれば断り、cookie で状態を変える要求は自分の Origin を求めます（CSRF）。
- コードの送信はメールアドレスごと・IP ごと、確認は IP ごと・メールアドレスごと、招待と送信は人ごとに上限があります（`FeedbackLimiter`。鍵は `RATE_LIMIT_SALT` の HMAC）。
- 送る指摘は許可した項目だけ（プロジェクト名・どこで・題・日時・文）。手元のファイルのパスは受けません。
- 画面は厳しい CSP（自分のスクリプトだけ）・noindex・Referrer なしで配り、文字は `textContent` で出します。
- 失敗は短い code だけを返し、メールアドレス・IP・本文・トークン・コードはログに出しません。

## 公開の手順

1. D1 を作る: `node scripts/release-tools.mjs wrangler d1 create ferret-account` → 出た `database_id` を `wrangler.jsonc` の `"TODO"` に入れる
2. 表を作る: `node scripts/release-tools.mjs wrangler d1 migrations apply ferret-account --remote --config workers/feedback-cloud/wrangler.jsonc`
3. メールの送信を有効にする: `node scripts/release-tools.mjs wrangler email sending enable ferretade.dev`（送り元は `noreply@ferretade.dev`）
4. 秘密を入れる（どちらも十分に長い乱数。ほかの Worker とは別の値）:
   - `node scripts/release-tools.mjs wrangler secret put AUTH_SECRET --config workers/feedback-cloud/wrangler.jsonc`
   - `node scripts/release-tools.mjs wrangler secret put RATE_LIMIT_SALT --config workers/feedback-cloud/wrangler.jsonc`
5. デプロイ: `node scripts/release-tools.mjs wrangler deploy --config workers/feedback-cloud/wrangler.jsonc`（`account.ferretade.dev` の custom domain も作られます）
6. 確かめる: `https://account.ferretade.dev/` でコードが届いてログインできること、`GET /v1/me` に `Origin: https://example.com` を付けると 403 になること

表を変えるときは `migrations/0002_*.sql` を足して、2 と同じコマンドで流します。`AUTH_SECRET` を変えると送ったばかりのコードだけが効かなくなります（セッションは残ります）。
