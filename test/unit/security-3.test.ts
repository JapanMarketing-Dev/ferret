import { generateKeyPairSync, createPublicKey } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_CATALOG,
  BUILTIN_AGENTS,
  DEFAULT_AGENT_PREFERENCES,
  SKIP_PERMISSION_AGENTS,
  sanitizeAgentPreferences
} from '../../src/shared/agentCatalog'
import { resolveAgentLaunchPolicy } from '../../src/shared/agentPolicy'
import { applyAgentWorkspaceTrust, registeredProjectIdFor } from '../../src/main/agentWorkspaceTrust'
import { isRemoteImageSource, previewCsp, renderPreviewPage } from '../../src/main/preview/render'
import { renderPreviewBody } from '../../src/main/preview/markdown'
import { scrubBreadcrumb, scrubEvent, scrubString } from '../../src/shared/telemetry'
import {
  RELEASE_PUBLIC_KEY,
  RELEASE_SIGNER_IDENTITY,
  RELEASE_SIGNING_NAMESPACE,
  verifiedReleaseFiles,
  verifySshSignature
} from '../../src/main/releaseSignature'
import {
  SIGNER_IDENTITY,
  SIGNING_NAMESPACE,
  signSshsig,
  sshPublicKeyLine,
  trustedPublicKey,
  verifySshsig
} from '../../scripts/release-signing.mjs'
import { setReporter } from '../../src/shared/report'

vi.mock('electron', () => ({ app: { getVersion: () => '0.0.1' }, net: { fetch: vi.fn() } }))

/**
 * Codex のセキュリティスキャン3回目（security-3 [1]〜[7]）の回帰テストと、同じ種類の問題を機械的に止める不変条件。
 * [3][4][7]（feedback-relay）は test/unit/feedback-relay.test.ts の「security-3」の describe にある（偽の env を共有するため）。
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

// ───────────────────────── [1] ─────────────────────────

/**
 * security-3 [1] は、利用者の判断（2026-10-04）で既定を「権限確認を省いて起動する」に変えた。
 * 決まりは SECURITY.md の Agent permissions。ここでは、その既定・設定で切れること・利用者の引数を消さないことを確かめる
 */
