/**
 * ビジネス1件（開いているプロジェクトのフォルダ）の記録の読み書き（構想 3章・4章）。
 *
 * Electron に依存しない。時計・送信・ブラウザの取り込み・実験ページの API は外から渡す（単体テストで差し替える）。
 * - renderer から来た値は信じない。記録はもう一度型へ寄せ（coerceRecord）、検査（validateRecord）で error があれば書かない
 * - 人だけが変える欄は保存で変えない: 仮説の stage・stageHistory（advanceStage だけ）、承認の status・answer・decidedAt
 *   （decideApproval だけ）、実験の page（pushPage・unpublishPage だけ）。判断の済んだ承認は種類・関係する ID・題名・内容も変えない
 * - 人の判断の正本はフォルダの外（approvalLedger.ts）。approvals/ のファイルは写しで、公開の判定には使わない。
 *   承認と公開は、main が読んだ中身をネイティブの確認（deps.confirm）に出し、人が押したときだけ進める
 * - 一度の読み込みは合計のバイト数に上限（loadBudgetBytes）。フォルダの一覧は件数で打ち切る
 * - 壊れたファイルは problems に出し（相対のパスと日本語の理由だけ）、落ちない。壊れたファイルは上書きしない
 * - 送ったと言えるのは、本当に送れたときだけ。送れたときだけ .business/sent/ に残す
 */
import { createHash } from 'node:crypto'
import {
  CHANGE_AXES,
  EXECUTION_KEYS,
  RECORD_KINDS,
  RECORD_KIND_LIST,
  STAGES,
  STEP_IDS,
  isRecordId,
  isStepId,
  nextId,
  type Approval,
  type BusinessData,
  type BusinessFile,
  type ChangeAxis,
  type Evidence,
  type ExecutionItem,
  type ExecutionKey,
  type Experiment,
  type Hypothesis,
  type RecordKind,
  type RecordTypes,
  type SearchLog,
  type SentPrompt,
  type Stage,
  type StepId
} from '@shared/business/model'
import { coerceBusiness, coerceRecord, coerceSearch, defaultExecution, emptyBusiness, emptyRecord, type Fix } from '@shared/business/records'
import { MAX_RECORD_BYTES, RecordParseError, dumpYaml, formatRecordFile, parseJsonl, parseRecordFile, parseYaml } from '@shared/business/format'
import { hasErrors, validateBusiness, validateRecord } from '@shared/business/rules'
import { summarize } from '@shared/business/steps'
import { AGENT_RULES, buildPrompt, fillPrompt, promptById, promptValues } from '@shared/business/prompts'
import type { Issue } from '@shared/business/rules'
import { RECORD_README, contextMarkdown } from '@shared/business/context'
import type { BusinessSendTarget, BusinessSendRequest, BusinessSnapshot, PageContent, PageStats, PromptView, SaveResult, SavedPage } from '@shared/business/ipc'
import { UserFacingError } from '@shared/errors'
import { BusinessFs, MAX_DIR_ENTRIES, toBusinessError } from './fsx'
import { ensureBusinessGitExclude } from './gitExclude'
import { MAX_STATS_RANGE_DAYS, PAGE_LIMITS, SLUG_PATTERN, validatePageContent, type PagesApi } from './pages'
import { MemoryApprovalLedger, entryIntact, makeEntry, pageContentHash, recordHash, type ApprovalLedger, type BoundPage, type LedgerEntry } from './approvalLedger'

// ---- 置き場所 ----

export const BUSINESS_FILE = 'business.yaml'
export const SEARCHES_FILE = 'searches.jsonl'
export const PRINCIPLES_DIR = 'principles'
export const MANUAL_FILE = 'principles/手法.md'
export const PROMPTS_DIR = 'prompts'
export const META_DIR = '.business'
export const CONTEXT_FILE = '.business/context.md'
/** 実験ページに送った中身の控え */
const PAGES_DIR = '.business/pages'
export const README_FILE = '.business/README.md'
export const SENT_DIR = '.business/sent'
export const CAPTURES_DIR = '.business/captures'
export const PROPOSALS_DIR = '.business/proposals'
export const TRASH_DIR = '.business/trash'
export const SKILL_FILE = '.claude/skills/ferret-business/SKILL.md'
export const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md'] as const
export const BLOCK_START = '<!-- ferret-business:start -->'
export const BLOCK_END = '<!-- ferret-business:end -->'
/** アプリが書いたファイルの印（これがあるファイルだけ、版が変わったら書き直す。人が書いたファイルは上書きしない） */
export const GENERATED_MARK = '<!-- ferret-business:generated -->'

/** 上限 */
export const LIMITS = {
  name: 100,
  target: 500,
  note: 1000,
  answer: 2000,
  body: 200_000,
  promptOverride: 50_000,
  sendText: 100_000,
  searchQuery: 500,
  searchField: 200,
  searchNote: 2000,
  searchesBytes: 5 * 1024 * 1024,
  sentHistory: 50,
  selection: 5000,
  title: 300,
  executionPlan: 2000,
  agentFileBytes: 1024 * 1024,
  /** 一度の読み込みで読む合計のバイト数 */
  loadBytes: 32 * 1024 * 1024
} as const

export const LEDGER_MISMATCH = '承認の記録が一致しません（手で書き換えられた可能性）'
export const LOAD_BUDGET_MESSAGE = '記録が多すぎるので一部だけ読みました'

const SCAFFOLD_DIRS = [
  PRINCIPLES_DIR, ...RECORD_KIND_LIST.map((k) => RECORD_KINDS[k].dir), PROMPTS_DIR,
  META_DIR, SENT_DIR, CAPTURES_DIR, PROPOSALS_DIR, TRASH_DIR
]

// ---- 外から渡すもの ----

export interface SendOutcome {
  ok: boolean
  message: string
  /** 送り先の名前（履歴に残す。例: Claude Code） */
  label: string
}

/** Agent へ送る（index.ts では TerminalManager の resolveSendTarget・sendReview。bracketed paste のあと Enter） */
export interface AgentSender {
  send(target: BusinessSendTarget, text: string): Promise<SendOutcome>
}

/** 内蔵ブラウザで見ているページ */
export interface PageCapture {
  url: string
  title: string
  selection: string
  png: Uint8Array
}

/** 人に確かめる（index.ts ではアプリの窓のネイティブのダイアログ）。押したら true */
export interface ConfirmRequest {
  message: string
  detail: string
  confirmLabel: string
}
export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>

