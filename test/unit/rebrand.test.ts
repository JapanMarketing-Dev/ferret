import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-rebrand-unit' } }))

import { MIGRATED_MARKER, legacyConfigDir, migrateLegacyConfigDir, resolveConfigDir } from '../../src/main/settingsFile'
import {
  createSession,
  deleteSession,
  ensureGitExclude,
  findIncompleteSessions,
  listSessions,
  sessionPaths
} from '../../src/main/sessions/index'
import { readBrandEnv } from '@shared/brandEnv'
import { DECISION_ENV, DECISION_ENV_PREFIXES, LEGACY_DECISION_ENV } from '@shared/decision'
import { PRODUCT_NAME } from '@shared/i18n'
import { STAR_REPO } from '@shared/starPrompt'
import { DOWNLOAD_PAGE_URL } from '../../src/main/updateCheck'

/**
 * MOVIE-ADE → Ferret の改名。設定フォルダの引っ越し・レビューフォルダの新旧・環境変数の別名・画面に旧名が残っていないか。
 * 本物の ~/.movie-ade・~/.ferret・利用者のプロジェクトには触れず、すべて一時フォルダで確かめる。
 */

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'ade-rebrand-')) })
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** 旧フォルダに設定・状態・使用量・.env を置く */
function seedLegacy(dir: string, tag: string): void {
  mkdirSync(join(dir, 'usage'), { recursive: true })
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: tag }))
  writeFileSync(join(dir, 'state.json'), JSON.stringify({ version: 1, url: `http://${tag}/` }))
  writeFileSync(join(dir, 'usage', '2026-10.jsonl'), `{"tag":"${tag}"}\n`)
  writeFileSync(join(dir, '.env'), `KEY=${tag}\n`, { mode: 0o600 })
}

