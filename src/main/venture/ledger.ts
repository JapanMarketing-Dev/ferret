/**
 * ビジネスの人の判断（承認・却下・予算の上限・運営の段階）の正本。ビジネスのフォルダ（Agent が書ける）の外、userData/venture-approvals/ に置く。
 * ビジネス担当の FileApprovalLedger（src/main/business/approvalLedger.ts）と同じ作法:
 *
 * - ファイル名はビジネスのフォルダの実体のパスの sha256（同じフォルダを別の名前で開いても同じ記録）
 * - 承認は依頼の中身（kind・refs・title・detail）のハッシュ（recordHash）に結び付く。中身が変われば画面では changed
 * - 1件ごとに HMAC-SHA256（鍵は乱数で、chooseKeyCipher の KeyCipher で暗号化して userData/venture-approvals-key.bin に置く）。
 *   読むときに確かめ、合わないもの（ほかのプロセスが書き換えた・足した・別のフォルダの記録を写した）は無かったものとして扱う。
 *   暗号化できない環境（dev 起動・E2E）は鍵を起動中だけ持つ（再起動すると判断は「待ち」に戻る）
 * - 置き場所のフォルダ・ファイルがリンクなら読まない・書かない。読む前に大きさを確かめる
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { lstat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'
import { APPROVAL_KINDS, CHANNELS } from '@shared/venture/model'
import type { ApprovalKind, ApprovalRequest, ApprovalView, BudgetCap, Channel, OperationsDecision } from '@shared/venture/model'
import type { KeyCipher } from '../pipeline/stt/keys'
import { readFileNoFollow } from '../sessions/containment'
import { savePrivateFile } from '../atomicFile'

/** 承認・却下の1件 */
export interface ApprovalEntry {
  status: 'approved' | 'rejected'
  answer: string
  decidedAt: string
  kind: ApprovalKind
  /** 判断したときの依頼の中身（kind・refs・title・detail）のハッシュ */
  recordHash: string
}

/** 人が承認した予算の上限（経路ごと） */
export interface BudgetEntry {
  daily: number | null
  monthly: number | null
  decidedAt: string
}

/** 運営の段階の人の判断 */
export interface OperationsEntry {
  decision: OperationsDecision
  decidedAt: string
}

export interface LedgerState {
  approvals: Record<string, ApprovalEntry>
  /** 鍵は経路（CHANNELS）か '*' */
  budgets: Record<string, BudgetEntry>
  operations: OperationsEntry | null
}

export interface VentureLedger {
  /** 確かめられた記録だけ */
  read(): Promise<LedgerState>
  putApproval(id: string, entry: ApprovalEntry): Promise<void>
  /** null なら外す */
  putBudget(channel: Channel | '*', entry: BudgetEntry | null): Promise<void>
  /** 予算の承認を丸ごと置き換える（案に無くなった経路は外れる） */
  replaceBudgets(budgets: Record<string, BudgetEntry>): Promise<void>
  putOperations(entry: OperationsEntry): Promise<void>
}

/** 台帳のファイルの上限 */
export const MAX_LEDGER_BYTES = 4 * 1024 * 1024
/** 承認の id・メモの上限（台帳に書く前に確かめる） */
export const LEDGER_LIMITS = { id: 40, answer: 2000, maxBudget: 1e12 } as const

const HEX64 = /^[0-9a-f]{64}$/

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

export function emptyLedgerState(): LedgerState {
  return { approvals: {}, budgets: {}, operations: null }
}

/** 依頼の中身のハッシュ（refs の並びも含む） */
export function recordHash(a: Pick<ApprovalRequest, 'kind' | 'refs' | 'title' | 'detail'>): string {
  return sha256(JSON.stringify(['venture-approval-v1', a.kind, [...(a.refs ?? [])], a.title, a.detail ?? '']))
}

/**
 * ファイルの依頼と台帳を照らした状態。ファイルの status は見ない（parseApprovals が落としている）。
 * 承認したあとに中身が変われば changed、却下したあとに変われば pending（判断し直し）
 */
export function approvalViews(requests: readonly ApprovalRequest[], state: LedgerState): ApprovalView[] {
  return requests.map((r) => {
    const e = Object.prototype.hasOwnProperty.call(state.approvals, r.id) ? state.approvals[r.id] : undefined
    if (!e) return { ...r, status: 'pending' }
    if (e.recordHash !== recordHash(r)) return e.status === 'approved' ? { ...r, status: 'changed', decidedAt: e.decidedAt } : { ...r, status: 'pending' }
    return { ...r, status: e.status, decidedAt: e.decidedAt, ...(e.answer ? { answer: e.answer } : {}) }
  })
}

