# 実験ランディングページ Worker（business-ade-experiment-pages）

S8「有料試行・集客」で、実験（X01…）ごとに小さなランディングページを出し、経路ごとの **表示数・CTA クリック数・関心表明（フォーム送信）** を測るための Cloudflare Worker です。
コードは `workers/experiment-pages/`（独立したパッケージ。依存・lockfile もこの中）にあります。

- 公開ページは、管理 API で登録した **構造化された文面だけ** から組み立てます。管理者が書いた HTML をそのまま出すことはありません。文面はすべて HTML エスケープします。
- ページを公開するのは外向きの操作です。公開してよいかは人がアプリ側で承認します。Worker の役割は認証を確かめるところまでです。
- 外部につながずに数秒で終わる単体・結合テスト（Vitest と Workers のテスト連携）があります。E2E テストはありません。

## 構成

| 項目 | 内容 |
| --- | --- |
| Worker 名 | `business-ade-experiment-pages`（`workers_dev: true`） |
| 保存先 | D1（バインディング `DB`）。マイグレーションは `migrations/` |
| 定期実行 | 毎日 18:17 UTC（日本時間 03:17）に保持期間を過ぎたデータを削除 |
| エラー検知 | Sentry（`@sentry/cloudflare`）。`SENTRY_DSN` が未設定なら何もしない |
| 性能・ログ | Workers Observability（ログとトレース。`wrangler.jsonc` の `observability`） |
| UX 分析 | PostHog（任意）。`POSTHOG_KEY` と `POSTHOG_HOST` を設定したときだけ |
| リリース | Wrangler と Gradual Deployments（段階的デプロイ） |

日付（集計日・回数制限の日の区切り）はすべて **日本時間** です。

## 公開ページのルート

| メソッドとパス | 内容 |
| --- | --- |
| `GET /p/:slug` | 公開中のページを表示します。サーバー側で表示を 1 回数えます。明らかなボット（UA が空、bot・curl・headless など）は数えません。 |
| `POST /p/:slug/cta` | CTA クリックを数えて 204 を返します（ページ内の小さなスクリプトから送ります）。 |
| `POST /p/:slug/interest` | 関心表明フォームの送信先です。JavaScript がなくても動きます。受け付けたら「送信しました」のページを返します。 |
| `GET /robots.txt` | `/api/` のクロールを禁止します。 |
| `GET /favicon.ico` | 空の 204 を返します（コンソールに 404 を出さないため）。 |

- 未登録・下書き・公開停止・形式が不正な slug は、どれも **同じ 404 ページ** になります（状態コード・ヘッダ・本文が同じで、下書きがあるかどうかは分かりません）。下書きでも未登録でも、問い合わせるクエリは同じ 1 回です。
- 表示と CTA の重複除外: `HMAC-SHA256(HASH_SALT, 日付|slug|IP)` の先頭 128 bit を、日ごとに 1 回だけ数えます。User-Agent は使いません（UA を変えて送っても別人として数えないため）。IP や UA をそのまま保存することはありません。
  - 同じ IP の後ろにいる別の人（会社のネットワークなど）は 1 人として数えます。少なめに出る側に倒しています。
  - 重複除外ハッシュの行は、slug・日・種類（表示／CTA）ごとに **5,000 行まで**。超えたら新しい行を書かず、`uniqueVisitors`・`ctaClicks` も増やしません（`views` は数え続けます）。行数の確認と追加は 1 つの SQL 文で行うので、同時に来ても 5,000 行を超えません。
