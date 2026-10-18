/**
 * ビジネスの IPC（src/main/venture/handlers.ts・wire.ts）を偽の wiring と偽のダイアログで: 入力の検査・やめたとき null・
 * 確認でやめたら台帳に書かない・メンバーの追加・create の名前とフォルダの検査・ventureForBusiness の流れと -venture の名前の衝突
 */
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { FileVentureLedger } from '../../src/main/venture/ledger'
import { cleanVentureName } from '../../src/main/venture/handlers'
import { sha256Hex } from '../../src/main/venture/sendPass'
import { VENTURE_LEDGER_DIR, makeVentureFolderSync, ventureForBusiness } from '../../src/main/venture/wire'
import { t } from '../../src/shared/i18n'
import { VENTURE_PATHS } from '../../src/shared/venture/model'
import { VENTURE_PROMPTS, ventureRules } from '../../src/shared/venture/prompts'
import { parseGuardrails, parseVentureConfig } from '../../src/shared/venture/records'
import { createVenture, harness, tmp, type Harness } from './ventureMainHarness'

let base: string
let h: Harness
let root: string
const E = (key: string, params?: Record<string, string | number>) => t(`venture.error.${key}` as Parameters<typeof t>[0], params)
const j = (v: unknown) => JSON.stringify(v)
const read = (rel: string) => readFile(path.join(root, ...rel.split('/')), 'utf8')
const write = (rel: string, text: string) => writeFile(path.join(root, ...rel.split('/')), text)
const config = async () => parseVentureConfig(await read(VENTURE_PATHS.config)).value!
const PROMPT = VENTURE_PROMPTS[0].id

beforeEach(async () => {
  base = await tmp('venture-handlers-')
  await mkdir(path.join(base, 'userData'))
  h = harness(path.join(base, 'userData'))
})

async function openVenture(): Promise<void> {
  root = await createVenture(h, base)
  h.boxes.length = 0
  h.opens.length = 0
  h.notified = 0
}

describe('venture:status・venture:list', () => {
  it('未選択なら root null', async () => {
    expect(await h.call('venture:status')).toEqual({ root: null, projectId: null, isVenture: false, isOrchestra: false })
  })

  it('オーケストラでない・オーケストラ・ビジネス', async () => {
    const plain = path.join(base, 'plain')
    await mkdir(plain)
    const p = h.w.registerFolder(plain, {})
    h.openId = p.id
    expect(await h.call('venture:status')).toMatchObject({ root: plain, isOrchestra: false, isVenture: false })
    const o = h.w.registerFolder(plain, { orchestra: true })
    h.openId = o.id
    expect(await h.call('venture:status')).toMatchObject({ isOrchestra: true, isVenture: false })
    await openVenture()
    expect(await h.call('venture:status')).toMatchObject({ root, isOrchestra: true, isVenture: true })
  })

  it('一覧はオーケストラで venture.json があるものだけ（SSH・普通のプロジェクトは除く）', async () => {
    await openVenture()
    const orch = path.join(base, 'orch')
    await mkdir(orch)
    h.w.registerFolder(orch, { orchestra: true })
    const fake = path.join(base, 'fakeVenture')
    await mkdir(fake)
    await writeFile(path.join(fake, 'venture.json'), '{}')
    h.w.registerFolder(fake, {})
    h.projects.push({ id: 'ssh1', name: 'ssh', folderPath: root, urls: [], editorWorkspace: true, source: 'ssh' })
    const list = await h.call('venture:list')
    expect(list).toEqual([{ projectId: h.project(root)!.id, name: 'Shop', folder: root }])
  })
})

