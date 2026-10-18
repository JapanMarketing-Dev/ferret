/**
 * ビジネスの人の判断の台帳（src/main/venture/ledger.ts）: HMAC の改ざん・足したもの・別のフォルダの記録・リンクの置き場所・
 * 中身が変わったら changed・予算・運営・鍵
 */
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  FileVentureLedger, MAX_LEDGER_BYTES, MemoryVentureLedger, VentureLedgerKeyStore, approvalViews, approvedBudgets, emptyLedgerState, isBudgetAmount,
  isBudgetKey, ledgerScope, recordHash, type ApprovalEntry
} from '../../src/main/venture/ledger'
import type { KeyCipher } from '../../src/main/pipeline/stt/keys'
import type { ApprovalRequest } from '../../src/shared/venture/model'
import { tmp } from './ventureMainHarness'

const req = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: 'A001', kind: 'post', title: 'Post launch note', detail: 'Hello world', refs: ['P001'], createdAt: '2026-10-01T00:00:00Z', ...over
})
const approved = (r: ApprovalRequest, over: Partial<ApprovalEntry> = {}): ApprovalEntry => ({
  status: 'approved', answer: '', decidedAt: '2026-10-02T00:00:00Z', kind: r.kind, recordHash: recordHash(r), ...over
})

let base: string
let dir: string
let root: string
const key = Buffer.alloc(32, 7)
const ledger = (r = root, k: () => Promise<Buffer> = async () => key) => new FileVentureLedger(dir, r, k)

beforeEach(async () => {
  base = await tmp('venture-ledger-')
  dir = path.join(base, 'userData', 'venture-approvals')
  root = path.join(base, 'biz')
  await mkdir(root, { recursive: true })
})

describe('recordHash', () => {
  it('同じ中身なら同じ', () => {
    expect(recordHash(req())).toBe(recordHash(req({ id: 'A999', createdAt: 'x' })))
  })
  it.each([
    ['kind', { kind: 'billing' as const }],
    ['title', { title: 'Other' }],
    ['detail', { detail: 'Hello world!' }],
    ['refs', { refs: ['P002'] }],
    ['refs の並び', { refs: ['P001', 'P002'] }]
  ])('%s が変われば変わる', (_label, over) => {
    expect(recordHash(req(over))).not.toBe(recordHash(req()))
  })
  it('区切りをずらしても同じにならない（JSON の配列で包む）', () => {
    expect(recordHash(req({ title: 'a', detail: 'b' }))).not.toBe(recordHash(req({ title: 'a"', detail: 'b' })))
  })
})

describe('approvalViews', () => {
  it('台帳に無ければ pending（ファイルの status は見ない）', () => {
    const fileSaysApproved = { ...req(), status: 'approved' } as unknown as ApprovalRequest
    expect(approvalViews([fileSaysApproved], emptyLedgerState())[0].status).toBe('pending')
  })
  it('承認・却下と answer・decidedAt', () => {
    const r = req()
    const s = emptyLedgerState()
    s.approvals.A001 = approved(r, { answer: 'ok' })
    expect(approvalViews([r], s)[0]).toMatchObject({ status: 'approved', answer: 'ok', decidedAt: '2026-10-02T00:00:00Z' })
    s.approvals.A001 = approved(r, { status: 'rejected' })
    expect(approvalViews([r], s)[0].status).toBe('rejected')
  })
  it('承認のあとに中身が変われば changed', () => {
    const r = req()
    const s = emptyLedgerState()
    s.approvals.A001 = approved(r)
    expect(approvalViews([req({ detail: 'changed' })], s)[0].status).toBe('changed')
  })
  it('却下のあとに中身が変われば pending（判断し直し）', () => {
    const r = req()
    const s = emptyLedgerState()
    s.approvals.A001 = approved(r, { status: 'rejected' })
    expect(approvalViews([req({ title: 'new' })], s)[0].status).toBe('pending')
  })
  it('__proto__ などの id で台帳の外を拾わない', () => {
    expect(approvalViews([req({ id: 'constructor' })], emptyLedgerState())[0].status).toBe('pending')
  })
})

