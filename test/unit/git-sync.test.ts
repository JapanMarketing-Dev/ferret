import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  AUTO_FETCH_INTERVAL_MS, AUTO_FETCH_MAX_BACKOFF_MS, autoFetchDelayMs, classifyGitError, elapsedLabel, emptyFetchState,
  gitActionAvailability, parseGitStatus, pushPrecondition, recordFetch, shouldFetch, type GitFetchState
} from '@shared/gitSync'

// ログインシェルを起こさない（git は main の PATH から探す）
vi.mock('../../src/main/agentDetection', () => ({
  searchDirs: async () => (process.env.PATH ?? '').split(delimiter).filter(Boolean)
}))

const HEAD = '0123456789abcdef0123456789abcdef01234567'

describe('git status --porcelain=v2 --branch を読む', () => {
  it('upstream・HEAD・先行と遅れ・変更の数', () => {
    const text = [
      `# branch.oid ${HEAD}`,
      '# branch.head feature/login',
      '# branch.upstream origin/feature/login',
      '# branch.ab +2 -3',
      '1 .M N... 100644 100644 100644 aaa bbb src/a.ts',
      '? notes.md'
    ].join('\n')
    expect(parseGitStatus(text)).toEqual({
      branch: 'feature/login', shortOid: '0123456', headOid: HEAD, changes: 2, ahead: 2, behind: 3,
      hasUpstream: true, upstream: 'origin/feature/login', upstreamGone: false
    })
  })

  it('upstream があるのに ab の行が無いのは、リモートのブランチが消えたとき', () => {
    const s = parseGitStatus(`# branch.oid ${HEAD}\n# branch.head topic\n# branch.upstream origin/topic\n`)
    expect(s).toMatchObject({ hasUpstream: true, upstreamGone: true, ahead: 0, behind: 0 })
  })

  it('upstream が無い・コミットが無い', () => {
    expect(parseGitStatus('# branch.oid (initial)\n# branch.head main\n')).toMatchObject({ headOid: null, hasUpstream: false, upstream: null, upstreamGone: false })
  })
})

describe('git の失敗の種類', () => {
  it.each([
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled', 'auth'],
    ['git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.', 'auth'],
    ['remote: HTTP Basic: Access denied\nfatal: Authentication failed for \'https://gitlab.com/a/b.git/\'', 'auth'],
    ['fatal: unable to access \'https://github.com/a/b.git/\': Could not resolve host: github.com', 'network'],
    ['ssh: connect to host gitlab.example port 22: Network is unreachable\nfatal: Could not read from remote repository.', 'network'],
    ['error: Your local changes to the following files would be overwritten by merge:\n\tsrc/a.ts\nPlease commit your changes or stash them before you merge.', 'localChanges'],
    ['hint: Diverging branches can\'t be fast-forwarded\nfatal: Not possible to fast-forward, aborting.', 'diverged'],
    [' ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs', 'rejected'],
    ['There is no tracking information for the current branch.', 'noUpstream'],
    ['fatal: couldn\'t find remote ref refs/heads/gone', 'upstreamGone'],
    ['fatal: Unable to create \'/Users/taro/app/.git/index.lock\': File exists.', 'locked'],
    ['error: failed to push some refs\nhusky - pre-push hook exited with code 1 (error)', 'failed'],
    ['something else', 'failed']
  ] as const)('%s', (stderr, kind) => {
    expect(classifyGitError(stderr)).toBe(kind)
  })

  it('起動できない・時間切れは出力より先', () => {
    expect(classifyGitError('Authentication failed', { missing: true })).toBe('gitMissing')
    expect(classifyGitError('Authentication failed', { timedOut: true })).toBe('timeout')
  })
})