/** 台帳の予算を BudgetCap の並び（'*' のあと CHANNELS の順） */
export function approvedBudgets(state: LedgerState): BudgetCap[] {
  const order: Array<Channel | '*'> = ['*', ...CHANNELS]
  return order.flatMap((channel) => {
    const e = Object.prototype.hasOwnProperty.call(state.budgets, channel) ? state.budgets[channel] : undefined
    return e ? [{ channel, daily: e.daily, monthly: e.monthly }] : []
  })
}

export function isBudgetKey(v: unknown): v is Channel | '*' {
  return v === '*' || (typeof v === 'string' && (CHANNELS as readonly string[]).includes(v))
}

/** 予算の数（0 以上の有限の数か null、上限 1e12） */
export function isBudgetAmount(v: unknown): v is number | null {
  return v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= LEDGER_LIMITS.maxBudget)
}

// ---------------------------------------------------------------- 形の確かめ

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function coerceApproval(v: unknown): ApprovalEntry | null {
  if (!isObj(v)) return null
  if (v.status !== 'approved' && v.status !== 'rejected') return null
  if (typeof v.answer !== 'string' || v.answer.length > LEDGER_LIMITS.answer || typeof v.decidedAt !== 'string') return null
  if (typeof v.kind !== 'string' || !(APPROVAL_KINDS as readonly string[]).includes(v.kind)) return null
  if (typeof v.recordHash !== 'string' || !HEX64.test(v.recordHash)) return null
  return { status: v.status, answer: v.answer, decidedAt: v.decidedAt, kind: v.kind as ApprovalKind, recordHash: v.recordHash }
}

function coerceBudget(v: unknown): BudgetEntry | null {
  if (!isObj(v) || typeof v.decidedAt !== 'string') return null
  const daily = v.daily === undefined ? null : v.daily
  const monthly = v.monthly === undefined ? null : v.monthly
  if (!isBudgetAmount(daily) || !isBudgetAmount(monthly)) return null
  return { daily, monthly, decidedAt: v.decidedAt }
}

function coerceOperations(v: unknown): OperationsEntry | null {
  if (!isObj(v) || typeof v.decidedAt !== 'string') return null
  if (v.decision !== 'pass' && v.decision !== 'fail' && v.decision !== null) return null
  return { decision: v.decision, decidedAt: v.decidedAt }
}

// ---------------------------------------------------------------- 鍵

/** HMAC の鍵。暗号化できれば userData に暗号化して置き、できなければ起動中だけ持つ */
export class VentureLedgerKeyStore {
  private cached: Buffer | null = null
  private pending: Promise<Buffer> | null = null

  constructor(private readonly file: string, private readonly cipher: KeyCipher) {}

  key(): Promise<Buffer> {
    if (this.cached) return Promise.resolve(this.cached)
    // 同時に呼ばれても鍵を1つにする
    this.pending ??= this.load().finally(() => { this.pending = null })
    return this.pending
  }

  private async load(): Promise<Buffer> {
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
  if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new UserFacingError(t('venture.error.ledgerLink'))
}

function macOf(key: Buffer, scope: string, type: 'approval' | 'budget' | 'operations', id: string, fields: unknown[]): string {
  return createHmac('sha256', key).update(JSON.stringify(['venture-ledger-mac-v1', scope, type, id, ...fields])).digest('hex')
}

const approvalFields = (e: ApprovalEntry) => [e.status, e.answer, e.decidedAt, e.kind, e.recordHash]
const budgetFields = (e: BudgetEntry) => [e.daily, e.monthly, e.decidedAt]
const operationsFields = (e: OperationsEntry) => [e.decision, e.decidedAt]

function macMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string' || !HEX64.test(given)) return false
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(given, 'hex'))
}

/** ビジネスのフォルダの実体のパス（無ければ名前の上の絶対パス）の sha256 */
export function ledgerScope(root: string): string {
  let real: string
  try {
    real = realpathSync.native(root)
  } catch {
    real = path.resolve(root)
  }
  return sha256(real)
}

// ---------------------------------------------------------------- ファイルの台帳

