import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.1' }, net: { fetch: vi.fn() } }))

/**
 * Codex のセキュリティスキャン4回目（security-4 [1]〜[12]）で直した種類を、機械的に止める不変条件。
 * 件ごとの回帰テストは次にある:
 *   [1] agent-executable.test.ts  [2] site-verify.test.ts  [3][7] release-envelope.test.ts
 *   [4][8][11][12] feedback-relay.test.ts  [5][9] contained-file.test.ts
 *   [6] preview-remote-grant.test.ts  [10] review-history-limits.test.ts
 * ここは「同じ種類のコードを新しく書いたときにも落ちる」ことを狙う（ソースの形と、境界の関数のふるまい）。
 */

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(join(root, p), 'utf8')

function walk(dir: string, exts: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(join(root, dir))) {
    if (name === 'node_modules') continue
    const p = `${dir}/${name}`
    if (statSync(join(root, p)).isDirectory()) walk(p, exts, out)
    else if (exts.test(name)) out.push(p)
  }
  return out
}

// ───────────────────────── [1] 実行ファイルの解決 ─────────────────────────

describe('security-4 [1] built-in agents never resolve from the project folder', () => {
  it('every built-in launch and account login goes through resolveTrustedExecutable; logins run outside the project', () => {
    const terminal = read('src/main/terminal.ts')
    expect(terminal).toMatch(/deliver\(await trusted\(login\.argv/)
    expect(terminal).toMatch(/launchLine = await trusted\(\[\.\.\.policy\.argv/)
    expect(terminal).toMatch(/resolveTrustedExecutable\(argv\[0\]/)
    expect(terminal).toMatch(/const cwd = options\.accountLogin \? homedir\(\)/)
    // PTY の環境には、cmd.exe に今のフォルダを探させない印が必ず入る
    expect(terminal).toMatch(/\.\.\.windowsSearchPathEnv\(\)/)
  })
})

// ───────────────────────── [2][3][7] 配布物 ─────────────────────────

describe('security-4 [2][3][7] downloads are bound to the signed SHA256SUMS', () => {
  it('the app, the site and the repository trust the same release key', async () => {
    const { RELEASE_PUBLIC_KEY } = await import('../../src/main/releaseSignature')
    const { RELEASE_PUBLIC_KEY: SITE_KEY } = await import('../../site/js/verify.js')
    expect(SITE_KEY).toBe(RELEASE_PUBLIC_KEY)
    expect(read('build/release-signing/allowed_signers')).toContain(RELEASE_PUBLIC_KEY)
  })

  it('the update check derives identity from signed names and never offers membership-only checks', () => {
    const update = read('src/main/updateCheck.ts')
    expect(update).toMatch(/verifiedReleaseFiles\(latest, manifest\.files/)
    expect(update).toMatch(/verified = pickVerifiedDownload\(result\.latest, signed\)/)
    expect(read('src/main/releaseSignature.ts')).not.toMatch(/export function releaseFilesAreSigned/)
  })

  it('the app downloads the verified file itself instead of reopening a page that refetches R2', () => {
    const main = read('src/main/index.ts')
    const start = main.indexOf("'app:openUpdate': async")
    const handler = main.slice(start, start + 1500)
    expect(handler).toMatch(/verifiedDownload\(\)/)
    expect(handler).toMatch(/downloadVerifiedUpdate\(file/)
  })

  it('no site script assigns an installer URL to a link', () => {
    for (const file of walk('site/js', /\.js$/)) {
      expect(read(file), file).not.toMatch(/\.href\s*=\s*(?:asset|file|f)\.url|href:\s*(?:asset|file|f)\.url/)
    }
  })
})

// ───────────────────────── [5][9] プロジェクトのファイル ─────────────────────────

describe('security-4 [5][9] project file I/O is bound to the opened file and bounded', () => {
  /**
   * resolveInside で確かめたパスを開き直す main のモジュールは、開いたものを containedFile.ts で確かめる。
   * 開かないもの（OS に渡すだけ・名前を変えるだけ）はここに理由とともに足す
   */
  const PATH_ONLY: Record<string, string> = {
    'src/main/index.ts': 'fs:reveal / fs:openExternal は OS にパスを渡すだけ（読み書きしない）',
    'src/main/fileOps.ts': '作成・名前の変更・ゴミ箱。作成は O_EXCL、移す前に assertStillInside を使う',
    'src/main/files.ts': 'resolveInside の定義元。読み書きは containedFile.ts を使う（下で確かめる）'
  }
  it('every module that reads or writes a resolveInside path uses containedFile.ts', () => {
    for (const file of walk('src/main', /\.ts$/)) {
      const src = read(file)
      if (!/\bresolveInside\(/.test(src) || file === 'src/main/containedFile.ts') continue
      if (PATH_ONLY[file]) continue
      expect(src, `${file}: resolveInside の結果を開くなら containedFile.ts の openContained / assertHandleInside を使う`).toMatch(/from '\.\.?\/(?:\.\.\/)?containedFile'/)
    }
    const files = read('src/main/files.ts')
    expect(files).toMatch(/openContained\(root, file, 'write'\)/)
    expect(files).toMatch(/afterOpen: \(handle\) => assertHandleInside\(handle, root, file\)/)
    // 確かめる前に中身を消す O_TRUNC で開かない
    expect(files).not.toMatch(/O_TRUNC/)
  })

  it('directory listings are capped and iterate instead of reading every entry', async () => {
    const { MAX_DIRECTORY_ENTRIES } = await import('../../src/main/files')
    expect(Number.isFinite(MAX_DIRECTORY_ENTRIES)).toBe(true)
    const files = read('src/main/files.ts')
    const list = files.slice(files.indexOf('export async function listDirectory'), files.indexOf('// ─── 読み書き'))
    // 読むのは dirEntries.ts の readDirEntries だけ（上限で切る）。macOS・Linux は opendir で少しずつ読む。
    // Windows は opendir の DirHandle の生成でアプリごと落ちたので readdir で読み、返す数は同じ上限で切る（FERRET-1Q）
    // 上限は既定で MAX_DIRECTORY_ENTRIES（引数はテストが小さくするためだけ。IPC の fs:list は渡さない）
    expect(list).toMatch(/limit = MAX_DIRECTORY_ENTRIES\): Promise<FsEntry\[\]>/)
    expect(list).toMatch(/readDirEntries\(listed\.path, limit\)/)
    // SSH のプロジェクトはリモートの一覧（remoteFiles.ts の上限）。手元は上限を渡さずに読む
    expect(read('src/main/index.ts')).toMatch(/'fs:list': async \(relDir\) => \{[^}]*listRemoteDirectory\(remote, relDir\) : listDirectory\(projectRoot\(\), relDir\)\n/)
    expect(list).not.toMatch(/readdir\(|opendir\(/)
    const dirEntries = read('src/main/dirEntries.ts')
    expect(dirEntries).toMatch(/if \(platform === 'win32'\) \{\n\s+const all = await readdir\(path, \{ withFileTypes: true \}\)\n\s+return \{ entries: all\.slice\(0, max\)/)
    expect(dirEntries).toMatch(/const dir = await opendir\(path\)/)
  })
})

// ───────────────────────── [6] 同意 ─────────────────────────

describe('security-4 [6] consent is never URL state', () => {
  it('remote images need a grant that only the page button can obtain, and saved URLs never keep it', async () => {
    const preview = read('src/main/preview/index.ts')
    expect(preview).toMatch(/consumeRemoteImagesGrant\(/)
    expect(preview).not.toMatch(/searchParams\.get\(REMOTE_IMAGES_PARAM\) === '1'/)
    const { isRemoteImagesGrantRequest, REMOTE_IMAGES_GRANT_HEADER, REMOTE_IMAGES_GRANT_VALUE } = await import('../../src/main/preview/remoteGrant')
    const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null })
    expect(isRemoteImagesGrantRequest('GET', headers({ [REMOTE_IMAGES_GRANT_HEADER]: REMOTE_IMAGES_GRANT_VALUE }))).toBe(false)
    expect(isRemoteImagesGrantRequest('POST', headers({}))).toBe(false)
    expect(isRemoteImagesGrantRequest('POST', headers({ [REMOTE_IMAGES_GRANT_HEADER]: REMOTE_IMAGES_GRANT_VALUE }))).toBe(true)
    const { sanitizeProjectSession } = await import('../../src/shared/projectSession')
    const kept = sanitizeProjectSession({ url: 'ade-preview://project/README.md?remote-images=abc' })
    expect(kept?.url ?? '').not.toMatch(/remote-images/)
  })
})

// ───────────────────────── [10] 自動の一覧 ─────────────────────────

describe('security-4 [10] automatic listings are bounded in total', () => {
  it('review history has finite count, byte and time budgets; onboarding does not list full histories', async () => {
    const { HISTORY_LIMITS } = await import('../../src/main/sessions/limits')
    for (const [name, value] of Object.entries(HISTORY_LIMITS)) expect(Number.isFinite(value), name).toBe(true)
    expect(read('src/renderer/onboarding/useSetupChecklist.ts')).not.toMatch(/'review:list'/)
  })
})

// ───────────────────────── [4][8][11][12] 公開の中継 ─────────────────────────

describe('security-4 [4][8][11][12] the public feedback relay', () => {
  const relay = read('workers/feedback-relay/src/index.ts')

  it('checks the shared pre-parse budget before any per-source state or body read', () => {
    // security-5 [10] からは、見るだけ（peek）ではなく予約（hit）を先に取る
    const peek = relay.indexOf("askLimiter(env, 'preparse', 'hit'")
    expect(peek).toBeGreaterThan(0)
    expect(peek).toBeLessThan(relay.indexOf("'attempt'"))
    expect(peek).toBeLessThan(relay.indexOf('await readCapped(request'))
  })

  it('takes the global issue quota only after the duplicate claim', () => {
    const dup = relay.indexOf("'dup'")
    const global = relay.indexOf("name: 'global'")
    expect(dup).toBeGreaterThan(0)
    expect(global).toBeGreaterThan(dup)
  })

  it('groups IPv6 sources by /64 and keeps the pre-parse budget finite', async () => {
    const { sourceIdentity } = await import('../../workers/feedback-relay/src/limiter')
    const { PREPARSE_LIMITS } = await import('../../workers/feedback-relay/src/limits')
    expect(sourceIdentity('2001:db8:1:2::1')).toBe(sourceIdentity('2001:db8:1:2:ffff::9'))
    expect(sourceIdentity('2001:db8:1:2::1')).not.toBe(sourceIdentity('2001:db8:1:3::1'))
    for (const w of PREPARSE_LIMITS) expect(Number.isFinite(w.max)).toBe(true)
  })

  it('posts user text with no live GitHub reference outside a literal block', async () => {
    const { buildIssue } = await import('../../workers/feedback-relay/src/github')
    const body = 'see octo/repo#1, GH-2, https://github.com/o/r/issues/3, https://github.com/o/r/pull/4, [x](https://github.com/o/r/issues/5), @someone and #6'
    const issue = buildIssue({ kind: 'bug', title: 'octo/repo#9 @x', body, appVersion: '1.0.0', imageUrls: [] })
    // コードブロックの外側だけを見る
    const outside = issue.body.replace(/(`{3,})[^\n]*\n[\s\S]*?\n\1/g, '')
    for (const live of [/\b[\w.-]+\/[\w.-]+#\d/, /\bGH-\d/, /github\.com\/[^\s)]+\/(?:issues|pull)\/\d/, /(?:^|\s)@\w/, /(?:^|\s)#\d/]) {
      expect(outside).not.toMatch(live)
      expect(issue.title).not.toMatch(live)
    }
  })

  it('an unknown GitHub outcome is neither retried nor re-routed by the app', async () => {
    const { RETRYABLE_CODES } = await import('../../src/shared/feedbackRelay')
    const { shouldFallBackToBrowser } = await import('../../src/main/feedbackRelay')
    expect(RETRYABLE_CODES).not.toContain('upstream_pending')
    expect(shouldFallBackToBrowser('upstream_pending' as never)).toBe(false)
    const { createIssue } = await import('../../workers/feedback-relay/src/github')
    const issue = { title: 't', body: 'b', labels: [] }
    const throwing = (async () => { throw new Error('reset') }) as unknown as typeof fetch
    const broken201 = (async () => new Response('{not json', { status: 201 })) as unknown as typeof fetch
    const gateway = (async () => new Response('', { status: 502 })) as unknown as typeof fetch
    for (const f of [throwing, broken201, gateway]) expect(await createIssue(f, ['t', 'k'].join(''), 'o/r', issue)).toEqual({ status: 'unknown' })
  })
})
