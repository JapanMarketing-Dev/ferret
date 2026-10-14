<!--
  README の構成は stablyai/orca にならう。画像は docs/images/（中立なデモプロジェクトのスクリーンショット）。
  - docs/images/hero.gif: LP のアニメーション（site/js/hero.js、Claude Opus 5.5 で作成）から `node tools/docs/render-hero.mjs --readme` で書き出す。
  - agents:start / agents:end のあいだの Agent 一覧は `node tools/docs/readme-agents.mjs` が docs/images/agents/agents.json から作る。
-->

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/ferret-wordmark-dark.svg">
  <img src=".github/assets/ferret-wordmark-light.svg" alt="Ferret" height="64">
</picture>

**声と画面で、大量のフィードバックを的確に渡す ADE。**<br>
テキストで指示を書く代わりに、実際の画面の上で声と箇所を指して、たくさんの指摘を一度に的確に Agent へ渡せます。<br>
会議中にもそのまま使え、直ったかは判定モデルが確かめます（ADE = Agentic Development Environment）。

[![GitHub stars](https://img.shields.io/github/stars/JapanMarketing-Dev/ferret?style=flat&color=7c5cff&label=stars)](https://github.com/JapanMarketing-Dev/ferret/stargazers)
[![Version](https://img.shields.io/github/package-json/v/JapanMarketing-Dev/ferret?style=flat&label=version&color=ff4fa3)](https://ferretade.dev/download)
[![Download](https://img.shields.io/badge/download-macOS%20%7C%20Windows%20%7C%20Linux-3ee08f?style=flat)](https://ferretade.dev/download)
[![License: MIT](https://img.shields.io/badge/license-MIT-a18bff?style=flat)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-join-5865F2?style=flat&logo=discord&logoColor=white)](https://discord.gg/A5zAuwg866)
[![X](https://img.shields.io/badge/X-@ai__agent__dev-000000?style=flat&logo=x&logoColor=white)](https://x.com/ai_agent_dev)

[Webサイト](https://ferretade.dev) · [ダウンロード](https://ferretade.dev/download) · [ドキュメント（英語）](https://ferretade.dev/docs/quick-start.html) · [変更履歴](https://ferretade.dev/download#versions)

[English](README.md) · **日本語**

<br>

<img src="docs/images/hero.gif" width="100%" alt="料金ページの Sign up ボタンをペンで囲み、どうしたいかを話す。Done when 付きの指摘2件が claude の動くターミナルへ飛び、ページが直り、Agent がスクリーンショットと照らして Done 2/2 と報告する">

</div>

<br>

## 画面を説明しない。画面を指す。

テキストの指示は、どこの話かを説明するだけで言葉の大半を使ってしまいます。Ferret なら、内蔵ブラウザでアプリを操作し、気になる所をペンで囲んで、どうしたいかを話すだけ。止めると、印も言葉もテキストになり、場面ごとの**指摘**になります。ペンの跡が入った静止画、話した言葉そのまま、URL、そして Agent が確かめられる **Done when**（完了の条件）がそろいます。いくら話しても構いません。端末内の whisper なら文字起こしは無料です。

<img src="docs/images/shots/record.webp" width="100%" alt="録画中: Sign up をペンで囲み、Start trial を四角で囲んだ画面。ツールバーでマイクの入力レベルが動いている">

<img src="docs/images/shots/findings.webp" width="100%" alt="Findings 画面: 書き込み入りの静止画と話した言葉が付いた指摘3件、3 / 3 done の進捗バー、サイドバーの Button fixes ✓3/3">

→ [Recording](https://ferretade.dev/docs/recording.html)

## 会議でそのまま使う: より多く、より的確に

Zoom・Meet・Teams のオンライン会議でも、対面で1つの画面を囲むときでも使えます。内蔵ブラウザ・任意のウィンドウ・画面全体のどれかを録画しながら、みんなが指して話します。数行の議事録ではなく、すべての発言が画面上の場所と組になったテキストとして Agent に届きます。

<img src="docs/images/shots/capture-target.webp" width="100%" alt="録画対象のダイアログ: 内蔵ブラウザ、画面全体、ウィンドウ">

→ [録画する対象の選び方](https://ferretade.dev/docs/recording.html#target)

## 判定モデルが確かめる: 「完了」を定義できる

どの指摘にも **Done when** が付いています。Agent は実装したあと、新しいスクリーンショットとその条件を、あなたが選んだ**判定モデル**に送り、すべての指摘が通るまで続けて、指摘ごとのスコア付きで **Done** か **Not done** を報告します。これで、Agent が期待どおりに動いたかが分かります。Ferret 自身は判定しません。

使える決定モデルは TypeSafe Jev、Cloudflare Clef / Clef Flash（Ollama か Workers AI 経由）、Vercel AI Gateway、または互換の API です。キーは各自持ちで、料金は提供元へ直接払います。Ferret が課金することはありません。

<img src="docs/images/shots/verify@1x.webp" width="100%" alt="Ferret の Agent ターミナル: 1回目は 0.10（未完了）、判定し直して2回目は 0.92（完了）、すべての指摘が通過">

<sub>本物の判定モデルの呼び出し（Cloudflare Workers AI の Clef Flash、2回）。AFTER の画像はデモ用に用意したものです。Ferret 自身は判定せず、Agent があなたの設定した決定モデルを呼び出します。</sub>

→ [Sending to agents（検証）](https://ferretade.dev/docs/agents.html#verify)

## そのほか

| | |
|---|---|
| **どの Agent でも**: Claude Code、Codex、Gemini CLI、Cursor、GitHub Copilot、Devin などを内蔵ターミナルで起動し、指摘を渡します。[Docs](https://ferretade.dev/docs/agents.html) | **Web・モバイル・デスクトップ**: 開発サーバーの URL、モバイル幅やシミュレータのウィンドウ、任意のデスクトップアプリのウィンドウを対象にでき、プロジェクトごとに保存できます。[Docs](https://ferretade.dev/docs/projects.html) |
| **Agent に設定を任せられる**: 設定はすべて `~/.ferret/settings.json`（JSON Schema 付き）にあり、コーディング Agent に設定してもらえます。[Docs](https://ferretade.dev/docs/settings-json.html) | **プライバシー**: 作業の中身を受け取る Ferret のサーバーはありません（例外は、近く入る、自分で送る匿名のフィードバックで、公開の GitHub Issue になります）。キーは各自持ちで OS の鍵の仕組みに保存し、動画は Agent に送りません。[Docs](https://ferretade.dev/docs/privacy.html) |

<table>
  <tr>
    <td width="50%"><img src="docs/images/shots/targets.webp" alt="Review targets: 保存した URL（local の blog・docs・pricing、dev）と最近のページ"><br><sub>Review targets: 保存した URL と最近のページ</sub></td>
    <td width="50%"><img src="docs/images/shots/send.webp" alt="Send to Agent: Claude Code のタブを起動して指示を貼り付ける"><br><sub>Send to Agent で Claude Code が起動し、指示が入ります（ターミナルの中身はデモ用の代役です）</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/shots/agents.webp" alt="新しいターミナルのメニュー: New Terminal、Claude Code、Codex、OpenCode"><br><sub>ターミナルのメニューから Agent を起動</sub></td>
    <td width="50%"><img src="docs/images/shots/settings-json.webp" alt="内蔵エディタで開いた settings.json"><br><sub>内蔵エディタで開いた settings.json</sub></td>
  </tr>
</table>

## 対応する Agent

内蔵ターミナルで CLI の Agent を起動します。Agent は各自が契約しているもので動きます。それ以外には **Copy for Agent** で同じ指示をコピーできます。

<!-- agents:start (generated by tools/docs/readme-agents.mjs from docs/images/agents/agents.json; do not edit by hand) -->
<table>
  <tr>
    <td align="center" width="16%"><a href="https://code.claude.com/docs/en/setup"><img src="docs/images/agents/claude.svg" width="32" height="32" alt=""><br><sub>Claude Code</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/openai/codex"><img src="docs/images/agents/codex.svg" width="32" height="32" alt=""><br><sub>Codex</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/xai-org/grok-build"><img src="docs/images/agents/grok.png" width="32" height="32" alt=""><br><sub>Grok</sub></a></td>
    <td align="center" width="16%"><a href="https://cursor.com/docs/cli/installation"><img src="docs/images/agents/cursor.png" width="32" height="32" alt=""><br><sub>Cursor</sub></a></td>
    <td align="center" width="16%"><a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><img src="docs/images/agents/copilot.png" width="32" height="32" alt=""><br><sub>GitHub Copilot</sub></a></td>
    <td align="center" width="16%"><a href="https://dev.meta.ai/docs/muse-code"><img src="docs/images/agents/muse.png" width="32" height="32" alt=""><br><sub>Muse</sub></a></td>
  </tr>
  <tr>
    <td align="center" width="16%"><a href="https://deepseek-harness.github.io/deepseek-harness/"><img src="docs/images/agents/dsh.png" width="32" height="32" alt=""><br><sub>DeepSeek Harness</sub></a></td>
    <td align="center" width="16%"><a href="https://zcode.z.ai/en/docs"><img src="docs/images/agents/zcode.png" width="32" height="32" alt=""><br><sub>ZCode</sub></a></td>
    <td align="center" width="16%"><a href="https://opencode.ai/docs/"><img src="docs/images/agents/opencode.png" width="32" height="32" alt=""><br><sub>OpenCode</sub></a></td>
    <td align="center" width="16%"><a href="https://mimo.xiaomi.com/coder"><img src="docs/images/agents/mimo-code.png" width="32" height="32" alt=""><br><sub>MiMo Code</sub></a></td>
    <td align="center" width="16%"><a href="https://ampcode.com/docs/cli"><img src="docs/images/agents/amp.png" width="32" height="32" alt=""><br><sub>Amp</sub></a></td>
    <td align="center" width="16%"><a href="https://openclaude.gitlawb.com/"><img src="docs/images/agents/openclaude.png" width="32" height="32" alt=""><br><sub>OpenClaude</sub></a></td>
  </tr>
  <tr>
    <td align="center" width="16%"><a href="https://antigravity.google/docs/cli/install"><img src="docs/images/agents/antigravity.png" width="32" height="32" alt=""><br><sub>Antigravity</sub></a></td>
    <td align="center" width="16%"><a href="https://pi.dev"><img src="docs/images/agents/pi.svg" width="32" height="32" alt=""><br><sub>Pi</sub></a></td>
    <td align="center" width="16%"><a href="https://omp.sh/docs"><img src="docs/images/agents/omp.svg" width="32" height="32" alt=""><br><sub>oh-my-pi</sub></a></td>
    <td align="center" width="16%"><a href="https://hermes-agent.nousresearch.com/docs/"><img src="docs/images/agents/hermes.png" width="32" height="32" alt=""><br><sub>Hermes Agent</sub></a></td>
    <td align="center" width="16%"><a href="https://docs.devin.ai/work-with-devin/devin-cli"><img src="docs/images/agents/devin.png" width="32" height="32" alt=""><br><sub>Devin</sub></a></td>
    <td align="center" width="16%"><a href="https://goose-docs.ai/docs/getting-started/installation/"><img src="docs/images/agents/goose.png" width="32" height="32" alt=""><br><sub>Goose</sub></a></td>
  </tr>
  <tr>
    <td align="center" width="16%"><a href="https://docs.augmentcode.com/cli/overview"><img src="docs/images/agents/aug.png" width="32" height="32" alt=""><br><sub>Auggie</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/autohandai/code-cli"><img src="docs/images/agents/autohand.png" width="32" height="32" alt=""><br><sub>Autohand Code</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/charmbracelet/crush"><img src="docs/images/agents/crush.png" width="32" height="32" alt=""><br><sub>Charm (Crush)</sub></a></td>
    <td align="center" width="16%"><a href="https://docs.cline.bot/cline-cli/overview"><img src="docs/images/agents/cline.png" width="32" height="32" alt=""><br><sub>Cline</sub></a></td>
    <td align="center" width="16%"><a href="https://www.codebuddy.ai/docs/cli/installation"><img src="docs/images/agents/codebuddy.png" width="32" height="32" alt=""><br><sub>CodeBuddy</sub></a></td>
    <td align="center" width="16%"><a href="https://www.codebuff.com/docs/help/quick-start"><img src="docs/images/agents/codebuff.png" width="32" height="32" alt=""><br><sub>Codebuff</sub></a></td>
  </tr>
  <tr>
    <td align="center" width="16%"><a href="https://freebuff.com/cli"><img src="docs/images/agents/freebuff.png" width="32" height="32" alt=""><br><sub>Freebuff</sub></a></td>
    <td align="center" width="16%"><a href="https://commandcode.ai/docs/quickstart"><img src="docs/images/agents/command-code.png" width="32" height="32" alt=""><br><sub>Command Code</sub></a></td>
    <td align="center" width="16%"><a href="https://docs.continue.dev/cli/quickstart"><img src="docs/images/agents/continue.png" width="32" height="32" alt=""><br><sub>Continue</sub></a></td>
    <td align="center" width="16%"><a href="https://docs.factory.com/cli/getting-started/quickstart"><img src="docs/images/agents/droid.svg" width="32" height="32" alt=""><br><sub>Droid</sub></a></td>
    <td align="center" width="16%"><a href="https://kilo.ai/docs/code-with-ai/platforms/cli"><img src="docs/images/agents/kilo.svg" width="32" height="32" alt=""><br><sub>Kilocode</sub></a></td>
    <td align="center" width="16%"><a href="https://www.kimi.com/code/docs/en/kimi-code-cli/guides/getting-started"><img src="docs/images/agents/kimi.png" width="32" height="32" alt=""><br><sub>Kimi</sub></a></td>
  </tr>
  <tr>
    <td align="center" width="16%"><a href="https://kiro.dev/docs/cli/"><img src="docs/images/agents/kiro.png" width="32" height="32" alt=""><br><sub>Kiro</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/mistralai/mistral-vibe"><img src="docs/images/agents/mistral-vibe.png" width="32" height="32" alt=""><br><sub>Mistral Vibe</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/QwenLM/qwen-code"><img src="docs/images/agents/qwen-code.png" width="32" height="32" alt=""><br><sub>Qwen Code</sub></a></td>
    <td align="center" width="16%"><a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><img src="docs/images/agents/rovo.png" width="32" height="32" alt=""><br><sub>Rovo Dev</sub></a></td>
    <td align="center" width="16%"><a href="https://aider.chat/docs/install.html"><img src="docs/images/agents/aider.svg" width="32" height="32" alt=""><br><sub>Aider</sub></a></td>
    <td align="center" width="16%"><a href="https://ante.run/start/quickstart/"><img src="docs/images/agents/ante.png" width="32" height="32" alt=""><br><sub>Ante</sub></a></td>
  </tr>
  <tr>
    <td align="center" width="16%"><a href="https://docs.blackbox.ai/features/blackbox-cli/getting-started"><img src=".github/assets/agent-generic.svg" width="32" height="32" alt=""><br><sub>BLACKBOX CLI</sub></a></td>
    <td align="center" width="16%"><a href="https://forgecode.dev/docs/"><img src=".github/assets/agent-generic.svg" width="32" height="32" alt=""><br><sub>ForgeCode</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/google-gemini/gemini-cli"><img src="docs/images/agents/gemini.png" width="32" height="32" alt=""><br><sub>Gemini CLI</sub></a></td>
    <td align="center" width="16%"><a href="https://junie.jetbrains.com/docs/junie-cli.html"><img src=".github/assets/agent-generic.svg" width="32" height="32" alt=""><br><sub>Junie CLI</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/letta-ai/letta-code"><img src=".github/assets/agent-generic.svg" width="32" height="32" alt=""><br><sub>Letta Code</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/openclaw/openclaw"><img src="docs/images/agents/openclaw.png" width="32" height="32" alt=""><br><sub>OpenClaw</sub></a></td>
  </tr>
  <tr>
    <td align="center" width="16%"><a href="https://docs.openhands.dev/openhands/usage/cli/installation"><img src=".github/assets/agent-generic.svg" width="32" height="32" alt=""><br><sub>OpenHands CLI</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/PrimeIntellect-ai/prime-agent"><img src="docs/images/agents/prime-agent.png" width="32" height="32" alt=""><br><sub>Prime Agent</sub></a></td>
    <td align="center" width="16%"><a href="https://docs.qoder.com/cli/installation"><img src="docs/images/agents/qoder.png" width="32" height="32" alt=""><br><sub>Qoder CLI</sub></a></td>
    <td align="center" width="16%"><a href="https://github.com/RooCodeInc/Roo-Code/tree/main/apps/cli"><img src=".github/assets/agent-generic.svg" width="32" height="32" alt=""><br><sub>Roo Code CLI</sub></a></td>
    <td align="center" width="16%"><a href="https://docs.trae.cn/cli_get-started-with-trae-code-cli-2"><img src="docs/images/agents/trae.png" width="32" height="32" alt=""><br><sub>Trae CLI</sub></a></td>
    <td align="center"><sub>…ほか、CLI で動く Agent なら何でも</sub></td>
  </tr>
</table>
<!-- agents:end -->

## ダウンロード

| macOS | Windows | Linux |
|---|---|---|
| Apple silicon / Intel · `.dmg` | x64 / Arm64 · インストーラ `.exe` | x64 · `.deb` / AppImage |

**[ferretade.dev/download](https://ferretade.dev/download)** からダウンロードして開くだけです。

- **macOS**: `.dmg` を開き、Ferret を「アプリケーション」へドラッグ。
- **Windows**: インストーラを実行すると、そのまま入って起動します。
- **Linux**: Ubuntu / Debian は `.deb` をダブルクリック（または `sudo apt install ./Ferret-<version>-linux-amd64.deb`）。ほかの配布は AppImage。

詳しくは [インストール](https://ferretade.dev/docs/ja/install)。

## クイックスタート

1. プロジェクトのフォルダと開発サーバーの URL（例: `http://localhost:3000`）を開きます
2. **Record**（⌘⇧R / Ctrl+Shift+R）を押し、囲んで話します。終わったら止めます
3. 指摘を見直して **Send to Agent**。Agent が実装し、指摘ごとにスクリーンショットと照らして確かめます

詳しい手順: [Quick start](https://ferretade.dev/docs/quick-start.html)

## ドキュメント（英語）

[Quick start](https://ferretade.dev/docs/quick-start.html) · [Install](https://ferretade.dev/docs/install.html) · [Recording](https://ferretade.dev/docs/recording.html) · [Sending to agents](https://ferretade.dev/docs/agents.html) · [Transcription and costs](https://ferretade.dev/docs/transcription.html) · [Settings](https://ferretade.dev/docs/settings.html) · [Keyboard shortcuts](https://ferretade.dev/docs/keyboard.html) · [Data and privacy](https://ferretade.dev/docs/privacy.html) · [Troubleshooting](https://ferretade.dev/docs/troubleshooting.html)

## 開発への参加

不具合の報告やプルリクエストを歓迎します。[CONTRIBUTING.md](CONTRIBUTING.md) を見てください。開発は `develop` で進めます。脆弱性の連絡は [SECURITY.md](SECURITY.md) へ。

```sh
git clone https://github.com/JapanMarketing-Dev/ferret.git
cd ferret
pnpm install
pnpm dev          # ソースから起動（Node.js 22）
pnpm typecheck
pnpm test:unit
```

## ライセンス・クレジット

- [MIT](LICENSE)、Copyright (c) 2026 JapanMarketing-Dev。開発は [Japan Marketing LLC](https://www.japan-marketing.co.jp/)
- [Orca](https://github.com/stablyai/orca)（MIT）に着想を得て、一部のコードを移植しています。移植したコードと同梱する依存のライセンスは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にまとめています。Agent のロゴは Orca と各社のもので、名前とロゴの商標は各社に帰属します
- Webサイトのヒーローアニメーションは Claude Opus 5.5 で作りました

---

## このビルドについて

- **できること**: 内蔵ブラウザで開いた画面の録画と書き込み、声とペンの書き込みからの指摘づくり、指摘の編集・結合・削除、内蔵ターミナルで動く Agent（Codex / Claude Code）への送信。プロジェクトは、この PC のフォルダ、GitHub・GitLab からの clone、SSH の先から開けます。サービスの CLI（gh・glab・wrangler・Vercel・AWS など）はターミナルから入れてログインでき、プロジェクトの画像・動画・音声・PDF は内蔵のビューアで開けます
- **費用は各自持ち**: 作業に使う開発者側のサーバーやAPIキーはありません。例外はアプリ内の匿名のフィードバックで、送ったときだけ、その内容が小さな中継（`workers/feedback-relay`）を通って公開の GitHub Issue になります。中継は IP を保存しません。文字起こしは端末内（whisper.cpp、無料）、自分の OpenAI の API キー、自前の GPU などで動かす OpenAI 互換サーバーから選びます。Agent は各自が契約している CLI を使います
- **対応OS**: macOS（Apple Silicon / Intel）、Windows（x64 / arm64）、Linux（x64）。普段使っているのは macOS（Apple Silicon）です。リリースのたびに Mac の上で確かめます。`tools/qa/linux-smoke.sh` が Linux のコンテナで Linux 版を作り、xvfb の上で `e2e/platform-smoke.spec.ts`（起動・内蔵ブラウザ・ターミナルでシェルが開くこと・設定）を流します。`scripts/check-win-unpacked.mjs` と `scripts/check-nsis-archive.mjs` が、Windows 版のアプリとインストーラに CPU ごとの正しい部品が入っていることを確かめます。Intel Mac 版のターミナルは Rosetta で確かめました。macOS 版は Developer ID で署名・公証済みです

## インストール・起動

ソースから起動するときは、Node.js 22 と pnpm を使います。Linux では `pnpm install` のときにターミナル用のネイティブモジュール（node-pty）をビルドするので、先に `build-essential` と `python3` を入れてください。Windows は同梱のビルド済み node-pty を使うので、コンパイラは要りません。

```sh
git clone https://github.com/JapanMarketing-Dev/ferret.git
cd ferret
pnpm install
pnpm dev
```

アプリでプロジェクトフォルダとURLを開き、録画を始めて、変えたい所をペンで囲みながら話し、止めます。フィードバックは声とペンで行います。

録画中は対象画面を大きく表示します。ペンボタン、またはOption / Altを押している間だけ描画できます。録画の開始・停止は⌘⇧R、モード切替は⌘⇧M（Windows / Linux では Ctrl+Shift+R / Ctrl+Shift+M）。一時停止中は書き込みを止め、経過時間も進めません。

停止すると指摘一覧へ戻ります。画像の拡大・差し替え、録画の見返し、編集・送信対象の選択・確定・結合・削除・前の編集に戻す操作ができます。設定で停止後もフィードバックモードに留められます。

## 文字起こしとAgent

音声まわりのAIは、各自が自分のキーか自前のGPUで、自分のコストで使います。設定の「文字起こし」で接続先を選びます。

- **この端末（無料・既定）**: `whisper.cpp`のCLIとGGMLモデルを準備し、「端末内モデルを選ぶ」で指定します。モデルや音声認識精度は別途確認が必要です。
- **OpenAI（自分のAPIキー）**: 音声がOpenAIへ送られます。
- **OpenAI互換**: Base URL・モデル名・APIキー（省略可）を入れます。自宅のGPUで動かすfaster-whisper-server / speaches / whisper.cpp server / vLLM、Groqなどへ`/v1/audio/transcriptions`の形式で送ります。Base URLの末尾の`/v1`は有っても無くても構いません。
- **ほかの提供元（自分のAPIキー）**: Groq、Deepgram、ElevenLabs Scribe、Google Gemini、Mistral Voxtral、Azure OpenAI、OpenRouterは、Base URLとモデル名を埋めたプリセットから選べます。Base URL・モデル・タイムアウト・追加のヘッダーは変えられます。OpenAI互換でないAPI（Deepgram、ElevenLabs、Gemini、OpenRouterの音声入力）は、提供元ごとの小さなアダプタで送ります。

「接続を確認」で1秒の無音を送り、認証・URL・モデル名の誤りを確かめられます。APIキーはOSの鍵（macOS: キーチェーン / Windows: DPAPI / Linux: libsecret・KWallet）で暗号化し、設定とは別のファイルに保存します。暗号化できない環境（Linuxで鍵束が無い場合など）では保存せず、その起動中だけ保持します。開発起動では無視対象の`.env`の`OPENAI_API_KEY`も使えます（配布版は環境変数・`.env`のキーを読みません）。キーをソースへ書かないでください。キーが無いときに別のキーや接続先へ切り替えることはなく、端末内の文字起こしを案内します。開発者が運営する中継サーバーは無く、通信は利用者の端末から選んだ接続先へ直接行います。

1レビューの概算の費用上限は既定$1で、設定で変えられます（検証起動では$0.05）。料金の分からない互換サーバーでは$0.006/分で概算し、上限を「なし」にもできます。上限に達したら送信を止め、音声を保存します。APIエラーでも自動再送しません。

「指摘を整理」は、各自が契約しているCLI（Claude Code / Codex）を非対話モードで使います。音声・動画・画像を渡さず、文字と操作情報を整理します。編集前に実行します。整理できなくても原文と画像を使えます。APIキーへ自動で切り替えません。代わりに、自分のAPIキーでLLMを直接呼ぶこともできます（Anthropic、OpenAI、Google Gemini、OpenRouter、OpenAI互換のエンドポイント）。設定の「指摘の整理」でモデル名を自由に入れ、「整理」ボタンの横で選びます。対応する提供元ではJSON Schemaで出力を縛り、どの提供元でも返ったJSONを検証します。キーは提供元ごとに保存し、文字起こしと整理で共有します。どれも利用者の端末から自分のキーで直接送り、中継サーバーはありません。配布版は環境変数のキーを読みません。

内蔵ターミナルでAgentを起動して「Agentへ送信」を押すと、保存先を読む指示を入力・実行します。権限確認中・送り先不明のときは止めます。外部のAgentには「Agent向けにコピー」で同じ指示を渡します。動画は指示に含めません。

## 保存

`<project>/.ferret/reviews/<日時>/`に`feedback.md`、画像、`session.json`、操作ログ、録画を保存します。Gitのローカル除外設定へ追加します。途中の記録が残っていれば履歴から復元でき、欠落の可能性を表示します。

完成したレビューの作業用画像・音声・動画は、設定した期間（既定7日）を過ぎた起動時に削除します。出力した指摘・画像は残します。未完成レビューは削除しません。

## 外部との通信

外部と通信するのは次の場合だけです。

- 自分のAPIキーでの文字起こし・「指摘を整理」（選んだ提供元・接続先）
- Whisperモデルのダウンロード（Hugging Face）
- フッターの利用量の表示（各提供元のAPI。自分のClaude / Codexのログインを使う）
- GitHub / GitLab からの clone と、そこにある自分のリポジトリの一覧（自分の`gh`・`glab` CLI経由）
- 「更新を確認」を押したときだけ（Cloudflare R2の配布サーバー）
- **アプリからのフィードバック**（近く入ります。送ったときだけ）: 本文・種類（不具合か要望）・アプリの版・含めたときだけ OS の版・添付した静止画（3枚まで）が、開発者の中継を通って `JapanMarketing-Dev/ferret` の公開の Issue になります。鍵やトークン・メール・ホームのパスは伏せ字にし、中継は IP を保存しません。詳しくは [Data and privacy](https://ferretade.dev/docs/privacy.html#feedback)
- **クラッシュレポート（Sentry）**: クラッシュと未処理のエラーを送ります。既定はONで、設定の「プライバシー」か初回起動時の案内からOFFにできます。送るのはスタックトレースとOS・CPU・アプリの版です。パス、URL、ターミナルの出力、文字起こし、指摘、メールアドレス、APIキー、IPアドレスは除くか集めません。開発起動（`pnpm dev`）も`development`として送ります。E2Eと単体テストでは送りません。フォークした人は`FERRET_SENTRY_DSN`（以前の`MOVIE_ADE_SENTRY_DSN`も可）で自分のDSNに向けるか、空にして止められます。詳しくは[Data and privacy](https://ferretade.dev/docs/privacy.html#crash-reports)。

## 開発・検証

```sh
pnpm typecheck
pnpm test:unit
pnpm build:mac:dev    # dist/dev/mac-arm64/Ferret.app
pnpm build:win:dev    # dist/dev/win-unpacked/Ferret-Dev.exe
pnpm build:linux:dev  # dist/dev/linux-unpacked/ferret-dev（Linux の上でだけ作れる）
pnpm lp:dev
```

`build:*:dev` は、署名なし・展開済みの dev アプリを作ります（確認用）。設定は`electron-builder.dev.cjs`で、本番版と混ざらないよう識別子を分けています。本番の配布用の設定は`electron-builder.config.cjs`です。`scripts/build-release.sh` は、`~/.ferret-signing/env` があれば macOS 版を Developer ID で署名・公証します（値はリポジトリに入れません。無いときは ad-hoc 署名だけです）。Windows 版は Mac でも作れます。Linux 版は、node-pty のビルド済みバイナリが Linux 用には無いため、Linux（またはコンテナ）の上で作ります。LPは`http://127.0.0.1:4173/`です。アプリに`.env`は含めません。製品名は Ferret ですが、利用者のデータはこれまでどおり `ade-movie` フォルダに置きます。

### 配布

macOS のインストーラは Developer ID で署名し、公証を受けています。置き場所は Cloudflare R2（バケット `movie-ade-releases`）で、GitHub には置きません。`pnpm dist:mac` / `pnpm dist:win` / `pnpm dist:linux`（Linux の上で）で `Ferret-<version>-<os>-<arch>.<ext>` を作ります。Mac での手順は `pnpm release:build`（型検査と単体テストのあと、6本を `dist/release` に作る。Linux は x64 の podman / docker コンテナで作る。イメージは digest で、Debian のパッケージは snapshot.debian.org の決まった日付で、pnpm は sha512 で固定し、commit・使った材料・各ファイルの sha256 を `dist/release/BUILD-PROVENANCE.txt` に残す）→ `pnpm release:r2 stage` → 確認 → `pnpm release:r2 promote --version <version>` です。公開は2段階です。まず `node scripts/release-r2.mjs stage --dir dist/release` で、公開前の置き場 `staging/<version>/` に上げます。ここでは索引を変えないので、サイトにも更新確認にも出ません。確認が済んだら `node scripts/release-r2.mjs promote --version <version>` で `releases/<version>/` へ移し、`versions.json`・`latest.json` を更新します。同じ版は上げ直しません。最新10版を超えた古い版は、表示してから消します。`v*` のタグを push すると、`.github/workflows/release.yml` が3つの OS で単体テストと配布物のビルドを行い、各ファイルの sha256 をジョブの要約に残します（手元のビルドと見比べる記録）。このワークフローは secrets を持ちません。署名・GitHub Release の下書き・R2 への公開・Sentry へのソースマップは、手元の手順だけで行います（署名の鍵を持つ処理が、タグの中身を動かしたり、artifact の受け渡しで受け取ったバイト列に署名したりしないため）。手元から公開するときは、stage のあとに `node scripts/release-github.mjs create --version <version>` で SHA256SUMS だけの下書きを作り（SHA256SUMS は `dist/release`（`--dir` で変更）の配布物を手元でハッシュした値で作って署名します。staging の manifest はそれと名前・大きさ・sha256 が一致するかを確かめるだけで、違えば署名しません）、`gh release download v<version> --pattern SHA256SUMS` で取った分を `promote --expect-sums` に渡し、最後に `node scripts/release-github.mjs publish --version <version>` で下書きを公開します（どちらも `--dry-run` で gh を動かさずにコマンドだけを確かめられます）。wrangler は devDependencies で版を固定したものを shell を通さずに起動し、R2 から読んだ manifest は形を確かめてから使います。ソースマップを Sentry へ上げる組織トークン（`SENTRY_AUTH_TOKEN`）の作り方は英語の README を見てください。devDependencies で版を固定した `sentry` CLI（`pnpm exec sentry auth login` でログイン）で、手元からだけ上げます。PATH の CLI や npx で取ってきた CLI は使いません。公開リポジトリなので標準のランナーは無料で、`cross-platform.yml` は push / PR のたびに3つのOSで動きます（macOS は1ジョブ）。非公開に戻すときは、実行時間（とくに macOS）の費用が持ち主にかかるので、手動だけにしてください。

要件・設計は[docs/02_requirements.md](docs/02_requirements.md)、[docs/03_design.md](docs/03_design.md)。main はリリース用です。develop で開発し、PR は develop へ出してください。

## ダウンロードサイトの公開

`site/` はビルド不要の静的サイトで、Cloudflare Pages（https://ferretade.dev。Pages のプロジェクト movie-ade の独自ドメイン。古い https://movie-ade.pages.dev は使わず、開くと ferretade.dev の同じページへ移ります。`site/js/theme.js` が移し、`site/_headers` で検索にも出しません）で公開します。ヘッダーは `site/_headers`、短縮 URL は `site/_redirects`、404 は `site/404.html` です。`pnpm lp:dev` で `http://127.0.0.1:4173/` に表示します。公開は `pnpm site:deploy`（Pages のプロジェクト movie-ade へ `site/` を上げる。版を固定した wrangler（devDependencies）を使う。`node scripts/release-tools.mjs wrangler login` でログインしておく）か、ダッシュボードで movie-ade を GitHub に接続し、ビルドコマンドは空、出力は `site` にします。配布ファイルは Cloudflare R2 に置き、サイトは `site/js/config.js` の `DOWNLOAD_BASE` から `versions.json`・`latest.json`・`releases/<version>/manifest.json` を読みます。