describe('approvedBudgets', () => {
  it("'*' のあと CHANNELS の順", () => {
    const s = emptyLedgerState()
    s.budgets.x = { daily: 1, monthly: null, decidedAt: 'd' }
    s.budgets['*'] = { daily: null, monthly: 100, decidedAt: 'd' }
    s.budgets['google-ads'] = { daily: 5, monthly: 50, decidedAt: 'd' }
    expect(approvedBudgets(s).map((b) => b.channel)).toEqual(['*', 'google-ads', 'x'])
  })
  it('空', () => {
    expect(approvedBudgets(emptyLedgerState())).toEqual([])
  })
})

describe('isBudgetKey / isBudgetAmount', () => {
  it.each([['*', true], ['x', true], ['google-ads', true], ['facebook', false], ['', false], [1, false], [null, false]])('key %s → %s', (v, ok) => {
    expect(isBudgetKey(v)).toBe(ok)
  })
  it.each([[0, true], [null, true], [1e12, true], [1e12 + 1, false], [-1, false], [Number.NaN, false], [Number.POSITIVE_INFINITY, false], ['5', false], [undefined, false]])('amount %s → %s', (v, ok) => {
    expect(isBudgetAmount(v)).toBe(ok)
  })
})

describe('FileVentureLedger', () => {
  it('無ければ空', async () => {
    expect(await ledger().read()).toEqual(emptyLedgerState())
  })

  it('承認・予算・運営を書いて読める（ファイルは所有者だけ）', async () => {
    const l = ledger()
    const r = req()
    await l.putApproval('A001', approved(r))
    await l.putBudget('*', { daily: 1000, monthly: 30000, decidedAt: 'd' })
    await l.putOperations({ decision: 'pass', decidedAt: 'd' })
    const s = await ledger().read()
    expect(s.approvals.A001.recordHash).toBe(recordHash(r))
    expect(s.budgets['*']).toEqual({ daily: 1000, monthly: 30000, decidedAt: 'd' })
    expect(s.operations).toEqual({ decision: 'pass', decidedAt: 'd' })
    if (process.platform !== 'win32') {
      const { stat } = await import('node:fs/promises')
      expect((await stat(l.file)).mode & 0o077).toBe(0)
    }
  })

  it('ファイル名はフォルダの実体のパスの sha256', async () => {
    expect(path.basename(ledger().file)).toBe(`${ledgerScope(root)}.json`)
    const alias = path.join(base, 'alias')
    await symlink(root, alias)
    expect(ledger(alias).file).toBe(ledger().file)
  })

  it('書き換えた記録（status を変えた）は無かったことにする', async () => {
    const l = ledger()
    await l.putApproval('A001', approved(req(), { status: 'rejected' }))
    const raw = JSON.parse(await readFile(l.file, 'utf8'))
    raw.approvals.A001.status = 'approved'
    await writeFile(l.file, JSON.stringify(raw))
    expect((await ledger().read()).approvals).toEqual({})
  })

  it('足した記録（mac を写した・mac なし）は無かったことにする', async () => {
    const l = ledger()
    await l.putApproval('A001', approved(req()))
    const raw = JSON.parse(await readFile(l.file, 'utf8'))
    raw.approvals.A002 = { ...raw.approvals.A001 }
    raw.approvals.A003 = { ...raw.approvals.A001, mac: undefined }
    await writeFile(l.file, JSON.stringify(raw))
    const s = await ledger().read()
    expect(Object.keys(s.approvals)).toEqual(['A001'])
  })

  it('予算の改ざん（金額を上げた）は外す', async () => {
    const l = ledger()
    await l.putBudget('x', { daily: 100, monthly: null, decidedAt: 'd' })
    const raw = JSON.parse(await readFile(l.file, 'utf8'))
    raw.budgets.x.daily = 1_000_000
    await writeFile(l.file, JSON.stringify(raw))
    expect((await ledger().read()).budgets).toEqual({})
  })

  it('予算の経路を付け替えた（x の記録を * に写した）ものは外す', async () => {
    const l = ledger()
    await l.putBudget('x', { daily: 100, monthly: null, decidedAt: 'd' })
    const raw = JSON.parse(await readFile(l.file, 'utf8'))
    raw.budgets['*'] = raw.budgets.x
    await writeFile(l.file, JSON.stringify(raw))
    expect(Object.keys((await ledger().read()).budgets)).toEqual(['x'])
  })

  it('運営の改ざんは外す', async () => {
    const l = ledger()
    await l.putOperations({ decision: 'fail', decidedAt: 'd' })
    const raw = JSON.parse(await readFile(l.file, 'utf8'))
    raw.operations.decision = 'pass'
    await writeFile(l.file, JSON.stringify(raw))
    expect((await ledger().read()).operations).toBeNull()
  })

  it('別のフォルダの記録を写しても通らない', async () => {
    const other = path.join(base, 'other')
    await mkdir(other)
    const lo = ledger(other)
    await lo.putApproval('A001', approved(req()))
    await mkdir(path.dirname(ledger().file), { recursive: true })
    await writeFile(ledger().file, await readFile(lo.file))
    expect((await ledger().read()).approvals).toEqual({})
  })

  it('違う鍵では読めない（再起動で鍵が変わったら待ちに戻る）', async () => {
    await ledger().putApproval('A001', approved(req()))
    const s = await ledger(root, async () => Buffer.alloc(32, 9)).read()
    expect(s.approvals).toEqual({})
  })

  it('壊れた JSON・形の違うファイルは空', async () => {
    await mkdir(dir, { recursive: true })
    const file = ledger().file
    await writeFile(file, '{oops')
    expect(await ledger().read()).toEqual(emptyLedgerState())
    await writeFile(file, '[1,2]')
    expect(await ledger().read()).toEqual(emptyLedgerState())
  })

  it('壊れたファイルでも書ける（確かめられた記録だけを残して書き直す）', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(ledger().file, 'garbage')
    await ledger().putApproval('A001', approved(req()))
    expect(Object.keys((await ledger().read()).approvals)).toEqual(['A001'])
  })

  it('大きすぎるファイルは読まない', async () => {
    await mkdir(dir, { recursive: true })
    await writeFile(ledger().file, Buffer.alloc(MAX_LEDGER_BYTES + 10, 0x20))
    expect(await ledger().read()).toEqual(emptyLedgerState())
  })

  it('置き場所のフォルダがリンクなら読まない・書かない', async () => {
    const elsewhere = path.join(base, 'elsewhere')
    await mkdir(elsewhere)
    await mkdir(path.dirname(dir), { recursive: true })
    await symlink(elsewhere, dir)
    await expect(ledger().putApproval('A001', approved(req()))).rejects.toThrow()
    const { readdir } = await import('node:fs/promises')
    expect(await readdir(elsewhere)).toEqual([])
    expect(await ledger().read()).toEqual(emptyLedgerState())
  })

  it('台帳のファイルがリンクなら読まない・書かない', async () => {
    const outside = path.join(base, 'outside.json')
    const l = ledger()
    await l.putApproval('A001', approved(req()))
    await writeFile(outside, await readFile(l.file))
    await rm(l.file)
    await symlink(outside, l.file)
    expect((await ledger().read()).approvals).toEqual({})
    await expect(l.putApproval('A002', approved(req({ id: 'A002' })))).rejects.toThrow()
    expect(JSON.parse(await readFile(outside, 'utf8')).approvals.A002).toBeUndefined()
  })

  it('形の違う記録は書かない', async () => {
    const l = ledger()
    await expect(l.putApproval('', approved(req()))).rejects.toThrow()
    await expect(l.putApproval('A'.repeat(41), approved(req()))).rejects.toThrow()
    await expect(l.putApproval('A001', { ...approved(req()), status: 'maybe' as 'approved' })).rejects.toThrow()
    await expect(l.putApproval('A001', { ...approved(req()), recordHash: 'abc' })).rejects.toThrow()
    await expect(l.putBudget('nope' as 'x', { daily: 1, monthly: 1, decidedAt: 'd' })).rejects.toThrow()
    await expect(l.putBudget('x', { daily: -1, monthly: 1, decidedAt: 'd' })).rejects.toThrow()
    await expect(l.replaceBudgets({ x: { daily: Number.NaN, monthly: null, decidedAt: 'd' } })).rejects.toThrow()
    await expect(l.putOperations({ decision: 'yes' as 'pass', decidedAt: 'd' })).rejects.toThrow()
    expect(await l.read()).toEqual(emptyLedgerState())
  })

  it('putBudget(null) で外し、replaceBudgets で丸ごと置き換える', async () => {
    const l = ledger()
    await l.putBudget('x', { daily: 1, monthly: 2, decidedAt: 'd' })
    await l.putBudget('*', { daily: 3, monthly: 4, decidedAt: 'd' })
    await l.putBudget('x', null)
    expect(Object.keys((await l.read()).budgets)).toEqual(['*'])
    await l.replaceBudgets({ 'meta-ads': { daily: 5, monthly: null, decidedAt: 'e' } })
    expect((await l.read()).budgets).toEqual({ 'meta-ads': { daily: 5, monthly: null, decidedAt: 'e' } })
  })

  it('同時に書いても全部残る（1本の列）', async () => {
    const l = ledger()
    await Promise.all(Array.from({ length: 20 }, (_, i) => l.putApproval(`A${String(i).padStart(3, '0')}`, approved(req({ id: `A${i}` })))))
    expect(Object.keys((await l.read()).approvals)).toHaveLength(20)
  })

  it('1件が失敗しても次の書き込みは通る', async () => {
    const l = ledger()
    await expect(l.putApproval('', approved(req()))).rejects.toThrow()
    await l.putApproval('A001', approved(req()))
    expect(Object.keys((await l.read()).approvals)).toEqual(['A001'])
  })
})

