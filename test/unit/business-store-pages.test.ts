import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BusinessStore, type ConfirmRequest } from '../../src/main/business/store'
import { PageConfigStore, createPagesApi, isPrivateAddress, normalizeEndpoint, parseStats, validatePageContent, type LookupAll, type PagesApi } from '../../src/main/business/pages'
import { FileApprovalLedger, LedgerKeyStore, MemoryApprovalLedger } from '../../src/main/business/approvalLedger'
import { createPinnedFetch, pinnedLookup } from '../../src/main/business/pinnedFetch'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { mkdirSync as mkdirS, symlinkSync } from 'node:fs'
import { BusinessWatcher, isIgnored, type WatchFn } from '../../src/main/business/watcher'
import { listBusinesses } from '../../src/main/business/list'
import { businessHandlers } from '../../src/main/business/handlers'
import { emptyRecord } from '@shared/business/records'
import type { PageContent, PageStats } from '@shared/business/ipc'
import type { KeyCipher } from '../../src/main/pipeline/stt/keys'
import manual from '../../resources/business/手法.md?raw'

const NOW = new Date('2026-10-17T03:00:00.000Z')
let dir: string
let root: string
let store: BusinessStore
let ledger: MemoryApprovalLedger
let confirmAnswer = true
let confirms: ConfirmRequest[] = []
const confirm = async (r: ConfirmRequest) => { confirms.push(r); return confirmAnswer }
/** 公開の名前を引いた結果（本物の DNS は使わない） */
const publicLookup: LookupAll = async () => [{ address: '93.184.216.34', family: 4 }]
let pageOrigin = 'https://pages.example.com'
const sha = (t: string) => createHash('sha256').update(t).digest('hex')
const fixedKey = async () => Buffer.alloc(32, 7)

const content: PageContent = {
  headline: '月末の証憑回収を代行します', subhead: '', bullets: ['1', '2'], priceText: '月 3 万円', ctaLabel: '相談する', formIntro: '', consentText: '同意します', footerNote: ''
}

class FakeApi implements PagesApi {
  puts: Array<{ slug: string; status: string; experimentId: string }> = []
  unpublished: string[] = []
  statsCalls: Array<{ slug: string; from: string; to: string }> = []
  async put(slug: string, body: { experimentId: string; status: 'draft' | 'published' }) {
    this.puts.push({ slug, status: body.status, experimentId: body.experimentId })
  }
  async unpublish(slug: string) {
    this.unpublished.push(slug)
  }
  async stats(slug: string, from: string, to: string): Promise<PageStats> {
    this.statsCalls.push({ slug, from, to })
    return { slug, experimentId: 'X01', from, to, views: 120, uniqueVisitors: 80, ctaClicks: 12, interests: 3 }
  }
}

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'business-pages-')))
  root = join(dir, 'biz')
  mkdirSync(root)
  ledger = new MemoryApprovalLedger()
  confirmAnswer = true
  confirms = []
  pageOrigin = 'https://pages.example.com'
  store = new BusinessStore({ root, now: () => NOW, manual: '# 手法', ledger, confirm, pageOrigin: async () => pageOrigin })
  await store.init({ name: '経理', target: '' })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.useRealTimers()
})


