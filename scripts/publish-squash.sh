#!/usr/bin/env bash
#
# 公開リポジトリ（既定: origin = JapanMarketing-Dev/MOVIE-ADE）へ、履歴を1コミットにまとめて出す準備をする。
#
#   scripts/publish-squash.sh [元にする ref（既定: main）]
#
# 手元の main の履歴（作者のメールなど）は公開しない。元の ref の「コミット済みの中身」だけを、
# 公開先の main の上に1コミットとして積む。作業は一時的な worktree で行い、手元の作業ツリーには触らない。
#
#   0. 元の ref の中身（tree）が、この Mac の単体テストを通っているか確かめる（scripts/cross-os-unit.sh の記録。
#      FERRET_REQUIRE_CROSS_OS=1 なら Linux・Windows の記録も求める。既定では公開後の GitHub Actions に任せる）。
#      同じ tree を CI と同じ CodeQL で調べて警告が0件だったかも確かめる（scripts/codeql-local.sh の記録）
#   1. 公開先の main を取得し、一時的な worktree を作る
#   2. 元の ref の中身を git archive で写し、公開しないもの（E2E 一式・docs/qa など）を外す
#   3. package.json・tsconfig から E2E の記述を外し、pnpm-lock.yaml を作り直す
#   4. 実名・自宅のパスなどが残っていないか調べる
#   5. GitHub の noreply アドレスを作者にしてコミットする
#   6. gitleaks で、作ったコミットと中身を調べる
#   7. push の直前で止めて確認を求める（確認しなければ push せず、コマンドだけを表示する）
#
# 環境変数:
#   PUBLISH_REMOTE   公開先のリモート（既定: origin）
#   PUBLISH_BRANCH   公開先のブランチ（既定: main）
#   PUBLISH_NAME     作者名（既定: takumi123）
#   PUBLISH_EMAIL    作者のメール。<id>+<login>@users.noreply.github.com の形だけを受け付ける
#                    （既定: 7465033+takumi123@users.noreply.github.com）
#   PUBLISH_MESSAGE  コミットのメッセージ（既定: 元の ref の package.json の版から「Release <version>」）
#   PUBLISH_FORBIDDEN_FILE
#                    公開版に残っていたら止める文字列（正規表現、1行に1つ）を書いたファイル。
#                    実名などをこのスクリプトに書くと公開されてしまうので、別のファイルに置く。
#                    既定: .publish-forbidden.txt（Git の対象外）
#   PUBLISH_DRY_RUN=1
#                    4 までと gitleaks dir だけを行い、コミットも push もしない
set -euo pipefail

SOURCE_REF="${1:-main}"
REMOTE="${PUBLISH_REMOTE:-origin}"
BRANCH="${PUBLISH_BRANCH:-main}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
# 題名は版ごとにする（公開の履歴が読めるように）。版が読めなければ止める
SOURCE_VERSION="$(git show "${SOURCE_REF}:package.json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).version;if(!v)process.exit(1);process.stdout.write(v)})')"
MESSAGE="${PUBLISH_MESSAGE:-Release ${SOURCE_VERSION}}"
FORBIDDEN_FILE="${PUBLISH_FORBIDDEN_FILE:-$ROOT/.publish-forbidden.txt}"

# 公開版に含めないもの。手元の main には残す
EXCLUDES=(
  e2e
  playwright.config.ts
  docs/qa
  .quit-probe.mjs
  test-results
  e2e-artifacts
  playwright-report
)

# どの環境でも止める文字列（自宅のパス・社内のメール）。テストで使う架空のパスは除く
BUILTIN_FORBIDDEN='/Users/[A-Za-z0-9._-]+/|/home/[A-Za-z0-9._-]+/|@[A-Za-z0-9-]+\.co\.jp'
# taro・hanako はテストで使う架空の名前。example.co.jp は例示用のドメイン
BUILTIN_ALLOWED='/Users/(me|you|someone|name|taro|hanako)/|/home/(me|you|someone|user|name|linuxbrew|taro|hanako)/|@example\.co\.jp'

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n[中止] %s\n' "$*" >&2; exit 1; }

for cmd in git gitleaks pnpm node; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd が見つかりません"
done

git rev-parse --verify --quiet "$SOURCE_REF^{commit}" >/dev/null || die "ref が見つかりません: $SOURCE_REF"