describe('venture:create', () => {
  it('名前を整えて <親>/<名前> に作り、オーケストラとして登録して開く', async () => {
    h.picks.push(base)
    const state = await h.call('venture:create', { name: '  My/Shop:2  ' })
    const folder = path.join(base, 'My-Shop-2')
    expect(parseVentureConfig(await readFile(path.join(folder, 'venture.json'), 'utf8')).value!.name).toBe('My-Shop-2')
    expect(h.registered).toEqual([{ folder, options: { name: 'My-Shop-2', orchestra: true } }])
    const p = h.project(folder)!
    expect(p.editorWorkspace).toBe(true)
    expect(h.opened).toEqual([p.id])
    expect(state).toEqual({ projects: h.projects, activeProjectId: p.id })
    expect(h.opens[0].properties).toContain('createDirectory')
    expect(h.notified).toBe(1)
  })

  it.each([[''], ['   '], ['...'], ['///'], [null], [5], [undefined]])('名前 %j は断る（ダイアログを出さない）', async (name) => {
    await expect(h.call('venture:create', { name } as { name: string })).rejects.toThrow(E('nameEmpty'))
    expect(h.opens).toEqual([])
  })

  it('入力がオブジェクトでなければ断る', async () => {
    await expect(h.call('venture:create', null as unknown as { name: string })).rejects.toThrow(E('badInput'))
  })

  it('やめたら null（何も作らない・登録しない）', async () => {
    h.picks.push(null)
    expect(await h.call('venture:create', { name: 'Shop' })).toBeNull()
    expect(h.registered).toEqual([])
    expect(await readdir(base)).toEqual(['userData'])
  })

  it('録画中は断る（ダイアログの前と後）', async () => {
    h.recording = true
    await expect(h.call('venture:create', { name: 'Shop' })).rejects.toThrow('recording now')
    expect(h.opens).toEqual([])
    h.recording = false
    h.picks.push(base)
    h.onOpen = () => { h.recording = true }
    await expect(h.call('venture:create', { name: 'Shop' })).rejects.toThrow('recording now')
    expect(h.registered).toEqual([])
  })

  it('親がリンク・相対パス・無いフォルダなら断る', async () => {
    const link = path.join(base, 'link')
    await symlink(base, link)
    for (const parent of [link, 'relative/dir', path.join(base, 'nope')]) {
      h.picks.push(parent)
      await expect(h.call('venture:create', { name: 'Shop' })).rejects.toThrow(E('parentInvalid'))
    }
  })

  it('空でないフォルダ・ファイル・リンクがあれば断る', async () => {
    await mkdir(path.join(base, 'Full'))
    await writeFile(path.join(base, 'Full', 'a.txt'), 'x')
    await writeFile(path.join(base, 'File'), 'x')
    await symlink(path.join(base, 'Full'), path.join(base, 'Link'))
    for (const name of ['Full', 'File', 'Link']) {
      h.picks.push(base)
      await expect(h.call('venture:create', { name })).rejects.toThrow(E('folderNotEmpty', { name }))
    }
    expect(await readdir(path.join(base, 'Full'))).toEqual(['a.txt'])
  })

  it('空のフォルダ（.DS_Store だけ）は使う', async () => {
    await mkdir(path.join(base, 'Empty'))
    await writeFile(path.join(base, 'Empty', '.DS_Store'), '')
    h.picks.push(base)
    await h.call('venture:create', { name: 'Empty' })
    expect(await readdir(path.join(base, 'Empty'))).toContain('venture.json')
  })

  it('名前は 80 文字まで', () => {
    expect(cleanVentureName('a'.repeat(200))).toHaveLength(80)
    expect(cleanVentureName('..a..b')).toBe('a.b')
    expect(cleanVentureName('x\u0000y\nz')).toBe('x-y-z')
    expect(cleanVentureName('tail. ')).toBe('tail')
  })
})

describe('venture:convert', () => {
  it('オーケストラでなければ断る', async () => {
    const plain = path.join(base, 'plain')
    await mkdir(plain)
    h.openId = h.w.registerFolder(plain, {}).id
    await expect(h.call('venture:convert')).rejects.toThrow(E('notOrchestra'))
  })

  it('開いていなければ断る', async () => {
    await expect(h.call('venture:convert')).rejects.toThrow(E('noFolder'))
  })

  it('オーケストラに雛形を書いてビジネスにする（既にあれば断る）', async () => {
    const orch = path.join(base, 'Team')
    await mkdir(orch)
    h.openId = h.w.registerFolder(orch, { orchestra: true }).id
    const snap = await h.call('venture:convert')
    expect(snap.config.name).toBe('Team')
    expect(h.notified).toBe(1)
    await expect(h.call('venture:convert')).rejects.toThrow(E('alreadyVenture'))
  })

  it('venture.json がフォルダ・リンクなら雛形で隠さない', async () => {
    const orch = path.join(base, 'Team')
    await mkdir(path.join(orch, 'venture.json'), { recursive: true })
    h.openId = h.w.registerFolder(orch, { orchestra: true }).id
    await expect(h.call('venture:convert')).rejects.toThrow(E('configBroken'))
  })
})

describe('venture:load', () => {
  beforeEach(openVenture)

  it.each([['7d'], [''], [null], [30]])('期間 %j は断る', async (period) => {
    await expect(h.call('venture:load', { period } as { period: '30d' })).rejects.toThrow(E('badPeriod'))
  })

  it('ビジネスでなければ断る', async () => {
    const orch = path.join(base, 'Team')
    await mkdir(orch)
    h.openId = h.w.registerFolder(orch, { orchestra: true }).id
    await expect(h.call('venture:load', { period: '30d' })).rejects.toThrow(E('noVenture'))
  })

  it('SSH のオーケストラは断る', async () => {
    const p = h.project(root)!
    p.source = 'ssh'
    await expect(h.call('venture:load', { period: '30d' })).rejects.toThrow()
  })

  it('期間ごとに読む', async () => {
    const snap = await h.call('venture:load', { period: 'all' })
    expect(snap.root).toBe(root)
    expect(snap.projectId).toBe(h.openId)
    expect(snap.summary.period).toBeNull()
  })
})