export interface StoreDeps {
  root: string
  now?: () => Date
  /** principles/手法.md に写す本文（resources/business/手法.md） */
  manual?: string
  /** 人の判断の正本（フォルダの外）。省略時は起動中だけのもの */
  ledger?: ApprovalLedger
  /** 承認・公開の確認。省略時は確かめられないので断る */
  confirm?: ConfirmFn
  /** 一度の読み込みで読む合計のバイト数（テストで小さくする） */
  loadBudgetBytes?: number
  /** いまの実験ページの接続先の origin（公開の承認を結び付ける）。省略時は未設定 */
  pageOrigin?: () => Promise<string>
}

// ---- 小さな道具 ----

const pad = (n: number) => String(n).padStart(2, '0')
/** その時計の地元の日付（YYYY-MM-DD） */
export function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fail(message: string): never {
  throw new UserFacingError(message)
}

function text(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string') fail(`${label}が正しくありません。`)
  if (value.length > max) fail(`${label}は ${max} 文字までです。`)
  return value
}

const recordFile = (kind: RecordKind, id: string) => `${RECORD_KINDS[kind].dir}/${id}.md`

/** 手法.md の写しの頭（版と確認日） */
export function manualCopy(manual: string, today: string): string {
  const version = createHash('sha256').update(manual).digest('hex').slice(0, 12)
  return `<!-- ferret-business:manual 版 ${version} ／ 写した日 ${today}。正本は Ferret の resources/business/手法.md。このビジネス独自の原則は principles/ に別のファイルで書く -->\n\n${manual}`
}

/** RECORD_README の「## 見出し」ごとの本文 */
function readmeSection(heading: string): string {
  const parts = RECORD_README.split(/^## /m)
  const found = parts.find((p) => p.startsWith(`${heading}\n`))
  return found ? found.slice(heading.length + 1).trim() : ''
}

/** Agent に入れる skill（.claude/skills/ferret-business/SKILL.md）。記録の形式・書いてよいファイル・承認が要る操作・手法.md の場所 */
export function skillMarkdown(): string {
  return [
    '---',
    'name: ferret-business',
    'description: Ferret のビジネスの記録（business.yaml・hypotheses/・evidence/・experiments/ など）を読み書きするときに使う。記録の形式、書いてよいファイル、人の承認が要る操作、調べ方の原則（principles/手法.md）の場所。',
    '---',
    GENERATED_MARK,
    '',
    '# Ferret の記録',
    '',
    '作業の前に `.business/context.md`（いまのステップ・数・次に確かめること・関係するファイル）を読む。',
    '記録の形式の全文は `.business/README.md`。',
    '',
    '## 記録の形式',
    '',
    readmeSection('置き場所'),
    '',
    readmeSection('決まり'),
    '',
    '## 書いてよいファイル',
    '',
    readmeSection('書いてよいファイル'),
    '- `.business/context.md`・`.business/sent/`・`.business/captures/` は Ferret が書く。手で直さない。',
    '',
    '## 人の承認が要る操作',
    '',
    readmeSection('人の承認が要る操作'),
    '',
    '## 手法.md の場所',
    '',
    '調べ方の原則は `principles/手法.md`（バーニングニーズ調査マニュアルの写し。先頭に版と写した日）。このビジネス独自の原則は `principles/` のほかのファイル。',
    ''
  ].join('\n')
}

export function agentBlock(): string {
  return [
    BLOCK_START,
    '## Ferret',
    '',
    'このフォルダは Ferret のビジネスの記録です。作業の前に `.business/context.md`（いまの状況）と `.business/README.md`（記録の形式・書いてよいファイル・人の承認が要る操作）を読んでください。調べ方の原則は `principles/手法.md`。',
    '応募・営業送信・広告出稿・課金・ログインが要るサイトの操作・実験ページの公開・段階を進めることはしません。必要なら `approvals/` に承認の依頼を書いて止まります。',
    BLOCK_END
  ].join('\n')
}

/** CLAUDE.md・AGENTS.md の印の間を差し替える（無ければ末尾に足す） */
export function upsertBlock(current: string | null, block: string): string {
  if (current === null || !current.trim()) return `${block}\n`
  const start = current.indexOf(BLOCK_START)
  const end = current.indexOf(BLOCK_END)
  if (start >= 0 && end > start) return `${current.slice(0, start)}${block}${current.slice(end + BLOCK_END.length)}`
  return `${current.replace(/\n*$/, '')}\n\n${block}\n`
}

/** 送った履歴の名前に使う日時（ファイル名に使えない : を含めない） */
function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-')
}

function targetLabel(target: BusinessSendTarget, label: string): string {
  if (label) return label
  return target.kind === 'new' ? (target.agent === 'codex' ? 'Codex' : 'Claude Code') : 'Agent'
}

// ---- 読み込み ----

interface Loaded {
  data: BusinessData
  bodies: Record<string, string>
  /** 読めなかった記録のファイル（相対のパス）。上書きしない */
  broken: Set<string>
  businessBroken: boolean
  overriddenPrompts: string[]
  /** 判断の正本（フォルダの外）と、ファイルの写しが合わないもの */
  ledgerIssues: Issue[]
  ledger: Record<string, LedgerEntry>
}

const MAX_FIXES_PER_FILE = 5
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)

export class BusinessStore {
  readonly fs: BusinessFs
  private readonly now: () => Date
  private readonly manual: string
  private readonly ledger: ApprovalLedger
  private readonly confirm: ConfirmFn
  private readonly loadBudget: number
  private readonly pageOrigin: () => Promise<string>
  private queue: Promise<unknown> = Promise.resolve()

  constructor(deps: StoreDeps) {
    this.fs = new BusinessFs(deps.root)
    this.now = deps.now ?? (() => new Date())
    this.manual = deps.manual ?? ''
    this.ledger = deps.ledger ?? new MemoryApprovalLedger()
    this.confirm = deps.confirm ?? (async () => false)
    this.loadBudget = deps.loadBudgetBytes ?? LIMITS.loadBytes
    this.pageOrigin = deps.pageOrigin ?? (async () => '')
  }

  get root(): string {
    return this.fs.root
  }

  /** 書き込みを1つずつ行う（同時の保存で読み直しと書き込みが入れ違わない） */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private iso(): string {
    return this.now().toISOString()
  }

  async isBusiness(): Promise<boolean> {
    return (await this.fs.kind(BUSINESS_FILE)) === 'file'
  }

  async status(): Promise<{ isBusiness: boolean; name: string | null }> {
    try {
      const raw = await this.fs.readText(BUSINESS_FILE, MAX_RECORD_BYTES)
      if (raw === null) return { isBusiness: false, name: null }
      try {
        return { isBusiness: true, name: coerceBusiness(parseYaml(raw), this.fallbackName(), this.iso()).value.name }
      } catch {
        return { isBusiness: true, name: null }
      }
    } catch {
      return { isBusiness: false, name: null }
    }
  }