describe('押せる操作', () => {
  const base = { branch: 'main', hasUpstream: true, upstreamGone: false, ahead: 0, behind: 0 }
  it('upstream があれば、取得・同期とも押せる', () => {
    expect(gitActionAvailability({ ...base, behind: 2 })).toEqual({ fetch: true, pull: { enabled: true, reason: null }, sync: { enabled: true, reason: null } })
  })
  it('upstream が無いブランチは確認（fetch）だけ', () => {
    const a = gitActionAvailability({ ...base, hasUpstream: false })
    expect(a.fetch).toBe(true)
    expect(a.pull).toEqual({ enabled: false, reason: 'noUpstream' })
    expect(a.sync.enabled).toBe(false)
  })
  it('分かれている・detached・upstream が消えたときは取り込まない', () => {
    expect(gitActionAvailability({ ...base, ahead: 1, behind: 1 }).pull.reason).toBe('diverged')
    expect(gitActionAvailability({ ...base, branch: null }).pull.reason).toBe('detached')
    expect(gitActionAvailability({ ...base, upstreamGone: true }).pull.reason).toBe('upstreamGone')
  })
  it('push は確認したときの HEAD のままで、遅れていないときだけ', () => {
    const s = { ...base, ahead: 2, headOid: HEAD }
    expect(pushPrecondition(s, HEAD)).toBeNull()
    expect(pushPrecondition(s, HEAD.toUpperCase())).toBeNull()
    expect(pushPrecondition(s, 'f'.repeat(40))).toBe('headMoved')
    expect(pushPrecondition({ ...s, behind: 1 }, HEAD)).toBe('diverged')
    expect(pushPrecondition({ ...s, hasUpstream: false }, HEAD)).toBe('noUpstream')
  })
})

describe('裏の fetch の予定', () => {
  const now = 10 * 60 * 60_000
  const recent: GitFetchState = { ...emptyFetchState(), lastAttemptAt: now - 1_000, lastFetchAt: now - 1_000 }

  it('プロジェクトを開いたら（起動時・切り替えを含む）、直前に確かめていても・見えていなくても・失敗が続いていても、すぐ fetch する', () => {
    expect(shouldFetch('open', emptyFetchState(), now, true)).toBe(true)
    expect(shouldFetch('open', recent, now, true)).toBe(true)
    expect(shouldFetch('open', recent, now, false)).toBe(true)
    expect(shouldFetch('open', { ...recent, failures: 5, lastError: 'auth' }, now, false)).toBe(true)
  })

  it('走っている最中は、開いたときでも重ねない', () => {
    expect(shouldFetch('open', { ...recent, fetching: true }, now, true)).toBe(false)
    expect(shouldFetch('manual', { ...recent, fetching: true }, now, true)).toBe(false)
  })

  it('定期・前に出したときは、見えていて 5 分たってから', () => {
    expect(shouldFetch('interval', recent, now, true)).toBe(false)
    expect(shouldFetch('focus', recent, now, true)).toBe(false)
    const old = { ...recent, lastAttemptAt: now - AUTO_FETCH_INTERVAL_MS }
    expect(shouldFetch('interval', old, now, true)).toBe(true)
    expect(shouldFetch('focus', old, now, true)).toBe(true)
    expect(shouldFetch('interval', old, now, false)).toBe(false)
    expect(shouldFetch('interval', emptyFetchState(), now, true)).toBe(true)
  })

  it('失敗が続けば間隔を延ばす（最大 1 時間）', () => {
    expect(autoFetchDelayMs(0)).toBe(AUTO_FETCH_INTERVAL_MS)
    expect(autoFetchDelayMs(1)).toBe(2 * AUTO_FETCH_INTERVAL_MS)
    expect(autoFetchDelayMs(2)).toBe(4 * AUTO_FETCH_INTERVAL_MS)
    expect(autoFetchDelayMs(50)).toBe(AUTO_FETCH_MAX_BACKOFF_MS)
    const failing = { ...emptyFetchState(), lastAttemptAt: now - AUTO_FETCH_INTERVAL_MS, failures: 1, lastError: 'network' as const }
    expect(shouldFetch('interval', failing, now, true)).toBe(false)
    expect(shouldFetch('interval', { ...failing, lastAttemptAt: now - 2 * AUTO_FETCH_INTERVAL_MS }, now, true)).toBe(true)
  })

  it('結果の記録：成功で失敗の数を戻し、失敗は最後に成功した時刻を残す', () => {
    const failed = recordFetch({ ...emptyFetchState(), fetching: true, lastFetchAt: 5 }, 100, 'auth')
    expect(failed).toEqual({ fetching: false, lastFetchAt: 5, lastAttemptAt: 100, lastError: 'auth', failures: 1 })
    expect(recordFetch(failed, 200, null)).toEqual({ fetching: false, lastFetchAt: 200, lastAttemptAt: 200, lastError: null, failures: 0 })
  })

  it('何分前の表示', () => {
    expect(elapsedLabel(now, now - 30_000)).toEqual({ unit: 'just', count: 0 })
    expect(elapsedLabel(now, now - 3 * 60_000)).toEqual({ unit: 'minutes', count: 3 })
    expect(elapsedLabel(now, now - 2 * 3600_000)).toEqual({ unit: 'hours', count: 2 })
    expect(elapsedLabel(now, now - 3 * 86_400_000)).toEqual({ unit: 'days', count: 3 })
    expect(elapsedLabel(now, now + 5_000)).toEqual({ unit: 'just', count: 0 })
  })
})

