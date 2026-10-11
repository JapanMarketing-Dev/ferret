#!/usr/bin/env bash
# 3つのOSの配布物（6本）と、macOS の自動更新用の zip（2本）を、この Mac で作り直して dist/release/ に集める。R2 へは上げない。
#
#   pnpm release:build            # package.json の version で作る
#   SKIP_LINUX=1 pnpm release:build   # Linux を飛ばす（コンテナが使えないとき）
#
# 続けて: pnpm release:r2 stage → 確認 → pnpm release:r2 promote --version <version>
#
# 手順:
#   1. 作業ツリーを一時フォルダへ複製する（APFS の複製なので速く、場所も取らない）。
#      動いている dev サーバーが使う out/ を上書きしないため、ビルドはすべて複製の中で行う
#   2. 複製の中で pnpm typecheck と pnpm test:unit を流す。1件でも落ちたら止める。
#      続けて pnpm build:release（ビルド＋ソースマップの送信。scripts/sentry-sourcemaps.mjs）
#   3. macOS: dmg（arm64 / x64）と、自動更新用の zip（arm64 / x64。Squirrel.Mac が入れ替えに使う。サイトには出さない）
#   4. Windows: 展開済みのアプリ（x64 / arm64）を作り、NSIS だけは /tmp の下の短いフォルダの複製から作る
#      （Mac の makensis は、テンプレートのパスが長いと落ちる。scripts/check-nsis-paths.mjs で先に確かめる）。
#      できたインストーラは scripts/check-nsis-archive.mjs（古い 7-Zip での検査）を通らなければ止める
#   5. Linux: node-pty の Linux 用バイナリが同梱されていないので、x64 の Linux コンテナ（podman か docker）の中で
#      pnpm install をやり直し（out/ は手順 2 で作ったものを使う）、AppImage / deb を作る。パッケージに入った node-pty で PTY が開けることも確かめる
#
# 必要なもの: macOS、pnpm、podman（または docker）、p7zip（brew install p7zip。インストーラの検査用）。未署名で作る。
#
# Linux のビルドの材料は動かない値に固定する（security-5 [13]。タグや apt の索引は後から中身が変わる）:
#   - コンテナのイメージは digest で指定し、取ったイメージの digest が同じことを確かめてから使う
#   - apt は snapshot.debian.org の決まった時刻の索引から入れる（パッケージの署名はイメージの中の Debian の鍵で確かめる）
#   - pnpm は corepack に sha512 を渡して入れる（違えば止まる）
# 更新するときは、新しい digest・時刻・sha512 を確かめてからこの3つを書き換える（test/unit/security-5-release.test.ts が形を確かめる）。
# できたものの sha256・commit・使った材料は dist/release/BUILD-PROVENANCE.txt に残す
set -euo pipefail