  private fallbackName(): string {
    const parts = this.root.split(/[\\/]/).filter(Boolean)
    return parts.at(-1) ?? 'ビジネス'
  }

  private async loadAll(): Promise<Loaded> {
    const now = this.iso()
    const problems: BusinessData['problems'] = []
    const broken = new Set<string>()
    const pushFixes = (path: string, fixes: Fix[]) => {
      for (const f of fixes.slice(0, MAX_FIXES_PER_FILE)) problems.push({ path, message: `${f.field ? `${f.field}: ` : ''}${f.message}` })
      if (fixes.length > MAX_FIXES_PER_FILE) problems.push({ path, message: `ほかに ${fixes.length - MAX_FIXES_PER_FILE} 件の値を直して読み込みました` })
    }
    const problemOf = (err: unknown) => (err instanceof RecordParseError ? err.message : toBusinessError(err).message)
    // 合計のバイト数の予算。超えたら読むのをやめ、problems に1回だけ出す
    let budget = this.loadBudget
    let overBudget = false
    const spend = (raw: string, path: string): boolean => {
      budget -= Buffer.byteLength(raw)
      if (budget >= 0) return true
      if (!overBudget) problems.push({ path, message: LOAD_BUDGET_MESSAGE })
      overBudget = true
      return false
    }

    // business.yaml
    let business: BusinessFile
    let businessBroken = false
    let rawBusiness: string | null
    try {
      rawBusiness = await this.fs.readText(BUSINESS_FILE, MAX_RECORD_BYTES)
    } catch (err) {
      rawBusiness = null
      businessBroken = true
      problems.push({ path: BUSINESS_FILE, message: `開けません: ${problemOf(err)}` })
    }
    if (rawBusiness === null && !businessBroken) fail('このフォルダはまだビジネスではありません。先にビジネスを作成してください。')
    if (rawBusiness !== null) {
      try {
        const c = coerceBusiness(parseYaml(rawBusiness), this.fallbackName(), now)
        business = c.value
        pushFixes(BUSINESS_FILE, c.fixes)
      } catch (err) {
        businessBroken = true
        problems.push({ path: BUSINESS_FILE, message: `開けません: ${problemOf(err)}` })
        business = emptyBusiness(this.fallbackName(), now)
      }
    } else {
      business = emptyBusiness(this.fallbackName(), now)
    }

    const data: BusinessData = {
      root: this.root, business, hypotheses: [], evidence: [], alternatives: [], interviews: [], experiments: [], decisions: [], approvals: [], searches: [], problems
    }
    const bodies: Record<string, string> = {}
    const lists: { [K in RecordKind]: RecordTypes[K][] } = {
      hypothesis: data.hypotheses, evidence: data.evidence, alternative: data.alternatives, interview: data.interviews,
      experiment: data.experiments, decision: data.decisions, approval: data.approvals
    }

    for (const kind of RECORD_KIND_LIST) {
      if (overBudget) break
      const dir = RECORD_KINDS[kind].dir
      let listing: Awaited<ReturnType<BusinessFs['list']>>
      try {
        listing = await this.fs.list(dir, MAX_DIR_ENTRIES)
      } catch (err) {
        problems.push({ path: `${dir}/`, message: `読めません: ${problemOf(err)}` })
        continue
      }
      if (listing.truncated) problems.push({ path: `${dir}/`, message: `ファイルが多すぎるため、先頭の ${MAX_DIR_ENTRIES} 件だけ読みました` })
      for (const entry of listing.entries) {
        if (overBudget) break
        if (!entry.name.endsWith('.md')) continue
        const rel = `${dir}/${entry.name}`
        const id = entry.name.slice(0, -3)
        if (entry.kind === 'link') {
          problems.push({ path: rel, message: 'リンクなので読みません' })
          continue
        }
        if (entry.kind !== 'file') continue
        if (!isRecordId(kind, id)) {
          problems.push({ path: rel, message: `ファイル名が${RECORD_KINDS[kind].label}の ID の形（${RECORD_KINDS[kind].prefix}01 など）ではありません` })
          continue
        }
        try {
          const raw = await this.fs.readText(rel, MAX_RECORD_BYTES)
          if (raw === null) continue
          if (!spend(raw, `${dir}/`)) break
          const parsed = parseRecordFile(raw)
          const front = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data as Record<string, unknown> : null
          if (front && front.id !== undefined && front.id !== null && String(front.id) !== id) {
            broken.add(rel)
            problems.push({ path: rel, message: `ID（${String(front.id).slice(0, 20)}）とファイル名（${id}）が違うので読みません` })
            continue
          }
          const c = coerceRecord(kind, parsed.data, id, now)
          ;(lists[kind] as RecordTypes[typeof kind][]).push(c.value)
          bodies[id] = parsed.body
          pushFixes(rel, c.fixes)
        } catch (err) {
          broken.add(rel)
          problems.push({ path: rel, message: `開けません: ${problemOf(err)}` })
        }
      }
    }

    // 検索履歴
    try {
      const raw = overBudget ? null : await this.fs.readText(SEARCHES_FILE, LIMITS.searchesBytes)
      if (raw !== null && spend(raw, SEARCHES_FILE)) {
        const { rows, broken: brokenLines } = parseJsonl(raw)
        let skipped = brokenLines
        for (const row of rows) {
          const s = coerceSearch(row)
          if (s) data.searches.push(s)
          else skipped++
        }
        if (skipped) problems.push({ path: SEARCHES_FILE, message: `読めない行が ${skipped} 行あります` })
      }
    } catch (err) {
      problems.push({ path: SEARCHES_FILE, message: `読めません: ${problemOf(err)}` })
    }

    // 上書きしたプロンプト
    const overriddenPrompts: string[] = []
    try {
      const { entries } = await this.fs.list(PROMPTS_DIR, 500)
      for (const e of entries) {
        if (e.kind === 'file' && e.name.endsWith('.md') && promptById(e.name.slice(0, -3))) overriddenPrompts.push(e.name.slice(0, -3))
      }
    } catch (err) {
      problems.push({ path: `${PROMPTS_DIR}/`, message: `読めません: ${problemOf(err)}` })
    }

    // 人の判断はフォルダの外の正本に合わせる。合わなければ知らせて「待ち」として扱う
    const ledger = await this.ledger.all()
    const ledgerIssues: Issue[] = []
    for (const a of data.approvals) {
      const entry = ledger[a.id]
      const matches = entry !== undefined && entryIntact(entry) && entry.recordHash === recordHash(a)
      if (matches) {
        if (a.status !== entry.status || a.answer !== entry.answer) ledgerIssues.push({ severity: 'warning', ref: a.id, field: 'status', message: LEDGER_MISMATCH })
        a.status = entry.status
        a.answer = entry.answer
        a.decidedAt = entry.decidedAt
      } else if (entry !== undefined || a.status !== '待ち') {
        ledgerIssues.push({ severity: 'warning', ref: a.id, field: 'status', message: LEDGER_MISMATCH })
        a.status = '待ち'
        a.answer = ''
        a.decidedAt = ''
      }
    }

    return { data, bodies, broken, businessBroken, overriddenPrompts, ledgerIssues, ledger }
  }

