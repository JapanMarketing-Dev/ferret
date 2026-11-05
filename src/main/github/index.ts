import type { GitHubRepoRef, GitHubRepoResult, GitHubStatus } from '@shared/github'
import { gh, ghErrorMessage, run } from './gh'
import { needsHostLookup, parseAuthStatus, parseForgeRemote, pickActiveAccount } from './parse'
import { t } from '@shared/i18n'
import { cliInstallCommand } from '@shared/cliTools'

/**
 * GitHub 連携の共通部分（フィードバックの送信者の確認・フッターのリポジトリ・開いてよいページの確認）。
 *
 * Orca と同じく GitHub CLI（gh）に認証を任せる。本システムはトークンを読まず、保存もしない。
 * - 接続状態: `gh auth status` を読む（Orca由来: ~/bench/orca/src/main/github/auth-diagnose.ts の diagnoseGhAuth（MIT））
 * - リポジトリ: プロジェクトフォルダの `git remote get-url origin`
 */

/** gh の入れ方。コマンドは CLI の一覧（@shared/cliTools）が正本。その OS の1行が無ければ案内の文 */
function installHint(): string {
  const platform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'
  return cliInstallCommand('gh', platform) ?? t('github.errors.installHint')
}

export async function githubStatus(): Promise<GitHubStatus> {
  const envToken = process.env.GH_TOKEN ? 'GH_TOKEN' : process.env.GITHUB_TOKEN ? 'GITHUB_TOKEN' : null
  const base = { envToken, installHint: installHint() } as const
  // 未ログインだと 1 で終わるが、診断の文は同じように出るので両方の出力を読む
  const result = await gh(['auth', 'status'], { timeoutMs: 10_000 })
  if (result.missing) return { ...base, ghInstalled: false, account: null, accounts: [], error: null }
  const accounts = parseAuthStatus(`${result.stdout}\n${result.stderr}`)
  return {
    ...base,
    ghInstalled: true,
    account: pickActiveAccount(accounts, 'github.com') ?? pickActiveAccount(accounts),
    accounts,
    error: result.timedOut ? ghErrorMessage(result) : null
  }
}

export async function githubRepo(folderPath: string | null): Promise<GitHubRepoResult> {
  if (!folderPath) return { repo: null, reason: t('github.errors.openProject') }
  // git は信頼できる絶対パスで、リポジトリの設定のコマンドを動かさずに（security-7 [5]・[15]）。gitSync.ts は ./index を読むので遅れて読む
  const { AUTOMATIC_GIT_CONFIG, trustedGit } = await import('./gitSync')
  const git = await trustedGit(folderPath)
  if (!git) return { repo: null, reason: t('github.errors.gitMissing') }
  const result = await run(git, ['-C', folderPath, ...AUTOMATIC_GIT_CONFIG, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 })
  if (result.missing) return { repo: null, reason: t('github.errors.gitMissing') }
  if (result.failed) {
    return { repo: null, reason: /not a git repository/i.test(result.stderr) ? t('github.errors.notGitRepo') : t('github.errors.noOrigin') }
  }
  const repo = await resolveRemote(result.stdout)
  return repo ? { repo, reason: null } : { repo: null, reason: t('github.errors.originNotForge') }
}

/**
 * origin の URL を GitHub / GitLab のリポジトリとして読む。github.com・gitlab.com などで決まらないホスト
 * （セルフホスト）のときだけ、渡された lookup でセルフホストの GitLab のホストを聞く（既定は聞かない）
 */
export async function resolveRemote(remoteUrl: string, lookup: () => Promise<string[]> = async () => []): Promise<GitHubRepoRef | null> {
  const hosts = needsHostLookup(remoteUrl) ? await lookup().catch(() => []) : []
  return parseForgeRemote(remoteUrl, hosts)
}
