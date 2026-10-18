/**
 * 人の判断（承認・却下）の正本。ビジネスのフォルダ（Agent が書ける）の外、userData/business-approvals/ に置く。
 *
 * - ファイル名はビジネスのフォルダの実体のパスの sha256（同じフォルダを別の名前で開いても同じ記録）
 * - 1件ごとに、判断したときの依頼の中身（種類・関係する ID・題名・内容）のハッシュを持つ。
 *   「実験ページの公開」は、実験 ID・ページの名前（slug）・公開する中身のハッシュにも結び付ける
 * - approvals/ のファイルは写し。公開の判定はここだけを見る（ファイルの status は信じない）
 * - 1件ごとに HMAC-SHA256（鍵は乱数で、OS の鍵の仕組み＝Electron の safeStorage で暗号化して userData に置く）を付け、
 *   読むときに確かめる。合わないもの（同じユーザーのほかのプロセスが書き換えた・足した）は無かったものとして扱う。
 *   暗号化できない環境（dev 起動・E2E）は、トークンと同じく鍵を起動中だけ持つ（再起動すると判断は「待ち」に戻る）
 * - 置き場所のフォルダ・ファイルがリンクなら読まない・書かない。読む前に大きさを確かめる
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { UserFacingError } from '@shared/errors'
import type { KeyCipher } from '../pipeline/stt/keys'
import { readFileNoFollow } from '../sessions/containment'
import type { Approval } from '@shared/business/model'
import type { PageContent } from '@shared/business/ipc'
import { savePrivateFile } from '../atomicFile'

/** 公開に結び付けたページ */
export interface BoundPage {
  experimentId: string
  slug: string
  contentHash: string
  /** 承認したときの実験ページの接続先（origin） */
  origin: string
}

export interface LedgerEntry {
  status: '承認' | '却下'
  answer: string
  decidedAt: string
  kind: Approval['kind']
  /** 種類・関係する ID・題名・内容のハッシュ */
  recordHash: string
  page: BoundPage | null
  /** recordHash と page をまとめたハッシュ */
  binding: string
}

export interface ApprovalLedger {
  all(): Promise<Record<string, LedgerEntry>>
  put(id: string, entry: LedgerEntry): Promise<void>
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function recordHash(a: Pick<Approval, 'kind' | 'refs' | 'title' | 'detail'>): string {
  return sha256(JSON.stringify(['approval-v1', a.kind, [...a.refs], a.title, a.detail]))
}

/** 公開する中身（題名と本文）のハッシュ。キーの順に左右されない */
export function pageContentHash(title: string, content: PageContent): string {
  const c = content
  return sha256(JSON.stringify(['page-v1', title, c.headline, c.subhead, [...c.bullets], c.priceText, c.ctaLabel, c.formIntro, c.consentText, c.footerNote]))
}

export function bindingOf(record: string, page: BoundPage | null): string {
  return sha256(JSON.stringify(['binding-v2', record, page ? [page.experimentId, page.slug, page.contentHash, page.origin] : null]))
}

export function makeEntry(input: Omit<LedgerEntry, 'binding' | 'recordHash'> & { approval: Pick<Approval, 'kind' | 'refs' | 'title' | 'detail'> }): LedgerEntry {
  const rh = recordHash(input.approval)
  return { status: input.status, answer: input.answer, decidedAt: input.decidedAt, kind: input.kind, recordHash: rh, page: input.page, binding: bindingOf(rh, input.page) }
}

/** 中身が壊れていない（binding が recordHash と page から作り直せる）か */
export function entryIntact(e: LedgerEntry): boolean {
  return e.binding === bindingOf(e.recordHash, e.page)
}

const MAX_LEDGER_BYTES = 4 * 1024 * 1024
const HEX64 = /^[0-9a-f]{64}$/

function coerceEntry(raw: unknown): LedgerEntry | null {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null
  if (!o) return null
  if (o.status !== '承認' && o.status !== '却下') return null
  if (typeof o.answer !== 'string' || typeof o.decidedAt !== 'string' || typeof o.kind !== 'string') return null
  if (typeof o.recordHash !== 'string' || !HEX64.test(o.recordHash) || typeof o.binding !== 'string' || !HEX64.test(o.binding)) return null
  let page: BoundPage | null = null
  if (o.page !== null && o.page !== undefined) {
    const p = o.page as Record<string, unknown>
    if (typeof p !== 'object' || typeof p.experimentId !== 'string' || typeof p.slug !== 'string' || typeof p.contentHash !== 'string' || typeof p.origin !== 'string') return null
    page = { experimentId: p.experimentId, slug: p.slug, contentHash: p.contentHash, origin: p.origin }
  }
  return { status: o.status, answer: o.answer, decidedAt: o.decidedAt, kind: o.kind as Approval['kind'], recordHash: o.recordHash, page, binding: o.binding }
}

/** HMAC の鍵。暗号化できれば userData に暗号化して置き、できなければ起動中だけ持つ */
export class LedgerKeyStore {
  private cached: Buffer | null = null