describe('venture:addMember・removeMember', () => {
  beforeEach(openVenture)

  it('登録済みのプロジェクトをこのビジネスに入れる', async () => {
    const dev = path.join(base, 'dev')
    await mkdir(dev)
    const p = h.w.registerFolder(dev, {})
    h.registered.length = 0
    const snap = await h.call('venture:addMember', { role: 'dev', projectId: p.id })
    expect(h.registered).toEqual([{ folder: dev, options: { orchestraId: h.openId } }])
    expect((await config()).members).toEqual([{ role: 'dev', folder: dev, projectId: p.id }])
    expect(snap.members[0]).toMatchObject({ role: 'dev', folder: dev, inOrchestra: true, exists: true })
    expect(h.notified).toBe(1)
  })

  it('同じ役割・同じフォルダは1つ、別の役割なら別に足す', async () => {
    const dev = path.join(base, 'dev')
    await mkdir(dev)
    const p = h.w.registerFolder(dev, {})
    await h.call('venture:addMember', { role: 'dev', projectId: p.id })
    await h.call('venture:addMember', { role: 'dev', projectId: p.id })
    await h.call('venture:addMember', { role: 'publish', projectId: p.id })
    expect((await config()).members.map((m) => m.role)).toEqual(['dev', 'publish'])
  })

  it.each([['orchestra'], ['ssh'], ['unknown'], ['self'], ['missingFolder']])('プロジェクト %s は断る', async (kind) => {
    let id = 'nope'
    if (kind === 'orchestra') {
      const o = path.join(base, 'o')
      await mkdir(o)
      id = h.w.registerFolder(o, { orchestra: true }).id
    } else if (kind === 'ssh') {
      h.projects.push({ id: 'ssh', name: 's', folderPath: base, urls: [], source: 'ssh' })
      id = 'ssh'
    } else if (kind === 'self') id = h.openId!
    else if (kind === 'missingFolder') id = h.w.registerFolder(path.join(base, 'gone'), {}).id
    await expect(h.call('venture:addMember', { role: 'dev', projectId: id })).rejects.toThrow(E('memberProject'))
    expect((await config()).members).toEqual([])
  })

  it.each([['boss'], [''], [null]])('役割 %j は断る', async (role) => {
    await expect(h.call('venture:addMember', { role } as { role: 'dev' })).rejects.toThrow(E('badRole'))
  })

  it('projectId の形が違えば断る', async () => {
    await expect(h.call('venture:addMember', { role: 'dev', projectId: 5 as unknown as string })).rejects.toThrow(E('memberProject'))
    await expect(h.call('venture:addMember', { role: 'dev', projectId: 'x'.repeat(201) })).rejects.toThrow(E('memberProject'))
  })

  it('フォルダを選んで足す（新しく登録し、このビジネスに入れる）', async () => {
    const ch = path.join(base, 'channel')
    await mkdir(ch)
    h.picks.push(ch)
    const snap = await h.call('venture:addMember', { role: 'video' })
    const p = h.project(ch)!
    expect(p.orchestraId).toBe(h.openId)
    expect((await config()).members).toEqual([{ role: 'video', folder: ch, projectId: p.id }])
    expect(snap.videoCount).toBe(0)
    expect(h.opens[0].properties).toEqual(['openDirectory'])
  })

  it('やめたら null（書かない）', async () => {
    h.picks.push(null)
    expect(await h.call('venture:addMember', { role: 'video' })).toBeNull()
    expect((await config()).members).toEqual([])
    expect(h.notified).toBe(0)
  })

  it('リンク・ビジネスのフォルダ自体・オーケストラのフォルダは断る', async () => {
    const real = path.join(base, 'real')
    await mkdir(real)
    await symlink(real, path.join(base, 'alias'))
    const o = path.join(base, 'orch')
    await mkdir(o)
    h.w.registerFolder(o, { orchestra: true })
    for (const pick of [path.join(base, 'alias'), root, o, 'rel']) {
      h.picks.push(pick)
      await expect(h.call('venture:addMember', { role: 'dev' })).rejects.toThrow(E('memberFolder'))
    }
    expect((await config()).members).toEqual([])
  })

  it('外すのは venture.json からだけ（プロジェクトは消さない）', async () => {
    const dev = path.join(base, 'dev')
    await mkdir(dev)
    const p = h.w.registerFolder(dev, {})
    await h.call('venture:addMember', { role: 'dev', projectId: p.id })
    await h.call('venture:addMember', { role: 'publish', projectId: p.id })
    const snap = await h.call('venture:removeMember', { role: 'dev', folder: dev })
    expect(snap.members.map((m: { role: string }) => m.role)).toEqual(['publish'])
    expect(h.project(dev)).toBeDefined()
    expect(await readdir(base)).toContain('dev')
  })

  it('外す入力の検査', async () => {
    await expect(h.call('venture:removeMember', { role: 'x' as 'dev', folder: '/a' })).rejects.toThrow(E('badRole'))
    await expect(h.call('venture:removeMember', { role: 'dev', folder: 5 as unknown as string })).rejects.toThrow(E('memberFolder'))
    await expect(h.call('venture:removeMember', { role: 'dev', folder: '' })).rejects.toThrow(E('memberFolder'))
    await expect(h.call('venture:removeMember', { role: 'dev', folder: 'a'.repeat(1001) })).rejects.toThrow(E('memberFolder'))
    await expect(h.call('venture:removeMember', { role: 'dev', folder: 'a\u0001' })).rejects.toThrow(E('memberFolder'))
  })

  it('壊れた venture.json にはメンバーを足さない', async () => {
    await write(VENTURE_PATHS.config, j({ name: 'x', members: {} }))
    const dev = path.join(base, 'dev')
    await mkdir(dev)
    const p = h.w.registerFolder(dev, {})
    await expect(h.call('venture:addMember', { role: 'dev', projectId: p.id })).rejects.toThrow(E('configBroken'))
  })
})

