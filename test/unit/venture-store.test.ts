/**
 * ビジネスのフォルダの読み書き（src/main/venture/store.ts）: 作るときのファイル・上書きしない・壊れた JSON・リンクを読まない/書かない・
 * データのファイルの上限・取り込みの結果が summary に入る・ファイルに approved と書いても承認にならない・メンバー・動画の数
 */
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { MemoryVentureLedger, recordHash } from '../../src/main/venture/ledger'
import {
  DATA_EXTENSIONS, README_FILE, VENTURE_STORE_LIMITS, VentureStore, countVideos, importFileName, importStamp, initialFiles, localDate, promptContext,
  safeSegments, serialFor, writeInitialFilesSync
} from '../../src/main/venture/store'
import { t } from '../../src/shared/i18n'
import type { Project } from '../../src/shared/types'
import { VENTURE_PATHS } from '../../src/shared/venture/model'
import { STREAM_FILE_KEYS, parseGuardrails, parseVentureConfig } from '../../src/shared/venture/records'
import { tmp } from './ventureMainHarness'

const TODAY = '2026-10-18'
let base: string
let root: string
let ledger: MemoryVentureLedger
let projects: Project[]

const store = (over: Partial<ConstructorParameters<typeof VentureStore>[0]> = {}) =>
  new VentureStore({ root, ledger, projectId: 'v1', projects: () => projects, ...over })