- 表示と CTA の回数制限（超えても **ページは普通に返し**、CTA も 204 を返します。数えない・書かないだけです）:
  - ハッシュにした IP ごとに、表示は **1 時間あたり 60 回**、CTA は **1 時間あたり 30 回**まで数えます（UTC の時間帯。全 slug 共通）。
  - slug ごとに、表示・CTA それぞれ **1 日（日本時間）あたり 20,000 回**まで数えます。
  - IP の上限を超えた要求では slug のカウンタを増やしません（1 つの IP が他の人の枠を使い切れないように）。
  - ボット判定で外れた要求はカウンタも使いません。
  - `views` は表示の総数（再読み込みも数える）、`uniqueVisitors` は日ごとの重複を除いた人数の合計、`ctaClicks` も日ごとに重複を除いた数です。日をまたいだ同一人物の判定はしません（ハッシュに日付を含めているため）。

### 関心表明フォーム

| 項目 | 規則 |
| --- | --- |
| `name` | 任意、100 文字まで、改行と制御文字は不可 |
| `company` | 任意、200 文字まで |
| `email` | 必須、254 文字まで、形式を確認する |
| `message` | 任意、2000 文字まで（改行は使える） |
| `consent` | `yes` でなければ受け付けない |
| `website` | ボット対策の見えない欄。何か入っていたら「送信しました」と表示して **保存しない** |

処理の順番と応答:

1. CSRF 確認。`Sec-Fetch-Site` があれば `same-origin` のときだけ通します。`Origin` が `null` 以外なら自分のオリジンと一致する必要があります。どちらの手がかりもなければ拒否します（403）。
   - このページは `Referrer-Policy: no-referrer` なので、ブラウザのフォーム送信では `Origin: null` になります。そのため `Sec-Fetch-Site` を主に使います。
2. slug が公開中でなければ 404。
3. `HASH_SALT` が未設定（または 32 文字未満）なら 503（受付を止めます）。
4. `Content-Type` が `application/x-www-form-urlencoded` でなければ 415。本文が 32KB を超えたら 413。
5. 回数制限（下記）を超えたら 429（`Retry-After` 付き）。
6. 見えない欄に入力があれば「送信しました」と表示して捨てます。
7. 入力が不正なら 400（どこが悪いかを固定文で示し、入力値はページに出しません）。
8. 保存して「送信しました」（お名前があればエスケープして最初の 40 文字だけ「〇〇 様」と出します）。

### 回数制限（D1 のカウンタを採用）

- カウンタは「上限未満なら 1 増やす」を 1 つの SQL 文で行います（`... ON CONFLICT DO UPDATE ... WHERE count < 上限`）。上限に達したあとの要求はカウンタにも書きません。同時に来ても上限を超えません（関心表明・表示・CTA とも）。

- ハッシュにした IP ごとに **1 時間（UTC の時間帯）あたり 5 回**。6 回目から 429。
- slug ごとに **1 日（日本時間）あたり 200 回**。201 回目から 429。
- 不正な入力や見えない欄に入力された送信も回数に含めます（総当たりを防ぐため）。

Workers Rate Limiting バインディングを使わず D1 のカウンタにした理由:
Rate Limiting バインディングは期間が 10 秒か 60 秒しか選べず、拠点ごとのおおよその数です。「1 時間に 5 回」「1 日に 200 回」を正確に数えられません。D1 なら 1 文（`INSERT … ON CONFLICT DO UPDATE … WHERE count < 上限`）で原子的に確かめて増やせ、テストで境界（5 回目は通り、6 回目は止まる）を確かめられます。送信の量は少ないので D1 の負荷は問題になりません。
窓は固定です（例: 10:59 に 5 回、11:00 にまた 5 回は通ります）。

## 管理 API（`/api/*`）

すべて `Authorization: Bearer <ADMIN_TOKEN>` が必要です。

- 比較は SHA-256 にしてから `crypto.subtle.timingSafeEqual` で行います（長さや一致した位置で応答時間が変わらない）。
- `ADMIN_TOKEN` が未設定、または 32 文字未満なら、すべて 401 にします。
- 401 は詳細なしの `{"error":{"code":"unauthorized","message":"認証が必要です"}}` です。認証より前にルートの有無は判定しないので、存在しないパスも 401 になります。
- 本文は 32KB まで（`Content-Length` を信用せず、読みながら数えます）。PUT は `application/json` のみ受け付けます。
- エラーはいつも `{ "error": { "code", "message", "details?" } }` の形です。`message` は日本語で、スタックトレースは返しません。
- CORS ヘッダは付けません（デスクトップアプリの main プロセスから呼ぶ前提）。
- 型と検証関数は `workers/experiment-pages/src/contract.ts`（依存ゼロ）にあり、デスクトップアプリから import できます。

