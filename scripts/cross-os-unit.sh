#!/usr/bin/env bash
#
# 公開の前の関門: commit 済みの中身で、単体テスト（pnpm test:unit）を手元で流す。
#
#   bash scripts/cross-os-unit.sh [ref（既定: HEAD）] [mac|linux|win|all（既定: mac）]
#
#   mac:   この Mac で流す（速い。依存はリポジトリの node_modules を使う）。publish-squash.sh が既定で求めるのはこれだけ
#   linux / win / all: 下の Linux コンテナ・Windows の VM で流す（遅い。FERRET_REQUIRE_CROSS_OS=1 のときだけ公開の条件になる）
#
# Linux・Windows は、公開したあとに GitHub Actions の Cross-platform が3つの OS で並列に流す。
# release-github.mjs create はその結果が通るまでリリースを作らない（scripts/release-ci.mjs）。
#
# 公開リポジトリの CI（Cross-platform）は、publish-squash.sh で出したあとにまとめて走る。mac では通るのに
# Windows・Linux でだけ落ちるテスト（実行ビット、パスの区切り、EMFILE、fs.watch など）にリリース後に気づかないよう、
# 公開の前に同じテストをこの Mac の上の Linux コンテナと Windows の VM で流す。
#
#   Linux:   podman（か docker）の arm64 の node:22-bookworm。x64 は qemu-user で遅く Chromium も落ちるため
#            （ネイティブの依存は node-pty だけで、テストの中身は CPU に依らない）
#   Windows: UTM の「QA Windows 11」（ARM64）に ssh（127.0.0.1:2233）。止まっていれば utmctl で起動する
#
# 通った OS ごとに「<tree のハッシュ> <os>」を .git/ferret-cross-os-unit に足す。publish-squash.sh は、
# 公開する ref の tree が linux と win の両方で通っていなければ止まる（中身が同じなら commit が変わっても通る）。
#
# 環境変数:
#   FERRET_WIN_SSH_KEY   VM の ssh の秘密鍵（既定: ~/.ssh/ferret_vmqa_key）
#   FERRET_WIN_SSH       ssh の宛先（既定: user@127.0.0.1）。ポートは FERRET_WIN_SSH_PORT（既定: 2233）
#   FERRET_WIN_VM        UTM の VM 名（既定: QA Windows 11）
#   FERRET_WIN_NODE_DIR  VM の中の Node 22 のフォルダ（既定: C:\qa\node-v22.23.3-win-arm64。公式の zip を展開したもの）
#   FERRET_WIN_GIT_DIR   VM の中の git.exe のフォルダ（既定: C:\qa\mingit\cmd。Git for Windows の MinGit の arm64 の zip を
#                        展開したもの。git を使うテストがあり、GitHub の windows-latest には入っている）
set -euo pipefail

REF="${1:-HEAD}"
WHICH="${2:-mac}"
case "$WHICH" in mac | linux | win | all) ;; *) echo "2つ目の引数は mac / linux / win / all です: $WHICH" >&2; exit 2 ;; esac

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
TREE="$(git rev-parse --verify "${REF}^{tree}")"
RECORD="$(git rev-parse --git-common-dir)/ferret-cross-os-unit"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ferret-cross-os-unit.XXXXXX")"
SHORT="${TREE:0:12}"

say() { printf '\n==> %s\n' "$*"; }
passed() { echo "$TREE $1" >> "$RECORD"; say "$1: 通りました（tree $SHORT を $RECORD に記録）"; }

if [ -n "$(git status --porcelain --untracked-files=no)" ] && [ "$REF" = "HEAD" ]; then
  echo "注意: 作業ツリーの未 commit の変更は試しません。試すのは commit 済みの ${REF}（tree ${SHORT}）です。"
fi
git archive --format=tar "$REF" > "$WORK/src.tar"

run_mac() {
  say "この Mac で単体テスト"
  mkdir -p "$WORK/mac"
  tar -x -C "$WORK/mac" -f "$WORK/src.tar" || return 1
  # 依存は入れ直さず、リポジトリのものを使う（pnpm-lock.yaml が同じことを確かめる）
  cmp -s "$WORK/mac/pnpm-lock.yaml" "$ROOT/pnpm-lock.yaml" || { echo "pnpm-lock.yaml が作業ツリーと違います。pnpm install してから流してください" >&2; return 1; }
  ln -s "$ROOT/node_modules" "$WORK/mac/node_modules"
  (cd "$WORK/mac" && CI=true pnpm test:unit)
}