describe('git の子プロセスは問い合わせを出さない', () => {
  it('端末・askpass・資格情報マネージャーの問い合わせを切り、出力を英語にする', async () => {
    const { gitSyncEnv } = await import('../../src/main/github/gitSync')
    const env = gitSyncEnv({ PATH: '/usr/bin', SSH_ASKPASS: '/usr/libexec/ssh-askpass', GIT_ASKPASS: '/opt/askpass', LANG: 'ja_JP.UTF-8' }, 'darwin')
    expect(env).toMatchObject({ GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never', GCM_INTERACTIVE: 'never', LC_ALL: 'C' })
    expect(env.SSH_ASKPASS).toBeUndefined()
    expect(gitSyncEnv({ PATH: 'C:\\Windows' }, 'win32').NoDefaultCurrentDirectoryInExePath).toBe('1')
  })
})

// ─── 本物の git で（リモートは手元の bare リポジトリ。ネットワークへは出ない） ─────────────

// 1件で git を数十回起動する。Windows はプロセスの起動が遅く（ARM の VM で1回 130ms 以上）、10 秒の既定では足りないことがある
describe('本物の git：fetch・最新の取得（fast-forward）・push', { timeout: 60_000 }, () => {
  let root = ''
  const saved: Record<string, string | undefined> = {}
  const ENV_KEYS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']
  let seq = 0

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'ferret-git-sync-'))
    for (const key of ENV_KEYS) saved[key] = process.env[key]
    // 利用者の git の設定（フック・署名）を読まない
    writeFileSync(join(root, 'gitconfig'), '[init]\n\tdefaultBranch = main\n')
    process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig')
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 'Taro'
    process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 'taro@example.test'
  })

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
    // Windows は git の終わった直後にファイルを掴んだままのことがある（EBUSY）。少し待って消し直す
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  /**
   * bare のリモートと、それを clone した2つ（project が開いているフォルダ、other は別の人）。
   * git を毎回8回起動して作ると遅いので、最初の1組を雛形にして写し、リモートの場所だけ書き換える
   */
  let template = ''
  function setup(): { remote: string; project: string; other: string } {
    template ||= build(join(root, 'template'))
    const dir = join(root, `case-${++seq}`)
    cpSync(template, dir, { recursive: true, verbatimSymlinks: true })
    for (const clone of ['project', 'other']) {
      const config = join(dir, clone, '.git', 'config')
      writeFileSync(config, readFileSync(config, 'utf8').split(join(template, 'remote.git')).join(join(dir, 'remote.git')))
    }
    return { remote: join(dir, 'remote.git'), project: join(dir, 'project'), other: join(dir, 'other') }
  }

  function build(dir: string): string {
    const remote = join(dir, 'remote.git')
    execFileSync('git', ['init', '--quiet', '--bare', remote])
    const project = join(dir, 'project')
    const other = join(dir, 'other')
    execFileSync('git', ['clone', '--quiet', remote, project], { stdio: 'ignore' })
    writeFileSync(join(project, 'a.txt'), 'one\n')
    git(project, 'add', 'a.txt')
    git(project, 'commit', '--quiet', '-m', 'first')
    git(project, 'push', '--quiet', '-u', 'origin', 'main')
    execFileSync('git', ['clone', '--quiet', remote, other], { stdio: 'ignore' })
    return dir
  }

  function commitIn(repo: string, file: string, content: string, push: boolean): void {
    writeFileSync(join(repo, file), content)
    git(repo, 'add', file)
    git(repo, 'commit', '--quiet', '-m', `edit ${file}`)
    if (push) git(repo, 'push', '--quiet')
  }

  async function sync() {
    return import('../../src/main/github/gitSync')
  }

  /** 裏の fetch の許可を一時フォルダに残す（security-7 [9]） */
  async function withConsentStore() {
    const { setFetchConsentStore } = await sync()
    const { FetchConsentStore } = await import('../../src/main/github/fetchConsent')
    setFetchConsentStore(new FetchConsentStore(join(root, `consent-${++seq}.json`)))
  }
  /** 通信しない宛先（閉じたポート）の https のリモート。fetch はすぐ失敗する */
  const UNREACHABLE = 'https://127.0.0.1:9/acme/shop.git'

  it('ローカルのパスのリモートは裏で fetch しない（upload-pack をこのパソコンで動かさない）。押した fetch で遅れが分かる', async () => {
    await withConsentStore()
    const { autoFetch, readGitStatus, runGitAction } = await sync()
    const { project, other } = setup()
    commitIn(other, 'b.txt', 'from other\n', true)
    const before = await readGitStatus(project)
    expect(before.behind).toBe(0)
    expect(before.fetch.autoFetch).toBeNull()
    expect(await autoFetch(project, 'open', true)).toBeNull()
    const fetched = await runGitAction(project, 'fetch', null)
    expect(fetched.status).toMatchObject({ isGit: true, branch: 'main', upstream: 'origin/main', behind: 1, ahead: 0, hasRemote: true })
  })

  it('裏の fetch は、行き先を見せて認めてもらうまで走らせない。認めたら走り、続けての定期は間隔を待つ', async () => {
    await withConsentStore()
    const { autoFetch, readGitStatus, decideAutoFetch } = await sync()
    const { project } = setup()
    git(project, 'remote', 'set-url', 'origin', UNREACHABLE)
    const before = await readGitStatus(project)
    expect(before.fetch).toMatchObject({ autoFetch: 'unknown', remote: '127.0.0.1:9/acme/shop' })
    expect(await autoFetch(project, 'open', true)).toBeNull()
    expect((await decideAutoFetch(project, false)).fetch.autoFetch).toBe('declined')
    expect(await autoFetch(project, 'open', true)).toBeNull()
    expect((await decideAutoFetch(project, true)).fetch.autoFetch).toBe('approved')
    const fetched = await autoFetch(project, 'open', true)
    expect(fetched?.fetch.lastError).not.toBeNull()
    expect(await autoFetch(project, 'interval', true)).toBeNull()
    // リモートの URL が変われば、また聞く
    git(project, 'remote', 'set-url', 'origin', 'https://127.0.0.1:9/other/repo.git')
    expect((await readGitStatus(project)).fetch.autoFetch).toBe('unknown')
    expect(await autoFetch(project, 'open', true)).toBeNull()
  })

  it('認めていないリモートで裏の fetch を頼んでも、同時に読んだ状態は「取得中」にならない（フッターの回る印が消えない不具合）', async () => {
    await withConsentStore()
    const { autoFetch, readGitStatus } = await sync()
    const { project } = setup()
    git(project, 'remote', 'set-url', 'origin', UNREACHABLE)
    // フッターは 30 秒ごと・前に出すたびに、読み直しと裏の fetch を同時に頼む
    for (const trigger of ['open', 'interval', 'focus'] as const) {
      const [status, fetched] = await Promise.all([readGitStatus(project), autoFetch(project, trigger, true)])
      expect(fetched).toBeNull()
      expect(status.fetch.fetching).toBe(false)
    }
    // 同時に2つ頼まれても、重ねず、どちらも null（印も残らない）
    const both = await Promise.all([autoFetch(project, 'open', true), autoFetch(project, 'open', true)])
    expect(both).toEqual([null, null])
    expect((await readGitStatus(project)).fetch.fetching).toBe(false)
  })

  it('認めたリモートの裏の fetch が終われば、取得中の印は消えている（届かないリモートでも時間内に終わる）', async () => {
    await withConsentStore()
    const { autoFetch, readGitStatus, decideAutoFetch } = await sync()
    const { project } = setup()
    git(project, 'remote', 'set-url', 'origin', UNREACHABLE)
    await decideAutoFetch(project, true)
    const fetched = await autoFetch(project, 'open', true)
    expect(fetched?.fetch.fetching).toBe(false)
    expect(fetched?.fetch.lastError).not.toBeNull()
    expect((await readGitStatus(project)).fetch.fetching).toBe(false)
  })

  it('最新を取得：fast-forward で取り込み、ファイルが変わる', async () => {
    const { runGitAction } = await sync()
    const { project, other } = setup()
    commitIn(other, 'b.txt', 'from other\n', true)
    commitIn(other, 'c.txt', 'more\n', true)
    const result = await runGitAction(project, 'pull', null)
    expect(result).toMatchObject({ ok: true, error: null, commits: 2 })
    // 終わった後の状態なので、自分の操作を「動いている」と返さない（フッターのボタンがすぐ押せる）
    expect(result.status).toMatchObject({ behind: 0, ahead: 0, busy: null })
    expect(readFileSync(join(project, 'b.txt'), 'utf8')).toBe('from other\n')
  })

  it('未コミットの変更とぶつかるときは取り込まず、変更を残す', async () => {
    const { runGitAction } = await sync()
    const { project, other } = setup()
    commitIn(other, 'a.txt', 'changed by other\n', true)
    writeFileSync(join(project, 'a.txt'), 'my local edit\n')
    const before = git(project, 'rev-parse', 'HEAD')
    const result = await runGitAction(project, 'pull', null)
    expect(result).toMatchObject({ ok: false, error: 'localChanges' })
    expect(readFileSync(join(project, 'a.txt'), 'utf8')).toBe('my local edit\n')
    expect(git(project, 'rev-parse', 'HEAD')).toBe(before)
    expect(result.status.behind).toBe(1)
  })

  it('分かれているときはマージしない', async () => {
    const { runGitAction } = await sync()
    const { project, other } = setup()
    commitIn(other, 'b.txt', 'theirs\n', true)
    commitIn(project, 'c.txt', 'mine\n', false)
    const before = git(project, 'rev-parse', 'HEAD')
    const result = await runGitAction(project, 'pull', null)
    expect(result).toMatchObject({ ok: false, error: 'diverged' })
    expect(result.status).toMatchObject({ ahead: 1, behind: 1, busy: null })
    expect(git(project, 'rev-parse', 'HEAD')).toBe(before)
  })

  it('push：確認した HEAD のときだけ upstream へ送る', async () => {
    const { runGitAction, readGitStatus } = await sync()
    const { remote, project } = setup()
    commitIn(project, 'c.txt', 'mine\n', false)
    const status = await readGitStatus(project)
    expect(status.ahead).toBe(1)
    const moved = await runGitAction(project, 'push', 'f'.repeat(40))
    expect(moved).toMatchObject({ ok: false, error: 'headMoved' })
    expect(git(remote, 'rev-parse', 'main')).not.toBe(status.headOid)
    const pushed = await runGitAction(project, 'push', status.headOid)
    expect(pushed).toMatchObject({ ok: true, commits: 1 })
    expect(pushed.status.ahead).toBe(0)
    expect(git(remote, 'rev-parse', 'main')).toBe(status.headOid)
  })

  it('リモートが先に進んでいれば push は断られる（取り込んでからにする）', async () => {
    const { runGitAction, readGitStatus } = await sync()
    const { project, other } = setup()
    commitIn(other, 'b.txt', 'theirs\n', true)
    commitIn(project, 'c.txt', 'mine\n', false)
    // まだ fetch していないので、手元からは遅れが見えない
    const status = await readGitStatus(project)
    const result = await runGitAction(project, 'push', status.headOid)
    expect(result).toMatchObject({ ok: false, error: 'rejected' })
  })

  it('upstream の無いブランチは確認だけ。取り込みは理由を返す', async () => {
    const { runGitAction } = await sync()
    const { project } = setup()
    git(project, 'switch', '--quiet', '-c', 'feature/local')
    expect(await runGitAction(project, 'fetch', null)).toMatchObject({ ok: true, error: null })
    expect(await runGitAction(project, 'pull', null)).toMatchObject({ ok: false, error: 'noUpstream' })
  })

  it('fetch の失敗は投げずに状態へ残す', async () => {
    await withConsentStore()
    const { autoFetch, decideAutoFetch } = await sync()
    const { project } = setup()
    git(project, 'remote', 'set-url', 'origin', UNREACHABLE)
    await decideAutoFetch(project, true)
    const status = await autoFetch(project, 'open', true)
    expect(status?.fetch.lastError).not.toBeNull()
    expect(status?.fetch.fetching).toBe(false)
    expect(status?.fetch.lastFetchAt).toBeNull()
  })
})