describe('venture:importFile', () => {
  beforeEach(openVenture)

  it('選んだファイルを data/imports/<source>/ に写して結果を返す', async () => {
    const src = path.join(base, 'Ads Report.csv')
    await writeFile(src, 'Day,Campaign,Impr.,Clicks,Cost\n2026-10-11,A,100,5,300\nbad,A,1,1,1\n')
    h.picks.push(src)
    const out = await h.call('venture:importFile', { source: 'google-ads' })
    expect(out.path).toMatch(/^data\/imports\/google-ads\/\d{8}-\d{6}-Ads-Report\.csv$/)
    expect(out.rows).toBe(1)
    expect(out.issues.map((i: { code: string }) => i.code)).toEqual(['badDate'])
    expect(await read(out.path)).toBe(await readFile(src, 'utf8'))
    expect(out.snapshot.data.files.map((f: { path: string }) => f.path)).toEqual([out.path])
    expect(h.opens[0].filters?.[0].extensions).toEqual(['csv', 'tsv', 'txt', 'json'])
    expect(h.notified).toBe(1)
  })

  it.each([['facebook'], [''], [null]])('元 %j は断る', async (source) => {
    await expect(h.call('venture:importFile', { source } as { source: 'x' })).rejects.toThrow(E('badSource'))
  })

  it('やめたら null', async () => {
    h.picks.push(null)
    expect(await h.call('venture:importFile', { source: 'x' })).toBeNull()
  })

  it('拡張子の違うファイルは断る', async () => {
    const src = path.join(base, 'a.xlsx')
    await writeFile(src, 'x')
    h.picks.push(src)
    await expect(h.call('venture:importFile', { source: 'x' })).rejects.toThrow(E('importExtension'))
  })

  it('大きすぎるファイルは写さない', async () => {
    const src = path.join(base, 'big.csv')
    await writeFile(src, Buffer.alloc(20 * 1024 * 1024 + 1, 0x61))
    h.picks.push(src)
    await expect(h.call('venture:importFile', { source: 'x' })).rejects.toThrow(E('importTooLarge', { max: 20 }))
    expect(await readdir(path.join(root, 'data/imports'))).toEqual(['.gitkeep'])
  })

  it('リンクのファイルは読まない', async () => {
    const real = path.join(base, 'real.csv')
    await writeFile(real, 'Day,Clicks\n2026-10-01,1\n')
    await symlink(real, path.join(base, 'link.csv'))
    h.picks.push(path.join(base, 'link.csv'))
    await expect(h.call('venture:importFile', { source: 'x' })).rejects.toThrow()
    expect(await readdir(path.join(root, 'data/imports'))).toEqual(['.gitkeep'])
  })
})

describe('venture:requestApproval', () => {
  beforeEach(openVenture)
  const ok = { kind: 'post' as const, title: 'Post the launch', detail: 'Text', refs: ['P001'] }

  it('人の依頼として足す', async () => {
    const snap = await h.call('venture:requestApproval', ok)
    expect(snap.approvals).toEqual([expect.objectContaining({ id: 'A001', ...ok, by: 'human', status: 'pending' })])
    expect(h.notified).toBe(1)
  })

  it('refs は前後の空白を外し、重複を除く', async () => {
    const snap = await h.call('venture:requestApproval', { ...ok, refs: [' P001 ', 'P001', 'T002'] })
    expect(snap.approvals[0].refs).toEqual(['P001', 'T002'])
  })

  it.each([
    ['kind', { kind: 'launchMissiles' }, 'badKind'],
    ['空の題', { title: '  ' }, 'badTitle'],
    ['長い題', { title: 'x'.repeat(201) }, 'badTitle'],
    ['改行のある題', { title: 'a\nb' }, 'badTitle'],
    ['数の題', { title: 5 }, 'badTitle'],
    ['長い中身', { detail: 'x'.repeat(20001) }, 'badDetail'],
    ['中身が無い', { detail: undefined }, 'badDetail'],
    ['制御文字の中身', { detail: 'a\u0007' }, 'badDetail'],
    ['refs が多い', { refs: Array.from({ length: 21 }, (_, i) => `P${i}`) }, 'badRefs'],
    ['refs の文字', { refs: ['../x'] }, 'badRefs'],
    ['refs の長さ', { refs: ['x'.repeat(41)] }, 'badRefs'],
    ['refs が配列でない', { refs: 'P001' }, 'badRefs'],
    ['refs の要素が数', { refs: [1] }, 'badRefs']
  ])('%s は断る', async (_label, over, key) => {
    await expect(h.call('venture:requestApproval', { ...ok, ...over } as typeof ok)).rejects.toThrow(E(key, { max: key === 'badTitle' ? 200 : key === 'badDetail' ? 20000 : 20 }))
    expect(JSON.parse(await read(VENTURE_PATHS.approvals)).requests).toEqual([])
  })

  it('ちょうどの長さは通る（題 200・中身 20000・refs 20）', async () => {
    await h.call('venture:requestApproval', { kind: 'billing', title: 'x'.repeat(200), detail: 'y'.repeat(20000), refs: Array.from({ length: 20 }, (_, i) => `R${i}`) })
    expect(JSON.parse(await read(VENTURE_PATHS.approvals)).requests).toHaveLength(1)
  })
})