describe('実験ページ: 公開は承認の後だけ', () => {
  beforeEach(async () => {
    await store.saveRecord('experiment', { ...emptyRecord('experiment', 'X01', ''), hypothesis: '' }, '本文')
  })

  it('承認が無い公開は、承認の依頼（待ち）を作って下書きだけ送る', async () => {
    const api = new FakeApi()
    const snap = await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    expect(api.puts).toEqual([{ slug: 'shohyo-kaishu', status: 'draft', experimentId: 'X01' }])
    expect(snap.data.experiments[0]!.page).toEqual({ slug: 'shohyo-kaishu', status: '下書き' })
    expect(snap.data.approvals).toHaveLength(1)
    expect(snap.data.approvals[0]).toMatchObject({ id: 'R01', kind: '実験ページの公開', status: '待ち', refs: ['X01'] })
    expect(snap.bodies.X01).toBe('本文\n')
    // もう一度押しても、待ちの依頼は増やさない
    const again = await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    expect(again.data.approvals).toHaveLength(1)
    expect(api.puts.map((p) => p.status)).toEqual(['draft', 'draft'])
  })

  it('承認済みなら公開する。却下なら下書きのまま', async () => {
    const api = new FakeApi()
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    await store.decideApproval('R01', '承認', '')
    // 承認の確認には main が読んだ中身（実験・slug・題名・見出し）を出す
    expect(confirms[0]!.detail).toContain('ページの名前: shohyo-kaishu')
    expect(confirms[0]!.detail).toContain('ページの題名: 証憑回収')
    expect(confirms[0]!.detail).toContain(`見出し: ${content.headline}`)
    const snap = await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    expect(confirms[1]).toMatchObject({ confirmLabel: '公開する' })
    expect(confirms[1]!.detail).toContain('実験: X01')
    expect(api.puts.at(-1)!.status).toBe('published')
    expect(snap.data.experiments[0]!.page).toEqual({ slug: 'shohyo-kaishu', status: '公開中' })
    await expect(store.pushPage({ experimentId: 'X01', slug: 'other-slug', title: 'x', content, publish: false }, async () => api)).rejects.toThrow('公開中のページの名前は変えられません')
    const stopped = await store.unpublishPage('X01', async () => api)
    expect(api.unpublished).toEqual(['shohyo-kaishu'])
    expect(stopped.data.experiments[0]!.page!.status).toBe('停止')
  })

  it('ほかの実験への承認では公開しない', async () => {
    const api = new FakeApi()
    await store.saveRecord('experiment', { ...emptyRecord('experiment', 'X02', ''), hypothesis: '' }, '')
    await store.pushPage({ experimentId: 'X02', slug: 'other-page', title: 't', content, publish: false }, async () => api)
    await store.saveRecord('approval', { ...emptyRecord('approval', 'R05', ''), kind: '実験ページの公開', refs: ['X02'] }, '')
    await store.decideApproval('R05', '承認', '')
    const snap = await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: 't', content, publish: true }, async () => api)
    expect(api.puts.at(-1)!.status).toBe('draft')
    expect(snap.data.approvals.map((a) => a.id)).toEqual(['R05', 'R06'])
  })

  it('下書きを送っていない実験の公開は承認できない', async () => {
    await store.saveRecord('approval', { ...emptyRecord('approval', 'R01', ''), kind: '実験ページの公開', refs: ['X01'] }, '')
    await expect(store.decideApproval('R01', '承認', '')).rejects.toThrow('下書きがまだ送られていません')
    expect(confirms).toEqual([])
    await store.saveRecord('approval', { ...emptyRecord('approval', 'R02', ''), kind: '実験ページの公開', refs: ['H01'] }, '')
    await expect(store.decideApproval('R02', '承認', '')).rejects.toThrow('どの実験のページか')
  })

  it('承認のあとに中身・ページの名前を変えたら公開せず、新しい承認の依頼を作る', async () => {
    const api = new FakeApi()
    const push = (over: Record<string, unknown> = {}) => store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true, ...over }, async () => api)
    await push()
    await store.decideApproval('R01', '承認', '')
    const changed = await push({ content: { ...content, headline: '別の見出し' } })
    expect(api.puts.at(-1)!.status).toBe('draft')
    expect(changed.data.experiments[0]!.page!.status).toBe('下書き')
    expect(changed.data.approvals.map((a) => [a.id, a.status])).toEqual([['R01', '承認'], ['R02', '待ち']])
    // 題名を変えても同じ（もう待ちがあるので増やさない）
    const retitled = await push({ title: '別の題名' })
    expect(api.puts.at(-1)!.status).toBe('draft')
    expect(retitled.data.approvals).toHaveLength(2)
    // slug を変えても、承認した slug ではないので公開しない
    await push({ slug: 'another-slug' })
    expect(api.puts.at(-1)!.status).toBe('draft')
    // 新しい依頼を承認すると、最後に送った中身（another-slug・証憑回収）でだけ公開できる
    await store.decideApproval('R02', '承認', '')
    await push({ slug: 'another-slug', title: '別の題名' })
    expect(api.puts.at(-1)!.status).toBe('draft')
    await push({ slug: 'another-slug' })
    expect(api.puts.at(-1)).toMatchObject({ slug: 'another-slug', status: 'published' })
  })

  it('公開の確認でやめたら、何も送らず記録も変えない', async () => {
    const api = new FakeApi()
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    await store.decideApproval('R01', '承認', '')
    const putsBefore = api.puts.length
    confirmAnswer = false
    await expect(store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)).rejects.toThrow('公開をやめました')
    expect(api.puts).toHaveLength(putsBefore)
    expect((await store.load()).data.experiments[0]!.page!.status).toBe('下書き')
  })

  it('承認の確認でやめたら、公開できない', async () => {
    const api = new FakeApi()
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    confirmAnswer = false
    await expect(store.decideApproval('R01', '承認', '')).rejects.toThrow('承認をやめました')
    confirmAnswer = true
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    expect(api.puts.map((p) => p.status)).toEqual(['draft', 'draft'])
  })

  it('ファイルを手で「承認」に書き換えても公開しない（正本はフォルダの外）', async () => {
    const api = new FakeApi()
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    const file = join(root, 'approvals', 'R01.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: 待ち', 'status: 承認'))
    const snap = await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    expect(api.puts.map((p) => p.status)).toEqual(['draft', 'draft'])
    expect(snap.data.approvals[0]!.status).toBe('待ち')
    expect(snap.issues.some((i) => i.ref === 'R01' && i.message === '承認の記録が一致しません（手で書き換えられた可能性）')).toBe(true)
  })

  it('別の種類で承認した依頼を「実験ページの公開」に書き換えても公開しない', async () => {
    const api = new FakeApi()
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: false }, async () => api)
    await store.saveRecord('approval', { ...emptyRecord('approval', 'R01', ''), kind: '外部へ送る', title: 'メールを送る', refs: ['H01'] }, '')
    await store.decideApproval('R01', '承認', '')
    const file = join(root, 'approvals', 'R01.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('kind: 外部へ送る', 'kind: 実験ページの公開').replace(/refs:\n\s+- H01/, 'refs:\n  - X01'))
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    expect(api.puts.map((p) => p.status)).toEqual(['draft', 'draft'])
  })

  it('正本はフォルダの実体のパスごとに userData の下へ置き、読み直せる', async () => {
    const dirLedger = join(dir, 'ud', 'business-approvals')
    const a = new FileApprovalLedger(dirLedger, root, fixedKey)
    const b = new FileApprovalLedger(dirLedger, join(root, '.', ''), fixedKey)
    expect(a.file).toBe(b.file)
    expect(a.file.startsWith(dirLedger)).toBe(true)
    expect(a.file).not.toContain(root)
    const s2 = new BusinessStore({ root, now: () => NOW, ledger: a, confirm })
    await s2.saveRecord('approval', { ...emptyRecord('approval', 'R01', ''), title: 'x' }, '')
    await s2.decideApproval('R01', '承認', 'ok')
    expect(Object.keys(await b.all())).toEqual(['R01'])
    writeFileSync(a.file, '壊れ')
    expect(await b.all()).toEqual({})
  })

  it('正本の HMAC が合わない記録（書き換え・足したもの・別の鍵）は無かったものとして扱い、「待ち」と知らせる', async () => {
    const dirLedger = join(dir, 'ud', 'business-approvals')
    const fileLedger = new FileApprovalLedger(dirLedger, root, fixedKey)
    const s2 = new BusinessStore({ root, now: () => NOW, ledger: fileLedger, confirm, pageOrigin: async () => pageOrigin })
    const api = new FakeApi()
    await s2.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    await s2.saveRecord('approval', { ...emptyRecord('approval', 'R02', ''), kind: '外部へ送る', title: '送る' }, '')
    await s2.decideApproval('R02', '却下', '')
    // 同じユーザーのほかのプロセスが、却下を承認に書き換え、R01 の承認を足す（binding は作り直せても HMAC は作れない）
    const raw = JSON.parse(readFileSync(fileLedger.file, 'utf8')) as { approvals: Record<string, Record<string, unknown>> }
    raw.approvals.R02!.status = '承認'
    raw.approvals.R01 = { ...raw.approvals.R02!, mac: '0'.repeat(64) }
    writeFileSync(fileLedger.file, JSON.stringify(raw))
    const file = join(root, 'approvals', 'R01.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('status: 待ち', 'status: 承認'))
    const all = await fileLedger.all()
    expect(Object.keys(all)).toEqual([])
    const snap = await s2.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    expect(api.puts.map((p) => p.status)).toEqual(['draft', 'draft'])
    expect(snap.data.approvals.find((a) => a.id === 'R01')!.status).toBe('待ち')
    expect(snap.issues.some((i) => i.ref === 'R01' && i.message.includes('一致しません'))).toBe(true)
    // 別の鍵で読むと、正しく書いた記録も確かめられない
    expect(await new FileApprovalLedger(dirLedger, root, async () => Buffer.alloc(32, 9)).all()).toEqual({})
  })

  it('正本の置き場所・ファイルがリンクなら読まない・書かない', async () => {
    const real = join(dir, 'elsewhere')
    mkdirS(real)
    const linkDir = join(dir, 'ud-link')
    symlinkSync(real, linkDir)
    const viaLink = new FileApprovalLedger(linkDir, root, fixedKey)
    await expect(viaLink.put('R01', { status: '承認', answer: '', decidedAt: '', kind: '外部へ送る', recordHash: 'a'.repeat(64), page: null, binding: 'b'.repeat(64) })).rejects.toThrow('リンク')
    expect(await viaLink.all()).toEqual({})
    const dirLedger = join(dir, 'ud2')
    const good = new FileApprovalLedger(dirLedger, root, fixedKey)
    await good.put('R01', { status: '却下', answer: '', decidedAt: '', kind: '外部へ送る', recordHash: 'a'.repeat(64), page: null, binding: 'b'.repeat(64) })
    const target = join(dir, 'target.json')
    writeFileSync(target, readFileSync(good.file))
    rmSync(good.file)
    symlinkSync(target, good.file)
    expect(await good.all()).toEqual({})
    writeFileSync(target, 'x'.repeat(5 * 1024 * 1024))
    rmSync(good.file)
    writeFileSync(good.file, 'x'.repeat(5 * 1024 * 1024))
    expect(await good.all()).toEqual({})
  })

  it('HMAC の鍵は暗号化して userData に置き、暗号化できなければ起動中だけ持つ', async () => {
    const cipher: KeyCipher = { available: () => true, encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString() }
    const file = join(dir, 'ud', 'key.bin')
    const k1 = await new LedgerKeyStore(file, cipher).key()
    expect(k1).toHaveLength(32)
    expect(readFileSync(file).includes(k1)).toBe(false)
    expect((await new LedgerKeyStore(file, cipher).key()).equals(k1)).toBe(true)
    const none: KeyCipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }
    const file2 = join(dir, 'ud', 'key2.bin')
    const k2 = await new LedgerKeyStore(file2, none).key()
    expect(existsSync(file2)).toBe(false)
    expect((await new LedgerKeyStore(file2, none).key()).equals(k2)).toBe(false)
  })

  it('承認のあとに実験ページの接続先が変わったら公開しない', async () => {
    const api = new FakeApi()
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    await store.decideApproval('R01', '承認', '')
    expect(confirms[0]!.detail).toContain('接続先: https://pages.example.com')
    pageOrigin = 'https://other.example.com'
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: '証憑回収', content, publish: true }, async () => api)
    expect(api.puts.map((p) => p.status)).toEqual(['draft', 'draft'])
    pageOrigin = ''
    await store.saveRecord('approval', { ...emptyRecord('approval', 'R09', ''), kind: '実験ページの公開', refs: ['X01'] }, '')
    await expect(store.decideApproval('R09', '承認', '')).rejects.toThrow('接続先が設定されていません')
  })
})