run_linux() {
  say "Linux（arm64 コンテナ）で単体テスト"
  local cli
  # docker の資格情報の設定（credsStore）を読ませない。公開のイメージを取るだけなので空でよい
  export DOCKER_CONFIG="$WORK/docker-config"
  mkdir -p "$DOCKER_CONFIG"
  if docker info >/dev/null 2>&1; then cli=docker; elif command -v podman >/dev/null 2>&1; then cli=podman; else
    echo "podman も docker も使えません" >&2; return 1
  fi
  mkdir -p "$WORK/linux"
  tar -x -C "$WORK/linux" -f "$WORK/src.tar" || return 1
  "$cli" run --rm --platform linux/arm64 -m 7g -v "$WORK/linux:/src:ro" docker.io/library/node:22-bookworm bash -euo pipefail -c '
    apt-get update -qq && apt-get install -y -qq build-essential python3 >/dev/null
    cp -a /src /work && cd /work
    npm install -g --silent pnpm@10.31.0
    pnpm install --frozen-lockfile
    # root で動くので、パーミッションで読めなくするテストが効かない。CI と同じく一般ユーザーで、SHELL も CI と同じ bash で流す
    # （useradd の既定の /bin/sh だと、Agent を起動するシェルの扱いが CI と変わってテストが落ちる）
    useradd -m -s /bin/bash tester && chown -R tester /work
    su tester -c "cd /work && CI=true pnpm test:unit"
  '
}

run_win() {
  say "Windows（UTM の VM）で単体テスト"
  local key="${FERRET_WIN_SSH_KEY:-$HOME/.ssh/ferret_vmqa_key}"
  local dest="${FERRET_WIN_SSH:-user@127.0.0.1}"
  local port="${FERRET_WIN_SSH_PORT:-2233}"
  local vm="${FERRET_WIN_VM:-QA Windows 11}"
  local node_dir="${FERRET_WIN_NODE_DIR:-C:\\qa\\node-v22.23.3-win-arm64}"
  local git_dir="${FERRET_WIN_GIT_DIR:-C:\\qa\\mingit\\cmd}"
  local utmctl=/Applications/UTM.app/Contents/MacOS/utmctl
  [ -f "$key" ] || { echo "VM の ssh の鍵がありません: ${key}（FERRET_WIN_SSH_KEY で指定）" >&2; return 1; }
  local ssh=(ssh -i "$key" -p "$port" -o BatchMode=yes -o ConnectTimeout=10 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$dest")
  if ! "${ssh[@]}" 'cmd /c ver' >/dev/null 2>&1; then
    [ -x "$utmctl" ] || { echo "VM に ssh できず、UTM もありません" >&2; return 1; }
    echo "VM「${vm}」を起動します"
    # utmctl は Apple Events を待って止まることがあるので時間を区切る（macOS に timeout は無い）
    perl -e 'alarm 60; exec @ARGV or die "exec: $!"' "$utmctl" start "$vm" || true
    local i
    for i in $(seq 1 60); do
      "${ssh[@]}" 'cmd /c ver' >/dev/null 2>&1 && break
      [ "$i" = 60 ] && { echo "VM に ssh できません（10 分待ちました）" >&2; return 1; }
      sleep 10
    done
  fi
  # 毎回新しいフォルダ（前回の node_modules を使い回さない）。パスの長さの上限に当たらないよう短くする
  local dir="C:\\fu\\$SHORT-$$"
  # VM の ssh の既定のシェルは PowerShell 5.1（&& が使えない）。手順は .cmd に書いて送り、cmd で動かす。
  # .cmd はリポジトリの外（C:\fu の直下）に置く（直下のファイルを数えるテストがある）
  printf '%s\r\n' '@echo off' \
    "set \"PATH=$node_dir;$git_dir;%PATH%\"" 'set "CI=true"' 'set "COREPACK_ENABLE_DOWNLOAD_PROMPT=0"' \
    "cd /d $dir" \
    'call corepack pnpm@10.31.0 install --frozen-lockfile || exit /b 1' \
    'call corepack pnpm@10.31.0 test:unit || exit /b 1' > "$WORK/run-unit.cmd"
  "${ssh[@]}" "cmd /c \"if exist C:\\fu rmdir /s /q C:\\fu\" ; cmd /c mkdir $dir" || return 1
  "${ssh[@]}" "tar -x -f - -C $dir" < "$WORK/src.tar" || return 1
  "${ssh[@]}" "tar -x -f - -C C:\\fu" < <(COPYFILE_DISABLE=1 tar -c -C "$WORK" -f - run-unit.cmd) || return 1
  "${ssh[@]}" "cmd /c C:\\fu\\run-unit.cmd"
}

# 下の if の中では set -e が効かない。run_linux / run_win の途中の失敗は || return 1 で止めている
status=0
if [ "$WHICH" = mac ]; then
  if run_mac; then passed mac; else status=1; say "mac: 落ちました"; fi
fi
if [ "$WHICH" = linux ] || [ "$WHICH" = all ]; then
  if run_linux; then passed linux; else status=1; say "linux: 落ちました"; fi
fi
if [ "$WHICH" = win ] || [ "$WHICH" = all ]; then
  if run_win; then passed win; else status=1; say "win: 落ちました"; fi
fi
rm -rf "$WORK"
exit "$status"
