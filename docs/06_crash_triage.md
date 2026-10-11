# クラッシュの読み方（Sentry・社内用）

Ferret のクラッシュと未処理のエラーは Sentry（組織 `workspacepm`、プロジェクト `ferret`。表示名 Ferret）に集まる。
プロジェクトは MOVIE-ADE から改名したもので、ID（4512189930602496）と DSN は同じ。0.1.x の issue とリリース（`movie-ade@0.1.x`）もそのまま残っている。
この文書は公開しない。利用者向けの説明は `site/docs/privacy.html#crash-reports`（`tools/docs/build-docs.mjs`）。

## 1. どの issue から見るか

- 配布版の issue だけを見る：`sentry issue list workspacepm/ferret --query "environment:production"`
  - `development` は dev 起動（`pnpm dev`）、`verification` は確認用の起動（`FERRET_SENTRY_FORCE=1`。以前の `MOVIE_ADE_SENTRY_FORCE` も可）。アラートは production だけで鳴る
- リリースごとのクラッシュしなかった割合：Sentry の Releases（起動ごとのセッションを送っている）
- 影響を受けた人数：issue の Users（ランダムなインストール ID で数える。個人は分からない）

## 2. リリース → 怪しいコミット

1. issue の右側の Release（`ferret@<version>`。0.1.x までは `movie-ade@<version>`）を開く
2. Commits に、そのリリースのコミット（変更したファイル付き）が並ぶ。`scripts/sentry-release.mjs` が公開（`release-r2.mjs promote`）のときに付ける
3. issue の Suspect Commits に、スタックのファイルを変えたコミットが出る
   - GitHub の連携（Sentry の Settings → Integrations → GitHub）とコードの対応づけ（Code Mappings：リポジトリ JapanMarketing-Dev/ferret、stack root `app:///` → source root 空、branch `main`）があると、行単位の blame と「GitHub で開く」も使える
4. 直した版を出したら `sentry issue resolve <ID> --in @next`（次のリリースで直った扱い。同じものが出たら regression として戻る）

## 3. フレームを元の TS に戻す（ソースマップ）

- 配布版の JS には debug ID が入っていて、`pnpm build:release`（`scripts/sentry-sourcemaps.mjs`）が同じ debug ID でソースマップを上げている。
  main / preload / renderer / 録画ウインドウのどれも `src/...ts` の行で出る
- 行が `out/...js` のままなら：
  - `sentry api "projects/workspacepm/ferret/events/<event id>/source-map-debug/?frame_idx=0&exception_idx=0"` で原因を見る
  - よくある原因：ソースマップを上げずに配布物を作った（`SENTRY_AUTH_TOKEN` 無しの CI など）。同じ版をもう一度上げるには、その版のビルドの `out/` で `node scripts/sentry-sourcemaps.mjs`
- dev 起動（release が `ferret@<version>+<sha>`）は、送る前にアプリが元の行へ戻している（`src/main/telemetrySourceMaps.ts`）

## 4. ネイティブのクラッシュ（minidump）

- main・renderer・GPU などのネイティブのクラッシュは、`Native crash (<プロセス>, <理由>)` という題名のイベントで届く（main のものは次の起動で送られる）
- **minidump（メモリの写し）は送らない**（security-2 [13]）。キー・パス・画面の文などが入りうるのに伏せ字を通せないため。届くのはプロセスの種類（tags の `event.process`。main-window / recorder など）・終了の理由（`exit.reason`）・版だけで、スタックは無い
  - 送らないことは `src/main/telemetry.ts` の beforeSend（届いた添付を全部捨てる・`minimizeNativeCrash`）と、transport の `filterEnvelope`（送ってよい項目と添付の名前だけを通す）の2か所で守る
  - 0.4.18 から、送る前に手元で minidump の例外の部分だけを読み（`src/shared/minidump.ts`）、短い値をタグにする。題名は `Native crash (<プロセス>, <理由>): <種類> in <モジュール>`
    - `crash.kind`: 例外の種類（`oom`・`access-violation`・`stack-overflow`・`fast-fail`・macOS の `bad-access`・Linux の `sigsegv` など）。V8 のメモリ不足の注釈があれば `oom`
    - `crash.code`: 例外の番号（16進）。`crash.module`: 落ちた場所のモジュールのファイル名（`pty.node`・`conpty.node`・`ferret.exe` など。パスは持たない）
    - `mem.rss`・`mem.heap`・`uptime`: 落ちる前の main のメモリの量と起動からの時間の区分（30秒ごとに scope に控え、次の起動のクラッシュのイベントに付く）
    - 2GB+ や `oom` ならメモリの増加、`conpty.node`・`pty.node` ならターミナル（node-pty）を疑う
  - 0.4.19 の次の版から、落ちた場所を symbols で関数に戻せる値も送る（FERRET-1Q で手がかりが無かったため）。どれもモジュールの名前と、モジュールの先頭からの位置だけで、アドレスそのもの・メモリの中身・パスは送らない（`test/unit/minidump-crash.test.ts` が確かめる）
    - `contexts.crash.location`: 落ちた場所（例 `ferret.exe+0x1a2b3c`）。`debug_id`・`code_id`: そのモジュールの symbols を引く ID（Windows の PDB の GUID＋age と、TimeDateStamp＋SizeOfImage）。`thread`: 落ちたスレッドの名前（`CrBrowserMain` など）
    - `contexts.crash.stack`: 落ちたスレッドのスタックの中で、読み込んだモジュールの中を指していた値を上から20件（戻り先の候補。データへのポインタも混ざる）
    - パンくず: 前の起動のパンくずのうち、Ferret 自身の `flow` だけ（`quit begin`・`quit terminals`・`quit watchdog`・`update install`・`terminal exit` など）を直近30件。終了や更新のどの段階で落ちたかが分かる。Electron のパンくず（URL・ウインドウの題名を含みうる）は捨てる
  - symbols で関数に戻す手順（`ferret.exe` は Electron の `electron.exe` の名前を変えたもの）:
    1. Electron の版（tags の `electron`）と CPU（`build`）に合う symbols を取る。例: `https://github.com/electron/electron/releases/download/v44.5.1/electron-v44.5.1-win32-x64-symbols.zip`（breakpad の `.sym`）
    2. 展開した `breakpad_symbols/electron.exe.pdb/<debug_id>/electron.exe.sym` の `<debug_id>` が `contexts.crash.debug_id` と同じかを確かめる（違えば別のビルド）
    3. `.sym` の `FUNC <位置> <長さ> <引数> <名前>` の行から、`location`・`stack` の位置（16進）を含む関数を探す（`awk` で十分。`PUBLIC` の行は長さが無いので、位置以下で一番近いもの）
    4. `pty.node`・`conpty.node` は node-pty の版の PDB（`scripts/sentry-sourcemaps.mjs` が上げるもの）で同じように読む
  - それでも足りなければ、再現した手元の minidump（Electron の crashDumps のフォルダ。旧名のまま `%APPDATA%\ade-movie\Crashpad\reports` のこともある）を開発者が自分で読む（`minidump-stackwalk <dump> <symbols のフォルダ>`）
