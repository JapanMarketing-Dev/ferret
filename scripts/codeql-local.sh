#!/usr/bin/env bash
#
# 公開の前の関門: commit 済みの中身を、公開リポジトリの CI（.github/workflows/codeql.yml）と同じ CodeQL で手元で調べる。
#
#   bash scripts/codeql-local.sh [ref（既定: HEAD）]
#
# 公開リポジトリの Code scanning は publish-squash.sh で出したあとに走るので、そこで初めて警告に気づくと
# 公開版に問題が残る。CI と同じ版の CodeQL・同じ言語（javascript-typescript と actions）・同じクエリ
# （既定の code-scanning のスイート、build-mode: none）で先に流し、error / warning が1件でもあれば失敗にする。
#
# CodeQL は github/codeql-action の公式のリリース（CI の action が使う版の bundle）だけを取り、sha256 を
# 確かめてから ~/.cache/ferret-codeql/<版>/ に展開する（2回目からは取らない）。版を上げるときは、codeql.yml の
# action の SHA が使う版（src/defaults.json の bundleVersion）に CODEQL_VERSION と CODEQL_SHA256 を合わせる。
#
# 通ったら「<tree のハッシュ> codeql」を .git/ferret-codeql に足す。publish-squash.sh は、公開する ref の tree に
# この記録が無ければ止まる（中身が同じなら commit が変わっても通る）。
#
# 環境変数:
#   FERRET_CODEQL_HOME   CodeQL を置くフォルダ（既定: ~/.cache/ferret-codeql）
#   FERRET_CODEQL_KEEP=1 調べたあとも作業フォルダ（データベースと SARIF）を消さない
set -euo pipefail

# codeql.yml の github/codeql-action@24c54180…（v4.38.3）が使う bundle の版と、その macOS 版の sha256
# （GitHub の release の asset の digest と codeql-bundle-osx64.tar.zst.checksum.txt で確かめた値）
CODEQL_VERSION=2.27.2
CODEQL_SHA256=6fcb14067caa51ff4dd9a7116955ce14f64027348773dde43a119c0aa618f2ce
CODEQL_URL="https://github.com/github/codeql-action/releases/download/codeql-bundle-v${CODEQL_VERSION}/codeql-bundle-osx64.tar.zst"
# codeql.yml の matrix.language と、言語ごとの既定のスイート（queries を指定しないときに CI が使うもの）
LANGUAGES=(javascript-typescript actions)
suite_of() {
  case "$1" in
    javascript-typescript) echo codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls ;;
    actions) echo codeql/actions-queries:codeql-suites/actions-code-scanning.qls ;;
  esac
}

REF="${1:-HEAD}"
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
TREE="$(git rev-parse --verify "${REF}^{tree}")"
SHORT="${TREE:0:12}"
RECORD="$(git rev-parse --git-common-dir)/ferret-codeql"
HOME_DIR="${FERRET_CODEQL_HOME:-$HOME/.cache/ferret-codeql}"
CODEQL="$HOME_DIR/$CODEQL_VERSION/codeql/codeql"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\n[中止] %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "この関門は mac 用です（CodeQL の macOS 版の sha256 だけを持っています）"
for cmd in curl zstd tar shasum node git; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd が見つかりません"
done

# --- CodeQL を用意する（公式の bundle・sha256 を確かめる） --------------------
if [ ! -x "$CODEQL" ]; then
  say "CodeQL $CODEQL_VERSION を取得します（github/codeql-action の公式のリリース）"
  mkdir -p "$HOME_DIR"
  archive="$HOME_DIR/codeql-bundle-v${CODEQL_VERSION}-osx64.tar.zst"
  curl -fL --proto '=https' --tlsv1.2 -o "$archive.part" "$CODEQL_URL"
  actual="$(shasum -a 256 "$archive.part" | cut -d' ' -f1)"
  if [ "$actual" != "$CODEQL_SHA256" ]; then
    rm -f "$archive.part"
    die "CodeQL の bundle の sha256 が違います（期待 ${CODEQL_SHA256}、実際 ${actual}）"
  fi
  mv "$archive.part" "$archive"
  rm -rf "$HOME_DIR/$CODEQL_VERSION.tmp"
  mkdir -p "$HOME_DIR/$CODEQL_VERSION.tmp"
  zstd -dc "$archive" | tar -x -C "$HOME_DIR/$CODEQL_VERSION.tmp"
  rm -rf "$HOME_DIR/$CODEQL_VERSION"
  mv "$HOME_DIR/$CODEQL_VERSION.tmp" "$HOME_DIR/$CODEQL_VERSION"
fi
"$CODEQL" version --format=terse | grep -qx "$CODEQL_VERSION" || die "CodeQL の版が $CODEQL_VERSION ではありません: $CODEQL"

# --- commit 済みの中身を写す --------------------------------------------------
if [ -n "$(git status --porcelain --untracked-files=no)" ] && [ "$REF" = "HEAD" ]; then
  echo "注意: 作業ツリーの未 commit の変更は調べません。調べるのは commit 済みの ${REF}（tree ${SHORT}）です。"
fi
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ferret-codeql.XXXXXX")"
[ "${FERRET_CODEQL_KEEP:-}" = 1 ] || trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src"
git archive --format=tar "$REF" | tar -x -C "$WORK/src"

# --- 言語ごとに database create → analyze ------------------------------------
for lang in "${LANGUAGES[@]}"; do
  say "$lang を調べます（tree ${SHORT}）"
  "$CODEQL" database create "$WORK/db-$lang" --language="$lang" --build-mode=none \
    --source-root="$WORK/src" --overwrite --quiet
  "$CODEQL" database analyze "$WORK/db-$lang" "$(suite_of "$lang")" \
    --format=sarif-latest --output="$WORK/$lang.sarif" --quiet
done

# --- 結果: error / warning が1件でもあれば失敗 ---------------------------------
say "結果"
node - "$WORK" "${LANGUAGES[@]}" <<'EOF'
const fs = require('fs')
const [work, ...langs] = process.argv.slice(2)
let bad = 0
for (const lang of langs) {
  const sarif = JSON.parse(fs.readFileSync(`${work}/${lang}.sarif`, 'utf8'))
  for (const run of sarif.runs) {
    const rules = new Map()
    for (const c of [run.tool.driver, ...(run.tool.extensions ?? [])]) for (const r of c.rules ?? []) rules.set(r.id, r)
    for (const res of run.results ?? []) {
      const rule = rules.get(res.ruleId)
      const level = res.level ?? rule?.defaultConfiguration?.level ?? 'warning'
      const loc = res.locations?.[0]?.physicalLocation
      const where = loc ? `${loc.artifactLocation.uri}:${loc.region?.startLine ?? '?'}` : '?'
      const line = `${level.padEnd(7)} ${res.ruleId}  ${where}  ${res.message.text.split('\n')[0]}`
      if (level === 'error' || level === 'warning') { bad++; console.log(line) } else console.log(`(参考) ${line}`)
    }
  }
}
if (bad > 0) { console.log(`\nerror / warning が ${bad} 件あります`); process.exit(1) }
console.log('error / warning は 0 件です')
EOF

echo "$TREE codeql" >> "$RECORD"
say "通りました（tree $SHORT を $RECORD に記録）"
[ "${FERRET_CODEQL_KEEP:-}" = 1 ] && echo "作業フォルダ: $WORK"
exit 0