  private snapshotOf(loaded: Loaded): BusinessSnapshot {
    return {
      data: loaded.data,
      bodies: loaded.bodies,
      issues: [...loaded.ledgerIssues, ...validateBusiness(loaded.data)],
      summary: summarize(loaded.data),
      overriddenPrompts: loaded.overriddenPrompts
    }
  }

  async load(): Promise<BusinessSnapshot> {
    return this.snapshotOf(await this.loadAll())
  }

  /** 1件を読む。無ければ null、壊れていれば UserFacingError（上書きさせない） */
  private async readRecord<K extends RecordKind>(kind: K, id: string): Promise<{ record: RecordTypes[K]; body: string } | null> {
    if (!isRecordId(kind, id)) fail(`ID「${String(id).slice(0, 20)}」の形が違います。`)
    const rel = recordFile(kind, id)
    const raw = await this.fs.readText(rel, MAX_RECORD_BYTES)
    if (raw === null) return null
    let parsed: ReturnType<typeof parseRecordFile>
    try {
      parsed = parseRecordFile(raw)
    } catch {
      fail(`${id} のファイルが壊れているため開けません。ファイルを直してから操作してください。`)
    }
    const front = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data as Record<string, unknown> : null
    if (front && front.id !== undefined && front.id !== null && String(front.id) !== id) fail(`${id} のファイルの ID がファイル名と違うため開けません。`)
    return { record: coerceRecord(kind, parsed.data, id, this.iso()).value, body: parsed.body }
  }