describe('設定フォルダの引っ越し（~/.movie-ade → ~/.ferret）', () => {
  const home = () => join(root, 'home')

  it('既定の置き場所: 配布版は ~/.ferret ← ~/.movie-ade、dev は ~/.ferret/dev ← ~/.movie-ade/dev', () => {
    expect(resolveConfigDir({ env: {}, home: home(), isPackaged: true })).toBe(join(home(), '.ferret'))
    expect(legacyConfigDir({ home: home(), isPackaged: true })).toBe(join(home(), '.movie-ade'))
    expect(resolveConfigDir({ env: {}, home: home(), isPackaged: false })).toBe(join(home(), '.ferret', 'dev'))
    expect(legacyConfigDir({ home: home(), isPackaged: false })).toBe(join(home(), '.movie-ade', 'dev'))
  })

  for (const isPackaged of [true, false]) {
    const kind = isPackaged ? '配布版' : 'dev'
    const paths = () => ({ from: legacyConfigDir({ home: home(), isPackaged }), to: resolveConfigDir({ env: {}, home: home(), isPackaged }) })

    it(`${kind}: 旧フォルダだけある → settings.json・state.json・usage/・.env を写し、旧フォルダは残して印を置く`, () => {
      const { from, to } = paths()
      seedLegacy(from, kind)
      expect(migrateLegacyConfigDir({ from, to, now: new Date('2026-10-03T00:00:00Z') })).toBe(to)
      expect(JSON.parse(readFileSync(join(to, 'settings.json'), 'utf8'))).toEqual({ theme: kind })
      expect(JSON.parse(readFileSync(join(to, 'state.json'), 'utf8')).url).toBe(`http://${kind}/`)
      expect(readFileSync(join(to, 'usage', '2026-10.jsonl'), 'utf8')).toContain(kind)
      expect(readFileSync(join(to, '.env'), 'utf8')).toBe(`KEY=${kind}\n`)
      if (process.platform !== 'win32') expect(statSync(join(to, '.env')).mode & 0o777).toBe(0o600)
      // 旧フォルダはそのまま（バックアップ）。印だけ増える
      expect(readFileSync(join(from, 'settings.json'), 'utf8')).toBe(JSON.stringify({ theme: kind }))
      expect(existsSync(join(from, 'usage', '2026-10.jsonl'))).toBe(true)
      expect(readFileSync(join(from, MIGRATED_MARKER), 'utf8')).toContain(to)
      // 一時フォルダは残さない
      expect(readdirSync(join(to, '..')).filter((n) => n.includes('.migrating-'))).toEqual([])
      // 2回目は何もしない
      expect(migrateLegacyConfigDir({ from, to })).toBeNull()
    })

    it(`${kind}: 両方ある → 新しいほうを使い、どちらも書き換えない`, () => {
      const { from, to } = paths()
      seedLegacy(from, 'old')
      mkdirSync(to, { recursive: true })
      writeFileSync(join(to, 'settings.json'), '{"theme":"new"}')
      expect(migrateLegacyConfigDir({ from, to })).toBeNull()
      expect(readFileSync(join(to, 'settings.json'), 'utf8')).toBe('{"theme":"new"}')
      expect(existsSync(join(to, 'usage'))).toBe(false)
      expect(existsSync(join(from, MIGRATED_MARKER))).toBe(false)
    })

    it(`${kind}: どちらも無い → 何も作らない`, () => {
      const { from, to } = paths()
      expect(migrateLegacyConfigDir({ from, to })).toBeNull()
      expect(existsSync(to)).toBe(false)
      expect(existsSync(from)).toBe(false)
    })

    it(`${kind}: 写し終えた印があれば、新しいフォルダを消しても写し直さない`, () => {
      const { from, to } = paths()
      seedLegacy(from, kind)
      migrateLegacyConfigDir({ from, to })
      rmSync(to, { recursive: true, force: true })
      expect(migrateLegacyConfigDir({ from, to })).toBeNull()
      expect(existsSync(join(to, 'settings.json'))).toBe(false)
    })
  }

  it('配布版: 先に dev が ~/.ferret/dev を作っていても、~/.movie-ade から写す（dev/ は写さない）', () => {
    const from = legacyConfigDir({ home: home(), isPackaged: true })
    const to = resolveConfigDir({ env: {}, home: home(), isPackaged: true })
    seedLegacy(from, 'packaged')
    seedLegacy(join(from, 'dev'), 'dev')
    mkdirSync(join(to, 'dev'), { recursive: true })
    writeFileSync(join(to, 'dev', 'settings.json'), '{"theme":"ferret-dev"}')
    expect(migrateLegacyConfigDir({ from, to })).toBe(to)
    expect(JSON.parse(readFileSync(join(to, 'settings.json'), 'utf8'))).toEqual({ theme: 'packaged' })
    expect(readFileSync(join(to, 'dev', 'settings.json'), 'utf8')).toBe('{"theme":"ferret-dev"}')
  })

  it('一部だけあるもの（settings.json だけ）も写せる。新しいフォルダに既にあるものは上書きしない', () => {
    const from = join(root, 'old')
    const to = join(root, 'new')
    mkdirSync(from, { recursive: true })
    writeFileSync(join(from, 'settings.json'), '{"theme":"old"}')
    writeFileSync(join(from, '.env'), 'A=old\n')
    mkdirSync(to, { recursive: true })
    writeFileSync(join(to, '.env'), 'A=new\n')
    expect(migrateLegacyConfigDir({ from, to })).toBe(to)
    expect(readFileSync(join(to, 'settings.json'), 'utf8')).toBe('{"theme":"old"}')
    expect(readFileSync(join(to, '.env'), 'utf8')).toBe('A=new\n')
  })

  it('写すものが1つも無い旧フォルダは、印も付けずに放っておく', () => {
    const from = join(root, 'old')
    mkdirSync(join(from, 'something-else'), { recursive: true })
    expect(migrateLegacyConfigDir({ from, to: join(root, 'new') })).toBeNull()
    expect(existsSync(join(from, MIGRATED_MARKER))).toBe(false)
    expect(existsSync(join(root, 'new'))).toBe(false)
  })
})