describe('venture:decide', () => {
  beforeEach(async () => {
    await openVenture()
    await write(VENTURE_PATHS.approvals, j({ requests: [{ id: 'A001', kind: 'adLaunch', title: 'Launch ads', detail: 'Budget 1000/day', refs: ['AD01'] }] }))
  })
  const ledgerState = () => new FileVentureLedger(path.join(base, 'userData', VENTURE_LEDGER_DIR), root, async () => Buffer.alloc(32)).read()

  it('ダイアログで確かめてから台帳に書く（承認）', async () => {
    h.answers.push(0)
    const snap = await h.call('venture:decide', { approvalId: 'A001', decision: 'approve', answer: ' go ' })
    expect(snap.approvals[0]).toMatchObject({ status: 'approved', answer: 'go' })
    expect(h.boxes[0].message).toContain('Launch ads')
    expect(h.boxes[0].detail).toContain('Budget 1000/day')
    expect(h.boxes[0].detail).toContain('AD01')
    expect(h.boxes[0].defaultId).toBe(1)
    expect(h.notified).toBe(1)
  })

  it('却下', async () => {
    h.answers.push(0)
    const snap = await h.call('venture:decide', { approvalId: 'A001', decision: 'reject', answer: '' })
    expect(snap.approvals[0].status).toBe('rejected')
  })

  it('やめたら null で台帳に書かない', async () => {
    h.answers.push(1)
    expect(await h.call('venture:decide', { approvalId: 'A001', decision: 'approve', answer: '' })).toBeNull()
    const snap = await h.call('venture:load', { period: '30d' })
    expect(snap.approvals[0].status).toBe('pending')
    expect((await readdir(path.join(base, 'userData'))).includes(VENTURE_LEDGER_DIR)).toBe(false)
    expect(h.notified).toBe(0)
  })

  it('窓が無ければ確かめられないので null', async () => {
    h.windowGone = true
    expect(await h.call('venture:decide', { approvalId: 'A001', decision: 'approve', answer: '' })).toBeNull()
    expect(h.boxes).toEqual([])
  })

  it('確かめている間に中身が変われば書かない', async () => {
    h.answers.push(0)
    h.onBox = () => write(VENTURE_PATHS.approvals, j({ requests: [{ id: 'A001', kind: 'adLaunch', title: 'Launch ads', detail: 'Budget 99999/day', refs: ['AD01'] }] }))
    await expect(h.call('venture:decide', { approvalId: 'A001', decision: 'approve', answer: '' })).rejects.toThrow(E('approvalChanged', { id: 'A001' }))
    h.onBox = null
    expect((await h.call('venture:load', { period: '30d' })).approvals[0].status).toBe('pending')
  })

  it('確かめている間に消されたら書かない', async () => {
    h.answers.push(0)
    h.onBox = () => write(VENTURE_PATHS.approvals, j({ requests: [] }))
    await expect(h.call('venture:decide', { approvalId: 'A001', decision: 'approve', answer: '' })).rejects.toThrow(E('approvalNotFound', { id: 'A001' }))
  })

  it('承認のあとファイルを書き換えたら changed（承認し直し）', async () => {
    h.answers.push(0)
    await h.call('venture:decide', { approvalId: 'A001', decision: 'approve', answer: '' })
    await write(VENTURE_PATHS.approvals, j({ requests: [{ id: 'A001', kind: 'adLaunch', title: 'Launch ads', detail: 'Budget 5000/day', refs: ['AD01'], status: 'approved' }] }))
    expect((await h.call('venture:load', { period: '30d' })).approvals[0].status).toBe('changed')
  })

  it('長い中身はダイアログに先頭だけ', async () => {
    await write(VENTURE_PATHS.approvals, j({ requests: [{ id: 'A001', kind: 'post', title: 'Long', detail: 'z'.repeat(5000) }] }))
    h.answers.push(1)
    await h.call('venture:decide', { approvalId: 'A001', decision: 'approve', answer: '' })
    expect(h.boxes[0].detail!.length).toBeLessThan(1500)
  })

  it.each([
    [{ approvalId: 'A999', decision: 'approve', answer: '' }, 'approvalNotFound'],
    [{ approvalId: '', decision: 'approve', answer: '' }, 'badInput'],
    [{ approvalId: 'x'.repeat(41), decision: 'approve', answer: '' }, 'badInput'],
    [{ approvalId: 5, decision: 'approve', answer: '' }, 'badInput'],
    [{ approvalId: 'A001', decision: 'maybe', answer: '' }, 'badDecision'],
    [{ approvalId: 'A001', decision: 'approve', answer: 'x'.repeat(2001) }, 'badAnswer'],
    [{ approvalId: 'A001', decision: 'approve', answer: 7 }, 'badAnswer']
  ])('%j は断る（ダイアログを出さない）', async (input, key) => {
    await expect(h.call('venture:decide', input as never)).rejects.toThrow(E(key, { id: 'A999', max: 2000 }))
    expect(h.boxes).toEqual([])
  })

  it('台帳は userData の下（フォルダの中には書かない）', async () => {
    h.answers.push(0)
    await h.call('venture:decide', { approvalId: 'A001', decision: 'approve', answer: '' })
    expect((await readdir(path.join(base, 'userData', VENTURE_LEDGER_DIR))).length).toBe(1)
    expect(JSON.parse(await read(VENTURE_PATHS.approvals)).requests[0].status).toBeUndefined()
    // 別の鍵（再起動）では読めない
    expect((await ledgerState()).approvals).toEqual({})
  })
})