describe('実験ページの数を実測へ', () => {
  it('実施中・完了の実験だけ。interest = 関心表明、contacts = 訪問者数。plan は触らない', async () => {
    const x = emptyRecord('experiment', 'X01', '')
    x.plan.contacts = 500
    x.plan.interest = 10
    await store.saveRecord('experiment', x, '')
    const api = new FakeApi()
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: 't', content, publish: false }, async () => api)
    await expect(store.applyPageStats('X01', async () => api)).rejects.toThrow('実施中か完了')
    const loaded = (await store.load()).data.experiments[0]!
    await store.saveRecord('experiment', { ...loaded, status: '実施中', period: { start: '2026-10-01', end: '2026-12-31' } }, '')
    const snap = await store.applyPageStats('X01', async () => api)
    const after = snap.data.experiments[0]!
    expect(after.actual.interest).toBe(3)
    expect(after.actual.contacts).toBe(80)
    expect(after.actual.payments).toBeNull()
    expect(after.plan.contacts).toBe(500)
    expect(after.plan.interest).toBe(10)
    // 未来の終了日は今日まで
    expect(api.statsCalls.at(-1)).toEqual({ slug: 'shohyo-kaishu', from: '2026-10-01', to: '2026-10-17' })
  })

  it('ページの無い実験は断る。期間が無ければ今日までの 366 日', async () => {
    await store.saveRecord('experiment', emptyRecord('experiment', 'X01', ''), '')
    const api = new FakeApi()
    await expect(store.pageStats('X01', async () => api)).rejects.toThrow('実験ページがありません')
    await store.pushPage({ experimentId: 'X01', slug: 'shohyo-kaishu', title: 't', content, publish: false }, async () => api)
    const stats = await store.pageStats('X01', async () => api)
    expect(stats).toMatchObject({ from: '2025-10-17', to: '2026-10-17', interests: 3 })
  })

  it('期間が 366 日を超えれば縮める', () => {
    const x = { ...emptyRecord('experiment', 'X01', ''), period: { start: '2020-01-01', end: '2026-01-31' } }
    expect(store.statsRange(x)).toEqual({ from: '2025-01-31', to: '2026-01-31' })
    expect(store.statsRange({ ...x, period: { start: '2026-12-01', end: '' } })).toEqual({ from: '2026-10-17', to: '2026-10-17' })
  })
})