# --- 0. 公開の前の関門（単体テスト） -------------------------------------------
# 同じ中身（tree）で scripts/cross-os-unit.sh がこの Mac で通した記録が無ければ止める。dry run は止めない。
# Linux・Windows は公開後に GitHub Actions の Cross-platform が流し、release-github.mjs create がその結果を待つ
# （VM・コンテナで先に流すときは FERRET_REQUIRE_CROSS_OS=1。その記録も求める）
SOURCE_TREE="$(git rev-parse "$SOURCE_REF^{tree}")"
CROSS_OS_RECORD="$(git rev-parse --git-common-dir)/ferret-cross-os-unit"
REQUIRED_OS=(mac)
[ "${FERRET_REQUIRE_CROSS_OS:-}" = "1" ] && REQUIRED_OS=(linux win)
if [ "${PUBLISH_DRY_RUN:-}" != "1" ]; then
  for os in "${REQUIRED_OS[@]}"; do
    grep -qx "$SOURCE_TREE $os" "$CROSS_OS_RECORD" 2>/dev/null \
      || die "${SOURCE_REF}（tree ${SOURCE_TREE:0:12}）は $os の単体テストを通した記録がありません。先に bash scripts/cross-os-unit.sh $SOURCE_REF $os を流してください"
  done
  # 公開リポジトリの Code scanning（CodeQL）に警告を出さない。同じ tree で scripts/codeql-local.sh が0件だった記録が無ければ止める
  grep -qx "$SOURCE_TREE codeql" "$(git rev-parse --git-common-dir)/ferret-codeql" 2>/dev/null \
    || die "${SOURCE_REF}（tree ${SOURCE_TREE:0:12}）は CodeQL で調べた記録がありません。先に bash scripts/codeql-local.sh $SOURCE_REF を流してください"
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "作業ツリーに未コミットの変更があります。公開版に入るのは $SOURCE_REF にコミット済みの中身だけです。"
  read -r -p "このまま続けますか? [y/N] " ans
  [ "$ans" = "y" ] || die "未コミットの変更をコミットしてから、もう一度実行してください"
fi

# --- 作者 -------------------------------------------------------------------
# 公開する1コミットの作者（GitHub の noreply アドレス）
NAME="${PUBLISH_NAME:-takumi123}"
EMAIL="${PUBLISH_EMAIL:-7465033+takumi123@users.noreply.github.com}"
[[ "$EMAIL" =~ ^[0-9]+\+[A-Za-z0-9-]+@users\.noreply\.github\.com$ ]] \
  || die "作者のメールは GitHub の noreply アドレス（<id>+<login>@users.noreply.github.com）にしてください: $EMAIL"

# --- 1. 一時的な worktree --------------------------------------------------
say "$REMOTE/$BRANCH を取得します"
git fetch --quiet "$REMOTE" "$BRANCH"
BASE="$(git rev-parse "$REMOTE/$BRANCH")"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/movie-ade-public.XXXXXX")"
git worktree add --quiet --detach "$STAGE" "$BASE"
echo "作業場所: $STAGE"

# --- 2. 中身を写して、公開しないものを外す ----------------------------------
say "$SOURCE_REF の中身を写します（$(git rev-parse --short "$SOURCE_REF")）"
git -C "$STAGE" rm -rq --ignore-unmatch .
git archive "$SOURCE_REF" | tar -x -C "$STAGE"
for path in "${EXCLUDES[@]}"; do
  rm -rf "${STAGE:?}/$path"
done

# --- 3. E2E の記述を外し、lockfile を作り直す -------------------------------
say "package.json と tsconfig から E2E の記述を外します"
(
  cd "$STAGE"
  node - <<'EOF'
const fs = require('fs')
const { execSync } = require('child_process')
const write = (p, j) => fs.writeFileSync(p, JSON.stringify(j, null, 2) + '\n')

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
delete pkg.scripts?.['test:e2e']
// @playwright/test をまだ使っているファイルがあれば残す（例: アイコンを描く scripts/build-icon.mjs）
let users = ''
try { users = execSync("grep -rlI --exclude-dir=node_modules --exclude=publish-squash.sh '@playwright/test' src scripts tools test 2>/dev/null", { encoding: 'utf8' }).trim() } catch {}
if (users) console.log(`@playwright/test は次のファイルが使っているので残します:\n${users}`)
else delete pkg.devDependencies?.['@playwright/test']
write('package.json', pkg)

for (const p of ['tsconfig.json', 'tsconfig.test.json']) {
  if (!fs.existsSync(p)) continue
  const j = JSON.parse(fs.readFileSync(p, 'utf8'))
  if (Array.isArray(j.include)) j.include = j.include.filter((x) => !/^e2e\/|^playwright\.config\.ts$/.test(x))
  write(p, j)
}

if (fs.existsSync('vitest.config.ts')) {
  const s = fs.readFileSync('vitest.config.ts', 'utf8').split('\n').filter((l) => !l.includes('pnpm test:e2e')).join('\n')
  fs.writeFileSync('vitest.config.ts', s)
}
EOF
  pnpm install --lockfile-only --ignore-scripts --silent
)

# --- 4. 個人・社内の情報が残っていないか ------------------------------------
say "実名・自宅のパスなどが残っていないか調べます"
hits="$(grep -rnIE "$BUILTIN_FORBIDDEN" "$STAGE" --exclude-dir=.git --exclude=.git --exclude-dir=node_modules --exclude=pnpm-lock.yaml | grep -vE "$BUILTIN_ALLOWED" || true)"
if [ -f "$FORBIDDEN_FILE" ]; then
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    case "$pat" in \#*) continue ;; esac
    more="$(grep -rnIiE "$pat" "$STAGE" --exclude-dir=.git --exclude=.git --exclude-dir=node_modules || true)"
    [ -n "$more" ] && hits="$hits"$'\n'"$more"
  done < "$FORBIDDEN_FILE"