describe('レビューフォルダ（.ferret/ に書き、.ade-movie/ も読む）', () => {
  let project: string
  beforeEach(() => { project = join(root, 'project'); mkdirSync(project) })

  /** 改名前の版が書いた分解済みでないレビュー（素材だけ） */
  async function legacyReview(id: string): Promise<string> {
    const dir = join(project, '.ade-movie', 'reviews', id)
    await mkdir(join(dir, 'work', 'audio'), { recursive: true })
    await mkdir(join(dir, 'work', 'frames'), { recursive: true })
    await writeFile(join(dir, 'events.jsonl'), '{"t":1,"type":"nav","url":"http://x/","title":"x"}\n', 'utf8')
    await writeFile(join(dir, 'work', 'audio', 'chunk-0000-0.wav'), 'a', 'utf8')
    return dir
  }

  it('新しいレビューは .ferret/reviews に作る', async () => {
    const p = await createSession(project, new Date(2026, 9, 3, 10, 0, 0))
    expect(p.dir).toBe(join(project, '.ferret', 'reviews', '20261003-100000'))
    expect(p.relativeDir).toBe('.ferret/reviews/20261003-100000')
    expect(existsSync(join(project, '.ade-movie'))).toBe(false)
  })

  it('.ade-movie/ にだけあるレビューはそちらを指し、移さない', async () => {
    const dir = await legacyReview('20261001-090000')
    const p = sessionPaths(project, '20261001-090000')
    expect(p.dir).toBe(dir)
    expect(p.relativeDir).toBe('.ade-movie/reviews/20261001-090000')
    expect(existsSync(join(project, '.ferret', 'reviews', '20261001-090000'))).toBe(false)
  })

  it('履歴と復元の一覧に新旧の両方が出る', async () => {
    await legacyReview('20261001-090000')
    await createSession(project, new Date(2026, 9, 3, 10, 0, 0))
    expect((await listSessions(project)).map((s) => s.id)).toEqual(['20261003-100000', '20261001-090000'])
    expect((await findIncompleteSessions(project)).map((s) => s.paths.id)).toContain('20261001-090000')
  })

  it('同じ ID が両方にあれば .ferret/ を使い、一覧には1件だけ', async () => {
    await legacyReview('20261003-100000')
    await mkdir(join(project, '.ferret', 'reviews', '20261003-100000'), { recursive: true })
    expect(sessionPaths(project, '20261003-100000').dir).toBe(join(project, '.ferret', 'reviews', '20261003-100000'))
    expect((await listSessions(project)).map((s) => s.id)).toEqual(['20261003-100000'])
  })

  it('新しく作るとき、.ade-movie/ にある ID とは重ねない', async () => {
    await legacyReview('20261003-100000')
    const p = await createSession(project, new Date(2026, 9, 3, 10, 0, 0))
    expect(p.id).toBe('20261003-100001')
    expect(p.dir.startsWith(join(project, '.ferret'))).toBe(true)
  })

  it('.ade-movie/ のレビューも消せる（reviews の外は消さない）', async () => {
    const dir = await legacyReview('20261001-090000')
    await deleteSession(project, '20261001-090000')
    expect(existsSync(dir)).toBe(false)
    await expect(deleteSession(project, '../../etc')).rejects.toThrow()
  })

  it('.git/info/exclude には .ferret/ と .ade-movie/ の両方を書く。片方だけなら足りない方を足す', async () => {
    await mkdir(join(project, '.git', 'info'), { recursive: true })
    await writeFile(join(project, '.git', 'info', 'exclude'), '# 以前の版\n.ade-movie/\n', 'utf8')
    expect(await ensureGitExclude(project)).toBe('added')
    const text = await readFile(join(project, '.git', 'info', 'exclude'), 'utf8')
    const lines = text.split('\n')
    expect(lines.filter((l) => l === '.ferret/')).toHaveLength(1)
    expect(lines.filter((l) => l === '.ade-movie/')).toHaveLength(1)
    expect(await ensureGitExclude(project)).toBe('already')
  })
})