describe('接続先とトークン', () => {
  it('配布版は https だけ。dev 起動は 127.0.0.1・localhost の http も使える', () => {
    expect(normalizeEndpoint('https://pages.example.com/', true)).toBe('https://pages.example.com')
    expect(normalizeEndpoint('https://pages.example.com/base//', true)).toBe('https://pages.example.com/base')
    expect(normalizeEndpoint('', true)).toBe('')
    expect(() => normalizeEndpoint('http://pages.example.com', true)).toThrow('https://')
    expect(() => normalizeEndpoint('http://pages.example.com', false)).toThrow('https://')
    expect(() => normalizeEndpoint('http://127.0.0.1:8787', true)).toThrow('https://')
    expect(normalizeEndpoint('http://127.0.0.1:8787', false)).toBe('http://127.0.0.1:8787')
    expect(normalizeEndpoint('http://localhost:8787/', false)).toBe('http://localhost:8787')
    for (const bad of ['https://user:pw@x.com', 'https://x.com/?a=1', 'https://x.com/#a', 'ftp://x.com', 'javascript:alert(1)', 'not a url', 5]) {
      expect(() => normalizeEndpoint(bad, false), String(bad)).toThrow()
    }
  })

  it('API は Bearer を付け、失敗を日本語で返す', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = []
    const fetchOk = async (url: string, init?: RequestInit) => {
      seen.push({ url, init })
      return new Response(JSON.stringify({ slug: 'abc', experimentId: 'X01', from: '2026-10-01', to: '2026-10-17', views: 1, uniqueVisitors: 1, ctaClicks: 0, interests: 0 }), { status: 200 })
    }
    const api = createPagesApi('https://pages.example.com', 'tok_123', fetchOk)
    expect((await api.stats('abc', '2026-10-01', '2026-10-17')).uniqueVisitors).toBe(1)
    expect(seen[0]!.url).toBe('https://pages.example.com/api/pages/abc/stats?from=2026-10-01&to=2026-10-17')
    expect((seen[0]!.init!.headers as Record<string, string>).Authorization).toBe('Bearer tok_123')
    await api.put('abc', { experimentId: 'X01', title: 't', content, status: 'draft' })
    expect(seen[1]!.init!.method).toBe('PUT')
    expect(JSON.parse(String(seen[1]!.init!.body))).toMatchObject({ experimentId: 'X01', status: 'draft' })
    await api.unpublish('abc')
    expect(seen[2]).toMatchObject({ url: 'https://pages.example.com/api/pages/abc/unpublish', init: { method: 'POST' } })
    const status = (code: number) => createPagesApi('https://p.example.com', 't', async () => new Response('{"error":{"code":"x","message":"English"}}', { status: code }))
    await expect(status(401).unpublish('abc')).rejects.toThrow('トークンが違います')
    await expect(status(404).unpublish('abc')).rejects.toThrow('サーバーにありません')
    await expect(status(400).unpublish('abc')).rejects.toThrow('受け付けませんでした')
    await expect(status(500).unpublish('abc')).rejects.toThrow('HTTP 500')
    await expect(createPagesApi('https://p.example.com', 't', async () => { throw new TypeError('fetch failed') }).unpublish('abc')).rejects.toThrow('つながりません')
    await expect(createPagesApi('https://p.example.com', 't', async () => new Response('not json')).stats('abc', 'a', 'b')).rejects.toThrow('応答を読めませんでした')
    await expect(createPagesApi('https://p.example.com', 't', async () => new Response('x'.repeat(2 * 1024 * 1024))).unpublish('abc')).rejects.toThrow()
    expect(() => createPagesApi('', 't', fetchOk)).toThrow('接続先が設定されていません')
    expect(() => createPagesApi('https://p.example.com', '', fetchOk)).toThrow('トークンが設定されていません')
    await expect(api.unpublish('../admin')).rejects.toThrow('ページの名前')
  })

  it('統計の応答を確かめる', () => {
    const ok = { slug: 's-1', experimentId: 'X01', from: 'a', to: 'b', views: 1, uniqueVisitors: 2, ctaClicks: 3, interests: 4 }
    expect(parseStats(ok, 's-1').interests).toBe(4)
    expect(() => parseStats({ ...ok, slug: 'other' }, 's-1')).toThrow()
    expect(() => parseStats({ ...ok, views: -1 }, 's-1')).toThrow()
    expect(() => parseStats({ ...ok, interests: 1.5 }, 's-1')).toThrow()
    expect(() => parseStats(null, 's-1')).toThrow()
  })

  it('ページの中身を検査する', () => {
    expect(validatePageContent(content).bullets).toEqual(['1', '2'])
    expect(() => validatePageContent({ ...content, ctaLabel: '' })).toThrow('ボタンの文言')
    expect(() => validatePageContent({ ...content, subhead: 5 })).toThrow('小見出し')
    expect(() => validatePageContent('x')).toThrow()
  })

  it('トークンは暗号化して保存し、画面には有無だけを返す。空のトークンは変えない', async () => {
    const cipher: KeyCipher = { available: () => true, encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString() }
    const files = { config: join(dir, 'ud', 'business-pages.json'), token: join(dir, 'ud', 'business-pages-token.bin') }
    const cfg = new PageConfigStore(files, cipher, true, publicLookup)
    expect(await cfg.config()).toEqual({ endpoint: '', hasToken: false })
    expect(await cfg.set({ endpoint: 'https://pages.example.com/', token: 'secret-token' })).toEqual({ endpoint: 'https://pages.example.com', hasToken: true })
    expect(readFileSync(files.token, 'utf8')).not.toContain('secret-token')
    expect(readFileSync(files.config, 'utf8')).not.toContain('secret-token')
    const again = new PageConfigStore(files, cipher, true, publicLookup)
    expect(await again.token()).toBe('secret-token')
    // 同じ接続先（origin）なら空のトークンは変えない
    expect(await again.set({ endpoint: 'https://pages.example.com/', token: '' })).toEqual({ endpoint: 'https://pages.example.com', hasToken: true })
    expect(await again.token()).toBe('secret-token')
    await expect(again.set({ endpoint: 'http://x.com', token: '' })).rejects.toThrow('https://')
    await expect(again.set({ endpoint: 'https://x.com', token: 'with space' })).rejects.toThrow('トークン')
    expect(await again.token()).toBe('secret-token')
  })

  it('接続先を変えてトークンを入れなければ、前のトークンは消す（別の接続先へ送らない）', async () => {
    const cipher: KeyCipher = { available: () => true, encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString() }
    const files = { config: join(dir, 'ud', 'business-pages.json'), token: join(dir, 'ud', 'business-pages-token.bin') }
    const cfg = new PageConfigStore(files, cipher, true, publicLookup)
    await cfg.set({ endpoint: 'https://pages.example.com', token: 'secret-token' })
    expect(await cfg.set({ endpoint: 'https://attacker.example', token: '' })).toEqual({ endpoint: 'https://attacker.example', hasToken: false })
    expect(existsSync(files.token)).toBe(false)
    const api = await cfg.api().catch((err: Error) => err)
    expect(api).toBeInstanceOf(Error)
    expect((api as Error).message).toContain('トークンが設定されていません')
    // 戻しても、消したトークンは戻らない
    expect((await cfg.set({ endpoint: 'https://pages.example.com', token: '' })).hasToken).toBe(false)
    // 新しい接続先と新しいトークンなら使える
    expect((await cfg.set({ endpoint: 'https://pages2.example.com', token: 'new-token' })).hasToken).toBe(true)
  })

  it('トークンを保存した origin と違う接続先へは送らない（設定ファイルを書き換えても）', async () => {
    const cipher: KeyCipher = { available: () => true, encrypt: (s) => Buffer.from(`enc:${Buffer.from(s).toString('base64')}`), decrypt: (b) => Buffer.from(b.toString().slice(4), 'base64').toString() }
    const files = { config: join(dir, 'ud', 'business-pages.json'), token: join(dir, 'ud', 'business-pages-token.bin') }
    await new PageConfigStore(files, cipher, true, publicLookup).set({ endpoint: 'https://pages.example.com', token: 'secret-token' })
    writeFileSync(files.config, JSON.stringify({ endpoint: 'https://attacker.example' }))
    const fetched: string[] = []
    const cfg = new PageConfigStore(files, cipher, true, publicLookup, async (url) => { fetched.push(url); return new Response('{}') })
    expect(await cfg.config()).toEqual({ endpoint: 'https://attacker.example', hasToken: false })
    await expect(cfg.api()).rejects.toThrow('トークンが設定されていません')
    expect(fetched).toEqual([])
    // 古い形（origin の無いトークン）は使わない
    writeFileSync(files.config, JSON.stringify({ endpoint: 'https://pages.example.com' }))
    writeFileSync(files.token, cipher.encrypt('bare-token'))
    expect(await new PageConfigStore(files, cipher, true, publicLookup).hasToken()).toBe(false)
    expect(() => createPagesApi('https://a.example.com', 't', async () => new Response('{}'), { tokenOrigin: 'https://b.example.com' })).toThrow('トークンが設定されていません')
  })

  it('社内・手元のアドレスの接続先は断る（名前の形・名前を引いた結果）', async () => {
    for (const bad of ['https://10.0.0.1', 'https://127.0.0.1', 'https://[::1]', 'https://[fd00::1]', 'https://169.254.169.254', 'https://localhost', 'https://api.localhost', 'https://printer.local', 'https://metadata.google.internal', 'https://intranet', 'https://0x7f000001', 'https://2130706433']) {
      expect(() => normalizeEndpoint(bad, true), bad).toThrow()
    }
    for (const ip of ['10.1.2.3', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00:ec2::254', 'fe80::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', 'not-an-ip']) {
      expect(isPrivateAddress(ip), ip).toBe(true)
    }
    for (const ip of ['93.184.216.34', '104.16.0.1', '2606:4700::1']) expect(isPrivateAddress(ip), ip).toBe(false)
    const cipher: KeyCipher = { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }
    const files = { config: join(dir, 'ud', 'c.json'), token: join(dir, 'ud', 't.bin') }
    const lookups: string[] = []
    const privateLookup: LookupAll = async (host) => { lookups.push(host); return [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }] }
    const cfg = new PageConfigStore(files, cipher, true, privateLookup)
    await expect(cfg.set({ endpoint: 'https://pages.example.com', token: 'tok' })).rejects.toThrow('社内・手元のアドレスは使えません')
    expect(lookups).toEqual(['pages.example.com'])
    expect(existsSync(files.config)).toBe(false)
    const failing = new PageConfigStore(files, cipher, true, async () => { throw new Error('ENOTFOUND') })
    await expect(failing.set({ endpoint: 'https://pages.example.com', token: 'tok' })).rejects.toThrow('名前を引けませんでした')
  })

  it('引いたアドレスを確かめ、確かめたアドレスにだけつなぐ（混ぜた答えは断る）', async () => {
    const calls: unknown[] = []
    const cb = (...args: unknown[]) => calls.push(args)
    const ok = pinnedLookup(async () => [{ address: '93.184.216.34', family: 4 }], (a) => a === '93.184.216.34')
    ok('pages.example.com', {}, cb as never)
    ok('pages.example.com', { all: true }, cb as never)
    const mixed = pinnedLookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }], (a) => a === '93.184.216.34')
    mixed('pages.example.com', {}, cb as never)
    await new Promise((r) => setTimeout(r, 10))
    expect(calls[0]).toEqual([null, '93.184.216.34', 4])
    expect(calls[1]).toEqual([null, [{ address: '93.184.216.34', family: 4 }]])
    expect((calls[2] as [Error])[0]).toMatchObject({ code: 'EBLOCKEDADDRESS' })
  })

  it('送るたびに引き直し、つなぐ先は確かめたアドレスそのもの。社内に変わったら送らない（DNS の差し替え）', async () => {
    const hits: string[] = []
    const server = createServer((req, res) => { hits.push(`${req.method} ${req.url} host=${req.headers.host}`); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}') })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as AddressInfo).port
    try {
      // テストでは 127.0.0.1 を「公開のアドレス」とみなす。2回目の名前引きは社内のアドレスを返す
      const answers = ['127.0.0.1', '10.0.0.5']
      let n = 0
      const fetchPinned = createPinnedFetch(async () => [{ address: answers[Math.min(n++, 1)]!, family: 4 }], (a) => a === '127.0.0.1')
      const first = await fetchPinned(`http://pages.example.test:${port}/api/x`, { method: 'GET', headers: { Authorization: 'Bearer t' } })
      expect(first.status).toBe(200)
      expect(await first.json()).toEqual({ ok: true })
      expect(hits).toEqual([`GET /api/x host=pages.example.test:${port}`])
      const api = createPagesApi(`http://pages.example.test:${port}`, 'tok', fetchPinned)
      await expect(api.unpublish('abc')).rejects.toThrow('社内・手元のアドレスは使えません')
      expect(hits).toHaveLength(1)
      // IP の直書きも同じように確かめる
      await expect(createPinnedFetch(publicLookup, () => false)(`http://127.0.0.1:${port}/`)).rejects.toMatchObject({ code: 'EBLOCKEDADDRESS' })
      expect(hits).toHaveLength(1)
      // 時間の上限（signal）で切れる
      const slow = createServer(() => undefined)
      await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()))
      const slowPort = (slow.address() as AddressInfo).port
      await expect(createPinnedFetch(async () => [{ address: '127.0.0.1', family: 4 }], () => true)(`http://x.example.test:${slowPort}/`, { signal: AbortSignal.timeout(100) })).rejects.toThrow()
      slow.closeAllConnections()
      slow.close()
    } finally {
      server.close()
    }
  })

  it('暗号化できなければトークンを書かず、起動中だけ持つ', async () => {
    const cipher: KeyCipher = { available: () => false, encrypt: () => { throw new Error('no') }, decrypt: () => { throw new Error('no') } }
    const files = { config: join(dir, 'ud', 'c.json'), token: join(dir, 'ud', 't.bin') }
    const cfg = new PageConfigStore(files, cipher, false, async () => { throw new Error('dev の手元は名前を引かない') })
    expect((await cfg.set({ endpoint: 'http://127.0.0.1:8787', token: 'tok' })).hasToken).toBe(true)
    expect(existsSync(files.token)).toBe(false)
    expect(await cfg.token()).toBe('tok')
  })
})