  constructor(private readonly file: string, private readonly cipher: KeyCipher) {}

  async key(): Promise<Buffer> {
    if (this.cached) return this.cached
    if (!this.cipher.available()) {
      this.cached = randomBytes(32)
      return this.cached
    }
    try {
      const raw = await readFileNoFollow(this.file, null, { maxBytes: 4096 })
      const key = Buffer.from(this.cipher.decrypt(raw), 'base64')
      if (key.length === 32) {
        this.cached = key
        return key
      }
    } catch {
      // 無い・読めない・リンク: 作り直す（前の判断は確かめられないので「待ち」に戻る）
    }
    const key = randomBytes(32)
    await assertNotLink(path.dirname(this.file))
    await savePrivateFile(this.file, this.cipher.encrypt(key.toString('base64')))
    this.cached = key
    return key
  }
}

async function assertNotLink(dir: string): Promise<void> {
  const st = await lstat(dir).catch(() => null)
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new UserFacingError('承認の記録の置き場所がリンクになっているため、保存しません。')
}

function macOf(key: Buffer, scope: string, id: string, e: LedgerEntry): string {
  const body = JSON.stringify(['ledger-mac-v1', scope, id, e.status, e.answer, e.decidedAt, e.kind, e.recordHash, e.page ? [e.page.experimentId, e.page.slug, e.page.contentHash, e.page.origin] : null, e.binding])
  return createHmac('sha256', key).update(body).digest('hex')
}

function macMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !HEX64.test(given)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'))
}

/** userData/business-approvals/<sha256(フォルダの実体のパス)>.json。1件ごとに HMAC を付ける */
export class FileApprovalLedger implements ApprovalLedger {
  readonly file: string
  private readonly scope: string

  constructor(dir: string, root: string, private readonly key: () => Promise<Buffer>) {
    let real: string
    try {
      real = realpathSync(root)
    } catch {
      real = path.resolve(root)
    }
    this.scope = sha256(real)
    this.file = path.join(dir, `${this.scope}.json`)
  }

  /** 確かめられた記録だけ（HMAC の合わないもの・形の違うものは除く） */
  async all(): Promise<Record<string, LedgerEntry>> {
    const dirStat = await lstat(path.dirname(this.file)).catch(() => null)
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return {}
    let raw: string
    try {
      raw = await readFileNoFollow(this.file, 'utf8', { maxBytes: MAX_LEDGER_BYTES }) // リンク・普通でないファイル・大きすぎるものは読まない
    } catch {
      return {}
    }
    const key = await this.key()
    try {
      const o = JSON.parse(raw) as { approvals?: Record<string, unknown> }
      const out: Record<string, LedgerEntry> = {}
      for (const [id, v] of Object.entries(o.approvals ?? {})) {
        const e = coerceEntry(v)
        if (e && macMatches(macOf(key, this.scope, id, e), (v as { mac?: unknown }).mac)) out[id] = e
      }
      return out
    } catch {
      return {}
    }
  }

  async put(id: string, entry: LedgerEntry): Promise<void> {
    const dir = path.dirname(this.file)
    await assertNotLink(dir)
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await assertNotLink(dir)
    const key = await this.key()
    const current = await this.all()
    const approvals: Record<string, LedgerEntry & { mac: string }> = {}
    for (const [k, e] of Object.entries({ ...current, [id]: entry })) approvals[k] = { ...e, mac: macOf(key, this.scope, k, e) }
    const text = `${JSON.stringify({ version: 2, approvals }, null, 2)}\n`
    if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) throw new UserFacingError('承認の記録が大きくなりすぎたため、保存できません。')
    await savePrivateFile(this.file, text)
  }
}

/** テスト用・userData の無いとき用（起動中だけ） */
export class MemoryApprovalLedger implements ApprovalLedger {
  private entries: Record<string, LedgerEntry> = {}

  async all(): Promise<Record<string, LedgerEntry>> {
    return structuredClone(this.entries)
  }

  async put(id: string, entry: LedgerEntry): Promise<void> {
    this.entries[id] = structuredClone(entry)
  }
}