  private async writeRecord<K extends RecordKind>(kind: K, record: RecordTypes[K], body: string): Promise<void> {
    const content = formatRecordFile(record, body)
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) fail(`記録が大きすぎるため保存できません（${MAX_RECORD_BYTES / 1024}KB まで）。`)
    await this.fs.write(recordFile(kind, record.id), content)
  }

  private async requireBusiness(): Promise<Loaded> {
    const loaded = await this.loadAll()
    if (loaded.businessBroken) fail('business.yaml が壊れているため開けません。ファイルを直してから操作してください。')
    return loaded
  }

  private async writeBusiness(business: BusinessFile): Promise<void> {
    await this.fs.write(BUSINESS_FILE, dumpYaml(business))
  }

  // ---- 作る ----

  /** ひな型を書く。既にあるファイルは上書きしない（アプリが書いた印のある README・SKILL と、CLAUDE.md・AGENTS.md の印の間だけ書き直す） */
  init(input: { name: unknown; target: unknown }): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      const exists = await this.isBusiness()
      let name = ''
      let target = ''
      if (!exists) {
        name = text(input?.name, LIMITS.name, 'ビジネス名').trim()
        if (!name) fail('ビジネス名を入れてください。')
        target = text(input?.target ?? '', LIMITS.target, '対象の1文').trim()
      }
      for (const dir of SCAFFOLD_DIRS) await this.fs.mkdir(dir)
      const now = this.now()
      if (!exists) await this.fs.writeIfMissing(BUSINESS_FILE, dumpYaml({ ...emptyBusiness(name, now.toISOString()), target }))
      if (this.manual) await this.fs.writeIfMissing(MANUAL_FILE, manualCopy(this.manual, localDate(now)))
      await this.writeGenerated(README_FILE, `${GENERATED_MARK}\n${RECORD_README}`)
      await this.writeGenerated(SKILL_FILE, skillMarkdown())
      for (const file of AGENT_FILES) await this.upsertAgentFile(file)
      await ensureBusinessGitExclude(this.fs)
      const loaded = await this.loadAll()
      await this.fs.write(CONTEXT_FILE, contextMarkdown(loaded.data, now.toISOString()))
      return this.snapshotOf(loaded)
    })
  }

  /** アプリが書くファイル。無ければ作り、印があって中身が違えば書き直す。印の無い（人が書いた）ファイルは触らない */
  private async writeGenerated(rel: string, content: string): Promise<void> {
    if (await this.fs.writeIfMissing(rel, content)) return
    if ((await this.fs.kind(rel)) !== 'file') return
    const current = await this.fs.readText(rel, LIMITS.agentFileBytes).catch(() => null)
    if (current?.includes(GENERATED_MARK) && current !== content) await this.fs.write(rel, content)
  }

  /** CLAUDE.md・AGENTS.md に印の間を足す・差し替える。リンク（CLAUDE.md → AGENTS.md など）は置き換えないので触らない */
  private async upsertAgentFile(rel: string): Promise<void> {
    const kind = await this.fs.kind(rel)
    if (kind !== null && kind !== 'file') return
    let current: string | null = null
    if (kind === 'file') {
      try {
        current = await this.fs.readText(rel, LIMITS.agentFileBytes)
      } catch {
        return // 大きすぎる・読めない。中身を消さないよう書かない
      }
    }
    const next = upsertBlock(current, agentBlock())
    if (next !== current) await this.fs.write(rel, next)
  }

  // ---- 記録 ----

  saveRecord<K extends RecordKind>(kind: K, record: unknown, body: unknown): Promise<SaveResult> {
    return this.serial(async () => {
      if (!RECORD_KIND_LIST.includes(kind)) fail('記録の種類が正しくありません。')
      const rawId = record && typeof record === 'object' ? (record as { id?: unknown }).id : undefined
      const id = typeof rawId === 'string' ? rawId : ''
      const shown = id.slice(0, 20)
      const error = (field: string, message: string): SaveResult => ({ ok: false, issues: [{ severity: 'error', ref: shown || kind, field, message }] })
      if (!isRecordId(kind, id)) return error('id', `ID「${shown}」の形が違います（${RECORD_KINDS[kind].prefix}01 など）`)
      if (typeof body !== 'string') return error('body', '本文が正しくありません')
      if (body.length > LIMITS.body) return error('body', `本文は ${LIMITS.body} 文字までです`)
      const loaded = await this.requireBusiness()
      const rel = recordFile(kind, id)
      if (loaded.broken.has(rel)) return error('id', `${id} のファイルが壊れているため上書きしません。ファイルを直してから保存してください`)
      const now = this.iso()
      const next = coerceRecord(kind, record, id, now).value as RecordTypes[K]
      const onDisk = await this.readRecord(kind, id)
      if (kind === 'hypothesis') {
        const h = next as Hypothesis
        const prev = onDisk?.record as Hypothesis | undefined
        h.stage = prev?.stage ?? STAGES[0]
        h.stageHistory = prev?.stageHistory ?? []
      }
      if (kind === 'approval') {
        const a = next as Approval
        const prev = onDisk?.record as Approval | undefined
        const decided = loaded.ledger[id] !== undefined || (prev !== undefined && prev.status !== '待ち')
        if (prev && decided && recordHash(prev) !== recordHash(a)) {
          return error('kind', `${id} は判断が済んでいるため、種類・関係する ID・題名・内容は変えられません。新しい承認の依頼を作ってください`)
        }
        a.status = prev?.status ?? '待ち'
        a.answer = prev?.answer ?? ''
        a.decidedAt = prev?.decidedAt ?? ''
      }
      if (kind === 'experiment') {
        const x = next as Experiment
        x.page = (onDisk?.record as Experiment | undefined)?.page ?? null
      }
      const others = { ...loaded.data, [listKey(kind)]: (loaded.data[listKey(kind)] as Array<{ id: string }>).filter((r) => r.id !== id) } as BusinessData
      const issues = validateRecord(kind, next, others)
      if (hasErrors(issues)) return { ok: false, issues }
      const content = formatRecordFile(next, body)
      if (Buffer.byteLength(content) > MAX_RECORD_BYTES) return error('body', `記録が大きすぎるため保存できません（${MAX_RECORD_BYTES / 1024}KB まで）`)
      await this.fs.write(rel, content)
      return { ok: true, snapshot: await this.load(), issues }
    })
  }

  /** .business/trash/<kind>-<id>-<日時>.md へ動かす（戻せる） */
  deleteRecord(kind: RecordKind, id: unknown): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      if (!RECORD_KIND_LIST.includes(kind)) fail('記録の種類が正しくありません。')
      if (!isRecordId(kind, id)) fail('ID の形が違います。')
      const rel = recordFile(kind, id)
      const k = await this.fs.kind(rel)
      if (k === null) fail(`${id} はありません。`)
      if (k !== 'file') fail(`${id} は普通のファイルではないため削除しません。`)
      await this.fs.mkdir(TRASH_DIR)
      await this.fs.move(rel, `${TRASH_DIR}/${kind}-${id}-${stamp(this.now())}.md`)
      return this.load()
    })
  }

  updateBusiness(patch: unknown): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('変更の内容が正しくありません。')
      const p = patch as Record<string, unknown>
      const loaded = await this.requireBusiness()
      const b: BusinessFile = { ...loaded.data.business, limits: { ...loaded.data.business.limits } }
      if (p.name !== undefined) {
        const name = text(p.name, LIMITS.name, 'ビジネス名').trim()
        if (!name) fail('ビジネス名を入れてください。')
        b.name = name
      }
      if (p.target !== undefined) b.target = text(p.target, LIMITS.target, '対象の1文').trim()
      if (p.step !== undefined) {
        if (!isStepId(p.step)) fail('ステップは S1〜S10 から選んでください。')
        b.step = p.step
      }
      if (p.currentHypothesis !== undefined) {
        if (p.currentHypothesis !== null && !isRecordId('hypothesis', p.currentHypothesis)) fail('仮説の ID の形が違います。')
        b.currentHypothesis = p.currentHypothesis as string | null
      }
      if (p.limits !== undefined) {
        const l = p.limits && typeof p.limits === 'object' ? p.limits as Record<string, unknown> : fail('上限が正しくありません。')
        const num = (v: unknown, label: string): number | null => {
          if (v === null || v === undefined) return null
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1e12) fail(`${label}は 0 以上の数で入れてください。`)
          return v
        }
        b.limits = { hours: num(l.hours, '時間の上限'), yen: num(l.yen, '費用の上限') }
      }
      if (p.execution !== undefined) b.execution = mergeExecution(b.execution, p.execution)
      await this.writeBusiness(b)
      return this.load()
    })
  }

  /** 段階を隣へだけ動かす（人が押したとき）。履歴に日時とメモを残す */
  advanceStage(hypothesisId: unknown, to: unknown, note: unknown): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      if (!isRecordId('hypothesis', hypothesisId)) fail('仮説の ID の形が違います。')
      if (typeof to !== 'string' || !(STAGES as readonly string[]).includes(to)) fail('段階が正しくありません。')
      const memo = text(note ?? '', LIMITS.note, 'メモ').trim()
      await this.requireBusiness()
      const found = await this.readRecord('hypothesis', hypothesisId)
      if (!found) fail(`仮説 ${hypothesisId} はありません。`)
      const h = found.record
      const from = STAGES.indexOf(h.stage)
      const dest = STAGES.indexOf(to as Stage)
      if (from === dest) fail(`${hypothesisId} は既に「${to}」です。`)
      if (Math.abs(from - dest) !== 1) fail(`段階は1つずつしか動かせません（いまは「${h.stage}」）。`)
      h.stageHistory = [...h.stageHistory, { from: h.stage, to: to as Stage, at: this.iso(), note: memo }]
      h.stage = to as Stage
      await this.writeRecord('hypothesis', h, found.body)
      return this.load()
    })
  }

  /** 周を閉じる。変えるもの1つと戻るステップ（S1〜S8）を決めて次の周へ */
  closeLoop(input: unknown): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      const i = input && typeof input === 'object' ? input as Record<string, unknown> : fail('内容が正しくありません。')
      if (typeof i.changed !== 'string' || !(CHANGE_AXES as readonly string[]).includes(i.changed)) fail('変えるものは 対象・成果・価格・経路 から1つ選んでください。')
      const backTo = i.backTo
      if (!isStepId(backTo) || STEP_IDS.indexOf(backTo) > STEP_IDS.indexOf('S8')) fail('戻るステップは S1〜S8 から選んでください。')
      const note = text(i.note ?? '', LIMITS.note, 'メモ').trim()
      const loaded = await this.requireBusiness()
      const b = loaded.data.business
      const next: BusinessFile = {
        ...b,
        loops: [...b.loops, { loop: b.loop, changed: i.changed as ChangeAxis, backTo: backTo as StepId, note, at: this.iso() }],
        loop: b.loop + 1,
        step: backTo as StepId
      }
      await this.writeBusiness(next)
      return this.load()
    })
  }

  // ---- プロンプト ----

  private async override(promptId: string): Promise<string | null> {
    const raw = await this.fs.readText(`${PROMPTS_DIR}/${promptId}.md`, MAX_RECORD_BYTES)
    return raw?.trim() ? raw : null
  }

  async prompt(promptId: unknown): Promise<PromptView> {
    const template = typeof promptId === 'string' ? promptById(promptId) : undefined
    if (!template) fail('プロンプトが見つかりません。')
    const loaded = await this.loadAll()
    const override = await this.override(template.id)
    return { ...buildPrompt(template, loaded.data, override), body: override?.trim() ? override.trim() : template.body, overridden: override !== null }
  }

  savePromptOverride(promptId: unknown, body: unknown): Promise<PromptView> {
    return this.serial(async () => {
      const template = typeof promptId === 'string' ? promptById(promptId) : undefined
      if (!template) fail('プロンプトが見つかりません。')
      const rel = `${PROMPTS_DIR}/${template.id}.md`
      if (body === null || (typeof body === 'string' && !body.trim())) {
        await this.fs.remove(rel)
      } else {
        const content = text(body, LIMITS.promptOverride, 'プロンプト')
        await this.fs.write(rel, content.endsWith('\n') ? content : `${content}\n`)
      }
      return this.prompt(template.id)
    })
  }

  // ---- 送る ----

  /** context.md を書き直してから送る。送れたときだけ .business/sent/ に残す。送れなければ ok:false（送ったとは言わない） */
  send(request: unknown, sender: AgentSender): Promise<{ ok: boolean; message: string }> {
    return this.serial(async () => {
      const r = request && typeof request === 'object' ? request as Partial<BusinessSendRequest> : fail('送る内容が正しくありません。')
      const template = typeof r.promptId === 'string' ? promptById(r.promptId) : undefined
      if (!template) fail('プロンプトが見つかりません。')
      if (typeof r.text !== 'string' || !r.text.trim()) fail('送る本文が空です。')
      if (r.text.length > LIMITS.sendText) fail(`送る本文は ${LIMITS.sendText.toLocaleString('ja-JP')} 文字までです。`)
      const target = parseTarget(r.target)
      const loaded = await this.requireBusiness()
      const now = this.now()
      // 守ること（AGENT_RULES）は main が付ける。画面から来た本文の末尾に無ければ足す（消して送れない）
      const rules = fillPrompt(AGENT_RULES, promptValues(loaded.data)).text
      const body = r.text.trimEnd().endsWith(rules) ? r.text : `${r.text.trimEnd()}\n\n${rules}`
      await this.fs.write(CONTEXT_FILE, contextMarkdown(loaded.data, now.toISOString()))
      let outcome: SendOutcome
      try {
        outcome = await sender.send(target, body)
      } catch (err) {
        return { ok: false, message: err instanceof UserFacingError ? err.message : '送れませんでした。もう一度送ってください。' }
      }
      if (!outcome.ok) return { ok: false, message: outcome.message || '送れませんでした。' }
      const front = { id: '', at: now.toISOString(), step: loaded.data.business.step, promptId: template.id, target: targetLabel(target, outcome.label) }
      try {
        const base = `${stamp(now)}-${template.id}`
        for (let n = 0; n < 20; n++) {
          const id = n === 0 ? base : `${base}-${n + 1}`
          if (await this.fs.writeIfMissing(`${SENT_DIR}/${id}.md`, formatRecordFile({ ...front, id }, body))) break
        }
      } catch {
        return { ok: true, message: `${outcome.message}（送った履歴は保存できませんでした）` }
      }
      return { ok: true, message: outcome.message }
    })
  }

  /** 送った履歴（新しい順に 50 件） */
  async sentHistory(): Promise<SentPrompt[]> {
    let names: string[]
    try {
      // 名前は日時で始まるので、名前の大きい順＝新しい順。全部の名前を持たず、上位 50 件だけを残しながら数える
      names = (await this.fs.newest(SENT_DIR, LIMITS.sentHistory, (e) => e.kind === 'file' && e.name.endsWith('.md'), (n) => n.slice(0, -3))).map((n) => n.slice(0, -3))
    } catch {
      return []
    }
    const out: SentPrompt[] = []
    for (const name of names) {
      try {
        const raw = await this.fs.readText(`${SENT_DIR}/${name}.md`, MAX_RECORD_BYTES)
        if (raw === null) continue
        const { data, body } = parseRecordFile(raw)
        const o = data && typeof data === 'object' ? data as Record<string, unknown> : {}
        out.push({
          id: typeof o.id === 'string' && o.id ? o.id : name,
          at: typeof o.at === 'string' ? o.at : '',
          step: isStepId(o.step) ? o.step : 'S1',
          promptId: typeof o.promptId === 'string' ? o.promptId : '',
          target: typeof o.target === 'string' ? o.target : '',
          body
        })
      } catch {
        // 壊れた履歴は飛ばす（送った事実の一覧なので、読めるものだけ出す）
      }
    }
    return out
  }

  // ---- 人の判断 ----

  decideApproval(id: unknown, status: unknown, answer: unknown): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      if (!isRecordId('approval', id)) fail('承認の依頼の ID の形が違います。')
      if (status !== '承認' && status !== '却下') fail('承認か却下を選んでください。')
      const reply = text(answer ?? '', LIMITS.answer, '回答').trim()
      await this.requireBusiness()
      const found = await this.readRecord('approval', id)
      if (!found) fail(`承認の依頼 ${id} はありません。`)
      const record = found.record
      const entry = (await this.ledger.all())[id]
      if (entry && entryIntact(entry) && entry.recordHash === recordHash(record)) fail(`${id} は既に「${entry.status}」です。`)
      let page: BoundPage | null = null
      if (status === '承認') {
        const lines = [
          `種類: ${record.kind}`,
          `題名: ${clip(record.title, 200) || '（なし）'}`,
          `内容: ${clip(record.detail, 600) || '（なし）'}`,
          `関係する ID: ${record.refs.join('、') || '（なし）'}`
        ]
        if (record.kind === '実験ページの公開') {
          const experimentId = record.refs.find((r) => isRecordId('experiment', r))
          if (!experimentId) fail('どの実験のページか分かりません（関係する ID に実験の ID がありません）。')
          const saved = await this.pageContent(experimentId)
          if (!saved) fail(`${experimentId} の実験ページの下書きがまだ送られていません。先に下書きを送ってから承認してください。`)
          const origin = await this.pageOrigin()
          if (!origin) fail('実験ページの接続先が設定されていません。')
          page = { experimentId, slug: saved.slug, contentHash: pageContentHash(saved.title, saved.content), origin }
          lines.push('', '公開するページ:', `接続先: ${origin}`, `実験: ${experimentId}`, `ページの名前: ${saved.slug}`, `ページの題名: ${clip(saved.title, 200)}`, `見出し: ${clip(saved.content.headline, 200)}`)
        }
        const ok = await this.confirm({ message: `${id} を承認しますか？`, detail: lines.join('\n'), confirmLabel: '承認する' })
        if (!ok) fail('承認をやめました。')
      }
      const decidedAt = this.iso()
      // 正本（フォルダの外）を先に書き、ファイルへ写す
      await this.ledger.put(id, makeEntry({ status, answer: reply, decidedAt, kind: record.kind, page, approval: record }))
      const a: Approval = { ...record, status, answer: reply, decidedAt }
      await this.writeRecord('approval', a, found.body)
      return this.load()
    })
  }

  addSearch(search: unknown): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      const s = search && typeof search === 'object' && !Array.isArray(search) ? search as Record<string, unknown> : fail('検索の記録が正しくありません。')
      const query = text(s.query, LIMITS.searchQuery, '検索語').trim()
      if (!query) fail('検索語を入れてください。')
      const row: SearchLog = {
        at: this.iso(),
        query,
        medium: text(s.medium ?? '', LIMITS.searchField, '媒体').trim(),
        period: text(s.period ?? '', LIMITS.searchField, '期間').trim(),
        readable: s.readable === true,
        adopted: s.adopted === true,
        note: text(s.note ?? '', LIMITS.searchNote, 'メモ').trim()
      }
      if (!coerceSearch(row)) fail('検索の記録が正しくありません。')
      await this.requireBusiness()
      const current = await this.fs.readText(SEARCHES_FILE, LIMITS.searchesBytes)
      const line = `${JSON.stringify(row)}\n`
      if ((current?.length ?? 0) + line.length > LIMITS.searchesBytes) fail('検索履歴が大きくなりすぎました。古い行を別のファイルへ移してください。')
      await this.fs.append(SEARCHES_FILE, current && !current.endsWith('\n') ? `\n${line}` : line)
      return this.load()
    })
  }

  // ---- 証拠の取り込み ----

  /** 内蔵ブラウザで見ているページを証拠の下書きにする。選んだ文が無ければ「発見のみ」 */
  captureEvidence(capture: () => Promise<PageCapture>, hypothesisId: unknown): Promise<{ snapshot: BusinessSnapshot; id: string }> {
    return this.serial(async () => {
      const loaded = await this.requireBusiness()
      const page = await capture()
      let url: URL
      try {
        url = new URL(page.url)
      } catch {
        fail('ブラウザでページを開いてから追加してください。')
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('http・https のページだけ証拠に追加できます。')
      const selection = (typeof page.selection === 'string' ? page.selection : '').trim().slice(0, LIMITS.selection)
      const title = (typeof page.title === 'string' ? page.title : '').trim().slice(0, LIMITS.title)
      const now = this.now()
      const id = nextId('evidence', [...loaded.data.evidence.map((e) => e.id), ...[...loaded.broken].filter((p) => p.startsWith('evidence/')).map((p) => p.slice(9, -3))])
      const hypotheses = isRecordId('hypothesis', hypothesisId) && loaded.data.hypotheses.some((h) => h.id === hypothesisId) ? [hypothesisId] : []
      const dir = `${CAPTURES_DIR}/${id}`
      await this.fs.mkdir(dir)
      if (page.png && page.png.byteLength > 0) await this.fs.write(`${dir}/page.png`, page.png)
      await this.fs.write(`${dir}/meta.json`, `${JSON.stringify({ url: url.href, title, capturedAt: now.toISOString() }, null, 2)}\n`)
      const e: Evidence = {
        ...emptyRecord('evidence', id, now.toISOString()),
        hypotheses,
        url: url.href,
        medium: url.hostname.replace(/^www\./, ''),
        quote: selection,
        checkedAt: localDate(now),
        readStatus: selection ? '読了' : '発見のみ'
      }
      const body = [`# ${title || url.hostname}`, '', `- 取り込み: ${dir}/（画面の写し page.png・meta.json）`].join('\n')
      await this.writeRecord('evidence', e, body)
      return { snapshot: await this.load(), id }
    })
  }

  // ---- 実験ページ ----

  private async experimentOrFail(id: unknown): Promise<{ record: Experiment; body: string }> {
    if (!isRecordId('experiment', id)) fail('実験の ID の形が違います。')
    const found = await this.readRecord('experiment', id)
    if (!found) fail(`実験 ${id} はありません。`)
    return found
  }

  /**
   * 実験ページを Worker に送る。publish は、その実験の「実験ページの公開」が承認済みのときだけ。
   * 承認が無ければ、承認の依頼（待ち）を作り（既に待ちがあれば作らない）、下書きとして送る
   */
  pushPage(input: unknown, api: () => Promise<PagesApi>): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      const i = input && typeof input === 'object' ? input as Record<string, unknown> : fail('内容が正しくありません。')
      const loaded = await this.requireBusiness()
      const found = await this.experimentOrFail(i.experimentId)
      const x = found.record
      if (typeof i.slug !== 'string' || !SLUG_PATTERN.test(i.slug)) fail('ページの名前は英小文字・数字・- の 3〜48 文字にしてください。')
      const title = text(i.title, PAGE_LIMITS.title, 'ページの題名').trim()
      if (!title) fail('ページの題名を入れてください。')
      const content: PageContent = validatePageContent(i.content)
      if (x.page && x.page.slug !== i.slug && x.page.status === '公開中') fail('公開中のページの名前は変えられません。先に公開を止めてください。')
      // 公開の判定は正本（フォルダの外）だけを見る。実験・ページの名前・中身が承認したときと同じものだけ
      const contentHash = pageContentHash(title, content)
      const origin = await this.pageOrigin()
      const approved = !!origin && Object.values(loaded.ledger).some((e) =>
        e.status === '承認' && e.kind === '実験ページの公開' && entryIntact(e) &&
        e.page?.experimentId === x.id && e.page.slug === i.slug && e.page.contentHash === contentHash && e.page.origin === origin)
      const approvals = loaded.data.approvals.filter((a) => a.kind === '実験ページの公開' && a.refs.includes(x.id))
      const publish = i.publish === true && approved
      if (publish) {
        const ok = await this.confirm({
          message: `${x.id} の実験ページを公開しますか？`,
          detail: [`接続先: ${origin}`, `実験: ${x.id}`, `ページの名前: ${i.slug}`, `ページの題名: ${clip(title, 200)}`, `見出し: ${clip(content.headline, 200)}`, '', '公開すると誰でも見られます。'].join('\n'),
          confirmLabel: '公開する'
        })
        if (!ok) fail('公開をやめました。')
      }
      const client = await api()
      await client.put(i.slug, { experimentId: x.id, title, content, status: publish ? 'published' : 'draft' })
      if (i.publish === true && !approved && !approvals.some((a) => a.status === '待ち')) {
        const now = this.iso()
        const ids = [...loaded.data.approvals.map((a) => a.id), ...[...loaded.broken].filter((p) => p.startsWith('approvals/')).map((p) => p.slice(10, -3))]
        const request: Approval = {
          ...emptyRecord('approval', nextId('approval', ids), now),
          kind: '実験ページの公開',
          title: `${x.id} の実験ページ（${i.slug}）を公開する`,
          detail: `実験 ${x.id} のページ「${title}」を公開します。公開すると誰でも見られます。下書きはサーバーに送ってあります。`,
          refs: [x.id, ...(x.hypothesis && isRecordId('hypothesis', x.hypothesis) ? [x.hypothesis] : [])],
          options: ['公開する', '公開しない'],
          status: '待ち',
          requestedBy: 'Ferret',
          requestedAt: now
        }
        await this.writeRecord('approval', request, '')
      }
      x.page = { slug: i.slug, status: publish ? '公開中' : '下書き' }
      await this.writeRecord('experiment', x, found.body)
      // 送った中身を手元に残す（次に開いたとき、フォームへ戻す）
      const saved: SavedPage = { slug: i.slug, title, content, pushedAt: this.iso() }
      await this.fs.write(`${PAGES_DIR}/${x.id}.json`, `${JSON.stringify(saved, null, 2)}\n`)
      return this.load()
    })
  }

  unpublishPage(experimentId: unknown, api: () => Promise<PagesApi>): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      await this.requireBusiness()
      const found = await this.experimentOrFail(experimentId)
      const x = found.record
      if (!x.page) fail(`${x.id} には実験ページがありません。`)
      await (await api()).unpublish(x.page.slug)
      x.page = { ...x.page, status: '停止' }
      await this.writeRecord('experiment', x, found.body)
      return this.load()
    })
  }

  /** 統計の期間: 実験の期間（無ければ今日までの 1 年）。未来の終了日は今日にし、366 日を超えないように縮める */
  statsRange(x: Experiment): { from: string; to: string } {
    const today = localDate(this.now())
    const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))
    const minus = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10)
    const to = isDate(x.period.end) && x.period.end < today ? x.period.end : today
    const earliest = minus(to, MAX_STATS_RANGE_DAYS - 1)
    let from = isDate(x.period.start) ? x.period.start : earliest
    if (from > to) from = to
    if (from < earliest) from = earliest
    return { from, to }
  }

  /** 最後に送った実験ページの中身。無い・壊れていれば null（形は送るときと同じ検査をし直す） */
  async pageContent(experimentId: unknown): Promise<SavedPage | null> {
    const found = await this.experimentOrFail(experimentId)
    const raw = await this.fs.readText(`${PAGES_DIR}/${found.record.id}.json`, 64 * 1024)
    if (!raw) return null
    try {
      const o = JSON.parse(raw) as Record<string, unknown>
      if (typeof o.slug !== 'string' || !SLUG_PATTERN.test(o.slug)) return null
      return { slug: o.slug, title: text(o.title, PAGE_LIMITS.title, 'ページの題名'), content: validatePageContent(o.content), pushedAt: typeof o.pushedAt === 'string' ? o.pushedAt : '' }
    } catch {
      return null
    }
  }

  async pageStats(experimentId: unknown, api: () => Promise<PagesApi>): Promise<PageStats> {
    const found = await this.experimentOrFail(experimentId)
    const x = found.record
    if (!x.page) fail(`${x.id} には実験ページがありません。`)
    const { from, to } = this.statsRange(x)
    return (await api()).stats(x.page.slug, from, to)
  }

  /**
   * ページの数を実験の実測へ入れる（実施中・完了の実験だけ。計画 plan には触れない）。
   * 対応: actual.interest（関心表明）= ページの関心表明の件数（interests）、
   *       actual.contacts（接触）= ページを見た人の数（uniqueVisitors。日ごとに重複を除いた訪問者数の合計）。
   * 表示回数（views）と CTA のクリック数（ctaClicks）は対応する欄が無いので入れない
   */
  applyPageStats(experimentId: unknown, api: () => Promise<PagesApi>): Promise<BusinessSnapshot> {
    return this.serial(async () => {
      await this.requireBusiness()
      const found = await this.experimentOrFail(experimentId)
      const x = found.record
      if (x.status !== '実施中' && x.status !== '完了') fail('実測に入れられるのは、実施中か完了の実験だけです。')
      if (!x.page) fail(`${x.id} には実験ページがありません。`)
      const { from, to } = this.statsRange(x)
      const stats = await (await api()).stats(x.page.slug, from, to)
      x.actual = { ...x.actual, interest: stats.interests, contacts: stats.uniqueVisitors }
      await this.writeRecord('experiment', x, found.body)
      return this.load()
    })
  }
}