describe('環境変数の別名', () => {
  it('FERRET_* を先に読み、無ければ MOVIE_ADE_* を読む（空の新しい値も指定とみなす）', () => {
    expect(readBrandEnv({ MOVIE_ADE_X: 'old' }, 'X')).toBe('old')
    expect(readBrandEnv({ FERRET_X: 'new', MOVIE_ADE_X: 'old' }, 'X')).toBe('new')
    expect(readBrandEnv({ FERRET_X: '', MOVIE_ADE_X: 'old' }, 'X')).toBe('')
    expect(readBrandEnv({}, 'X')).toBeUndefined()
  })

  it('Agent に渡す判定モデルの変数は FERRET_DECISION_*。旧名も同じ項目で揃え、親から受け継がない接頭辞は両方', () => {
    expect(Object.values(DECISION_ENV).every((n) => n.startsWith('FERRET_DECISION_'))).toBe(true)
    expect(Object.keys(LEGACY_DECISION_ENV)).toEqual(Object.keys(DECISION_ENV))
    for (const key of Object.keys(DECISION_ENV) as (keyof typeof DECISION_ENV)[]) {
      expect(LEGACY_DECISION_ENV[key]).toBe(DECISION_ENV[key].replace('FERRET_', 'MOVIE_ADE_'))
    }
    expect([...DECISION_ENV_PREFIXES]).toEqual(['FERRET_DECISION_', 'MOVIE_ADE_DECISION_'])
  })
})

describe('画面・リンクに旧名が残っていない', () => {
  it('製品名・star のリポジトリ・ダウンロードの URL', () => {
    expect(PRODUCT_NAME).toBe('Ferret')
    expect(STAR_REPO).toEqual({ owner: 'JapanMarketing-Dev', repo: 'ferret' })
    expect(DOWNLOAD_PAGE_URL).toBe('https://ferretade.dev/download')
  })

  /**
   * src のコメント以外の行に、旧名（MOVIE-ADE・MOVIE_ADE_・.ade-movie・~/.movie-ade）・旧ドメイン・旧リポジトリが無いこと。
   * 引っ越しと互換のために旧名を持つ行だけ許す（ファイルと、その行に含まれる文字列で指定する）
   */
  it('src に利用者向けの旧名が無い（引っ越し・互換のコードは許可リスト）', () => {
    const src = join(__dirname, '..', '..', 'src')
    const allow: Record<string, string[]> = {
      // 設定フォルダの引っ越し（旧フォルダ名・旧い環境変数・旧フォルダに置く印の文面）
      'main/settingsFile.ts': ["'MOVIE_ADE_CONFIG_DIR'", "'.movie-ade'", 'MOVIE-ADE was renamed to Ferret'],
      // 判定モデルの環境変数の旧名（1リリースだけ併せて渡す）と、受け継がない接頭辞
      'shared/decision.ts': ["'MOVIE_ADE_DECISION_"],
      'shared/brandEnv.ts': ["'MOVIE_ADE_'"],
      'main/decision/relay.ts': ["'x-movie-ade-token'"],
      // 古いレビューを読み続ける・除外し続ける
      'main/sessions/paths.ts': ["'.ade-movie'"],
      'shared/files.ts': ["'.ade-movie'"],
      'main/files.ts': ["'.ade-movie'"],
      // 設定の検索語（旧名で探す人のため）
      'renderer/lib/settingsSections.ts': ["'movie-ade'"],
      // Sentry の環境変数の旧名（crash-reporting の担当）
      'shared/telemetry.ts': ['MOVIE_ADE_SENTRY_'],
      'main/telemetry.ts': ['MOVIE_ADE_SENTRY_'],
      'renderer/lib/telemetry.ts': ['MOVIE_ADE_SENTRY_']
    }
    const banned = /MOVIE-ADE|MOVIE_ADE_|\.ade-movie|~\/\.movie-ade|movie-ade\.japan-marketing|movie-ade\.pages\.dev|JapanMarketing-Dev\/MOVIE-ADE/i
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name)
        if (statSync(file).isDirectory()) { walk(file); continue }
        if (!/\.(ts|tsx|html|css)$/.test(name)) continue
        const rel = relative(src, file).split('\\').join('/')
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          const code = line.trim()
          if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*') || code.startsWith('<!--')) return
          if (!banned.test(line)) return
          if ((allow[rel] ?? []).some((ok) => line.includes(ok))) return
          hits.push(`${rel}:${i + 1}: ${code.slice(0, 160)}`)
        })
      }
    }
    walk(src)
    expect(hits).toEqual([])
  })
})

