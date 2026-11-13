/**
 * フッターの git の同期（fetch・最新の取得・push）の決まり。electron も子プロセスも使わない純粋な関数で、単体テストから直接呼べる。
 *
 * - `git status --porcelain=v2 --branch` を読む（ブランチ・upstream・先行と遅れ・未コミットの数）
 * - 今の状態で押せる操作と、押せない理由を決める
 * - 裏の fetch をいつ走らせるかを決める（プロジェクトを開いたとき・5分ごと・前に出したとき。失敗が続けば間を空ける）
 * - git の失敗（英語の出力。LC_ALL=C で走らせる）を決まった種類にする
 */

/** status から読んだもの */
export interface GitStatusSummary {
  /** ブランチ名。detached HEAD のときは null で、shortOid を出す */
  branch: string | null
  shortOid: string | null
  /** HEAD のコミット（40桁）。push の確認のあとに HEAD が動いていないかを確かめる。コミットが無ければ null */
  headOid: string | null
  /** 未コミットの変更（追跡外を含む）のファイル数 */
  changes: number
  ahead: number
  behind: number
  hasUpstream: boolean
  /** upstream の名前（origin/develop）。無ければ null */
  upstream: string | null
  /** upstream は設定されているが、リモートの側のブランチが無い（消された・まだ fetch していない） */
  upstreamGone: boolean
}

export function parseGitStatus(text: string): GitStatusSummary {
  const summary: GitStatusSummary = { branch: null, shortOid: null, headOid: null, changes: 0, ahead: 0, behind: 0, hasUpstream: false, upstream: null, upstreamGone: false }
  let sawAb = false
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.startsWith('# branch.oid ')) {
      const oid = line.slice('# branch.oid '.length).trim()
      // コミットが1つも無いリポジトリは (initial)
      const valid = /^[0-9a-f]{7,}$/i.test(oid)
      summary.shortOid = valid ? oid.slice(0, 7) : null
      summary.headOid = valid ? oid.toLowerCase() : null
    } else if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length).trim()
      summary.branch = head && head !== '(detached)' ? head : null
    } else if (line.startsWith('# branch.upstream ')) {
      summary.hasUpstream = true
      summary.upstream = line.slice('# branch.upstream '.length).trim() || null
    } else if (line.startsWith('# branch.ab ')) {
      const match = line.match(/^# branch\.ab \+(\d+) -(\d+)$/)
      if (match) {
        sawAb = true
        summary.ahead = Number(match[1])
        summary.behind = Number(match[2])
      }
    } else if (/^[12u?] /.test(line)) {
      // 1: 変更 2: 名前の変更・コピー u: 競合 ?: 追跡外
      summary.changes++
    }
  }
  // upstream があるのに先行・遅れの行が無いのは、リモートの側のブランチが無いとき
  summary.upstreamGone = summary.hasUpstream && !sawAb
  return summary
}

// ─── 失敗の種類 ─────────────────────────────

export type GitSyncErrorKind =
  | 'gitMissing' | 'timeout' | 'auth' | 'network'
  | 'noUpstream' | 'upstreamGone' | 'detached' | 'diverged' | 'localChanges'
  | 'rejected' | 'locked' | 'headMoved' | 'notGit' | 'failed'

/**
 * git の失敗を決まった種類にする。出力は英語（子プロセスは LC_ALL=C）。
 * 認証の失敗は ssh でも「Could not read from remote repository」を伴うので、ネットワークより先に見る。
 */
