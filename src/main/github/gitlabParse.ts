import type { GitLabAccount } from '@shared/forge'
import { isSafeGitLabPath, isSafeHost } from '@shared/forge'
import { normalizeCloneUrl, stripUrlCredentials, type GitHubRepoItem } from '@shared/projectSource'
import { asRecord } from '@shared/guards'

/**
 * glab（GitLab CLI）の出力を読み、`glab api` の引数を組み立てる純粋な関数。単体テストの対象。
 *
 * GitLab へは `glab api` だけで話す（--hostname でセルフホストにも同じ形で届く）。
 */

/**
 * `glab auth status`（stderr / stdout のどちらにも出る）を読む。ホストごとに次の形:
 *
 *   gitlab.com
 *     ✓ Logged in to gitlab.com as NAME (/path/to/config.yml)
 *     ✓ Token found: **************
 *   git.example.com
 *     x git.example.com: API call failed: ... 401 Unauthorized
 *
 * 括弧の中（設定ファイルのパス。ホームのパスを含む）とトークンの行は読まない。
 */
export function parseGlabAuthStatus(text: string): GitLabAccount[] {
  const accounts: GitLabAccount[] = []
  let current: GitLabAccount | null = null
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    const header = line.match(/^([a-z0-9][a-z0-9.-]*(?::\d+)?)\s*:?\s*$/i)
    if (header && isSafeHost(header[1]!)) {
      current = { host: header[1]!.toLowerCase(), user: null }
      accounts.push(current)
      continue
    }
    const loggedIn = line.match(/Logged in to (\S+) as (\S+)/i)
    if (loggedIn) {
      const host = loggedIn[1]!.toLowerCase()
      const user = loggedIn[2]!.replace(/[()]/g, '')
      if (!isSafeHost(host) || !/^[A-Za-z0-9_.-]{1,255}$/.test(user)) continue
      if (!current || current.host !== host) {
        current = accounts.find((a) => a.host === host) ?? { host, user: null }
        if (!accounts.includes(current)) accounts.push(current)
      }
      current.user = user
    }
  }
  // ログイン済みを先に（どちらも見つかった順のまま）
  return [...accounts.filter((a) => a.user), ...accounts.filter((a) => !a.user)]
}

/** ログイン済みのホストだけ */
export function signedInHosts(accounts: readonly GitLabAccount[]): string[] {
  return accounts.filter((a) => a.user).map((a) => a.host)
}

/** `glab api` の引数。ホストと API のパスは形を確かめてから入れる（- で始まる値をオプションに読ませない） */
export function glabApiArgs(host: string, endpoint: string): string[] {
  if (!isSafeHost(host)) throw new Error('invalid GitLab host')
  if (!/^[A-Za-z0-9][A-Za-z0-9_./%?=&-]*$/.test(endpoint)) throw new Error('invalid GitLab API path')
  return ['api', '--hostname', host, '--method', 'GET', endpoint]
}

/** 「GitLab から取得」の一覧に出すプロジェクト（自分がメンバーのもの、新しく触った順） */
export const GITLAB_PROJECTS_ENDPOINT = 'projects?membership=true&simple=true&per_page=100&order_by=last_activity_at'


/** GitLab の projects API の結果を一覧にする。clone の URL は normalizeCloneUrl を通ったものだけ */
export function mapGitLabProjects(json: unknown, host: string): GitHubRepoItem[] {
  if (!Array.isArray(json)) return []
  return json.flatMap((raw): GitHubRepoItem[] => {
    const r = asRecord(raw)
    if (!r || !isSafeGitLabPath(r.path_with_namespace)) return []
    const https = typeof r.http_url_to_repo === 'string' ? normalizeCloneUrl(stripUrlCredentials(r.http_url_to_repo)) : { ok: false as const }
    if (!https.ok || !/^https?:\/\//i.test(https.url)) return []
    const ssh = typeof r.ssh_url_to_repo === 'string' ? normalizeCloneUrl(r.ssh_url_to_repo) : { ok: false as const }
    return [{
      nameWithOwner: r.path_with_namespace,
      url: https.url,
      ...(ssh.ok ? { sshUrl: ssh.url } : {}),
      // simple=true では visibility が返らないことがある。分からなければ公開とはみなさない
      isPrivate: r.visibility !== 'public',
      ...(typeof r.last_activity_at === 'string' ? { updatedAt: r.last_activity_at } : {}),
      host
    }]
  })
}