describe('見張り（business:changed）', () => {
  function fakeWatch() {
    const handles: Array<{ root: string; emit: (f: string | null) => void; closed: boolean }> = []
    const fn: WatchFn = (root, onChange) => {
      const h = { root, emit: onChange, closed: false }
      handles.push(h)
      return { close: () => { h.closed = true } }
    }
    return { fn, handles }
  }

  it('続けて来た変更を 300ms まとめて1回知らせる。アプリが書く場所は知らせない', () => {
    vi.useFakeTimers()
    const { fn, handles } = fakeWatch()
    const changed = vi.fn()
    const w = new BusinessWatcher(changed, fn)
    w.watch('/biz')
    handles[0]!.emit('evidence/E01.md')
    vi.advanceTimersByTime(200)
    handles[0]!.emit('hypotheses/H01.md')
    vi.advanceTimersByTime(299)
    expect(changed).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(changed).toHaveBeenCalledTimes(1)
    for (const f of ['.business/sent/a.md', '.business/captures/E01/page.png', '.business/context.md', '.git/index', 'evidence/.E01.md.123.abcdef12.tmp', 'evidence/E01.md.4567.0a1b2c3d.tmp']) handles[0]!.emit(f)
    vi.advanceTimersByTime(1000)
    expect(changed).toHaveBeenCalledTimes(1)
    handles[0]!.emit(null)
    vi.advanceTimersByTime(300)
    expect(changed).toHaveBeenCalledTimes(2)
  })

  it('プロジェクトを切り替えたら前の見張りを止める', () => {
    vi.useFakeTimers()
    const { fn, handles } = fakeWatch()
    const changed = vi.fn()
    const w = new BusinessWatcher(changed, fn)
    w.watch('/a')
    w.watch('/a')
    expect(handles).toHaveLength(1)
    handles[0]!.emit('business.yaml')
    w.watch('/b')
    expect(handles[0]!.closed).toBe(true)
    vi.advanceTimersByTime(500)
    expect(changed).not.toHaveBeenCalled()
    w.watch(null)
    expect(handles[1]!.closed).toBe(true)
    expect(w.root).toBeNull()
  })

  it('見張れないフォルダでも落ちない', () => {
    const w = new BusinessWatcher(() => undefined, () => { throw new Error('ENOENT') })
    expect(() => w.watch('/nope')).not.toThrow()
    expect(w.root).toBeNull()
  })

  it('isIgnored', () => {
    expect(isIgnored('business.yaml')).toBe(false)
    expect(isIgnored('.business\\sent\\x.md')).toBe(true)
    expect(isIgnored('.business/proposals/p.md')).toBe(false)
  })
})