export function classifyGitError(stderr: string, flags: { missing?: boolean; timedOut?: boolean } = {}): GitSyncErrorKind {
  if (flags.missing) return 'gitMissing'
  if (flags.timedOut) return 'timeout'
  const text = stderr
  if (/index\.lock|Unable to create '.*\.lock'|cannot lock ref/i.test(text)) return 'locked'
  if (/would be overwritten by (merge|checkout)|Please commit your changes or stash them|untracked working tree files would be/i.test(text)) return 'localChanges'
  if (/Not possible to fast-forward|Diverging branches|have diverged|not a fast-forward merge/i.test(text)) return 'diverged'
  if (/hook declined|pre-push hook/i.test(text)) return 'failed'
  if (/\[rejected\]|\(fetch first\)|non-fast-forward|Updates were rejected/i.test(text)) return 'rejected'
  if (/There is no tracking information|has no upstream branch|no upstream configured|No upstream branch/i.test(text)) return 'noUpstream'
  if (/couldn't find remote ref|no such ref was fetched/i.test(text)) return 'upstreamGone'
  if (/Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(|Host key verification failed|HTTP Basic: Access denied|Invalid username or password|returned error: 40[13]|The requested URL returned error: 40[13]|access denied|denied to /i.test(text)) return 'auth'
  if (/Could not resolve host|unable to access|Connection (timed out|refused|reset|closed)|Network is unreachable|Could not read from remote repository|Operation timed out|unable to connect|early EOF|RPC failed|Could not resolve hostname|No route to host/i.test(text)) return 'network'
  if (/not a git repository/i.test(text)) return 'notGit'
  return 'failed'
}

// ─── 押せる操作 ─────────────────────────────

export type GitSyncAction = 'fetch' | 'pull' | 'push'

export interface GitActionAvailability {
  /** リモートの変更を確かめる（fetch）。upstream が無くても使える */
  fetch: boolean
  /** 最新を取得（fetch のあと fast-forward）。押せないときは reason */
  pull: { enabled: boolean; reason: GitSyncErrorKind | null }
  /** 同期（最新を取得してから、先行していれば確認のうえ push） */
  sync: { enabled: boolean; reason: GitSyncErrorKind | null }
}

/** 今の状態で押せる操作。分かれている（先行も遅れもある）ときは取り込まない（マージは Agent かターミナルで） */
export function gitActionAvailability(status: Pick<GitStatusSummary, 'branch' | 'hasUpstream' | 'upstreamGone' | 'ahead' | 'behind'>): GitActionAvailability {
  const blocked = !status.branch ? 'detached' : !status.hasUpstream ? 'noUpstream' : status.upstreamGone ? 'upstreamGone' : null
  const pullReason: GitSyncErrorKind | null = blocked ?? (status.ahead > 0 && status.behind > 0 ? 'diverged' : null)
  return {
    fetch: true,
    pull: { enabled: pullReason === null, reason: pullReason },
    sync: { enabled: pullReason === null, reason: pullReason }
  }
}

/** push の前の確かめ：確認を出したときの HEAD のままで、取り込んでいないものが無く、先行しているか */
export function pushPrecondition(status: Pick<GitStatusSummary, 'branch' | 'hasUpstream' | 'upstreamGone' | 'ahead' | 'behind' | 'headOid'>, expectedHead: string): GitSyncErrorKind | null {
  if (!status.branch) return 'detached'
  if (!status.hasUpstream) return 'noUpstream'
  if (status.upstreamGone) return 'upstreamGone'
  if (!status.headOid || status.headOid !== expectedHead.toLowerCase()) return 'headMoved'
  if (status.behind > 0) return 'diverged'
  return null
}

// ─── 裏の fetch の予定 ─────────────────────────────

/** 何をきっかけに fetch するか。open はプロジェクトを開いた（起動時・切り替えを含む）、manual は利用者が押した */
export type FetchTrigger = 'open' | 'interval' | 'focus' | 'manual'

export const AUTO_FETCH_INTERVAL_MS = 5 * 60_000
/** 失敗が続いたときの最大の間隔 */
export const AUTO_FETCH_MAX_BACKOFF_MS = 60 * 60_000

export interface GitFetchState {
  fetching: boolean
  /** 最後に成功した時刻（ms） */
  lastFetchAt: number | null
  /** 最後に試した時刻（成功・失敗を問わない） */
  lastAttemptAt: number | null
  /** 最後の試みが失敗なら、その種類 */
  lastError: GitSyncErrorKind | null
  /** 続けて失敗した回数 */
  failures: number
}

export function emptyFetchState(): GitFetchState {
  return { fetching: false, lastFetchAt: null, lastAttemptAt: null, lastError: null, failures: 0 }
}

/** 自動の fetch の間隔。失敗が続けば 5分→10分→20分…と延ばし、最大 1時間 */
export function autoFetchDelayMs(failures: number): number {
  const steps = Math.max(0, Math.min(failures, 10))
  return Math.min(AUTO_FETCH_INTERVAL_MS * 2 ** steps, AUTO_FETCH_MAX_BACKOFF_MS)
}

/**
 * 今 fetch するか。
 * - 走っている最中は重ねない
 * - プロジェクトを開いたとき・利用者が押したときは、すぐ走らせる（前回の失敗の間隔も待たない）
 * - 定期・前に出したときは、ウインドウが見えていて、前回の試みから間隔（失敗が続けば延ばしたもの）が過ぎたときだけ
 */
export function shouldFetch(trigger: FetchTrigger, state: GitFetchState, now: number, visible: boolean): boolean {
  if (state.fetching) return false
  if (trigger === 'open' || trigger === 'manual') return true
  if (!visible) return false
  if (state.lastAttemptAt === null) return true
  return now - state.lastAttemptAt >= autoFetchDelayMs(state.failures)
}

/** fetch の結果を状態に入れる */
export function recordFetch(state: GitFetchState, now: number, error: GitSyncErrorKind | null): GitFetchState {
  return error
    ? { ...state, fetching: false, lastAttemptAt: now, lastError: error, failures: state.failures + 1 }
    : { ...state, fetching: false, lastAttemptAt: now, lastFetchAt: now, lastError: null, failures: 0 }
}

/** 「何分前」の表示用。1分未満は just、1時間未満は分、1日未満は時間、それ以上は日 */
export function elapsedLabel(now: number, at: number): { unit: 'just' | 'minutes' | 'hours' | 'days'; count: number } {
  const sec = Math.max(0, Math.floor((now - at) / 1000))
  if (sec < 60) return { unit: 'just', count: 0 }
  if (sec < 3600) return { unit: 'minutes', count: Math.floor(sec / 60) }
  if (sec < 86_400) return { unit: 'hours', count: Math.floor(sec / 3600) }
  return { unit: 'days', count: Math.floor(sec / 86_400) }
}
