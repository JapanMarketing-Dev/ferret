/**
 * 公開する commit で GitHub Actions の Cross-platform（Linux・Windows・macOS の単体テスト）が通ったかを確かめる。
 * 手元の関門（scripts/cross-os-unit.sh）は通っても、GitHub の Linux（ext4）でだけ落ちるテストがあった（0.4.10、security-6 [7]）。
 * release-github.mjs create が、GitHub のリリースを作る前にこれで待って確かめる。
 */

/** 確かめるワークフローの名前（.github/workflows/cross-platform.yml の name） */
export const REQUIRED_WORKFLOWS = ['Cross-platform']

/**
 * runs（GitHub API の workflow_runs）から、その commit の判定を返す。
 * 同じワークフローが複数あれば一番新しいものを見る（同じ commit を再実行したときなど）
 */
export function ciVerdict(runs, sha, required = REQUIRED_WORKFLOWS) {
  const pending = []
  const failed = []
  for (const name of required) {
    const latest = runs
      .filter((run) => run.name === name && run.head_sha === sha)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0]
    if (!latest || latest.status !== 'completed') pending.push(name)
    else if (latest.conclusion !== 'success') failed.push(`${name}（${latest.conclusion}: ${latest.html_url ?? ''}）`)
  }
  if (failed.length) return { state: 'failure', failed }
  if (pending.length) return { state: 'pending', pending }
  return { state: 'success' }
}