# node:22-bookworm の linux/amd64（2026-10-04 に docker.io で確かめた digest）
LINUX_IMAGE="docker.io/library/node:22-bookworm@sha256:17b7fd60fd812617654c64b95f9b2dde94f103313073b672bc40fdad6dccbaa2"
DEBIAN_SNAPSHOT="20261001T000000Z"
PNPM_SPEC="pnpm@10.31.0+sha512.e3927388bfaa8078ceb79b748ffc1e8274e84d75163e67bc22e06c0d3aed43dd153151cbf11d7f8301ff4acb98c68bdc5cadf6989532801ffafe3b3e4a63c268"
if [[ ! "${LINUX_IMAGE}" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "Linux のビルドのイメージは digest（@sha256:…）で指定してください: ${LINUX_IMAGE}" >&2
  exit 1
fi
if [[ ! "${DEBIAN_SNAPSHOT}" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || [[ ! "${PNPM_SPEC}" =~ ^pnpm@[0-9.]+\+sha512\.[0-9a-f]{128}$ ]]; then
  echo "DEBIAN_SNAPSHOT・PNPM_SPEC の形が違います" >&2
  exit 1
fi

REPO="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(node -p "require('${REPO}/package.json').version")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ferret-release.XXXXXX")"
SRC="${WORK}/src"
OUT="${REPO}/dist/release"
export CSC_IDENTITY_AUTO_DISCOVERY=false
# macOS の Developer ID 署名と公証の設定（リポジトリの外）。無ければ未署名（ad-hoc）で作る
if [[ -f "${HOME}/.ferret-signing/env" ]]; then
  # shellcheck disable=SC1091
  source "${HOME}/.ferret-signing/env"
  echo "== macOS は Developer ID で署名し、公証します"
else
  echo "== ~/.ferret-signing/env が無いので、macOS は ad-hoc 署名のまま作ります（公証なし）"
fi
# renderer（Monaco を含む）のビルドは Node の既定のヒープを超えることがある
export NODE_OPTIONS=--max-old-space-size=4096

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS で実行してください（dmg と Windows 版をこの Mac で作るため）" >&2
  exit 1
fi

# 作業ツリーを写して作るので、commit していない変更（並行する別の作業の途中のものを含む）がそのまま配布物に入る。
# 0.4.21 はそうして作られた（BUILD-PROVENANCE の uncommitted changes）。公開する commit と同じ中身で作るため、
# 変更・追跡していないファイルがあれば止める。HEAD だけを作るには git worktree add で別の場所に出し、そこで流す
if [[ -n "$(git -C "${REPO}" status --porcelain --untracked-files=normal 2>/dev/null)" && "${FERRET_RELEASE_ALLOW_DIRTY:-}" != "1" ]]; then
  echo "commit していない変更があります。git worktree add --detach <場所> HEAD で HEAD だけを出し、そこで作ってください" >&2
  echo "（試しに作るだけなら FERRET_RELEASE_ALLOW_DIRTY=1）" >&2
  git -C "${REPO}" status --short >&2
  rm -rf "${WORK}"
  exit 1
fi

echo "== Ferret ${VERSION} を作ります（作業場所: ${WORK}）"
# 記録する commit は写す時点のもの（ビルドの間に次の commit を積んでも、写した中身の commit を残す）
SOURCE_COMMIT="$(git -C "${REPO}" rev-parse HEAD)$(git -C "${REPO}" diff --quiet HEAD -- 2>/dev/null || echo ' (uncommitted changes)')"
mkdir -p "${SRC}"
cd "${REPO}"
for entry in $(ls -A); do
  # Agent の作業ツリー（.claude）・手元のレビューの記録（.ade-movie / .ferret）・キー（.env）はビルドに要らないので写さない
  case "$entry" in dist|out|e2e-artifacts|test-results|.git|.claude|.ade-movie|.ferret|.env|.env.*) continue ;; esac
  cp -cR "$entry" "${SRC}/"
done

echo "== 型検査と単体テスト"
cd "${SRC}"
pnpm typecheck
pnpm test:unit
# ビルドのあと、ソースマップを Sentry へ上げ、out/ の JS に debug ID を書き込む（electron-builder より前）
pnpm build:release

echo "== macOS（dmg と自動更新用の zip。arm64 / x64）"
pnpm exec electron-builder --config electron-builder.config.cjs --mac dmg zip --arm64 --x64

echo "== Windows（x64 / arm64）"
pnpm exec electron-builder --config electron-builder.config.cjs --win --dir --x64
pnpm exec electron-builder --config electron-builder.config.cjs --win --dir --arm64
# 展開済みの中身（Ferret.exe・ffmpeg.dll・node-pty の部品が CPU ごとに正しいか）を確かめる。実機の無いところでの検査
node scripts/check-win-unpacked.mjs dist/release/win-unpacked x64
node scripts/check-win-unpacked.mjs dist/release/win-arm64-unpacked arm64
# app.asar に out/・package.json・node_modules 以外（作業フォルダ・記録・キー・ソースマップ）が入っていないか（macOS と Windows の4本）
node scripts/check-app-asar.mjs dist/release/mac*/Ferret.app/Contents/Resources/app.asar dist/release/win-unpacked/resources/app.asar dist/release/win-arm64-unpacked/resources/app.asar
rm -rf "${OUT}"
mkdir -p "${OUT}"
# Mac の makensis は、electron-builder のテンプレート（node_modules の下）のパスが長いと、アンインストーラを
# 作るところで黙って落ちる。リポジトリや作業場所が深くても通るよう、/tmp の下の短いフォルダに
# 必要なもの（node_modules・package.json・設定・build/）を複製して、そこから NSIS を作る（APFS の複製なので速い）
NSIS_DIR="$(mktemp -d /tmp/fnsis.XXXXXX)"
cp -cR "${SRC}/node_modules" "${SRC}/package.json" "${SRC}/electron-builder.config.cjs" "${SRC}/build" "${NSIS_DIR}/"
node scripts/check-nsis-paths.mjs "${NSIS_DIR}"
(
  cd "${NSIS_DIR}"
  node node_modules/electron-builder/cli.js --config electron-builder.config.cjs --win nsis --x64 --prepackaged "${SRC}/dist/release/win-unpacked" -c.directories.output="${NSIS_DIR}/out"
  node node_modules/electron-builder/cli.js --config electron-builder.config.cjs --win nsis --arm64 --prepackaged "${SRC}/dist/release/win-arm64-unpacked" -c.directories.output="${NSIS_DIR}/out"
)
cp -c "${NSIS_DIR}"/out/Ferret-"${VERSION}"-win-*.exe "${OUT}/"
rm -rf "${NSIS_DIR}"
cd "${REPO}"
# インストーラの中のアーカイブを、インストーラと同じ世代の古い 7-Zip（p7zip 17）で検査する。
# 読めないメソッド（ARM64 の分岐フィルタなど）があると、インストールで黙ってファイルが抜けるので、ここで止める
node scripts/check-nsis-archive.mjs "${OUT}"/Ferret-"${VERSION}"-win-*.exe
cp -c "${SRC}"/dist/release/Ferret-"${VERSION}"-mac-*.dmg "${SRC}"/dist/release/Ferret-"${VERSION}"-mac-*.zip "${OUT}/"

if [[ "${SKIP_LINUX:-}" == "1" ]]; then
  echo "== Linux は飛ばしました（SKIP_LINUX=1）"
else
  echo "== Linux（x64 のコンテナで AppImage / deb）"
  started_podman=""
  if docker info >/dev/null 2>&1; then
    CLI=docker
  elif command -v podman >/dev/null 2>&1; then
    CLI=podman
    if ! podman info >/dev/null 2>&1; then
      podman machine start >/dev/null
      started_podman=1
    fi
  else
    echo "podman も docker も使えません。SKIP_LINUX=1 で Linux を飛ばすか、Linux の上で pnpm dist:linux を流してください" >&2
    exit 1
  fi

  mkdir -p "${WORK}/linux"
  cat > "${WORK}/linux/run.sh" <<'LINUX'
set -euo pipefail
# 日々変わる既定の索引ではなく、決まった時刻の snapshot だけから入れる
rm -f /etc/apt/sources.list.d/*
cat > /etc/apt/sources.list <<APT
deb https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main
deb https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm-updates main
deb https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT} bookworm-security main
APT
apt-get -o Acquire::Check-Valid-Until=false update -qq
apt-get install -y -qq build-essential python3 rsync libnss3 libnspr4 libgtk-3-0 libasound2 libgbm1 libxss1 libxtst6 >/dev/null
# out/ は Mac で作ったものをそのまま使う（JS は OS に関係なく同じ。ソースマップの debug ID も揃う）
rsync -a --exclude node_modules --exclude dist /src/ /work/
cd /work
corepack enable && corepack prepare "${PNPM_SPEC}" --activate
pnpm install --frozen-lockfile
pnpm exec electron-builder --config electron-builder.config.cjs --linux AppImage deb --x64
cp dist/release/Ferret-*.AppImage dist/release/Ferret-*.deb /out/
# 中身の検査は Mac 側で行う（check-app-asar.mjs）。配布物には入れない
cp dist/release/linux-unpacked/resources/app.asar /out/linux-app.asar
# パッケージに入った node-pty で PTY を1つ開いて閉じる
cd dist/release/linux-unpacked
ELECTRON_RUN_AS_NODE=1 ./ferret -e "const p=require('./resources/app.asar/node_modules/node-pty');const t=p.spawn('/bin/bash',['-c','echo PTY_OK'],{});t.onData(d=>process.stdout.write(d));t.onExit(e=>process.exit(e.exitCode))"
LINUX
  mkdir -p "${WORK}/linux/out"
  # 公開のイメージ（docker.io の node）を取るだけなので、利用者の Docker の認証設定を読ませない。
  # ~/.docker/config.json の credHelpers（gcloud など）が期限切れだと、対話できずに取得が止まる（2026-10-04 の 0.4.0 の build）
  mkdir -p "${WORK}/registry"
  echo '{}' > "${WORK}/registry/config.json"
  echo '{"auths":{}}' > "${WORK}/registry/auth.json"
  DOCKER_CONFIG="${WORK}/registry" REGISTRY_AUTH_FILE="${WORK}/registry/auth.json" "${CLI}" pull --platform linux/amd64 "${LINUX_IMAGE}" >/dev/null
  # 取ったイメージが固定した digest のものかを確かめる（digest で取れば中身は確かめられるが、念のため手元の記録でも見る）
  if ! "${CLI}" image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "${LINUX_IMAGE}" | grep -q "@${LINUX_IMAGE##*@}\$"; then
    echo "取ったイメージの digest が ${LINUX_IMAGE##*@} と違います" >&2
    exit 1
  fi
  DOCKER_CONFIG="${WORK}/registry" REGISTRY_AUTH_FILE="${WORK}/registry/auth.json" "${CLI}" run --rm --platform linux/amd64 -m 7g --pull=never \
    -e DEBIAN_SNAPSHOT="${DEBIAN_SNAPSHOT}" -e PNPM_SPEC="${PNPM_SPEC}" \
    -v "${SRC}:/src:ro" -v "${WORK}/linux:/s:ro" -v "${WORK}/linux/out:/out" \
    "${LINUX_IMAGE}" bash /s/run.sh
  node scripts/check-app-asar.mjs "${WORK}/linux/out/linux-app.asar"
  cp "${WORK}"/linux/out/Ferret-* "${OUT}/"
  if [[ -n "${started_podman}" ]]; then podman machine stop >/dev/null; fi
fi

# どの commit と材料から作ったかと、できたものの sha256（release-github.mjs create はこのフォルダを自分でハッシュして署名する）
{
  echo "version ${VERSION}"
  echo "commit ${SOURCE_COMMIT}"
  echo "linux-image ${LINUX_IMAGE}"
  echo "debian-snapshot ${DEBIAN_SNAPSHOT}"
  echo "linux-pnpm ${PNPM_SPEC}"
  (cd "${OUT}" && shasum -a 256 Ferret-"${VERSION}"-*)
} > "${OUT}/BUILD-PROVENANCE.txt"

rm -rf "${WORK}"
echo "== できたもの（${OUT}）"
ls -la "${OUT}"/Ferret-"${VERSION}"-*
echo "次: pnpm release:r2 stage  →  確認  →  pnpm release:r2 promote --version ${VERSION}"