| メソッドとパス | 内容 | 主な応答 |
| --- | --- | --- |
| `PUT /api/pages/:slug` | 作成・更新。本文は `{ experimentId, title, content, status }` | 201 作成 / 200 更新 / 400 / 409（同じ slug を別の実験 ID で使おうとした） / 413 / 415 |
| `GET /api/pages` | 一覧 `{ pages: PageSummary[] }` | 200 |
| `GET /api/pages/:slug` | 1 件（下書きも見える）`PageResponse` | 200 / 404 |
| `POST /api/pages/:slug/unpublish` | 公開停止（下書きに戻し、`publishedAt` を null にする） | 200 / 404 |
| `GET /api/pages/:slug/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` | `{ slug, experimentId, from, to, views, uniqueVisitors, ctaClicks, interests }` | 200 / 400 / 404 |
| `GET /api/pages/:slug/interests?limit=1..1000` | 関心表明の一覧（**個人情報を含む**。新しい順、既定 500 件） | 200 / 400 / 404 |
| `DELETE /api/interests/:id` | 関心表明を 1 件削除（id は UUID） | 204 / 400 / 404 |

入力の規則:

- slug: `^[a-z0-9-]{3,48}$`
- experimentId: `^X\d{2,4}$`（X01 の形）
- title: 120 文字まで、必須
- content（すべてプレーンテキスト。未知のキーは 400）

| キー | 上限 | 必須 | 改行 |
| --- | --- | --- | --- |
| `headline` | 120 | 必須 | 不可 |
| `subhead` | 300 | | 可 |
| `bullets` | 8 個 × 各 200 | 各要素は空不可 | 不可 |
| `priceText` | 120 | | 不可 |
| `ctaLabel` | 40 | 必須 | 不可 |
| `formIntro` | 500 | | 可 |
| `consentText` | 1000 | 必須 | 可 |
| `footerNote` | 500 | | 可 |

- 改行（`\n`）以外の制御文字（`\r` やタブを含む）と、表示を乱す双方向制御文字（U+202A〜U+202E、U+2066〜U+2069）は使えません。
- stats の期間は両端を含めて 366 日まで、`from <= to`、実在する日付のみ。未知のクエリや重複したクエリは 400。
- `publishedAt` は下書きから公開にしたときに設定します。公開中のまま更新しても変わりません。

## セキュリティヘッダ（すべての応答）

- `Content-Security-Policy`: `default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` が基本です。HTML ではインラインの style（公開ページでは script も）を **応答ごとに変わる nonce** で許可します。`connect-src` は `'self'` だけです。`unsafe-inline` と `unsafe-eval` は使いません。
- `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy`（カメラ・位置情報などをすべて無効）、`Strict-Transport-Security: max-age=63072000; includeSubDomains`、`X-Frame-Options: DENY`、`Cross-Origin-Opener-Policy` と `Cross-Origin-Resource-Policy` は `same-origin`、`Cache-Control: no-store`。

## PostHog（任意）

`wrangler.jsonc` の `vars` に `POSTHOG_KEY`（例 `phc_…`）と `POSTHOG_HOST`（例 `https://us.i.posthog.com`）を入れると、公開ページにだけ PostHog を読み込みます。

