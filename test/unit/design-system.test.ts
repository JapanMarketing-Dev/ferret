/**
 * デザインシステムのタブ（Storybook の埋め込み）と skill「ferret-design-system」。
 * src/shared/designSystem.ts・src/main/designSystem.ts・src/shared/designSystemSkill.ts・src/main/designSystemSkill.ts
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_STORYBOOK_PORT,
  designSystemRequest,
  isLocalStorybookUrl,
  packageManagerFor,
  parseDesignSystemConfig,
  resolveDesignSystem,
  storybookPort,
  storybookScript,
  storybookStartCommand
} from '../../src/shared/designSystem'
import { designSystemStatus, isCertificateError, probeLocalUrl } from '../../src/main/designSystem'
import { DESIGN_SYSTEM_SKILL_NAME, isDesignSystemSkill, renderDesignSystemSkill } from '../../src/shared/designSystemSkill'
import { syncDesignSystemSkill } from '../../src/main/designSystemSkill'
import { renderFeedbackSkill } from '../../src/shared/feedbackSkill'
import { renderVisualReviewSkill } from '../../src/shared/visualReviewSkill'
import { decodeCenterTab } from '../../src/shared/projectSession'

describe('手元の Storybook の URL だけを開く', () => {
  it('localhost・127.0.0.1・[::1] の http/https は通す', () => {
    for (const url of ['http://localhost:6006', 'http://127.0.0.1:6007/', 'https://localhost:6006/?path=/story/x', 'http://[::1]:6006']) expect(isLocalStorybookUrl(url), url).toBe(true)
  })
  it('外のホスト・ほかのスキーム・認証情報付き・壊れた値は通さない', () => {
    for (const url of ['https://example.com', 'http://localhost.evil.com:6006', 'file:///etc/passwd', 'javascript:alert(1)', 'http://user:pw@localhost:6006', 'ade-media://x', '', 'not a url', 42, null, `http://localhost:6006/${'a'.repeat(400)}`]) {
      expect(isLocalStorybookUrl(url), String(url)).toBe(false)
    }
  })
})

describe('package.json から Storybook を探す', () => {
  it('storybook という名前の dev を優先し、ポートを読む', () => {
    expect(storybookScript({ 'sb:other': 'storybook dev -p 7000', storybook: 'storybook dev -p 6007' })).toEqual({ name: 'storybook', port: 6007 })
    expect(storybookScript({ ds: 'storybook dev --port=6100 --no-open' })).toEqual({ name: 'ds', port: 6100 })
    expect(storybookScript({ storybook: 'start-storybook' })).toEqual({ name: 'storybook', port: DEFAULT_STORYBOOK_PORT })
  })
  it('build だけ・無い・形の違うものは null', () => {
    expect(storybookScript({ 'build-storybook': 'storybook build' })).toBeNull()
    expect(storybookScript({})).toBeNull()
    expect(storybookScript(undefined)).toBeNull()
    expect(storybookScript({ storybook: 42 } as unknown as Record<string, unknown>)).toBeNull()
  })
  it('ポートの境界', () => {
    expect(storybookPort('storybook dev')).toBe(6006)
    expect(storybookPort('storybook dev -p 99999')).toBe(6006)
    expect(storybookPort('storybook dev -p 0')).toBe(6006)
    expect(storybookPort('storybook dev -p 1')).toBe(1)
    expect(storybookPort('storybook dev -p6007')).toBe(6006)
  })
})

describe('起動の1行', () => {
  it('ロックファイルからパッケージマネージャーを選ぶ', () => {
    expect(packageManagerFor(['pnpm-lock.yaml', 'package.json'])).toBe('pnpm')
    expect(packageManagerFor(['yarn.lock'])).toBe('yarn')
    expect(packageManagerFor(['bun.lockb'])).toBe('bun')
    expect(packageManagerFor(['bun.lock'])).toBe('bun')
    expect(packageManagerFor(['package-lock.json'])).toBe('npm')
    expect(packageManagerFor([])).toBe('npm')
  })
  it('ブラウザを開かない --ci を付ける（npm は -- の後ろ）', () => {
    expect(storybookStartCommand('npm', 'storybook')).toBe('npm run storybook -- --ci')
    expect(storybookStartCommand('pnpm', 'storybook')).toBe('pnpm run storybook --ci')
    expect(storybookStartCommand('yarn', 'sb:dev')).toBe('yarn sb:dev --ci')
    expect(storybookStartCommand('bun', 'storybook')).toBe('bun run storybook --ci')
  })
  it('シェルに渡せない名前は使わない', () => {
    for (const name of ['a; rm -rf ~', 'x && y', '$(id)', '', 'a b', 'x'.repeat(65)]) expect(storybookStartCommand('npm', name), name).toBeNull()
  })
})

describe('.ferret/design-system.json', () => {
  it('手元の url と1行の command だけを受け取る', () => {
    expect(parseDesignSystemConfig('{"url":"http://localhost:7001","command":" pnpm ds "}')).toEqual({ url: 'http://localhost:7001', command: 'pnpm ds' })
    expect(parseDesignSystemConfig('{"url":"https://evil.example","command":"a\\nb"}')).toEqual({})
    expect(parseDesignSystemConfig(`{"command":"${'x'.repeat(301)}"}`)).toEqual({})
    for (const text of [null, '', '{', '[]', 'null', '"x"']) expect(parseDesignSystemConfig(text)).toEqual({})
  })
})

describe('フォルダの手がかりから決める', () => {
  const pkg = (scripts: Record<string, string>) => JSON.stringify({ scripts })
  it('script があれば起動の1行と URL', () => {
    expect(resolveDesignSystem({ packageJson: pkg({ storybook: 'storybook dev -p 6010' }), hasStorybookDir: true, rootFiles: ['pnpm-lock.yaml'], config: null }))
      .toEqual({ present: true, url: 'http://localhost:6010', command: 'pnpm run storybook --ci' })
  })
  it('設定のファイルを優先する', () => {
    expect(resolveDesignSystem({ packageJson: pkg({ storybook: 'storybook dev' }), hasStorybookDir: true, rootFiles: [], config: '{"url":"http://127.0.0.1:9009","command":"make ds"}' }))
      .toEqual({ present: true, url: 'http://127.0.0.1:9009', command: 'make ds' })
  })
  it('.storybook/ だけなら present だが起動の1行は無い', () => {
    expect(resolveDesignSystem({ packageJson: null, hasStorybookDir: true, rootFiles: [], config: null })).toEqual({ present: true, url: 'http://localhost:6006' })
  })
  it('何も無ければ none・壊れた package.json でも落ちない', () => {
    expect(resolveDesignSystem({ packageJson: '{', hasStorybookDir: false, rootFiles: [], config: null })).toEqual({ present: false, url: 'http://localhost:6006' })
    expect(resolveDesignSystem({ packageJson: '{"scripts":"x"}', hasStorybookDir: false, rootFiles: [], config: null }).present).toBe(false)
  })
})

describe('動いているかを確かめる（main）', () => {
  let dir: string
  let server: Server | null = null
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-ds-')) })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
  })
  const listen = () => new Promise<number>((resolve) => {
    server = createServer((_req, res) => { res.statusCode = 404; res.end('x') })
    server.listen(0, '127.0.0.1', () => resolve((server!.address() as { port: number }).port))
  })

  it('答えれば（404 でも）動いている。外の URL は聞かない', async () => {
    const port = await listen()
    expect(await probeLocalUrl(`http://127.0.0.1:${port}`)).toBe(true)
    expect(await probeLocalUrl('https://example.com')).toBe(false)
  })
  it('手元の https の自己署名の証明書は、検証を外さずに「答えている」と見る', () => {
    for (const code of ['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED']) expect(isCertificateError({ code }), code).toBe(true)
    for (const err of [{ code: 'ECONNREFUSED' }, { code: 'ETIMEDOUT' }, {}, null, undefined]) expect(isCertificateError(err)).toBe(false)
  })
  it('つながらなければ false', async () => {
    const port = await listen()
    await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = null
    expect(await probeLocalUrl(`http://127.0.0.1:${port}`, 300)).toBe(false)
  })
  it('none・stopped・running を返す', async () => {
    expect(await designSystemStatus(dir, async () => true)).toEqual({ state: 'none', url: 'http://localhost:6006' })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ scripts: { storybook: 'storybook dev -p 6006' } }))
    await writeFile(join(dir, 'package-lock.json'), '{}')
    expect(await designSystemStatus(dir, async () => false)).toEqual({ state: 'stopped', url: 'http://localhost:6006', command: 'npm run storybook -- --ci' })
    const port = await listen()
    await mkdir(join(dir, '.ferret'), { recursive: true })
    await writeFile(join(dir, '.ferret', 'design-system.json'), JSON.stringify({ url: `http://127.0.0.1:${port}` }))
    expect((await designSystemStatus(dir)).state).toBe('running')
  })
  it('無いフォルダでも落ちない', async () => {
    expect((await designSystemStatus(join(dir, 'missing'), async () => true)).state).toBe('none')
  })
})

describe('タブ', () => {
  it('前回開いていたデザインシステムのタブに戻れる', () => {
    expect(decodeCenterTab('design-system', '/p')).toBe('design-system')
  })
  it('Agent への依頼は skill を名指しし、言語ごと', () => {
    expect(designSystemRequest('ja')).toContain('ferret-design-system')
    expect(designSystemRequest('ja')).toContain('ferret-feedback')
    expect(designSystemRequest('en')).toContain('Storybook')
  })
})

describe('skill「ferret-design-system」', () => {
  const text = renderDesignSystemSkill('9.9.9')
  it('前書き・印・版', () => {
    expect(text.startsWith(`---\nname: ${DESIGN_SYSTEM_SKILL_NAME}\ndescription: `)).toBe(true)
    expect(isDesignSystemSkill(text)).toBe(true)
    expect(isDesignSystemSkill('---\nname: ferret-design-system\n---\nmine')).toBe(false)
    expect(text).toContain('<!-- Ferret 9.9.9 -->')
  })
  it('必須・画面はそれだけで組む・状態ごとの stories・過去の指摘を入れる・タブで見せる', () => {
    for (const word of ['required for every product', 'Screens are built only from it', 'Every state as a story', 'ferret-feedback', 'Design system tab', '.ferret/design-system.json', '--ci']) expect(text).toContain(word)
  })
  it('ほかの skill から参照する', () => {
    expect(renderFeedbackSkill('1', '/l', '/p')).toContain('ferret-design-system')
    expect(renderVisualReviewSkill('1')).toContain('ferret-design-system')
  })
  it('設定のフォルダがある Agent にだけ入れ、印の無い同名の skill は触らない', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ferret-dsk-'))
    try {
      await mkdir(join(home, '.claude'), { recursive: true })
      await mkdir(join(home, '.codex', 'skills', DESIGN_SYSTEM_SKILL_NAME), { recursive: true })
      await writeFile(join(home, '.codex', 'skills', DESIGN_SYSTEM_SKILL_NAME, 'SKILL.md'), 'mine')
      const env = { HOME: home } as NodeJS.ProcessEnv
      expect(await syncDesignSystemSkill('1.0.0', home, env)).toBe(1)
      expect(isDesignSystemSkill(await readFile(join(home, '.claude', 'skills', DESIGN_SYSTEM_SKILL_NAME, 'SKILL.md'), 'utf8'))).toBe(true)
      expect(await readFile(join(home, '.codex', 'skills', DESIGN_SYSTEM_SKILL_NAME, 'SKILL.md'), 'utf8')).toBe('mine')
      expect(await syncDesignSystemSkill('1.0.0', home, env)).toBe(0)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