async function put(rel: string, text: string | Buffer): Promise<void> {
  const file = path.join(root, ...rel.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}
const read = (rel: string) => readFile(path.join(root, ...rel.split('/')), 'utf8')
const j = (v: unknown) => JSON.stringify(v)

async function init(s = store()): Promise<VentureStore> {
  await s.init({ name: 'Shop', createdAt: '2026-10-01T00:00:00Z', locale: 'en', members: [] })
  return s
}

beforeEach(async () => {
  base = await tmp('venture-store-')
  root = path.join(base, 'Shop')
  await mkdir(root)
  ledger = new MemoryVentureLedger()
  projects = [{ id: 'v1', name: 'Shop', folderPath: root, urls: [], editorWorkspace: true, orchestrator: true }]
})

describe('initialFiles', () => {
  const files = initialFiles('Shop', '2026-10-01T00:00:00Z', 'en', [{ role: 'business', folder: '/x/biz', projectId: 'p1' }])
  const byPath = new Map(files.map((f) => [f.path, f.text]))

  it('決まったファイルをすべて含む', () => {
    for (const p of [VENTURE_PATHS.config, VENTURE_PATHS.guardrails, VENTURE_PATHS.approvals, VENTURE_PATHS.externalLog, VENTURE_PATHS.ads, VENTURE_PATHS.content,
      VENTURE_PATHS.images, VENTURE_PATHS.support, VENTURE_PATHS.satisfaction, VENTURE_PATHS.checks, README_FILE, 'data/imports/.gitkeep', 'data/agent/.gitkeep']) {
      expect(byPath.has(p), p).toBe(true)
    }
  })
  it('venture.json は読めてメンバーが入る', () => {
    const c = parseVentureConfig(byPath.get(VENTURE_PATHS.config)!)
    expect(c.issues).toEqual([])
    expect(c.value).toMatchObject({ name: 'Shop', currency: 'JPY', members: [{ role: 'business', folder: '/x/biz', projectId: 'p1' }] })
  })
  it('guardrails.json は既定のチェック項目（言語どおり）・予算の案なし', () => {
    const en = parseGuardrails(byPath.get(VENTURE_PATHS.guardrails)!)
    expect(en.value.budgets).toEqual([])
    expect(en.value.checks.length).toBeGreaterThan(5)
    const ja = parseGuardrails(initialFiles('S', 'c', 'ja', []).find((f) => f.path === VENTURE_PATHS.guardrails)!.text)
    expect(ja.value.checks[0].text).not.toBe(en.value.checks[0].text)
  })
  it('業務の記録は空の配列（決まった鍵）', () => {
    expect(JSON.parse(byPath.get(VENTURE_PATHS.ads)!)).toEqual({ [STREAM_FILE_KEYS.ads]: [] })
    expect(JSON.parse(byPath.get(VENTURE_PATHS.support)!)).toEqual({ [STREAM_FILE_KEYS.support]: [] })
    expect(JSON.parse(byPath.get(VENTURE_PATHS.approvals)!)).toEqual({ requests: [] })
    expect(JSON.parse(byPath.get(VENTURE_PATHS.externalLog)!)).toEqual({ actions: [] })
  })
  it('README は名前と決まり（日英）', () => {
    expect(byPath.get(README_FILE)).toContain('# Shop')
    expect(byPath.get(README_FILE)).toContain(VENTURE_PATHS.approvals)
    expect(initialFiles('店', 'c', 'ja', []).find((f) => f.path === README_FILE)!.text).toContain('決まり')
  })
  it('純粋（同じ入力なら同じ・渡したメンバーを書き換えない）', () => {
    const members = [{ role: 'dev' as const, folder: '/d' }]
    const a = initialFiles('S', 'c', 'en', members)
    expect(initialFiles('S', 'c', 'en', members)).toEqual(a)
    a[0].text = 'x'
    expect(members).toEqual([{ role: 'dev', folder: '/d' }])
  })
})

describe('init', () => {
  it('雛形を書く', async () => {
    const created = await init()
    expect(await created.isVenture()).toBe(true)
    expect((await readdir(root)).sort()).toEqual([README_FILE, 'approvals', 'data', 'guardrails.json', 'log', 'streams', 'venture.json'].sort())
  })
  it('既にあるファイルは上書きしない', async () => {
    await put(VENTURE_PATHS.config, j({ version: 1, name: 'Mine', currency: 'USD' }))
    await put(VENTURE_PATHS.guardrails, 'not json at all')
    const created = await store().init({ name: 'Shop', createdAt: 'c', locale: 'en', members: [] })
    expect(created).not.toContain(VENTURE_PATHS.config)
    expect(created).not.toContain(VENTURE_PATHS.guardrails)
    expect(JSON.parse(await read(VENTURE_PATHS.config)).name).toBe('Mine')
    expect(await read(VENTURE_PATHS.guardrails)).toBe('not json at all')
  })
  it('2回目は何も作らない', async () => {
    await init()
    expect(await store().init({ name: 'Shop', createdAt: 'c', locale: 'en', members: [] })).toEqual([])
  })
  it('途中のフォルダがリンクなら書かない（外に書かない）', async () => {
    const outside = path.join(base, 'outside')
    await mkdir(outside)
    await symlink(outside, path.join(root, 'streams'))
    await expect(init()).rejects.toThrow(t('venture.error.link'))
    expect(await readdir(outside)).toEqual([])
  })
  it('末端がリンクなら書かない（たどらない）', async () => {
    const outside = path.join(base, 'secret.json')
    await writeFile(outside, 'secret')
    await symlink(outside, path.join(root, 'venture.json'))
    await init().catch(() => undefined)
    expect(await readFile(outside, 'utf8')).toBe('secret')
  })
})

describe('writeInitialFilesSync', () => {
  it('書いて、既にあるファイルは飛ばす', () => {
    const files = initialFiles('S', 'c', 'en', [])
    writeInitialFilesSync(root, files)
    writeInitialFilesSync(root, [{ path: VENTURE_PATHS.config, text: 'changed' }])
    return read(VENTURE_PATHS.config).then((text) => expect(JSON.parse(text).name).toBe('S'))
  })
  it('途中のフォルダがリンクなら断る', async () => {
    const outside = path.join(base, 'o')
    await mkdir(outside)
    await symlink(outside, path.join(root, 'log'))
    expect(() => writeInitialFilesSync(root, [{ path: VENTURE_PATHS.externalLog, text: '{}' }])).toThrow(t('venture.error.link'))
    expect(await readdir(outside)).toEqual([])
  })
  it('末端のリンクには書かない', async () => {
    const outside = path.join(base, 'o.json')
    await writeFile(outside, 'keep')
    await symlink(outside, path.join(root, 'venture.json'))
    writeInitialFilesSync(root, [{ path: VENTURE_PATHS.config, text: 'x' }])
    expect(await readFile(outside, 'utf8')).toBe('keep')
  })
  it('使えない相対パスは断る', () => {
    expect(() => writeInitialFilesSync(root, [{ path: '../x', text: '' }])).toThrow()
  })
})

describe('safeSegments', () => {
  it.each(['a/../b', '../a', '/a', 'a//b', 'a\\b', 'a:b', '.', '', 'a\0b'])('断る %j', (rel) => {
    expect(() => safeSegments(rel)).toThrow(t('venture.error.badPath'))
  })
  it('普通の名前', () => {
    expect(safeSegments('data/imports/x.csv')).toEqual(['data', 'imports', 'x.csv'])
  })
})

describe('load の記録', () => {
  it('venture.json が無ければ noVenture', async () => {
    await expect(store().load('30d', TODAY)).rejects.toThrow(t('venture.error.noVenture'))
  })

  it('雛形だけなら空のまとめ', async () => {
    const snap = await (await init()).load('30d', TODAY)
    expect(snap.config.name).toBe('Shop')
    expect(snap.recordIssues).toEqual([])
    expect(snap.approvals).toEqual([])
    expect(snap.data).toEqual({ files: [], issues: [], issueCount: 0, rowCount: 0, range: null })
    expect(snap.summary.period).toEqual({ from: '2026-09-19', to: TODAY })
    expect(snap.videoCount).toBeNull()
  })

  it('壊れた venture.json は既定で読み、問題に出し、ファイルは書き換えない', async () => {
    await init()
    await put(VENTURE_PATHS.config, '{ broken')
    const snap = await store().load('all', TODAY)
    expect(snap.config.name).toBe('Shop')
    expect(snap.recordIssues).toContainEqual({ file: VENTURE_PATHS.config, message: 'badJson' })
    expect(await read(VENTURE_PATHS.config)).toBe('{ broken')
  })

  it('壊れた guardrails・streams も問題に出す（画面は止めない）', async () => {
    await init()
    await put(VENTURE_PATHS.guardrails, '[]')
    await put(VENTURE_PATHS.support, j({ tickets: [{ id: 'T001' }, { id: 'T002', kind: 'inquiry', status: 'open' }] }))
    const snap = await store().load('30d', TODAY)
    expect(snap.recordIssues).toContainEqual({ file: VENTURE_PATHS.guardrails, message: 'badShape' })
    expect(snap.recordIssues.some((i) => i.file === VENTURE_PATHS.support)).toBe(true)
    expect(snap.streams.support.map((x) => x.id)).toEqual(['T002'])
    expect(await read(VENTURE_PATHS.guardrails)).toBe('[]')
  })

  it('リンクの記録は読まない（外のファイルの中身を出さない）', async () => {
    await init()
    const outside = path.join(base, 'requests.json')
    await writeFile(outside, j({ requests: [{ id: 'A001', kind: 'post', title: 'from outside' }] }))
    await rm(path.join(root, ...VENTURE_PATHS.approvals.split('/')))
    await symlink(outside, path.join(root, ...VENTURE_PATHS.approvals.split('/')))
    const snap = await store().load('30d', TODAY)
    expect(snap.approvals).toEqual([])
    expect(snap.recordIssues).toContainEqual({ file: VENTURE_PATHS.approvals, message: 'link' })
  })

  it('途中のフォルダがリンクの記録も読まない', async () => {
    await init()
    const outside = path.join(base, 'streams-out')
    await mkdir(path.join(outside, 'ads'), { recursive: true })
    await writeFile(path.join(outside, 'ads', 'campaigns.json'), j({ campaigns: [{ id: 'AD01', channel: 'x', name: 'n', status: 'running' }] }))
    await rm(path.join(root, 'streams'), { recursive: true })
    await symlink(outside, path.join(root, 'streams'))
    const snap = await store().load('30d', TODAY)
    expect(snap.streams.ads).toEqual([])
    expect(snap.recordIssues).toContainEqual({ file: VENTURE_PATHS.ads, message: 'link' })
  })

  it('大きすぎる記録は読まない', async () => {
    await init()
    await put(VENTURE_PATHS.content, Buffer.alloc(VENTURE_STORE_LIMITS.recordBytes + 1, 0x20))
    const snap = await store().load('30d', TODAY)
    expect(snap.recordIssues).toContainEqual({ file: VENTURE_PATHS.content, message: 'tooLarge' })
  })

  it('ファイルに approved と書いても承認にならない', async () => {
    await init()
    await put(VENTURE_PATHS.approvals, j({ requests: [{ id: 'A001', kind: 'post', title: 'Go', detail: 'd', status: 'approved', decidedAt: '2026-10-01' }] }))
    const snap = await store().load('30d', TODAY)
    expect(snap.approvals[0].status).toBe('pending')
    expect(snap.approvals[0].decidedAt).toBeUndefined()
  })

  it('台帳の承認は効き、中身が変われば changed', async () => {
    await init()
    const r = { id: 'A001', kind: 'post' as const, title: 'Go', detail: 'd', refs: [] }
    await put(VENTURE_PATHS.approvals, j({ requests: [r] }))
    await ledger.putApproval('A001', { status: 'approved', answer: 'ok', decidedAt: 'x', kind: 'post', recordHash: recordHash(r) })
    expect((await store().load('30d', TODAY)).approvals[0]).toMatchObject({ status: 'approved', answer: 'ok' })
    await put(VENTURE_PATHS.approvals, j({ requests: [{ ...r, detail: 'd2' }] }))
    expect((await store().load('30d', TODAY)).approvals[0].status).toBe('changed')
  })

  it('予算は台帳の値だけが効く（guardrails の案は proposed）', async () => {
    await init()
    await put(VENTURE_PATHS.guardrails, j({ version: 1, budgets: [{ channel: 'x', daily: 500, monthly: 9000 }], checks: [] }))
    await ledger.putBudget('x', { daily: 100, monthly: 3000, decidedAt: 'd' })
    const full = await store().loadFull('30d', TODAY)
    expect(full.approvedBudgets).toEqual([{ channel: 'x', daily: 100, monthly: 3000 }])
    const x = full.snapshot.summary.budgets.find((b) => b.channel === 'x')!
    expect(x.cap).toEqual({ daily: 100, monthly: 3000 })
    expect(x.proposed).toEqual({ daily: 500, monthly: 9000 })
  })

  it('運営の判断は台帳から', async () => {
    await init()
    await ledger.putOperations({ decision: 'pass', decidedAt: 'd' })
    const snap = await store().load('all', TODAY)
    expect(snap.summary.phase.checks.operations.ok).toBe(true)
  })

  it('キャッシュしない（読み直す）', async () => {
    const s = await init()
    await s.load('30d', TODAY)
    await put(VENTURE_PATHS.support, j({ tickets: [{ id: 'T001', kind: 'inquiry', status: 'open' }] }))
    expect((await s.load('30d', TODAY)).streams.support).toHaveLength(1)
  })
})

describe('load のデータ', () => {
  const agentRows = (rows: unknown[]) => j({ version: 1, source: 'canonical', rows })

  it('data/agent の規定の形と data/imports/<source> の CSV が summary に入る', async () => {
    await init()
    await put('data/agent/x.json', agentRows([{ date: '2026-10-10', channel: 'x', impressions: 1000, clicks: 20 }]))
    await put('data/imports/google-ads/a.csv', 'Day,Campaign,Impr.,Clicks,Cost\n2026-10-11,Brand,500,10,1200\n')
    const snap = await store().load('30d', TODAY)
    expect(snap.data.rowCount).toBe(2)
    expect(snap.data.files.map((f) => [f.path, f.source, f.rows])).toEqual([['data/agent/x.json', 'canonical', 1], ['data/imports/google-ads/a.csv', 'google-ads', 1]])
    expect(snap.data.range).toEqual({ from: '2026-10-10', to: '2026-10-11' })
    expect(snap.summary.kpis.spend).toBe(1200)
    expect(snap.summary.funnel.steps[0].count).toBe(1500)
  })

  it('取り込みの問題を数え、ファイルをまたいだ重複は後を優先', async () => {
    await init()
    await put('data/imports/google-ads/1.csv', 'Day,Campaign,Clicks\n2026-10-11,A,5\n')
    await put('data/imports/google-ads/2.csv', 'Day,Campaign,Clicks\n2026-10-11,A,7\nnot-a-date,A,1\n')
    const snap = await store().load('30d', TODAY)
    expect(snap.data.rowCount).toBe(1)
    expect(snap.summary.funnel.steps[1].count).toBe(7)
    expect(snap.data.issues.map((i) => i.code).sort()).toEqual(['badDate', 'duplicate'])
    expect(snap.data.issueCount).toBe(2)
  })

  it('知らない元のフォルダ・リンクのファイル・リンクのフォルダは読まない', async () => {
    await init()
    const outside = path.join(base, 'out.csv')
    await writeFile(outside, 'Day,Clicks\n2026-10-11,999\n')
    await put('data/imports/myspace/a.csv', 'Day,Clicks\n2026-10-11,1\n')
    await mkdir(path.join(root, 'data/imports/google-ads'), { recursive: true })
    await symlink(outside, path.join(root, 'data/imports/google-ads/link.csv'))
    await symlink(path.dirname(outside), path.join(root, 'data/imports/meta-ads'))
    const snap = await store().load('30d', TODAY)
    expect(snap.data.rowCount).toBe(0)
    expect(snap.recordIssues).toEqual(expect.arrayContaining([
      { file: 'data/imports/myspace', message: 'unknownSource' },
      { file: 'data/imports/google-ads/link.csv', message: 'link' },
      { file: 'data/imports/meta-ads', message: 'link' }
    ]))
  })

  it('深さ2まで（その下は読まない）・拡張子の違うものは読まない', async () => {
    await init()
    const row = (d: string) => agentRows([{ date: d, channel: 'x', clicks: 1 }])
    await put('data/agent/a.json', row('2026-10-01'))
    await put('data/agent/sub/b.json', row('2026-10-02'))
    await put('data/agent/sub/deep/c.json', row('2026-10-03'))
    await put('data/agent/d.xlsx', row('2026-10-04'))
    await put('data/agent/E.JSON', row('2026-10-05'))
    const snap = await store().load('all', TODAY)
    expect(snap.data.files.map((f) => f.path)).toEqual(['data/agent/E.JSON', 'data/agent/a.json', 'data/agent/sub/b.json'])
    expect(DATA_EXTENSIONS).toContain('.tsv')
  })

  it(`ファイルは ${VENTURE_STORE_LIMITS.dataFiles} まで`, async () => {
    await init()
    const dir = path.join(root, 'data/agent')
    await Promise.all(Array.from({ length: VENTURE_STORE_LIMITS.dataFiles + 5 }, (_, i) =>
      writeFile(path.join(dir, `f${String(i).padStart(4, '0')}.json`), agentRows([{ date: '2026-10-01', channel: 'x', campaign: `c${i}`, clicks: 1 }]))))
    const snap = await store().load('all', TODAY)
    expect(snap.data.files).toHaveLength(VENTURE_STORE_LIMITS.dataFiles)
    expect(snap.recordIssues).toContainEqual({ file: 'data', message: 'tooManyFiles' })
  })

  it('大きすぎるデータのファイルは tooLarge（中身は読まない）', async () => {
    await init()
    await put('data/imports/google-ads/big.csv', Buffer.alloc(20 * 1024 * 1024 + 1, 0x61))
    const snap = await store().load('all', TODAY)
    expect(snap.data.issues).toContainEqual({ file: 'imports/google-ads/big.csv', line: null, code: 'tooLarge' })
    expect(snap.data.files[0]).toMatchObject({ rows: 0, issues: 1 })
  })

  it('壊れた JSON のデータは問題に出す', async () => {
    await init()
    await put('data/agent/bad.json', '{ nope')
    const snap = await store().load('all', TODAY)
    expect(snap.data.issues[0]).toMatchObject({ file: 'agent/bad.json', code: 'badJson' })
  })

  it('問題は先頭から MAX_SNAPSHOT_ISSUES 件・数は全部', async () => {
    await init()
    const lines = Array.from({ length: 250 }, () => 'bad,1').join('\n')
    await put('data/imports/google-ads/x.csv', `Day,Clicks\n${lines}\n`)
    const snap = await store().load('all', TODAY)
    expect(snap.data.issues).toHaveLength(200)
    expect(snap.data.issueCount).toBe(250)
  })
})

describe('メンバーと動画の数', () => {
  it('登録済み・このオーケストラに属しているか・フォルダがあるか', async () => {
    const dev = path.join(base, 'dev')
    const other = path.join(base, 'other')
    await mkdir(dev)
    await mkdir(other)
    projects.push({ id: 'p2', name: 'Dev app', folderPath: dev, urls: [], orchestraId: 'v1' })
    projects.push({ id: 'p3', name: 'Other', folderPath: other, urls: [], orchestraId: 'o9' })
    projects.push({ id: 'o9', name: 'O9', folderPath: path.join(base, 'o9'), urls: [], editorWorkspace: true })
    await store().init({ name: 'Shop', createdAt: 'c', locale: 'en', members: [
      { role: 'dev', folder: dev, projectId: 'p2' },
      { role: 'publish', folder: other },
      { role: 'business', folder: path.join(base, 'missing') }
    ] })
    const snap = await store().load('30d', TODAY)
    expect(snap.members).toEqual([
      { role: 'dev', folder: dev, projectId: 'p2', name: 'Dev app', exists: true, inOrchestra: true },
      { role: 'publish', folder: other, projectId: 'p3', name: 'Other', exists: true, inOrchestra: false },
      { role: 'business', folder: path.join(base, 'missing'), projectId: null, name: 'missing', exists: false, inOrchestra: false }
    ])
  })

  it('動画チャンネルの直下のフォルダで ferret-video.json か solocut.json があるもの', async () => {
    const ch = path.join(base, 'channel')
    await mkdir(path.join(ch, 'v1'), { recursive: true })
    await writeFile(path.join(ch, 'v1', 'ferret-video.json'), '{}')
    await mkdir(path.join(ch, 'v2'))
    await writeFile(path.join(ch, 'v2', 'solocut.json'), '{}')
    await mkdir(path.join(ch, 'notes'))
    await writeFile(path.join(ch, 'loose.json'), '{}')
    expect(await countVideos(ch)).toBe(2)
    expect(await countVideos(path.join(base, 'nope'))).toBeNull()
    await store().init({ name: 'Shop', createdAt: 'c', locale: 'en', members: [{ role: 'video', folder: ch }] })
    expect((await store().load('30d', TODAY)).videoCount).toBe(2)
    expect((await store({ videoCount: async () => 7 }).load('30d', TODAY)).videoCount).toBe(7)
    expect((await store({ videoCount: async () => { throw new Error('x') } }).load('30d', TODAY)).videoCount).toBeNull()
  })
})

describe('記録を足す', () => {
  const approval = { kind: 'post' as const, title: 'T', detail: 'D', refs: ['P001'], by: 'human' as const, createdAt: 'c' }

  it('承認の依頼は A001 から続き、形の違う要素は残す', async () => {
    await init()
    await put(VENTURE_PATHS.approvals, j({ requests: [{ id: 'A007', kind: 'post', title: 'x' }, { bogus: true }], note: 'keep' }))
    const id = await store().addApproval(approval)
    expect(id).toBe('A008')
    const raw = JSON.parse(await read(VENTURE_PATHS.approvals))
    expect(raw.note).toBe('keep')
    expect(raw.requests).toHaveLength(3)
    expect(raw.requests[2]).toEqual({ id: 'A008', ...approval })
  })

  it('無ければ作る', async () => {
    await init()
    await rm(path.join(root, 'approvals'), { recursive: true })
    expect(await store().addApproval(approval)).toBe('A001')
  })

  it('壊れたファイルは書き換えない', async () => {
    await init()
    for (const text of ['{oops', '[]', j({ requests: {} }), j({ version: 2, requests: [] })]) {
      await put(VENTURE_PATHS.approvals, text)
      await expect(store().addApproval(approval)).rejects.toThrow(t('venture.error.fileBroken', { file: VENTURE_PATHS.approvals }))
      expect(await read(VENTURE_PATHS.approvals)).toBe(text)
    }
  })

  it('リンクには書かない', async () => {
    await init()
    const outside = path.join(base, 'req.json')
    await writeFile(outside, j({ requests: [] }))
    await rm(path.join(root, 'approvals'), { recursive: true })
    await symlink(base, path.join(root, 'approvals'))
    await expect(store().addApproval(approval)).rejects.toThrow(t('venture.error.link'))
    expect(await readFile(outside, 'utf8')).toBe(j({ requests: [] }))
  })

  it('同時に足しても id が重ならない（1本の列）', async () => {
    await init()
    const ids = await Promise.all(Array.from({ length: 12 }, () => store().addApproval(approval)))
    expect(new Set(ids).size).toBe(12)
    expect(JSON.parse(await read(VENTURE_PATHS.approvals)).requests).toHaveLength(12)
  })

  it('メンバーを変える（形の違う要素・ほかの欄は残す）', async () => {
    await init()
    const cfg = JSON.parse(await read(VENTURE_PATHS.config))
    cfg.members = [{ role: 'dev', folder: '/a' }, { role: 'alien', folder: '/z' }]
    cfg.extra = 1
    await put(VENTURE_PATHS.config, j(cfg))
    await store().updateMembers((ms) => [...ms, { role: 'video', folder: '/v', projectId: 'p9' }])
    const after = JSON.parse(await read(VENTURE_PATHS.config))
    expect(after.extra).toBe(1)
    expect(after.members).toEqual([{ role: 'alien', folder: '/z' }, { role: 'dev', folder: '/a' }, { role: 'video', folder: '/v', projectId: 'p9' }])
  })

  it('壊れた venture.json のメンバーは変えない', async () => {
    await init()
    for (const text of ['{oops', j({ version: 3 }), j({ name: 'x', members: 'nope' })]) {
      await put(VENTURE_PATHS.config, text)
      await expect(store().updateMembers((m) => m)).rejects.toThrow(t('venture.error.configBroken'))
      expect(await read(VENTURE_PATHS.config)).toBe(text)
    }
  })

  it('guardrails の予算: 足す・置き換える・両方 null で外す・ほかは残す', async () => {
    await init()
    const s = store()
    await s.setGuardrailBudget('x', 100, null, 'en')
    await s.setGuardrailBudget('*', null, 5000, 'en')
    await s.setGuardrailBudget('x', 200, 3000, 'en')
    let g = parseGuardrails(await read(VENTURE_PATHS.guardrails))
    expect(g.value.budgets).toEqual([{ channel: 'x', daily: 200, monthly: 3000 }, { channel: '*', daily: null, monthly: 5000 }])
    expect(g.value.checks.length).toBeGreaterThan(0)
    await s.setGuardrailBudget('x', null, null, 'en')
    g = parseGuardrails(await read(VENTURE_PATHS.guardrails))
    expect(g.value.budgets).toEqual([{ channel: '*', daily: null, monthly: 5000 }])
  })

  it('guardrails が無ければ既定から作り、壊れていれば書き換えない', async () => {
    await init()
    await rm(path.join(root, VENTURE_PATHS.guardrails))
    await store().setGuardrailBudget('x', 1, 2, 'en')
    expect(parseGuardrails(await read(VENTURE_PATHS.guardrails)).value.checks.length).toBeGreaterThan(0)
    await put(VENTURE_PATHS.guardrails, 'broken')
    await expect(store().setGuardrailBudget('x', 1, 2, 'en')).rejects.toThrow()
    expect(await read(VENTURE_PATHS.guardrails)).toBe('broken')
  })

  it('取り込んだファイルは data/imports/<source>/<stamp>-<名前>、同じ名前は -2', async () => {
    await init()
    const now = new Date(2026, 9, 18, 9, 5, 7)
    const a = await store().saveImport('meta-ads', 'report.csv', Buffer.from('a'), now)
    const b = await store().saveImport('meta-ads', 'report.csv', Buffer.from('b'), now)
    expect(a).toBe('data/imports/meta-ads/20261018-090507-report.csv')
    expect(b).toBe('data/imports/meta-ads/20261018-090507-report-2.csv')
    expect(await read(a)).toBe('a')
  })
})

describe('小さな関数', () => {
  it('localDate・importStamp はローカルの時刻', () => {
    const d = new Date(2026, 0, 2, 3, 4, 5)
    expect(localDate(d)).toBe('2026-01-02')
    expect(importStamp(d)).toBe('20260102-030405')
  })
  it.each([
    ['report.csv', 'report.csv'],
    ['/Users/me/Downloads/My Report (1).CSV', 'My-Report-(1).csv'],
    ['C:\\data\\x.tsv', 'x.tsv'],
    ['..hidden.json', 'hidden.json'],
    ['a<>:"|?*.txt', 'a.txt'],
    ['-.csv', 'data.csv'],
    [`${'a'.repeat(200)}.json`, `${'a'.repeat(80)}.json`]
  ])('importFileName %s → %s', (input, want) => {
    expect(importFileName(input)).toBe(want)
  })
  it.each(['x.xlsx', 'x', 'x.csv.exe', 'x.pdf', '.csv'])('importFileName %s → null', (input) => {
    expect(importFileName(input)).toBeNull()
  })
  it('serialFor は前が失敗しても次を走らせる', async () => {
    const order: number[] = []
    const a = serialFor(root, async () => { order.push(1); throw new Error('x') })
    const b = serialFor(root, async () => { order.push(2); return 2 })
    await expect(a).rejects.toThrow('x')
    expect(await b).toBe(2)
    expect(order).toEqual([1, 2])
  })
  it('promptContext は効いている予算と件数', async () => {
    await init()
    await put(VENTURE_PATHS.support, j({ tickets: [{ id: 'T1', kind: 'inquiry', status: 'open' }, { id: 'T2', kind: 'inquiry', status: 'awaitingApproval' }, { id: 'T3', kind: 'inquiry', status: 'closed' }] }))
    await put(VENTURE_PATHS.content, j({ items: [{ id: 'P1', channel: 'x', title: 't', status: 'review' }] }))
    await put(VENTURE_PATHS.approvals, j({ requests: [{ id: 'A001', kind: 'post', title: 'x' }] }))
    await ledger.putBudget('*', { daily: 1, monthly: 2, decidedAt: 'd' })
    const ctx = promptContext(await store().loadFull('30d', TODAY), 'en')
    expect(ctx).toMatchObject({ name: 'Shop', root, currency: 'JPY', budgets: [{ channel: '*', daily: 1, monthly: 2 }], counts: { pendingApprovals: 1, openTickets: 2, draftsAwaitingApproval: 2 } })
    expect(ctx.alerts.length).toBeGreaterThan(0)
    expect(ctx.alerts.every((a) => typeof a === 'string' && a.length > 0)).toBe(true)
  })
})