- `person_profiles: 'identified_only'`（匿名の訪問者にはプロフィールを作らない）、`persistence: 'memory'`（Cookie や localStorage を使わない）。
- 自動収集は CTA（`#cta`）のクリックだけです。セッション録画では入力欄をすべて伏せます（`maskAllInputs`）。
- CSP では `script-src` と `connect-src` に、そのホストだけを追加します。PostHog Cloud（`us|eu.i.posthog.com`）だけは配信元の `us|eu-assets.i.posthog.com` も追加します。
- 未設定、またはホストが https のオリジンでない・キーの形が不正なときは無効になります。そのときは第三者のスクリプトを一切出しません。404 や「送信しました」のページには、設定があっても出しません。

## Sentry とログの個人情報

- `SENTRY_DSN`（secret）があるときだけ有効です。`tracesSampleRate: 0` にしてあり、Sentry はエラー検知だけに使います。性能は Workers のトレースで見ます。
- `dataCollection` でヘッダ・Cookie・本文・クエリ・ユーザー情報を収集しないようにしています。さらに `beforeSend` で、リクエストは method と（クエリを除いた）URL だけを残します。ユーザー・extra・パンくずの data は削除し、メッセージや例外文の中のメール・IP・Bearer トークンは伏せます。
- release には Worker の Version ID（`CF_VERSION_METADATA`）が自動で入ります。段階的デプロイ中に、どちらの版のエラーかが分かります。
- アプリのログ（`console.*` の JSON）には slug・実験 ID・件数だけを出し、メール・IP・本文は出しません。Observability の `redact_query_string: true` で、URL のクエリもログとトレースに残しません。

## 保持期間（cron）

| データ | 保持 |
| --- | --- |
| 関心表明（`interests`。個人情報あり） | 作成から 180 日を過ぎたら削除 |
| 重複除外ハッシュ（`seen_hashes`） | 日付が今日（日本時間）の 2 日前より古いものを削除 |
| 回数制限のカウンタ（`rate_counters`） | 期限（IP は 2 時間、slug は 2 日）を過ぎたら削除 |
| 日次集計（`daily_stats`。数だけで個人情報なし） | 削除しない |

180 日を過ぎた関心表明は stats の `interests` にも数えられなくなります。必要な件数は、アプリ側で実験記録に取り込んでおいてください。

## 初回の準備（人がやること）

アカウントは会社の Cloudflare アカウント（~/CLAUDE.md の「使うアカウント」）を使います。`npx wrangler whoami` で確認し、違うアカウントなら先に進まないでください。

```sh
cd workers/experiment-pages
pnpm install

# 1. D1 を作り、出てきた database_id を wrangler.jsonc の d1_databases[0].database_id に入れる
npx wrangler d1 create business-ade-experiment-pages

# 2. テーブルを作る
pnpm db:migrate:remote

# 3. 秘密情報（どちらも 32 文字以上のランダム値。例: openssl rand -base64 48）
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put HASH_SALT
npx wrangler secret put SENTRY_DSN   # 任意。Sentry のプロジェクトを作ってから

# 4. 初回のデプロイ（版がまだないので段階的デプロイはできない）
pnpm deploy:full
```

- `ADMIN_TOKEN` は、デスクトップアプリの設定（OS の安全な保存先）にも同じ値を入れます。
- `HASH_SALT` を変えると、その日の重複除外がリセットされます（その日は同じ人を 2 回数えることがあります）。
- PostHog を使うなら、`wrangler.jsonc` の `vars.POSTHOG_KEY` と `vars.POSTHOG_HOST` を埋めてからデプロイします。

## ローカルでの確認

```sh
cp .dev.vars.example .dev.vars    # ローカル用の ADMIN_TOKEN / HASH_SALT
pnpm db:migrate:local
pnpm dev                          # http://localhost:8787
pnpm lint                         # biome check と tsc --noEmit
pnpm test                         # Vitest（Workers ランタイム内。外部への通信なし、数秒）
pnpm deploy:dry-run               # バンドルだけ作る（dist/）
```

Lighthouse は `pnpm dev` で起動したページ（`/p/<slug>`）に対して実行します。HTML は CSS を含めて 4KB 程度で、フレームワークは使っていません。