- `crash.exe`: 落ちたプロセスの実行ファイルの名前（minidump のモジュールの一覧の先頭）。macOS では crashpad の受け口がターミナルから起動したプログラムにも引き継がれるので、Ferret（`ferret`・`ferret.exe`・dev の `electron`）以外の名前の報告は main 以外なら送らない（FERRET-1X の headless_shell。`shouldSendNativeCrash`）
- node-pty の記号（`scripts/sentry-sourcemaps.mjs` が上げる）は、minidump を送らないので今は使われない

## 5. 落ちたときの状況

tags と添付で分かること（どれも利用者の内容は含まない）:

| 項目 | どこ |
|---|---|
| 版・OS と CPU・Electron の版 | `release` / `build`（例 `darwin-arm64`）/ `electron` |
| どのプロセス・ウインドウか | `event.process`（browser＝main、main-window、recorder） |
| エディタかフィードバックか・録画中か | `app.mode` / `recording` |
| 開いていたタブ（renderer のイベント） | `ui.tab` |
| 何の失敗か | `kind`（handled / ipc / pty-spawn / preload-error / render-error / perf …）・`area` / `op` |
| 直前の操作 | パンくずの `flow`（操作名だけ） |
| 起動が遅い理由 | `Slow startup` は JS より後（アプリの処理）の遅れ、`Slow launch before JS` は JS より前（初回起動の Gatekeeper の検査・dyld など）の遅れ。タグ `startup.phase`（pre-js / js / unknown）、contexts.startup に全体・JS より前・後・節目の時間 |
| main が止まった理由 | タグ `block.ipc` / `block.slowop` / `block.heap` / `block.ax`、contexts.block |
| main の直近のログ | クラッシュの issue の Attachments の `main-log.txt`（見出し付きの行だけ・伏せ字済み） |

## 6. 確認用の起動

画面にダイアログを出さないよう、必ず `ADE_E2E=1 ADE_SYNTHETIC_MIC=1 FERRET_SENTRY_FORCE=1` を付け、一時の `--user-data-dir` で起動する（動いている dev は使わない）。

```
FERRET_SENTRY_TEST=main,renderer,boundary,ipc,handled   # 1 / all でも同じ（以前の MOVIE_ADE_SENTRY_TEST も可）
FERRET_SENTRY_TEST=hang          # 起動が遅い・main の停止（warning）
FERRET_SENTRY_TEST=preload       # preload の読み込み中の例外
FERRET_SENTRY_TEST=uncaught      # main の捕まえていない例外（アプリは終わる）
FERRET_SENTRY_TEST=crash-renderer
FERRET_SENTRY_TEST=crash-main    # 次の起動で Native crash (browser, …) が送られる（minidump は送らない）
```

確かめたテストの issue は resolve しておく。

## 7. アラート

`scripts/sentry-alerts.mjs`（alerts:write を持つトークンが要る）が作る：production の新しい issue・再発・急増（1時間に20件）でメール、クラッシュしなかったセッションの割合が 99% を下回ったらチームへメール。issue の既定の担当はチーム `#workspacepm`（Ownership Rules の `path:* #workspacepm`）。