describe('venture:setBudget・approveBudgets・decideOperations', () => {
  beforeEach(openVenture)
  const guardrails = async () => parseGuardrails(await read(VENTURE_PATHS.guardrails)).value

  it('確かめてから台帳と guardrails.json に同じ値を書く', async () => {
    h.answers.push(0)
    const snap = await h.call('venture:setBudget', { channel: 'google-ads', daily: 1000, monthly: 30000 })
    expect((await guardrails()).budgets).toEqual([{ channel: 'google-ads', daily: 1000, monthly: 30000 }])
    const usage = snap.summary.budgets.find((b: { channel: string }) => b.channel === 'google-ads')
    expect(usage.cap).toEqual({ daily: 1000, monthly: 30000 })
    expect(usage.proposed).toBeNull()
    expect(h.boxes[0].detail).toContain('1,000')
  })

  it('両方 null で外す', async () => {
    h.answers.push(0, 0)
    await h.call('venture:setBudget', { channel: '*', daily: null, monthly: 500 })
    const snap = await h.call('venture:setBudget', { channel: '*', daily: null, monthly: null })
    expect((await guardrails()).budgets).toEqual([])
    expect(snap.summary.budgets.find((b: { channel: string }) => b.channel === '*')?.cap ?? null).toBeNull()
  })

  it('やめたら台帳にもファイルにも書かない', async () => {
    h.answers.push(1)
    expect(await h.call('venture:setBudget', { channel: 'x', daily: 1, monthly: 1 })).toBeNull()
    expect((await guardrails()).budgets).toEqual([])
    expect((await readdir(path.join(base, 'userData'))).includes(VENTURE_LEDGER_DIR)).toBe(false)
  })

  it.each([
    [{ channel: 'myspace', daily: 1, monthly: 1 }, 'badChannel'],
    [{ channel: 'x', daily: -1, monthly: 1 }, 'badAmount'],
    [{ channel: 'x', daily: 1, monthly: 1e12 + 1 }, 'badAmount'],
    [{ channel: 'x', daily: Number.NaN, monthly: 1 }, 'badAmount'],
    [{ channel: 'x', daily: Number.POSITIVE_INFINITY, monthly: 1 }, 'badAmount'],
    [{ channel: 'x', daily: '100', monthly: 1 }, 'badAmount']
  ])('%j は断る', async (input, key) => {
    await expect(h.call('venture:setBudget', input as never)).rejects.toThrow(E(key))
    expect(h.boxes).toEqual([])
  })

  it('0 と 1e12 は通る', async () => {
    h.answers.push(0)
    await h.call('venture:setBudget', { channel: 'x', daily: 0, monthly: 1e12 })
    expect((await guardrails()).budgets).toEqual([{ channel: 'x', daily: 0, monthly: 1e12 }])
  })

  it('guardrails.json が壊れていれば確かめる前に断る', async () => {
    await write(VENTURE_PATHS.guardrails, '{nope')
    await expect(h.call('venture:setBudget', { channel: 'x', daily: 1, monthly: 1 })).rejects.toThrow(E('fileBroken', { file: VENTURE_PATHS.guardrails }))
    expect(h.boxes).toEqual([])
    expect(await read(VENTURE_PATHS.guardrails)).toBe('{nope')
  })

  it('案をそのまま承認し、案に無くなった経路の承認は外す', async () => {
    h.answers.push(0)
    await h.call('venture:setBudget', { channel: 'meta-ads', daily: 5, monthly: 50 })
    const g = await guardrails()
    await write(VENTURE_PATHS.guardrails, j({ ...g, budgets: [{ channel: 'x', daily: 100, monthly: null }, { channel: '*', daily: null, monthly: 9000 }] }))
    h.answers.push(0)
    const snap = await h.call('venture:approveBudgets')
    const caps = Object.fromEntries(snap.summary.budgets.map((b: { channel: string; cap: unknown }) => [b.channel, b.cap]))
    expect(caps.x).toEqual({ daily: 100, monthly: null })
    expect(caps['*']).toEqual({ daily: null, monthly: 9000 })
    expect(caps['meta-ads'] ?? null).toBeNull()
    expect(h.boxes[1].detail).toContain('9,000')
  })

  it('案の承認をやめたら書かない・確かめている間に案が変われば書かない', async () => {
    const g = await guardrails()
    await write(VENTURE_PATHS.guardrails, j({ ...g, budgets: [{ channel: 'x', daily: 100, monthly: null }] }))
    h.answers.push(1)
    expect(await h.call('venture:approveBudgets')).toBeNull()
    h.answers.push(0)
    h.onBox = () => write(VENTURE_PATHS.guardrails, j({ ...g, budgets: [{ channel: 'x', daily: 100000, monthly: null }] }))
    await expect(h.call('venture:approveBudgets')).rejects.toThrow(E('budgetsChanged'))
    h.onBox = null
    const snap = await h.call('venture:load', { period: '30d' })
    expect(snap.summary.budgets.find((b: { channel: string }) => b.channel === 'x').cap).toBeNull()
  })

  it('運営の判断（pass・fail・null）', async () => {
    h.answers.push(0)
    let snap = await h.call('venture:decideOperations', { decision: 'pass' })
    expect(snap.summary.phase.checks.operations.ok).toBe(true)
    h.answers.push(0)
    snap = await h.call('venture:decideOperations', { decision: null })
    expect(snap.summary.phase.checks.operations.ok).toBeNull()
    h.answers.push(1)
    expect(await h.call('venture:decideOperations', { decision: 'fail' })).toBeNull()
  })

  it.each([['yes'], [true], [undefined]])('運営の判断 %j は断る', async (decision) => {
    await expect(h.call('venture:decideOperations', { decision } as never)).rejects.toThrow(E('badDecision'))
  })
})