describe('business:list', () => {
  it('ビジネスのプロジェクトだけを、待ちの承認と今の仮説の段階つきで返す', async () => {
    await store.saveRecord('hypothesis', emptyRecord('hypothesis', 'H01', ''), '')
    await store.advanceStage('H01', 'ネット上の有望仮説', '')
    await store.updateBusiness({ currentHypothesis: 'H01', step: 'S4' })
    await store.saveRecord('approval', emptyRecord('approval', 'R01', ''), '')
    await store.saveRecord('approval', emptyRecord('approval', 'R02', ''), '')
    await store.decideApproval('R02', '承認', '')
    writeFileSync(join(root, 'approvals', 'R03.md'), '壊れ')
    const plain = join(dir, 'plain')
    mkdirSync(plain)
    const items = await listBusinesses([
      { id: 'p1', folderPath: root },
      { id: 'p2', folderPath: plain },
      { id: 'p3', folderPath: join(dir, 'missing') },
      { id: 'p4', folderPath: root, source: 'ssh' }
    ])
    expect(items).toEqual([{ projectId: 'p1', name: '経理', step: 'S4', loop: 1, stage: 'ネット上の有望仮説', pendingApprovals: 1 }])
  })
})

describe('handlers', () => {
  it('フォルダが無ければ status は空、ほかは日本語で断る。登録のキーがそろっている', async () => {
    const pages = new PageConfigStore({ config: join(dir, 'c.json'), token: join(dir, 't.bin') }, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }, false)
    let current: string | null = null
    const consent = true
    const h = businessHandlers({
      root: () => current, projects: () => [], manual: '# 手法', pages,
      sender: { send: async () => ({ ok: false, message: 'いません', label: '' }) },
      capture: async () => ({ url: 'https://example.com', title: '', selection: '', png: new Uint8Array() }),
      now: () => NOW,
      consentSend: () => consent,
      confirm
    })
    expect(await h['business:status']()).toEqual({ root: null, isBusiness: false, name: null })
    await expect(Promise.resolve().then(() => h['business:load']())).rejects.toThrow('プロジェクトのフォルダを開いてください。')
    current = root
    expect(await h['business:status']()).toEqual({ root, isBusiness: true, name: '経理' })
    const { ticket } = await h['business:armSend']({ promptId: 'S1-candidates', textHash: sha('x'), target: { kind: 'active' } }) as { ticket: string }
    const r = await h['business:send']({ promptId: 'S1-candidates', text: 'x', target: { kind: 'active' }, ticket }) as { ok: boolean }
    expect(r.ok).toBe(false)
    const cap = await h['business:captureEvidence']({ hypothesisId: null }) as { id: string }
    expect(cap.id).toBe('E01')
    await expect(Promise.resolve().then(() => h['business:pushPage']({ experimentId: 'X01', slug: 'abc', title: 't', content, publish: false }))).rejects.toThrow()
  })

  it('Agent へ送るのは、操作の直後に作った札と、プロンプト・本文・送り先が合うときだけ', async () => {
    const pages = new PageConfigStore({ config: join(dir, 'c.json'), token: join(dir, 't.bin') }, { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }, false)
    let consent = false
    let clock = NOW.getTime()
    const texts: string[] = []
    const h = businessHandlers({
      root: () => root, projects: () => [], manual: '# 手法', pages,
      sender: { send: async (_t, text) => { texts.push(text); return { ok: true, message: '送りました', label: 'Codex' } } },
      capture: async () => ({ url: 'https://example.com', title: '', selection: '', png: new Uint8Array() }),
      now: () => new Date(clock),
      consentSend: () => consent,
      confirm
    })
    const req = { promptId: 'S1-candidates', text: '本文', target: { kind: 'active' as const } }
    const arm = (over: Record<string, unknown> = {}) => Promise.resolve().then(() => h['business:armSend']({ promptId: req.promptId, textHash: sha(req.text), target: req.target, ...over } as never) as { ticket: string })
    const send = (r: Record<string, unknown>) => Promise.resolve().then(() => h['business:send'](r as never))
    // 札なし・操作なし・偽の札は断る
    await expect(send(req)).rejects.toThrow('送るボタンを押してから')
    await expect(arm()).rejects.toThrow('送るボタンを押してから')
    await expect(send({ ...req, ticket: 'forged' })).rejects.toThrow('送るボタンを押してから')
    expect(texts).toEqual([])
    consent = true
    // 操作があっても札なしでは送らない
    await expect(send(req)).rejects.toThrow('送るボタンを押してから')
    const { ticket } = await arm()
    consent = false
    expect(await send({ ...req, ticket })).toMatchObject({ ok: true })
    // 札は1回きり
    await expect(send({ ...req, ticket })).rejects.toThrow('送るボタンを押してから')
    // 札は本文・プロンプト・送り先に結び付く（違えば使えず、札も消える）
    consent = true
    for (const change of [{ text: '別の本文' }, { promptId: 'S2-research' }, { target: { kind: 'terminal', id: 't9' } }]) {
      const t = (await arm()).ticket
      await expect(send({ ...req, ...change, ticket: t })).rejects.toThrow('送るボタンを押してから')
      await expect(send({ ...req, ticket: t })).rejects.toThrow('送るボタンを押してから')
    }
    // 新しい Agent の札は、起動したターミナルへの送信に使える
    const t2 = (await arm({ target: { kind: 'new', agent: 'codex' } })).ticket
    expect(await send({ ...req, target: { kind: 'terminal', id: 't1' }, ticket: t2 })).toMatchObject({ ok: true })
    // 60 秒を過ぎた札は使えない
    const t3 = (await arm()).ticket
    clock += 61_000
    await expect(send({ ...req, ticket: t3 })).rejects.toThrow('送るボタンを押してから')
    expect(texts).toHaveLength(2)
    await expect(arm({ textHash: 'zz' })).rejects.toThrow('本文')
  })
})