/**
 * 実行条件の4点の変更（一部の項目・一部の欄だけでもよい）。今の値に重ね、無い項目は既定の問いで埋める。
 * plan は文字（LIMITS.executionPlan まで）、confirmed は true / false だけ
 */
export function mergeExecution(current: BusinessFile['execution'], patch: unknown): Record<ExecutionKey, ExecutionItem> {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('実行条件が正しくありません。')
  const p = patch as Record<string, unknown>
  for (const key of Object.keys(p)) if (!(EXECUTION_KEYS as readonly string[]).includes(key)) fail('実行条件の項目が正しくありません。')
  const next = defaultExecution('ja', current)
  for (const key of EXECUTION_KEYS) {
    if (p[key] === undefined) continue
    const item = p[key] && typeof p[key] === 'object' && !Array.isArray(p[key]) ? p[key] as Record<string, unknown> : fail('実行条件が正しくありません。')
    if (item.plan !== undefined) next[key].plan = text(item.plan, LIMITS.executionPlan, '決める内容')
    if (item.confirmed !== undefined) {
      if (typeof item.confirmed !== 'boolean') fail('確認できたかは はい／いいえ で選んでください。')
      next[key].confirmed = item.confirmed
    }
  }
  return next
}

function listKey(kind: RecordKind): 'hypotheses' | 'evidence' | 'alternatives' | 'interviews' | 'experiments' | 'decisions' | 'approvals' {
  const keys = { hypothesis: 'hypotheses', evidence: 'evidence', alternative: 'alternatives', interview: 'interviews', experiment: 'experiments', decision: 'decisions', approval: 'approvals' } as const
  return keys[kind]
}

function parseTarget(raw: unknown): BusinessSendTarget {
  const t = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (t?.kind === 'active') return { kind: 'active' }
  if (t?.kind === 'terminal' && typeof t.id === 'string' && t.id && t.id.length <= 200) return { kind: 'terminal', id: t.id }
  if (t?.kind === 'new' && (t.agent === 'claude' || t.agent === 'codex')) return { kind: 'new', agent: t.agent }
  fail('送り先が正しくありません。')
}