describe('venture:prompt・armSend・send', () => {
  beforeEach(openVenture)

  it('依頼文に名前と決まりが入る', async () => {
    const view = await h.call('venture:prompt', { promptId: PROMPT })
    expect(view.id).toBe(PROMPT)
    expect(view.text).toContain('Shop')
    expect(view.text.endsWith(ventureRules('en'))).toBe(true)
    h.locale = 'ja'
    expect((await h.call('venture:prompt', { promptId: PROMPT })).text.endsWith(ventureRules('ja'))).toBe(true)
  })

  it.each([['nope'], [''], [5]])('依頼の id %j は断る', async (promptId) => {
    await expect(h.call('venture:prompt', { promptId } as never)).rejects.toThrow(E('badPrompt'))
  })

  const sendFlow = async (text: string, target: unknown = { kind: 'active' }, sendTarget: unknown = target) => {
    const { ticket } = await h.call('venture:armSend', { promptId: PROMPT, textHash: sha256Hex(text), target } as never)
    return h.call('venture:send', { promptId: PROMPT, text, target: sendTarget, ticket } as never)
  }

  it('札を確かめて送り、決まりを最後に付け足す', async () => {
    const out = await sendFlow('Do this')
    expect(out).toEqual({ ok: true, message: 'sent' })
    expect(h.terminals!.sent).toEqual([{ id: 't1', text: `Do this\n\n${ventureRules('en')}` }])
  })

  it('決まりが既に最後にあれば二重に付けない', async () => {
    const text = (await h.call('venture:prompt', { promptId: PROMPT })).text
    await sendFlow(text)
    expect(h.terminals!.sent[0].text).toBe(text)
  })

  it('札が無い・使い回し・本文の差し替えは断る', async () => {
    await expect(h.call('venture:send', { promptId: PROMPT, text: 'x', target: { kind: 'active' }, ticket: 'nope' })).rejects.toThrow(E('needsAction'))
    const { ticket } = await h.call('venture:armSend', { promptId: PROMPT, textHash: sha256Hex('a'), target: { kind: 'active' } })
    await expect(h.call('venture:send', { promptId: PROMPT, text: 'b', target: { kind: 'active' }, ticket })).rejects.toThrow(E('needsAction'))
    await expect(h.call('venture:send', { promptId: PROMPT, text: 'a', target: { kind: 'active' }, ticket })).rejects.toThrow(E('needsAction'))
    expect(h.terminals!.sent).toEqual([])
  })

  it('操作の直後でなければ札を作らない', async () => {
    h.consent = false
    await expect(h.call('venture:armSend', { promptId: PROMPT, textHash: sha256Hex('a'), target: { kind: 'active' } })).rejects.toThrow(E('needsAction'))
  })

  it('ビジネスでなければ札を作らない', async () => {
    const orch = path.join(base, 'Team')
    await mkdir(orch)
    h.openId = h.w.registerFolder(orch, { orchestra: true }).id
    await expect(h.call('venture:armSend', { promptId: PROMPT, textHash: sha256Hex('a'), target: { kind: 'active' } })).rejects.toThrow(E('noVenture'))
  })

  it('new の札で起動したターミナルへ送る', async () => {
    const out = await sendFlow('Go', { kind: 'new', agent: 'codex' }, { kind: 'terminal', id: 't2' })
    expect(out.ok).toBe(true)
    expect(h.terminals!.sent[0].id).toBe('t2')
  })

  it('送れなければ ok:false（送ったとは言わない）', async () => {
    h.terminals!.result = { ok: false, message: 'busy' }
    expect(await sendFlow('x')).toEqual({ ok: false, message: 'busy' })
    h.terminals!.throws = true
    expect((await sendFlow('y')).ok).toBe(false)
    h.terminals = null
    expect(await sendFlow('z')).toEqual({ ok: false, message: t('venture.error.sendNoTerminal') })
  })

  it('空の本文は送らない', async () => {
    await expect(sendFlow('   ')).rejects.toThrow(E('badText'))
  })
})