describe('手法.md', () => {
  it('resources/business/手法.md を埋め込める', () => {
    expect(manual).toContain('バーニングニーズ調査マニュアル')
  })
})

describe('承認・公開の確認（ネイティブのダイアログ）', () => {
  it('窓のダイアログで「承認する」を押したときだけ true。既定は「やめる」。窓が無ければ断る。E2E だけ答えを決められる', async () => {
    const { dialogConfirm } = await import('../../src/main/business/electronGlue')
    const shown: unknown[] = []
    const win = { isDestroyed: () => false } as never
    const ask = (response: number, w: unknown = win, e2eAnswer: string | null = null) => dialogConfirm({
      window: () => w as never,
      showMessageBox: async (_w, options) => { shown.push(options); return { response } },
      e2eAnswer
    })({ message: 'R01 を承認しますか？', detail: '種類: 外部へ送る', confirmLabel: '承認する' })
    expect(await ask(0)).toBe(true)
    expect(shown[0]).toMatchObject({ buttons: ['承認する', 'やめる'], defaultId: 1, cancelId: 1, detail: '種類: 外部へ送る' })
    expect(await ask(1)).toBe(false)
    expect(await ask(0, null)).toBe(false)
    expect(shown).toHaveLength(2)
    expect(await ask(1, null, 'yes')).toBe(true)
    expect(await ask(0, win, 'no')).toBe(false)
  })
})