describe('VentureLedgerKeyStore', () => {
  const fakeCipher = (ok = true): KeyCipher & { encrypted: number } => {
    const c = {
      encrypted: 0,
      available: () => ok,
      encrypt: (text: string) => { c.encrypted++; return Buffer.from(`enc:${text}`) },
      decrypt: (data: Buffer) => {
        const s = data.toString()
        if (!s.startsWith('enc:')) throw new Error('bad')
        return s.slice(4)
      }
    }
    return c
  }

  it('暗号化できなければ起動中だけの鍵（ファイルを書かない）', async () => {
    const file = path.join(base, 'userData', 'k.bin')
    const ks = new VentureLedgerKeyStore(file, fakeCipher(false))
    const k1 = await ks.key()
    expect(k1).toHaveLength(32)
    expect(await ks.key()).toBe(k1)
    await expect(readFile(file)).rejects.toThrow()
  })

  it('暗号化できれば保存し、次の起動でも同じ鍵', async () => {
    const file = path.join(base, 'userData', 'k.bin')
    const k1 = await new VentureLedgerKeyStore(file, fakeCipher()).key()
    const k2 = await new VentureLedgerKeyStore(file, fakeCipher()).key()
    expect(k2.equals(k1)).toBe(true)
  })

  it('壊れた鍵のファイルは作り直す', async () => {
    const file = path.join(base, 'userData', 'k.bin')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, randomBytes(10))
    const cipher = fakeCipher()
    const k = await new VentureLedgerKeyStore(file, cipher).key()
    expect(k).toHaveLength(32)
    expect(cipher.encrypted).toBe(1)
  })

  it('同時に呼んでも鍵は1つ', async () => {
    const file = path.join(base, 'userData', 'k.bin')
    const cipher = fakeCipher()
    const ks = new VentureLedgerKeyStore(file, cipher)
    const [a, b, c] = await Promise.all([ks.key(), ks.key(), ks.key()])
    expect(a.equals(b) && b.equals(c)).toBe(true)
    expect(cipher.encrypted).toBe(1)
  })
})

describe('MemoryVentureLedger', () => {
  it('写しを返す（返した値を変えても中は変わらない）', async () => {
    const l = new MemoryVentureLedger()
    await l.putApproval('A001', approved(req()))
    const s = await l.read()
    s.approvals.A001.status = 'rejected'
    expect((await l.read()).approvals.A001.status).toBe('approved')
  })
  it('予算・運営', async () => {
    const l = new MemoryVentureLedger()
    await l.putBudget('x', { daily: 1, monthly: null, decidedAt: 'd' })
    await l.putBudget('x', null)
    await l.replaceBudgets({ '*': { daily: null, monthly: 9, decidedAt: 'd' } })
    await l.putOperations({ decision: null, decidedAt: 'd' })
    expect(await l.read()).toEqual({ approvals: {}, budgets: { '*': { daily: null, monthly: 9, decidedAt: 'd' } }, operations: { decision: null, decidedAt: 'd' } })
  })
})