describe('ventureForBusiness', () => {
  it('ビジネス記録の隣に <名前>-venture を作って business で入れ、ビジネスを開く', async () => {
    const biz = path.join(base, 'coffee')
    await mkdir(biz)
    const { projectId } = ventureForBusiness(h.w)(biz, 'Coffee beans', 'ignored-orchestra')
    const vf = path.join(base, 'coffee-venture')
    const business = h.project(biz)!
    const venture = h.project(vf)!
    expect(projectId).toBe(business.id)
    expect(venture).toMatchObject({ name: 'Coffee beans', editorWorkspace: true })
    expect(business.orchestraId).toBe(venture.id)
    expect(h.opened).toEqual([venture.id])
    expect(h.registered.map((r) => [r.folder, r.options])).toEqual([[biz, {}], [vf, { name: 'Coffee beans', orchestra: true }], [biz, { orchestraId: venture.id }]])
    const cfg = parseVentureConfig(await readFile(path.join(vf, 'venture.json'), 'utf8')).value!
    expect(cfg.members).toEqual([{ role: 'business', folder: biz, projectId: business.id }])
    expect(await readdir(vf)).toEqual(expect.arrayContaining(['guardrails.json', 'approvals', 'data', 'streams', 'VENTURE.md']))
  })

  it('名前が埋まっていれば -venture-2, -venture-3', async () => {
    const biz = path.join(base, 'coffee')
    await mkdir(biz)
    await mkdir(path.join(base, 'coffee-venture'))
    await writeFile(path.join(base, 'coffee-venture-2'), 'file')
    ventureForBusiness(h.w)(biz, 'C', null)
    expect(h.project(path.join(base, 'coffee-venture-3'))).toBeDefined()
    expect(await readdir(path.join(base, 'coffee-venture'))).toEqual([])
    expect(makeVentureFolderSync(biz)).toBe(path.join(base, 'coffee-venture-4'))
  })

  it('既にあるリンクの名前も飛ばす（リンクの先に書かない）', async () => {
    const biz = path.join(base, 'coffee')
    await mkdir(biz)
    const elsewhere = path.join(base, 'elsewhere')
    await mkdir(elsewhere)
    await symlink(elsewhere, path.join(base, 'coffee-venture'))
    ventureForBusiness(h.w)(biz, 'C', null)
    expect(await readdir(elsewhere)).toEqual([])
    expect(h.project(path.join(base, 'coffee-venture-2'))).toBeDefined()
  })

  it('録画中は断る（何も作らない・登録しない）', async () => {
    const biz = path.join(base, 'coffee')
    await mkdir(biz)
    h.recording = true
    expect(() => ventureForBusiness(h.w)(biz, 'C', null)).toThrow('recording now')
    expect(h.registered).toEqual([])
    expect(await readdir(base)).not.toContain('coffee-venture')
  })

  it('名前が空ならフォルダの名前', async () => {
    const biz = path.join(base, 'tea')
    await mkdir(biz)
    ventureForBusiness(h.w)(biz, '  ', null)
    expect(h.project(path.join(base, 'tea-venture'))!.name).toBe('tea-venture')
  })

  it('作ったビジネスはそのまま読める', async () => {
    const biz = path.join(base, 'tea')
    await mkdir(biz)
    ventureForBusiness(h.w)(biz, 'Tea', null)
    root = path.join(base, 'tea-venture')
    const snap = await h.call('venture:load', { period: '30d' })
    expect(snap.members).toEqual([expect.objectContaining({ role: 'business', folder: biz, inOrchestra: true, exists: true })])
    expect(snap.recordIssues).toEqual([])
  })
})