describe('security-3 [1] Agent の権限確認は設定の skipPermissions で決まる（既定は省く）', () => {
  it('security-3 [1] 既定は権限確認を省く。既定の引数には省く引数を入れず、起動のときに足す', () => {
    expect(DEFAULT_AGENT_PREFERENCES.skipPermissions).toBe(true)
    for (const agent of BUILTIN_AGENTS) {
      if (AGENT_CATALOG[agent].yoloArgs) expect(DEFAULT_AGENT_PREFERENCES.launch[agent].args, agent).not.toContain(AGENT_CATALOG[agent].yoloArgs)
    }
    expect(SKIP_PERMISSION_AGENTS).toEqual(['claude', 'codex'])
  })

  it('security-3 [1] 保存された引数は書いたまま読む（--dangerously-* や --chrome を外さない）', () => {
    const prefs = sanitizeAgentPreferences({
      skipPermissions: false,
      launch: {
        claude: { command: 'claude', args: '--dangerously-skip-permissions --model opus' },
        codex: { command: 'codex', args: '--dangerously-bypass-approvals-and-sandbox' },
        gemini: { command: 'gemini', args: '--approval-mode=yolo' }
      }
    })
    expect(prefs.skipPermissions).toBe(false)
    expect(prefs.launch.claude.args).toBe('--dangerously-skip-permissions --model opus')
    expect(prefs.launch.codex.args).toBe('--dangerously-bypass-approvals-and-sandbox')
    expect(prefs.launch.gemini.args).toBe('--approval-mode=yolo')
    expect(sanitizeAgentPreferences({ skipPermissions: true, launch: { claude: { command: 'claude', args: '' } } }).launch.claude.args).toBe('')
  })

  it('security-3 [1] skipPermissions の無い以前の設定は既定（入）になり、以前の既定の空の引数は今の既定（--chrome）になる', () => {
    const old = sanitizeAgentPreferences({ launch: { claude: { command: 'claude', args: '' }, codex: { command: 'codex', args: '' } }, bypassProjects: ['p1'] })
    expect(old.skipPermissions).toBe(true)
    expect(old.launch.claude.args).toBe('--chrome')
    expect(old.launch.codex.args).toBe('')
    expect('bypassProjects' in old).toBe(false)
    // 利用者が変えた引数・コマンドはそのまま
    const custom = sanitizeAgentPreferences({ launch: { claude: { command: 'claude', args: '--model opus' }, codex: { command: '/opt/codex', args: '' } } })
    expect(custom.launch.claude.args).toBe('--model opus')
    expect(custom.launch.codex).toEqual({ command: '/opt/codex', args: '' })
    expect(sanitizeAgentPreferences({ skipPermissions: 'yes' }).skipPermissions).toBe(true)
  })

  // 決まりは設定を一度だけ argv に分けてから当てる（security-5 [2]）。結果は argv で返す
  const policy = (input: { agent: 'claude' | 'codex' | 'gemini'; args: string; projectId: string | null; skipPermissions: boolean }) =>
    resolveAgentLaunchPolicy({ ...input, command: '', shell: 'posix' })
  const argv = (input: Parameters<typeof policy>[0]) => {
    const result = policy(input)
    return result.ok ? result.argv.slice(1).join(' ') : `refused:${result.reason}`
  }

  it('security-3 [1] main の起動の決まり: 入なら Claude Code / Codex に省く引数を前に足し、登録したプロジェクトのフォルダだけ信頼を書く', () => {
    const on = { skipPermissions: true, projectId: 'p1' }
    expect(policy({ ...on, agent: 'claude', args: '--chrome' })).toEqual({ ok: true, argv: ['claude', '--dangerously-skip-permissions', '--chrome'], trustFolder: true })
    expect(policy({ ...on, agent: 'codex', args: '' })).toEqual({ ok: true, argv: ['codex', '--dangerously-bypass-approvals-and-sandbox'], trustFolder: true })
    // サブフォルダ・ホーム（登録したプロジェクトのフォルダそのものでない）では引数だけ足し、信頼は書かない
    expect(policy({ ...on, projectId: null, agent: 'claude', args: '' })).toEqual({ ok: true, argv: ['claude', '--dangerously-skip-permissions'], trustFolder: false })
    // 確かめていない Agent には足さない
    expect(policy({ ...on, agent: 'gemini', args: '' })).toEqual({ ok: true, argv: ['gemini'], trustFolder: false })
  })

  it('security-3 [1] 切なら何も足さず信頼も書かない。利用者が書いた引数はどちらでもそのまま', () => {
    const off = { skipPermissions: false, projectId: 'p1' }
    expect(policy({ ...off, agent: 'claude', args: '--chrome' })).toEqual({ ok: true, argv: ['claude', '--chrome'], trustFolder: false })
    expect(policy({ ...off, agent: 'codex', args: '' })).toEqual({ ok: true, argv: ['codex'], trustFolder: false })
    const typed = policy({ ...off, agent: 'claude', args: '--dangerously-skip-permissions --add-dir "a  b"' })
    expect(typed.ok && typed.argv).toEqual(['claude', '--dangerously-skip-permissions', '--add-dir', 'a  b'])
  })

  it('security-3 [1] 引数で確認の仕方を選んでいれば、省く引数を二重に足さない・混ぜない', () => {
    const on = { skipPermissions: true, projectId: null }
    for (const args of ['--dangerously-skip-permissions --chrome', '--permission-mode plan', '--permission-mode=acceptEdits', '--allow-dangerously-skip-permissions']) {
      expect(argv({ ...on, agent: 'claude', args }), args).toBe(args)
    }
    for (const args of ['--yolo --model o4', '-s workspace-write', '--sandbox=read-only', '-a on-request', '--full-auto', '-c approval_policy=never']) {
      expect(argv({ ...on, agent: 'codex', args }), args).toBe(args)
    }
    // 似ているが別の引数には足す
    expect(argv({ ...on, agent: 'codex', args: '--search' })).toBe('--dangerously-bypass-approvals-and-sandbox --search')
  })

  it('security-3 [1] プロジェクトの id はフォルダそのものでだけ決まる（サブフォルダ・ほかのプロジェクトに許可を引き継がない）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferret-sec3-'))
    try {
      mkdirSync(join(dir, 'acme-shop', 'sub'), { recursive: true })
      mkdirSync(join(dir, 'other'))
      const projects = [{ id: 'p1', folderPath: join(dir, 'acme-shop') }, { id: 'p2', folderPath: join(dir, 'other') }]
      expect(registeredProjectIdFor(join(dir, 'acme-shop'), projects)).toBe('p1')
      expect(registeredProjectIdFor(join(dir, 'acme-shop', 'sub'), projects)).toBeNull()
      expect(registeredProjectIdFor(dir, projects)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('security-3 [1] 登録したプロジェクトのフォルダでなければ、Claude Code / Codex の信頼の設定ファイルを変えない', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ferret-sec3-'))
    try {
      const home = join(dir, 'home')
      const project = join(dir, 'acme-shop')
      mkdirSync(home)
      mkdirSync(project)
      writeFileSync(join(home, '.claude.json'), '{"projects":{}}\n')
      // main は登録したプロジェクトのフォルダを渡す（terminal.ts）。そのフォルダでなければ書かない
      expect(await applyAgentWorkspaceTrust({ agent: 'claude', cwd: project, projectFolders: [], env: {}, homeDir: home })).toBe('skipped')
      expect(await applyAgentWorkspaceTrust({ agent: 'codex', cwd: project, projectFolders: [], env: {}, homeDir: home })).toBe('skipped')
      expect(readFileSync(join(home, '.claude.json'), 'utf8')).toBe('{"projects":{}}\n')
      expect(readdirSync(home)).toEqual(['.claude.json'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('security-3 [1] 不変条件: 権限確認を省くフラグを書いてよいのはカタログだけ。起動は main の決まりを通し、信頼は skipPermissions のときだけ書く', () => {
    const flags = ['--dangerously-skip-permissions', '--dangerously-bypass-approvals-and-sandbox', 'danger-full-access']
    // コメントは除いて見る（説明に名前を書くのはよい）
    const code = (f: string) => read(f).split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
    const offenders = walk('src', /\.(ts|tsx)$/).filter((f) => f !== 'src/shared/agentCatalog.ts' && !f.startsWith('src/shared/i18n/'))
      .filter((f) => flags.some((flag) => code(f).includes(flag)))
    expect(offenders).toEqual([])
    const terminal = read('src/main/terminal.ts')
    expect(terminal).toMatch(/resolveAgentLaunchPolicy\(/)
    expect(terminal).toMatch(/trustFolder = policy\.trustFolder/)
    expect(terminal).toMatch(/if \(trustFolder\) \{\s*await applyAgentWorkspaceTrust\(/)
    expect(terminal.match(/applyAgentWorkspaceTrust\(/g)).toHaveLength(1)
    // 自動起動も手で開くのも同じ決まり（skipPermissions だけを見る）。resume は会話を続ける引数だけで、権限には関わらない
    expect(terminal).toMatch(/resolveAgentLaunchPolicy\(\{ agent, command: configured\.command, args: configured\.args, projectId, skipPermissions: prefs\.skipPermissions, shell: startupShell(?:, resume)? \}\)/)
  })
})

// ───────────────────────── [2] ─────────────────────────

describe('security-3 [2] 配布物の真正性を、R2 とは別の鍵の署名で確かめる', () => {
  const tempKey = () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    return { pem: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), line: sshPublicKeyLine(publicKey) }
  }
  const sums = Buffer.from(`${'a'.repeat(64)}  Ferret-9.9.9-mac-arm64.dmg\n${'b'.repeat(64)}  Ferret-9.9.9-win-x64.exe\n`)

  it('security-3 [2] リリースの道具で署名したものを、アプリが同梱の形で確かめられる。書き換え・別の鍵・別の用途は通さない', () => {
    const key = tempKey()
    const sig = signSshsig(sums, key.pem)
    expect(verifySshSignature(sums, sig, key.line)).toBe(true)
    expect(verifySshsig(sums, sig, key.line)).toBe(true)
    expect(verifySshSignature(Buffer.from(sums.toString().replace('a', 'c')), sig, key.line)).toBe(false)
    expect(verifySshSignature(sums, sig, tempKey().line)).toBe(false)
    expect(verifySshSignature(sums, signSshsig(sums, key.pem, 'file'), key.line)).toBe(false)
    expect(verifySshSignature(sums, 'garbage', key.line)).toBe(false)
    // 同梱の公開鍵では、ほかの鍵の署名は通らない
    expect(verifySshSignature(sums, sig)).toBe(false)
  })

  it('security-3 [2] latest.json のファイルが、署名の合う SHA256SUMS に同じ値で載っているときだけ案内する', () => {
    const key = tempKey()
    const sig = signSshsig(sums, key.pem)
    // security-4 [3] から、manifest のファイルは SHA256SUMS と過不足なく一致しなければならない
    const files = [
      { name: 'Ferret-9.9.9-mac-arm64.dmg', sha256: 'a'.repeat(64), path: 'releases/9.9.9/Ferret-9.9.9-mac-arm64.dmg', size: 1 },
      { name: 'Ferret-9.9.9-win-x64.exe', sha256: 'b'.repeat(64), path: 'releases/9.9.9/Ferret-9.9.9-win-x64.exe', size: 1 }
    ]
    expect(verifiedReleaseFiles('9.9.9', files, sums, sig, key.line)).toHaveLength(2)
    expect(verifiedReleaseFiles('9.9.9', [{ ...files[0]!, sha256: 'd'.repeat(64) }, files[1]!], sums, sig, key.line)).toBeNull()
    expect(verifiedReleaseFiles('9.9.9', [{ ...files[0]!, name: 'Ferret-9.9.9-linux-x86_64.AppImage' }, files[1]!], sums, sig, key.line)).toBeNull()
    expect(verifiedReleaseFiles('9.9.9', [], sums, sig, key.line)).toBeNull()
  })

  it('security-3 [2] 署名の無い新しい版は、更新の確認で案内しない（R2 だけを書き換えても偽の版へ誘わない）', async () => {
    setReporter({ handled: vi.fn(), message: vi.fn(), breadcrumb: vi.fn() })
    try {
      const { checkForUpdate } = await import('../../src/main/updateCheck')
      const fetcher = (async (url: string) => {
        if (url.endsWith('latest.json')) {
          return Response.json({ schema: 1, version: '99.0.0', date: '', prerelease: false, notes: '',
            files: [{ name: 'Ferret-99.0.0-mac-arm64.dmg', path: 'releases/99.0.0/Ferret-99.0.0-mac-arm64.dmg', size: 1, sha256: 'a'.repeat(64), os: 'mac', arch: 'arm64', kind: 'dmg' }] })
        }
        if (url.endsWith('/SHA256SUMS')) return new Response(`${'a'.repeat(64)}  Ferret-99.0.0-mac-arm64.dmg\n`)
        if (url.endsWith('/SHA256SUMS.sig')) return new Response(signSshsig(Buffer.from(`${'a'.repeat(64)}  Ferret-99.0.0-mac-arm64.dmg\n`), tempKey().pem))
        return new Response('nope', { status: 404 })
      }) as unknown as typeof fetch
      // 署名が合わない・無いのは恒久的（unverified）。配信元の一時的な不調（5xx）・ネットワークの失敗は「あとで試す」（error）と分ける
      expect(await checkForUpdate(fetcher)).toEqual({ state: 'unverified', current: expect.any(String), latest: '99.0.0' })
      const missing = (async (url: string) => url.endsWith('latest.json') ? fetcher(url) : new Response('', { status: 404 })) as unknown as typeof fetch
      expect((await checkForUpdate(missing)).state).toBe('unverified')
      const down = (async (url: string) => url.endsWith('latest.json') ? fetcher(url) : new Response('', { status: 503 })) as unknown as typeof fetch
      expect((await checkForUpdate(down)).state).toBe('error')
      const offline = (async (url: string) => { if (url.endsWith('latest.json')) return fetcher(url); throw new Error('net::ERR_INTERNET_DISCONNECTED') }) as unknown as typeof fetch
      expect((await checkForUpdate(offline)).state).toBe('error')
    } finally {
      setReporter(null)
    }
  })

  it('security-3 [2] 不変条件: 公開鍵は R2 の外（リポジトリ・アプリ・SECURITY.md・ドキュメント）で同じ。署名者・用途も同じ', () => {
    const allowed = read('build/release-signing/allowed_signers')
    expect(trustedPublicKey(allowed)).toBe(RELEASE_PUBLIC_KEY)
    expect(read('SECURITY.md')).toContain(RELEASE_PUBLIC_KEY)
    expect(read('site/docs/advanced-install.html')).toContain(RELEASE_PUBLIC_KEY)
    expect(SIGNER_IDENTITY).toBe(RELEASE_SIGNER_IDENTITY)
    expect(SIGNING_NAMESPACE).toBe(RELEASE_SIGNING_NAMESPACE)
    // 公開鍵として読めること
    expect(() => createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(RELEASE_PUBLIC_KEY.split(' ')[1]!, 'base64').subarray(-32).toString('base64url') }, format: 'jwk' })).not.toThrow()
    // 秘密鍵をリポジトリに置かない
    for (const f of [...walk('build', /./), ...walk('scripts', /./), ...walk('src', /./)]) expect(read(f), f).not.toMatch(/BEGIN PRIVATE KEY|BEGIN OPENSSH PRIVATE KEY/)
  })

  it('security-3 [2] 不変条件: 署名の鍵は CI に置かず（security-7 [3]）、stage / promote は署名を確かめ、promote は署名が無ければ止める', () => {
    const wf = read('.github/workflows/release.yml')
    expect(wf).not.toMatch(/secrets\.RELEASE_SIGNING_KEY|secrets\.CLOUDFLARE_/)
    const r2 = read('scripts/release-r2.mjs')
    expect(r2).toMatch(/checkExpectedSums\(manifest, args, true\)/)
    expect(r2).toMatch(/assertSignedSums\(/)
    expect(read('scripts/release-github.mjs')).toMatch(/assertSignedSums\(/)
    // サイトの手順は、署名した SHA256SUMS を R2 の外の公開鍵で確かめる形
    const install = read('site/docs/advanced-install.html')
    expect(install).toContain('ssh-keygen -Y verify -f allowed_signers -I release@ferretade.dev -n ferret-release -s SHA256SUMS.sig')
    expect(install).not.toContain('There is no <code>SHA256SUMS</code> file')
  })
})

// ───────────────────────── [5] ─────────────────────────

describe('security-3 [5] プロジェクトの Markdown のプレビューで、外の画像を黙って読みに行かない', () => {
  it('security-3 [5] 外の画像は <img> にせず、行き先のホストを見せる印にする。プロジェクトの中の画像と data: はそのまま', () => {
    const html = renderPreviewBody('markdown', '![badge](https://tracker.example/p.png?u=1)\n\n![logo](docs/logo.png)\n\n![x](//cdn.example/a.png)\n\n![d](data:image/png;base64,AAAA)\n')
    expect(html).not.toMatch(/<img[^>]+src="(https?:)?\/\//)
    expect(html).toContain('class="remote-image"')
    expect(html).toContain('data-remote-host="tracker.example"')
    expect(html).toContain('data-remote-host="cdn.example"')
    expect(html).toMatch(/<img[^>]+src="docs\/logo\.png"/)
    expect(html).toMatch(/<img[^>]+src="data:image\/png/)
    // 参照形式・リンクの中の画像（README のバッジ）も同じ
    const ref = renderPreviewBody('markdown', '[![ci][b]](https://ci.example/)\n\n[b]: https://badge.example/ci.svg\n')
    expect(ref).not.toContain('<img')
    expect(ref).toContain('data-remote-host="badge.example"')
    expect(isRemoteImageSource('HTTP://x/y.png')).toBe(true)
    expect(isRemoteImageSource('ade-preview://project/a.png')).toBe(false)
    expect(isRemoteImageSource('a.png')).toBe(false)
  })

  it('security-3 [5] CSP は既定で外の画像を許さない。利用者が押したページだけ https を許す', () => {
    expect(previewCsp()).toMatch(/img-src ade-preview: data:(;|$)/)
    expect(previewCsp()).not.toMatch(/https:/)
    expect(previewCsp(true)).toMatch(/img-src ade-preview: data: https:/)
    expect(renderPreviewPage({ path: 'README.md', kind: 'markdown', body: '' })).toContain('data-remote-images="block"')
    expect(renderPreviewPage({ path: 'README.md', kind: 'markdown', body: '', remoteImages: true })).toContain('data-remote-images="allow"')
  })

  it('security-3 [5] 不変条件: プレビューの CSP を作るのは previewCsp だけで、既定で https を許す書き方が無い', () => {
    const index = read('src/main/preview/index.ts')
    expect(index).not.toMatch(/img-src[^\n]*https:/)
    expect(index).toMatch(/previewCsp\(remoteImages\)/)
    expect(read('src/main/preview/render.ts')).toMatch(/img-src \$\{PREVIEW_SCHEME\}: data:\$\{remoteImages \? ' https:' : ''\}/)
  })
})

// ───────────────────────── [6] ─────────────────────────

describe('security-3 [6] Sentry へ送る前に、素の IP アドレスを落とす', () => {
  const ips = ['203.0.113.9', '10.0.0.1', '127.0.0.1', '::1', 'fe80::1%en0', '2001:db8::8a2e:370:7334', '2001:0db8:0000:0000:0000:ff00:0042:8329', '::ffff:192.0.2.1']

  it.each(ips)('security-3 [6] %s は、ポート付き・括弧付きでも残らない', (ip) => {
    for (const text of [`connect ECONNREFUSED ${ip}:443`, `from ${ip}.`, `[${ip}]:8080`, `host=${ip}`]) {
      const out = scrubString(text)
      expect(out, text).not.toContain(ip)
      expect(out, text).toContain('<ip>')
    }
  })

  it('security-3 [6] IP でないもの（版・時刻・C++ の名前・スタックの行と列）は変えない', () => {
    for (const text of ['Electron 33.2.1', 'Chrome 130.0.6723.191', '12:34:56', 'Foo::add', 'std::vector', 'at app.js:12:34', 'a :: b', '1.2.3.4.5']) {
      expect(scrubString(text)).toBe(text)
    }
  })

  it('security-3 [6] 例外・breadcrumb・コンポーネントの階層・contexts のどこに入っていても落とす', () => {
    const ip = '198.51.100.23'
    const v6 = '2001:db8::1'
    const event = scrubEvent({
      exception: { values: [{ type: 'Error', value: `getaddrinfo ${ip} ${v6}`, stacktrace: { frames: [{ filename: 'app:///main.js', function: 'f' }] } }] },
      message: `failed ${ip}`,
      breadcrumbs: [{ category: 'startup', message: `listen ${v6}` }],
      contexts: { react: { componentStack: `in Foo (${ip})` }, os: { name: 'macOS', version: '15.6' } }
    })
    const text = JSON.stringify(event)
    expect(text).not.toContain(ip)
    expect(text).not.toContain(v6)
    expect(scrubBreadcrumb({ category: 'startup', message: `bind ${ip}` })?.message).toBe('bind <ip>')
  })

  it('security-3 [6] 不変条件: SECURITY.md が「送らない」と約束した種類ごとに、落とす見本がある', () => {
    // SECURITY.md の Crash reports の「… are removed or not collected」の並びを読み、種類ごとの見本で確かめる
    const policy = /Reports contain[^.]*\.\s*([^.]*?) are removed or not collected/.exec(read('SECURITY.md'))?.[1]
    expect(policy).toBeTruthy()
    // 「A, B, … Y and Z」。最後の項目だけ and で分ける（「Home and project paths」は1つの種類）
    const items = policy!.split(/,\s*/)
    const classes = [...items.slice(0, -1), ...items[items.length - 1]!.split(/\s+and\s+/)].map((s) => s.trim().toLowerCase()).filter(Boolean)
    const fake = ['s', 'k-', 'abcdefghijklmnop0123456789'].join('')
    const samples: Record<string, string[]> = {
      'home and project paths': ['/Users/taro/acme-shop/src/a.ts', 'C:\\Users\\taro\\acme-shop'],
      urls: ['https://acme-shop.example/admin?token=1'],
      'terminal output': [],
      transcripts: [],
      findings: [],
      'email addresses': ['alice@example.com'],
      'api keys': [fake],
      'ip addresses': ['203.0.113.9', '2001:db8::1']
    }
    for (const c of classes) {
      expect(Object.keys(samples), `SECURITY.md の「${c}」に見本が無い（ここに足す）`).toContain(c)
      for (const sample of samples[c]!) expect(scrubString(`boom ${sample} end`), `${c}: ${sample}`).not.toContain(sample)
    }
  })
})

// ───────────────────────── 再発防止（ドキュメント） ─────────────────────────

describe('security-3 再発防止: 方針を SECURITY.md に書き、テストで固定する', () => {
  it('security-3 SECURITY.md に、今回の種類の問題を作らないための決まりがある', () => {
    const md = read('SECURITY.md')
    for (const phrase of ['Agent permissions', 'Release authenticity', 'Project-driven network requests', 'Public endpoints']) expect(md).toContain(phrase)
    expect(relative(root, join(root, 'test/unit/security-3.test.ts')).split(sep).join('/')).toBe('test/unit/security-3.test.ts')
  })
})

afterEach(() => vi.restoreAllMocks())