### テストについて

- `@cloudflare/vitest-plugin`（旧名 `@cloudflare/vitest-pool-workers`。旧名のパッケージは非推奨になり、名前が変わりました）の `cloudflareTest()` を使っています。テストは workerd の中で動きます。D1 はテストごとにローカルのものを使い、`remoteBindings: false` で外部には接続しません。
- Wrangler 4.147 には複数の Worker をまとめて起動する `createTestHarness()` があります。これは Node 側から複数の Worker を HTTP で起動して試すためのものです。構成次第: 1 Worker なので不要と判断しました。Worker を増やしてサービスバインディングでつなぐことになったら検討します。

## デプロイと段階的リリース（Gradual Deployments）

D1 のマイグレーションを追加したときは、**先に** `pnpm db:migrate:remote` を実行します。新旧どちらの版でも動くスキーマ変更にしてください。

```sh
cd workers/experiment-pages
pnpm lint && pnpm test

# 1. 新しい版をアップロードする（まだ配信しない）
pnpm deploy:upload

# 2. 新しい版に少しずつ流す（残りは今の安定版）
pnpm deploy:gradual -- 10
#    ログとトレース・Sentry を見て問題がなければ
pnpm deploy:gradual -- 50
pnpm deploy:gradual -- 100

# 実行するコマンドを確かめるだけ
pnpm deploy:gradual -- 10 --dry-run
# 版を指定する
pnpm deploy:gradual -- 10 --version <version-id> --message "見出しの変更"

# 段階を踏まずに全量へ出す
pnpm deploy:full
```

- `deploy:gradual` は、新しい版を `--version` で指定しなければ `wrangler versions list` の一番新しい版にします。安定版は `wrangler deployments status` で今いちばん多く配信している版を使います。そのうえで `wrangler versions deploy <新>@N% <安定>@(100-N)% --yes` を実行します。
- 戻すとき: `npx wrangler versions deploy <安定版の id>@100% --yes`（または `npx wrangler rollback`）。
- 版の一覧: `npx wrangler versions list`。今の配分: `npx wrangler deployments status`。

## トレースとログの見方（Workers Observability）

`wrangler.jsonc` で `observability.enabled`・`logs.enabled`・`traces.enabled` を true にしています（サンプリング 100%、クエリ文字列は記録しない）。

- トレース: Cloudflare ダッシュボード → Workers & Pages → `business-ade-experiment-pages` → **Observability** → **Traces**。リクエストごとに、D1 の各クエリと外部 fetch（Sentry・PostHog への送信は含まれない）の所要時間が並びます。遅いリクエストは Duration で並べ替えて見ます。
- ログ: 同じ画面の **Events / Logs**。`event` フィールド（`interest_stored`・`interest_rate_limited`・`interest_honeypot`・`page_saved`・`page_unpublished`・`retention_done`・`unhandled` など）で絞り込めます。Query Builder で `event = "interest_rate_limited"` の件数を時系列で見る、といった使い方ができます。
- その場で流れを見る: `npx wrangler tail business-ade-experiment-pages --format pretty`。
- 段階的デプロイ中は、ログとトレースに付く Worker の版（scriptVersion）で絞り込むと、新旧の版を分けて比べられます。
- 量が増えて費用が気になったら、`observability.traces.head_sampling_rate` と `logs.head_sampling_rate` を 0.1 などに下げます。

## 現在のデプロイ（2026-10-17）

- URL: https://<your-worker>.<your-subdomain>.workers.dev
- D1: business-ade-experiment-pages（APAC）。マイグレーション 0001 を適用済み
- 秘密: ADMIN_TOKEN・HASH_SALT を設定済み。ADMIN_TOKEN の控えは手元の ~/.business-ade/secrets/experiment-pages-admin-token（600）
- 段階的なデプロイを確認済み（新しい版を 10% → 100%）