describe('起動の経路で引っ越しが動く（settings.ts の configDir）', () => {
  const saved: Record<string, string | undefined> = {}
  const keys = ['HOME', 'USERPROFILE', 'FERRET_CONFIG_DIR', 'MOVIE_ADE_CONFIG_DIR']
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k]
    for (const k of keys.slice(2)) delete process.env[k]
    process.env.HOME = process.env.USERPROFILE = join(root, 'home')
    vi.resetModules()
  })
  afterEach(() => {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    vi.doUnmock('electron')
    vi.doUnmock('../../src/main/runtime')
  })

  async function loadConfigDir(isPackaged: boolean): Promise<() => string> {
    vi.doMock('electron', () => ({ app: { getPath: () => join(root, 'userData'), commandLine: { hasSwitch: () => false } } }))
    vi.doMock('../../src/main/runtime', () => ({ IS_PACKAGED: isPackaged }))
    return (await import('../../src/main/settings')).configDir
  }

  it('dev: 先に ~/.movie-ade 直下の dev の書き損じを ~/.movie-ade/dev へ片付けてから、~/.ferret/dev へ写す', async () => {
    const home = join(root, 'home')
    // bd1d49b の dev が直下に書いた（state.json に writtenBy が無い）
    mkdirSync(join(home, '.movie-ade'), { recursive: true })
    writeFileSync(join(home, '.movie-ade', 'settings.json'), '{"theme":"dev-misplaced"}')
    writeFileSync(join(home, '.movie-ade', 'state.json'), '{"version":1}')
    const configDir = await loadConfigDir(false)
    expect(configDir()).toBe(join(home, '.ferret', 'dev'))
    expect(readFileSync(join(home, '.ferret', 'dev', 'settings.json'), 'utf8')).toBe('{"theme":"dev-misplaced"}')
    // 配布版用の ~/.ferret 直下には写さない
    expect(existsSync(join(home, '.ferret', 'settings.json'))).toBe(false)
    expect(existsSync(join(home, '.movie-ade', 'dev', MIGRATED_MARKER))).toBe(true)
  })

  it('配布版: ~/.movie-ade 直下を ~/.ferret へ写す（state.json の writtenBy もそのまま）', async () => {
    const home = join(root, 'home')
    mkdirSync(join(home, '.movie-ade'), { recursive: true })
    writeFileSync(join(home, '.movie-ade', 'settings.json'), '{"theme":"light"}')
    writeFileSync(join(home, '.movie-ade', 'state.json'), '{"version":1,"writtenBy":"packaged"}')
    const configDir = await loadConfigDir(true)
    expect(configDir()).toBe(join(home, '.ferret'))
    expect(readFileSync(join(home, '.ferret', 'state.json'), 'utf8')).toBe('{"version":1,"writtenBy":"packaged"}')
  })

  it('FERRET_CONFIG_DIR・旧名の指定があれば引っ越さない', async () => {
    const home = join(root, 'home')
    seedLegacy(join(home, '.movie-ade'), 'x')
    process.env.MOVIE_ADE_CONFIG_DIR = join(root, 'custom')
    const configDir = await loadConfigDir(true)
    expect(configDir()).toBe(join(root, 'custom'))
    expect(existsSync(join(home, '.ferret'))).toBe(false)
  })
})