/** userData/venture-approvals/<sha256(フォルダの実体のパス)>.json。1件ごとに HMAC を付ける */
export class FileVentureLedger implements VentureLedger {
  readonly file: string
  private readonly scope: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dir: string, root: string, private readonly key: () => Promise<Buffer>) {
    this.scope = ledgerScope(root)
    this.file = path.join(dir, `${this.scope}.json`)
  }

  async read(): Promise<LedgerState> {
    const out = emptyLedgerState()
    const dirStat = await lstat(path.dirname(this.file)).catch(() => null)
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) return out
    let raw: string
    try {
      raw = await readFileNoFollow(this.file, 'utf8', { maxBytes: MAX_LEDGER_BYTES }) // リンク・普通でないファイル・大きすぎるものは読まない
    } catch {
      return out
    }
    let o: Obj
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isObj(parsed)) return out
      o = parsed
    } catch {
      return out
    }
    const key = await this.key()
    if (isObj(o.approvals)) {
      for (const [id, v] of Object.entries(o.approvals)) {
        if (!id || id.length > LEDGER_LIMITS.id) continue
        const e = coerceApproval(v)
        if (e && macMatches(macOf(key, this.scope, 'approval', id, approvalFields(e)), (v as Obj).mac)) out.approvals[id] = e
      }
    }
    if (isObj(o.budgets)) {
      for (const [channel, v] of Object.entries(o.budgets)) {
        if (!isBudgetKey(channel)) continue
        const e = coerceBudget(v)
        if (e && macMatches(macOf(key, this.scope, 'budget', channel, budgetFields(e)), (v as Obj).mac)) out.budgets[channel] = e
      }
    }
    const ops = coerceOperations(o.operations)
    if (ops && macMatches(macOf(key, this.scope, 'operations', '', operationsFields(ops)), (o.operations as Obj).mac)) out.operations = ops
    return out
  }

  putApproval(id: string, entry: ApprovalEntry): Promise<void> {
    if (!id || id.length > LEDGER_LIMITS.id || !coerceApproval(entry)) return Promise.reject(new UserFacingError(t('venture.error.badInput')))
    return this.update((s) => { s.approvals[id] = { ...entry } })
  }

  putBudget(channel: Channel | '*', entry: BudgetEntry | null): Promise<void> {
    if (!isBudgetKey(channel) || (entry !== null && !coerceBudget(entry))) return Promise.reject(new UserFacingError(t('venture.error.badInput')))
    return this.update((s) => {
      if (entry) s.budgets[channel] = { ...entry }
      else delete s.budgets[channel]
    })
  }

  replaceBudgets(budgets: Record<string, BudgetEntry>): Promise<void> {
    for (const [k, e] of Object.entries(budgets)) {
      if (!isBudgetKey(k) || !coerceBudget(e)) return Promise.reject(new UserFacingError(t('venture.error.badInput')))
    }
    return this.update((s) => { s.budgets = Object.fromEntries(Object.entries(budgets).map(([k, e]) => [k, { ...e }])) })
  }

  putOperations(entry: OperationsEntry): Promise<void> {
    if (!coerceOperations(entry)) return Promise.reject(new UserFacingError(t('venture.error.badInput')))
    return this.update((s) => { s.operations = { ...entry } })
  }

  /** 読み直して変えて書く（同じ台帳への書き込みは1本の列に並べる） */
  private update(change: (s: LedgerState) => void): Promise<void> {
    const run = this.queue.then(async () => {
      const dir = path.dirname(this.file)
      await assertNotLink(dir)
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await assertNotLink(dir)
      const st = await lstat(this.file).catch(() => null)
      if (st && (st.isSymbolicLink() || !st.isFile())) throw new UserFacingError(t('venture.error.ledgerLink'))
      const key = await this.key()
      const state = await this.read()
      change(state)
      const approvals: Record<string, ApprovalEntry & { mac: string }> = {}
      for (const [id, e] of Object.entries(state.approvals)) approvals[id] = { ...e, mac: macOf(key, this.scope, 'approval', id, approvalFields(e)) }
      const budgets: Record<string, BudgetEntry & { mac: string }> = {}
      for (const [ch, e] of Object.entries(state.budgets)) budgets[ch] = { ...e, mac: macOf(key, this.scope, 'budget', ch, budgetFields(e)) }
      const operations = state.operations ? { ...state.operations, mac: macOf(key, this.scope, 'operations', '', operationsFields(state.operations)) } : null
      const text = `${JSON.stringify({ version: 1, approvals, budgets, operations }, null, 2)}\n`
      if (Buffer.byteLength(text) > MAX_LEDGER_BYTES) throw new UserFacingError(t('venture.error.ledgerTooLarge'))
      await savePrivateFile(this.file, text)
    })
    this.queue = run.catch(() => undefined)
    return run
  }
}

/** テスト用・userData の無いとき用（起動中だけ） */
export class MemoryVentureLedger implements VentureLedger {
  private state: LedgerState = emptyLedgerState()

  async read(): Promise<LedgerState> {
    return structuredClone(this.state)
  }

  async putApproval(id: string, entry: ApprovalEntry): Promise<void> {
    this.state.approvals[id] = structuredClone(entry)
  }

  async putBudget(channel: Channel | '*', entry: BudgetEntry | null): Promise<void> {
    if (entry) this.state.budgets[channel] = structuredClone(entry)
    else delete this.state.budgets[channel]
  }

  async replaceBudgets(budgets: Record<string, BudgetEntry>): Promise<void> {
    this.state.budgets = structuredClone(budgets)
  }

  async putOperations(entry: OperationsEntry): Promise<void> {
    this.state.operations = structuredClone(entry)
  }
}