else
  echo "注意: $FORBIDDEN_FILE がありません。実名・社名などの確認は、どの環境でも止める文字列だけで行います。"
fi
hits="$(printf '%s\n' "$hits" | sed '/^$/d')"
if [ -n "$hits" ]; then
  printf '%s\n' "$hits" | sed "s#$STAGE/##"
  die "公開しない文字列が残っています。元の ref を直してから、もう一度実行してください（作業場所は $STAGE に残しています）"
fi

GL_CONFIG=()
[ -f "$STAGE/.gitleaks.toml" ] && GL_CONFIG=(-c "$STAGE/.gitleaks.toml")

if [ "${PUBLISH_DRY_RUN:-}" = "1" ]; then
  say "gitleaks で中身を調べます（dry run）"
  (cd "$STAGE" && gitleaks dir --redact --no-banner "${GL_CONFIG[@]}" .) || die "gitleaks が中身に秘密らしい値を見つけました"
  echo "dry run なので、コミットせずに終わります。中身の確認: cd $STAGE"
  echo "作業場所を消すとき:  git worktree remove --force $STAGE"
  exit 0
fi

# --- 5. コミット -------------------------------------------------------------
say "コミットします（作者: $NAME <$EMAIL>）"
git -C "$STAGE" add -A
git -C "$STAGE" -c user.name="$NAME" -c user.email="$EMAIL" -c commit.gpgsign=false \
  commit --quiet -m "$MESSAGE"
COMMIT="$(git -C "$STAGE" rev-parse HEAD)"

# --- 6. gitleaks -------------------------------------------------------------
say "gitleaks で調べます"
gitleaks git --redact --no-banner "${GL_CONFIG[@]}" --log-opts="$BASE..$COMMIT" "$STAGE" \
  || die "gitleaks がコミットに秘密らしい値を見つけました（作業場所は $STAGE に残しています）"
(cd "$STAGE" && gitleaks dir --redact --no-banner "${GL_CONFIG[@]}" .) \
  || die "gitleaks が中身に秘密らしい値を見つけました（作業場所は $STAGE に残しています）"

# 公開先へ出るコミットが1つだけで、作者が noreply であることを確かめる
count="$(git rev-list --count "$BASE..$COMMIT")"
[ "$count" = "1" ] || die "公開先に出るコミットが $count 個あります（1つのはずです）"
authors="$(git log --format='%ae %ce' "$BASE..$COMMIT")"
[ "$authors" = "$EMAIL $EMAIL" ] || die "作者・コミッターのメールが想定と違います: $authors"

# --- 7. push の直前で止める -------------------------------------------------
REPO_URL="$(git remote get-url "$REMOTE")"
REPO_NAME="$(basename "$REPO_URL" .git)"
# 公開のブランチは main だけ（develop は 2026-10-15 に廃止）
PUSH_CMD="git push $REMOTE $COMMIT:refs/heads/$BRANCH"

say "準備ができました"
git -C "$STAGE" show --stat --format='commit %H%nAuthor: %an <%ae>%n%n    %s%n' HEAD | tail -n 5
echo
echo "  公開先:   $REPO_URL ($BRANCH)"
echo "  コミット: ${COMMIT}（$(git -C "$STAGE" ls-files | wc -l | tr -d ' ') ファイル）"
echo "  中身の確認: cd $STAGE"
echo
echo "push は公開です。取り消しても、複製やキャッシュに残ることがあります。"

if [ -t 0 ]; then
  read -r -p "push するなら、リポジトリ名（${REPO_NAME}）を入力してください。それ以外は push せずに終わります: " ans
  if [ "$ans" = "$REPO_NAME" ]; then
    $PUSH_CMD
    echo "push しました。手元の切り替えは、このスクリプトの末尾のコメントを見てください。"
  else
    echo "push しませんでした。"
  fi
fi

echo
echo "手で push するとき:  $PUSH_CMD"
echo "作業場所を消すとき:  git worktree remove --force $STAGE"

# ---------------------------------------------------------------------------
# 公開後の切り替え（手で行う。このスクリプトは実行しない）
#
# ブランチは main だけ（develop は 2026-10-15 に廃止）。
# 手元の main は非公開の old-origin（JapanMarketing-Dev/ADE-movie）の main を追い、作者のメールを含む履歴はそこにだけ置く。
# 公開リポジトリ（origin）の main には、このスクリプトが作る1コミットだけを積む。
#
#   1. 手元の履歴を old-origin に残す:  git push old-origin main
#   2. 一時的な作業場所を消す:          git worktree remove --force <作業場所>
#   3. 公開リポジトリに手元の main を直接 push しない（git push origin main はしない。
#      手元の main は公開の main と共通の祖先を持たないので、push は拒まれる。--force で上書きしない）。
