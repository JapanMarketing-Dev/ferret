/**
 * ビジネスリサーチ1件（開いているプロジェクトのフォルダ）の記録の読み書き。
 *
 * Electron に依存しない。時計・言語・送信・人の判断の正本は外から渡す（単体テストで差し替える）。
 * 置き場所と形式（model.ts の冒頭も参照）:
 *   research.yaml                 名前・対象範囲・重み・足切り・ファンネルの目安（YAML）
 *   candidates/C001.md            候補。YAML の前置き（Candidate）+ 自由なメモ（本文）
 *   evidence/E001.md              証拠。YAML の前置き（ResearchEvidence）+ 本文
 *   experiments/X001.md           市場実験。YAML の前置き（ResearchExperiment）+ 本文
 *   principles/knowledge.md       集客の5原則のナレッジの写し（Ferret が書く。印のあるものだけ書き直す）
 *   .research/README.md           記録の形式（Ferret が書く）
 *   .research/context.md          いまの状況（Ferret が書く。Agent が最初に読む）
 *   .research/sent/               Agent へ送った依頼（送れたときだけ）
 *   .research/trash/              消した記録（戻せる）
 *   CLAUDE.md・AGENTS.md          ferret-research:start/end の印の間に短い案内
 * 決まり:
 * - renderer から来た値は信じない。記録はもう一度型へ寄せ（coerceResearchRecord）、検査（validateResearchRecord）で error があれば書かない
 * - 人だけが変える欄は保存で変えない: 候補の stage・dropReason（setStage だけ）、gates（decideGate だけ）、promotedTo（markPromoted だけ）
 * - ゲートの人の判断の正本はフォルダの外（ApprovalLedger。index.ts では userData/research-gates/。HMAC つき）。
 *   ファイルの gates は写しで、正本と合わない pass・fail は「pending」として扱い、problems に出す（Agent がファイルに pass と書いても通らない）
 * - 書き込みは1つずつ（serial）。一度の読み込みは合計のバイト数に上限。フォルダの一覧は件数で打ち切る
 * - 壊れたファイルは problems に出し（相対のパスと理由だけ）、落ちない。壊れたファイルは上書きしない
 */
import { createHash } from 'node:crypto'
import {
  GATE_IDS,
  RESEARCH_CONTEXT_FILE,
  RESEARCH_FILE,
  RESEARCH_KNOWLEDGE_FILE,
  RESEARCH_META_DIR,
  RESEARCH_README_FILE,
  RESEARCH_RECORD_KINDS,
  RESEARCH_RECORD_KIND_LIST,
  RESEARCH_SENT_DIR,
  RESEARCH_TRASH_DIR,
  CANDIDATE_STAGES,
  DEFAULT_WEIGHTS,
  FUNNEL_STAGES,
  SCORE_KEYS,
  isResearchId,
  type Candidate,
  type CandidateStage,
  type GateDecision,
  type GateId,
  type ResearchData,
  type ResearchFile,
  type ResearchRecordKind,
  type ResearchRecordTypes
} from '@shared/research/model'
import type { ResearchIssue, ResearchPromptId, ResearchPromptView, ResearchSaveResult, ResearchSendRequest, ResearchSnapshot } from '@shared/research/ipc'
import { RESEARCH_PROMPT_IDS } from '@shared/research/ipc'
import { coerceResearch, coerceResearchRecord, emptyResearch, hasResearchErrors, validateResearchRecord, type ResearchFix } from '@shared/research/records'
import { canDecideGate } from '@shared/research/gates'
import { STOP_HOOK_SCRIPT_FILE, STOP_HOOK_SETTINGS_FILE, STOP_HOOK_STATE_DIR, mergeStopHookSettings, stopHookScript } from '@shared/research/stopHook'
import { buildResearchPrompt, researchAgentRules, researchGoal } from '@shared/research/prompts'
import { researchContextMarkdown, researchReadme } from '@shared/research/context'
import { MAX_RECORD_BYTES, RecordParseError, dumpYaml, formatRecordFile, parseRecordFile, parseYaml } from '@shared/business/format'
import { t, type TranslationKey } from '@shared/i18n'
import { UserFacingError, isUserFacingError } from '@shared/errors'
import { BusinessFs, MAX_DIR_ENTRIES, MESSAGES as FS_MESSAGES } from '../business/fsx'
import { ensureBusinessGitExclude } from '../business/gitExclude'
import { localDate, type AgentSender, type SendOutcome } from '../business/store'
import { MemoryApprovalLedger, entryIntact, makeEntry, recordHash, type ApprovalLedger, type LedgerEntry } from '../business/approvalLedger'
import type { BusinessSendTarget } from '@shared/business/ipc'
import { parseSendTarget } from '../business/sendPass'

export type Locale = 'ja' | 'en'

export const AGENT_FILES = ['CLAUDE.md', 'AGENTS.md'] as const
export const BLOCK_START = '<!-- ferret-research:start -->'
export const BLOCK_END = '<!-- ferret-research:end -->'
/** アプリが書いたファイルの印（これがあるファイルだけ書き直す。人が書いたファイルは上書きしない） */
export const GENERATED_MARK = '<!-- ferret-research:generated -->'
/** git の管理から外すもの（.git/info/exclude。コミットされない手元だけの除外） */
export const RESEARCH_GIT_EXCLUDES = [`${RESEARCH_SENT_DIR}/`, `${RESEARCH_TRASH_DIR}/`, `${STOP_HOOK_STATE_DIR}/`] as const
const GIT_HEADER = '# Ferret が追記（ビジネスリサーチの送った履歴とゴミ箱を git の管理から外す）'

export const LIMITS = {
  name: 100,
  scope: 500,
  note: 1000,
  reason: 1000,
  body: 200_000,
  sendText: 100_000,
  agentFileBytes: 1024 * 1024,
  /** 一度の読み込みで読む合計のバイト数 */
  loadBytes: 32 * 1024 * 1024
} as const

const SCAFFOLD_DIRS = [
  ...RESEARCH_RECORD_KIND_LIST.map((k) => RESEARCH_RECORD_KINDS[k].dir), 'principles', RESEARCH_META_DIR, RESEARCH_SENT_DIR, RESEARCH_TRASH_DIR
]
const MAX_FIXES_PER_FILE = 5

export interface ResearchStoreDeps {
  root: string
  now?: () => Date
  /** 依頼文・README・context.md・案内の言語 */
  locale?: () => Locale
  /** 集客の5原則のナレッジの本文（principles/knowledge.md に写す） */
  knowledge?: string
  /** ゲートの人の判断の正本（フォルダの外）。省略時は起動中だけ */
  ledger?: ApprovalLedger
  /** 一度の読み込みで読む合計のバイト数（テストで小さくする） */
  loadBudgetBytes?: number
}

// ---- 小さな道具 ----

/** i18n の文で断る（キーは research.error.*） */
export function fail(key: string, params?: Record<string, string | number>): never {
  throw new UserFacingError(t(`research.error.${key}` as TranslationKey, params))
}

const issueText = (code: string, params?: Record<string, string | number>) => t(`research.issue.${code}` as TranslationKey, params)

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') fail('badText', { field })
  if (value.length > max) fail('textTooLong', { field, max })
  return value
}

const FS_KEYS: Record<string, string> = Object.fromEntries(Object.entries(FS_MESSAGES).map(([k, v]) => [v, k]))

/** fsx.ts の日本語の文（パスを含まない）を i18n の文にする。それ以外はそのまま */
export function localizeError(err: unknown): unknown {
  if (!isUserFacingError(err)) return err
  const key = FS_KEYS[(err as Error).message]
  if (!key) return err
  const code = (err as { code?: unknown }).code
  return Object.assign(new UserFacingError(t(`research.error.fs.${key}` as TranslationKey), { cause: err }), code ? { code } : {})
}

/** 送った履歴の名前に使う日時（ファイル名に使えない : を含めない） */
function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-')
}

const recordFile = (kind: ResearchRecordKind, id: string) => `${RESEARCH_RECORD_KINDS[kind].dir}/${id}.md`

function listKey(kind: ResearchRecordKind): 'candidates' | 'evidence' | 'experiments' {
  return ({ candidate: 'candidates', evidence: 'evidence', experiment: 'experiments' } as const)[kind]
}

/** ゲートの判断を正本に結び付ける（候補・ゲート・状態・メモ・日時のハッシュ） */
export function gateBinding(candidateId: string, gate: GateId, d: GateDecision) {
  return { kind: '段階を進める' as const, refs: [candidateId], title: `research-gate-v1:${gate}`, detail: JSON.stringify([d.status, d.note, d.at]) }
}

export const gateLedgerId = (candidateId: string, gate: GateId) => `${candidateId}:${gate}`

/** principles/knowledge.md の写し（印と版と写した日） */
export function knowledgeCopy(knowledge: string, today: string): string {
  const version = createHash('sha256').update(knowledge).digest('hex').slice(0, 12)
  return `${GENERATED_MARK}\n<!-- ferret-research:knowledge ${version} / ${today} -->\n\n${knowledge}`
}

export function agentBlock(locale: Locale): string {
  const body = locale === 'en'
    ? [
        '## Ferret business research',
        '',
        `This folder is a Ferret business research. Before working, read \`${RESEARCH_CONTEXT_FILE}\` (current status) and \`${RESEARCH_README_FILE}\` (record format and which files you may write). How to research and judge: \`${RESEARCH_KNOWLEDGE_FILE}\`.`,
        'Do not send anything outside, log in, pay, apply or publish. Do not mark gates as pass and do not change candidate stages: people decide them in Ferret.',
        '',
        researchGoal('en')
      ]
    : [
        '## Ferret のビジネスリサーチ',
        '',
        `このフォルダは Ferret のビジネスリサーチの記録です。作業の前に \`${RESEARCH_CONTEXT_FILE}\`（いまの状況）と \`${RESEARCH_README_FILE}\`（記録の形式・書いてよいファイル）を読んでください。調べ方と判定の基準は \`${RESEARCH_KNOWLEDGE_FILE}\`。`,
        '外部への送信・ログイン・課金・応募・公開はしません。ゲートを pass にすること・候補の段階を変えることはしません（人が Ferret で決めます）。',
        '',
        researchGoal('ja')
      ]
  return [BLOCK_START, ...body, BLOCK_END].join('\n')
}

/** CLAUDE.md・AGENTS.md の印の間を差し替える（無ければ末尾に足す）。ビジネスの印（ferret-business）には触らない */
export function upsertBlock(current: string | null, block: string): string {
  if (current === null || !current.trim()) return `${block}\n`
  const start = current.indexOf(BLOCK_START)
  const end = current.indexOf(BLOCK_END)
  if (start >= 0 && end > start) return `${current.slice(0, start)}${block}${current.slice(end + BLOCK_END.length)}`
  return `${current.replace(/\n*$/, '')}\n\n${block}\n`
}

const isPromptId = (id: unknown): id is ResearchPromptId => typeof id === 'string' && (RESEARCH_PROMPT_IDS as readonly string[]).includes(id)

// ---- 読み込み ----

interface Loaded {
  data: ResearchData
  bodies: Record<string, string>
  /** 読めなかった記録のファイル（相対のパス）。上書きしない */
  broken: Set<string>
  researchBroken: boolean
}

export class ResearchStore {
  readonly fs: BusinessFs
  private readonly now: () => Date
  private readonly locale: () => Locale
  private readonly knowledge: string
  private readonly ledger: ApprovalLedger
  private readonly loadBudget: number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(deps: ResearchStoreDeps) {
    this.fs = new BusinessFs(deps.root)
    this.now = deps.now ?? (() => new Date())
    this.locale = deps.locale ?? (() => 'ja')
    this.knowledge = deps.knowledge ?? ''
    this.ledger = deps.ledger ?? new MemoryApprovalLedger()
    this.loadBudget = deps.loadBudgetBytes ?? LIMITS.loadBytes
  }

  get root(): string {
    return this.fs.root
  }

  /** 書き込みを1つずつ行う（同時の保存で読み直しと書き込みが入れ違わない） */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private fallbackName(): string {
    return this.root.split(/[\\/]/).filter(Boolean).at(-1) ?? 'research'
  }

  async isResearch(): Promise<boolean> {
    return (await this.fs.kind(RESEARCH_FILE)) === 'file'
  }

  async status(): Promise<{ isResearch: boolean; name: string | null }> {
    try {
      const raw = await this.fs.readText(RESEARCH_FILE, MAX_RECORD_BYTES)
      if (raw === null) return { isResearch: false, name: null }
      try {
        return { isResearch: true, name: coerceResearch(parseYaml(raw), this.fallbackName(), this.iso()).value.name }
      } catch {
        return { isResearch: true, name: null }
      }
    } catch {
      return { isResearch: false, name: null }
    }
  }

  private async loadAll(): Promise<Loaded> {
    const now = this.iso()
    const problems: ResearchData['problems'] = []
    const broken = new Set<string>()
    const pushFixes = (path: string, fixes: ResearchFix[]) => {
      for (const f of fixes.slice(0, MAX_FIXES_PER_FILE)) problems.push({ path, message: `${f.field ? `${f.field}: ` : ''}${issueText(f.code, f.params)}` })
      if (fixes.length > MAX_FIXES_PER_FILE) problems.push({ path, message: issueText('problemMoreFixes', { count: fixes.length - MAX_FIXES_PER_FILE }) })
    }
    const problemOf = (err: unknown): string => {
      if (err instanceof RecordParseError) {
        if (err.message.startsWith('大きすぎる')) return issueText('problemTooLarge', { max: MAX_RECORD_BYTES / 1024 })
        if (err.message.startsWith('先頭の')) return issueText('problemNoFrontMatter')
        return issueText('problemBroken', { detail: err.message.replace(/^[^:]*:\s*/, '').slice(0, 200) })
      }
      const e = localizeError(err)
      return isUserFacingError(e) ? (e as Error).message : issueText('problemUnreadable')
    }
    let budget = this.loadBudget
    let overBudget = false
    const spend = (raw: string, path: string): boolean => {
      budget -= Buffer.byteLength(raw)
      if (budget >= 0) return true
      if (!overBudget) problems.push({ path, message: issueText('problemBudget') })
      overBudget = true
      return false
    }

    // research.yaml
    let research: ResearchFile
    let researchBroken = false
    let raw: string | null = null
    try {
      raw = await this.fs.readText(RESEARCH_FILE, MAX_RECORD_BYTES)
    } catch (err) {
      researchBroken = true
      problems.push({ path: RESEARCH_FILE, message: problemOf(err) })
    }
    if (raw === null && !researchBroken) fail('notResearch')
    if (raw !== null) {
      try {
        const c = coerceResearch(parseYaml(raw), this.fallbackName(), now)
        research = c.value
        pushFixes(RESEARCH_FILE, c.fixes)
      } catch (err) {
        researchBroken = true
        problems.push({ path: RESEARCH_FILE, message: problemOf(err) })
        research = emptyResearch(this.fallbackName(), now)
      }
    } else {
      research = emptyResearch(this.fallbackName(), now)
    }

    const data: ResearchData = { root: this.root, research, candidates: [], evidence: [], experiments: [], problems }
    const bodies: Record<string, string> = {}
    for (const kind of RESEARCH_RECORD_KIND_LIST) {
      if (overBudget) break
      const dir = RESEARCH_RECORD_KINDS[kind].dir
      let listing: Awaited<ReturnType<BusinessFs['list']>>
      try {
        listing = await this.fs.list(dir, MAX_DIR_ENTRIES)
      } catch (err) {
        problems.push({ path: `${dir}/`, message: problemOf(err) })
        continue
      }
      if (listing.truncated) problems.push({ path: `${dir}/`, message: issueText('problemTooMany', { max: MAX_DIR_ENTRIES }) })
      for (const entry of listing.entries) {
        if (overBudget) break
        if (!entry.name.endsWith('.md')) continue
        const rel = `${dir}/${entry.name}`
        const id = entry.name.slice(0, -3)
        if (entry.kind === 'link') {
          problems.push({ path: rel, message: issueText('problemLink') })
          continue
        }
        if (entry.kind !== 'file') continue
        if (!isResearchId(kind, id)) {
          problems.push({ path: rel, message: issueText('problemBadName', { prefix: RESEARCH_RECORD_KINDS[kind].prefix }) })
          continue
        }
        try {
          const text = await this.fs.readText(rel, MAX_RECORD_BYTES)
          if (text === null) continue
          if (!spend(text, `${dir}/`)) break
          const parsed = parseRecordFile(text)
          const front = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data as Record<string, unknown> : null
          if (front && front.id !== undefined && front.id !== null && String(front.id) !== id) {
            broken.add(rel)
            problems.push({ path: rel, message: issueText('problemIdMismatch', { id: String(front.id).slice(0, 20), name: id }) })
            continue
          }
          const c = coerceResearchRecord(kind, parsed.data, id, now)
          ;(data[listKey(kind)] as Array<ResearchRecordTypes[typeof kind]>).push(c.value)
          bodies[`${kind}:${id}`] = parsed.body
          pushFixes(rel, c.fixes)
        } catch (err) {
          broken.add(rel)
          problems.push({ path: rel, message: problemOf(err) })
        }
      }
    }

    // ゲートの判断はフォルダの外の正本に合わせる。合わないものは pending として扱い、知らせる
    const ledger = await this.ledger.all()
    for (const c of data.candidates) {
      for (const g of GATE_IDS) {
        const decision = c.gates[g]
        const entry: LedgerEntry | undefined = ledger[gateLedgerId(c.id, g)]
        const matches = entry !== undefined && entryIntact(entry) && entry.recordHash === recordHash(gateBinding(c.id, g, decision))
        if (matches) continue
        if (decision.status !== 'pending' || entry !== undefined) {
          problems.push({ path: recordFile('candidate', c.id), message: issueText('gateNotVerified', { gate: g }) })
          c.gates[g] = { status: 'pending', note: '', at: '' }
        }
      }
    }
    return { data, bodies, broken, researchBroken }
  }

  private snapshotOf(loaded: Loaded): ResearchSnapshot {
    return { data: loaded.data }
  }

  async load(): Promise<ResearchSnapshot> {
    return this.snapshotOf(await this.loadAll())
  }

  /** 記録の本文（YAML の前置きのあとの自由なメモ）。無ければ null */
  async body(kind: ResearchRecordKind, id: string): Promise<string | null> {
    return (await this.readRecord(kind, id))?.body ?? null
  }

  private async requireResearch(): Promise<Loaded> {
    const loaded = await this.loadAll()
    if (loaded.researchBroken) fail('researchBroken')
    return loaded
  }

  /** 1件を読む。無ければ null、壊れていれば UserFacingError（上書きさせない） */
  private async readRecord<K extends ResearchRecordKind>(kind: K, id: string): Promise<{ record: ResearchRecordTypes[K]; body: string } | null> {
    if (!isResearchId(kind, id)) fail('badId', { id: String(id).slice(0, 20) })
    const raw = await this.fs.readText(recordFile(kind, id), MAX_RECORD_BYTES)
    if (raw === null) return null
    let parsed: ReturnType<typeof parseRecordFile>
    try {
      parsed = parseRecordFile(raw)
    } catch {
      fail('recordBroken', { id })
    }
    const front = parsed.data && typeof parsed.data === 'object' && !Array.isArray(parsed.data) ? parsed.data as Record<string, unknown> : null
    if (front && front.id !== undefined && front.id !== null && String(front.id) !== id) fail('idMismatch', { id })
    return { record: coerceResearchRecord(kind, parsed.data, id, this.iso()).value, body: parsed.body }
  }

  private async writeRecord<K extends ResearchRecordKind>(kind: K, record: ResearchRecordTypes[K], body: string): Promise<void> {
    const content = formatRecordFile(record, body)
    if (Buffer.byteLength(content) > MAX_RECORD_BYTES) fail('tooLarge', { max: MAX_RECORD_BYTES / 1024 })
    await this.fs.write(recordFile(kind, record.id), content)
  }

  /** 正本と照らした候補と本文（無ければ UserFacingError） */
  private async candidateOrFail(loaded: Loaded, id: unknown): Promise<{ candidate: Candidate; body: string }> {
    if (!isResearchId('candidate', id)) fail('badId', { id: String(id).slice(0, 20) })
    if (loaded.broken.has(recordFile('candidate', id))) fail('recordBroken', { id })
    const candidate = loaded.data.candidates.find((c) => c.id === id)
    if (!candidate) fail('notFound', { id })
    return { candidate, body: loaded.bodies[`candidate:${id}`] ?? '' }
  }

  // ---- 作る ----

  /** ひな型を書く。既にあるファイルは上書きしない（印のある README・ナレッジと、CLAUDE.md・AGENTS.md の印の間だけ書き直す） */
  init(input: unknown): Promise<ResearchSnapshot> {
    return this.serial(async () => {
      const i = input && typeof input === 'object' ? input as Record<string, unknown> : {}
      const exists = await this.isResearch()
      let name = ''
      let scope = ''
      if (!exists) {
        name = text(i.name ?? '', LIMITS.name, 'name').trim()
        if (!name) fail('nameRequired')
        scope = text(i.scope ?? '', LIMITS.scope, 'scope').trim()
      }
      for (const dir of SCAFFOLD_DIRS) await this.fs.mkdir(dir)
      const now = this.now()
      if (!exists) await this.fs.writeIfMissing(RESEARCH_FILE, dumpYaml({ ...emptyResearch(name, now.toISOString()), scope }))
      await this.writeScaffold(now)
      const loaded = await this.loadAll()
      await this.writeContext(loaded.data, now)
      return this.snapshotOf(loaded)
    })
  }

  private async writeScaffold(now: Date): Promise<void> {
    const locale = this.locale()
    if (this.knowledge) await this.writeGenerated(RESEARCH_KNOWLEDGE_FILE, knowledgeCopy(this.knowledge, localDate(now)), (a, b) => stripStamp(a) === stripStamp(b))
    await this.writeGenerated(RESEARCH_README_FILE, `${GENERATED_MARK}\n${researchReadme(locale)}`)
    for (const file of AGENT_FILES) await this.upsertAgentFile(file, locale)
    await this.writeStopHook()
    await ensureBusinessGitExclude(this.fs, RESEARCH_GIT_EXCLUDES, GIT_HEADER)
  }

  private async writeContext(data: ResearchData, now: Date): Promise<void> {
    await this.fs.write(RESEARCH_CONTEXT_FILE, researchContextMarkdown(data, now.toISOString(), this.locale()))
  }

  /** アプリが書くファイル。無ければ作り、印があって中身が違えば書き直す。印の無い（人が書いた）ファイルは触らない */
  private async writeGenerated(rel: string, content: string, same: (a: string, b: string) => boolean = (a, b) => a === b): Promise<void> {
    if (await this.fs.writeIfMissing(rel, content)) return
    if ((await this.fs.kind(rel)) !== 'file') return
    const current = await this.fs.readText(rel, LIMITS.agentFileBytes).catch(() => null)
    if (current?.includes(GENERATED_MARK) && !same(current, content)) await this.fs.write(rel, content)
  }

  /**
   * 「参入先を決め切る」を最後までやらせる Claude Code の Stop フック（@shared/research/stopHook）。
   * スクリプトは印があるときだけ書き直し、.claude/settings.json は足すだけ（読めない・リンク・大きすぎるなら触らない）
   */
  private async writeStopHook(): Promise<void> {
    await this.writeGenerated(STOP_HOOK_SCRIPT_FILE, stopHookScript(GENERATED_MARK))
    const kind = await this.fs.kind(STOP_HOOK_SETTINGS_FILE)
    if (kind !== null && kind !== 'file') return
    let current: string | null = null
    if (kind === 'file') {
      try {
        current = await this.fs.readText(STOP_HOOK_SETTINGS_FILE, LIMITS.agentFileBytes)
      } catch {
        return
      }
    }
    const next = mergeStopHookSettings(current)
    if (next !== null) await this.fs.write(STOP_HOOK_SETTINGS_FILE, next)
  }

  /** CLAUDE.md・AGENTS.md に印の間を足す・差し替える。リンクは触らない。大きすぎる・読めないファイルは書かない */
  private async upsertAgentFile(rel: string, locale: Locale): Promise<void> {
    const kind = await this.fs.kind(rel)
    if (kind !== null && kind !== 'file') return
    let current: string | null = null
    if (kind === 'file') {
      try {
        current = await this.fs.readText(rel, LIMITS.agentFileBytes)
      } catch {
        return
      }
    }
    const next = upsertBlock(current, agentBlock(locale))
    if (next !== current) await this.fs.write(rel, next)
  }

  // ---- 記録 ----

  saveRecord(kind: unknown, record: unknown, body: unknown): Promise<ResearchSaveResult> {
    return this.serial(async () => {
      if (typeof kind !== 'string' || !(RESEARCH_RECORD_KIND_LIST as readonly string[]).includes(kind)) fail('badKind')
      const k = kind as ResearchRecordKind
      const rawId = record && typeof record === 'object' ? (record as { id?: unknown }).id : undefined
      const id = typeof rawId === 'string' ? rawId : ''
      const shownId = id.slice(0, 20)
      const error = (field: string, code: string, params?: Record<string, string | number>): ResearchSaveResult => ({ ok: false, issues: [{ level: 'error', field, code, ...(params ? { params } : {}) }] })
      if (!isResearchId(k, id)) return error('id', 'idInvalid', { id: shownId })
      if (body !== null && body !== undefined && typeof body !== 'string') return error('body', 'bodyInvalid')
      if (typeof body === 'string' && body.length > LIMITS.body) return error('body', 'bodyTooLong', { max: LIMITS.body })
      const loaded = await this.requireResearch()
      const rel = recordFile(k, id)
      if (loaded.broken.has(rel)) return error('id', 'recordBroken', { id })
      const now = this.iso()
      const coerced = coerceResearchRecord(k, record, id, now)
      const next = coerced.value
      // 型へ寄せたときに直したこと（画面から来た値が型と違う）は warning で返す
      const fixIssues: ResearchIssue[] = coerced.fixes.map((f) => ({ level: 'warning', field: f.field, code: f.code, ...(f.params ? { params: f.params } : {}) }))
      if (k === 'candidate') {
        const c = next as Candidate
        const prev = loaded.data.candidates.find((x) => x.id === id)
        c.stage = prev?.stage ?? 'discovered'
        c.dropReason = prev?.dropReason ?? ''
        c.gates = prev ? structuredClone(prev.gates) : coerceResearchRecord('candidate', {}, id, now).value.gates
        c.promotedTo = prev?.promotedTo ?? null
        c.createdAt = prev?.createdAt ?? now
        c.updatedAt = now
      }
      const others: ResearchData = { ...loaded.data, [listKey(k)]: (loaded.data[listKey(k)] as Array<{ id: string }>).filter((r) => r.id !== id) }
      const issues = [...fixIssues, ...validateResearchRecord(k, next, others, localDate(this.now()))]
      if (hasResearchErrors(issues)) return { ok: false, issues }
      // 本文が null なら既存の本文を保つ（画面は本文を編集しない。Agent・人が書いたメモを消さない）
      const bodyText = typeof body === 'string' ? body : loaded.bodies[`${k}:${id}`] ?? ''
      const content = formatRecordFile(next, bodyText)
      if (Buffer.byteLength(content) > MAX_RECORD_BYTES) return error('body', 'recordTooLarge', { max: MAX_RECORD_BYTES / 1024 })
      await this.fs.write(rel, content)
      return { ok: true, snapshot: await this.load(), issues }
    })
  }

  /** .research/trash/<kind>-<id>-<日時>.md へ動かす（戻せる） */
  deleteRecord(kind: unknown, id: unknown): Promise<ResearchSnapshot> {
    return this.serial(async () => {
      if (typeof kind !== 'string' || !(RESEARCH_RECORD_KIND_LIST as readonly string[]).includes(kind)) fail('badKind')
      const k = kind as ResearchRecordKind
      if (!isResearchId(k, id)) fail('badId', { id: String(id).slice(0, 20) })
      const rel = recordFile(k, id)
      const found = await this.fs.kind(rel)
      if (found === null) fail('notFound', { id })
      if (found !== 'file') fail('notFile', { id })
      await this.fs.mkdir(RESEARCH_TRASH_DIR)
      await this.fs.move(rel, `${RESEARCH_TRASH_DIR}/${k}-${id}-${stamp(this.now())}.md`)
      return this.load()
    })
  }

  updateResearch(patch: unknown): Promise<ResearchSnapshot> {
    return this.serial(async () => {
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail('badPatch')
      const p = patch as Record<string, unknown>
      const loaded = await this.requireResearch()
      const r: ResearchFile = structuredClone(loaded.data.research)
      if (p.name !== undefined) {
        const name = text(p.name, LIMITS.name, 'name').trim()
        if (!name) fail('nameRequired')
        r.name = name
      }
      if (p.scope !== undefined) r.scope = text(p.scope, LIMITS.scope, 'scope').trim()
      if (p.weights !== undefined) {
        const w = p.weights && typeof p.weights === 'object' && !Array.isArray(p.weights) ? p.weights as Record<string, unknown> : fail('badWeights')
        const next = { ...DEFAULT_WEIGHTS }
        for (const key of SCORE_KEYS) {
          const v = w[key]
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100) fail('badWeights')
          next[key] = v
        }
        if (SCORE_KEYS.every((key) => next[key] === 0)) fail('badWeights')
        r.weights = next
      }
      if (p.cutoffs !== undefined) {
        const c = p.cutoffs && typeof p.cutoffs === 'object' && !Array.isArray(p.cutoffs) ? p.cutoffs as Record<string, unknown> : fail('badCutoffs')
        for (const key of SCORE_KEYS) {
          const v = c[key]
          if (v === null || v === undefined) r.cutoffs[key] = null
          else if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 5) r.cutoffs[key] = v
          else fail('badCutoffs')
        }
      }
      if (p.funnelTargets !== undefined) {
        const f = p.funnelTargets && typeof p.funnelTargets === 'object' && !Array.isArray(p.funnelTargets) ? p.funnelTargets as Record<string, unknown> : fail('badFunnelTargets')
        for (const key of FUNNEL_STAGES) {
          const v = f[key]
          if (v === undefined) continue
          if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 1e9) fail('badFunnelTargets')
          r.funnelTargets[key] = v
        }
      }
      if (p.minTargetCount !== undefined) {
        const v = p.minTargetCount
        if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 1e9) fail('badMinTargetCount')
        r.minTargetCount = v
      }
      await this.fs.write(RESEARCH_FILE, dumpYaml(r))
      return this.load()
    })
  }

  // ---- 人の判断 ----

  /** ゲートを人が確定する（前のゲートが pass でなければ pass にできない）。正本（フォルダの外）を先に書き、ファイルへ写す */
  decideGate(input: unknown): Promise<ResearchSnapshot> {
    return this.serial(async () => {
      const i = input && typeof input === 'object' ? input as Record<string, unknown> : fail('badPatch')
      if (typeof i.gate !== 'string' || !(GATE_IDS as readonly string[]).includes(i.gate)) fail('badGate')
      const gate = i.gate as GateId
      if (i.status !== 'pass' && i.status !== 'fail' && i.status !== 'pending') fail('badGateStatus')
      const note = text(i.note ?? '', LIMITS.note, 'note').trim()
      const loaded = await this.requireResearch()
      const { candidate, body } = await this.candidateOrFail(loaded, i.candidateId)
      const allowed = canDecideGate(candidate, gate, i.status)
      if (!allowed.ok) fail('gatePreviousNotPassed', { gate })
      const decision: GateDecision = { status: i.status, note, at: i.status === 'pending' ? '' : this.iso() }
      await this.ledger.put(gateLedgerId(candidate.id, gate), makeEntry({
        status: '承認', answer: '', decidedAt: this.iso(), kind: '段階を進める', page: null, approval: gateBinding(candidate.id, gate, decision)
      }))
      const next: Candidate = { ...candidate, gates: { ...candidate.gates, [gate]: decision }, updatedAt: this.iso() }
      await this.writeRecord('candidate', next, body)
      return this.load()
    })
  }

  /** 候補の段階を変える（人が押したときだけ）。dropped は理由が要る。selected は「プロジェクトにする」だけが付ける */
  setStage(input: unknown): Promise<ResearchSnapshot> {
    return this.serial(async () => {
      const i = input && typeof input === 'object' ? input as Record<string, unknown> : fail('badPatch')
      if (typeof i.stage !== 'string' || !(CANDIDATE_STAGES as readonly string[]).includes(i.stage)) fail('badStage')
      const stage = i.stage as CandidateStage
      if (stage === 'selected') fail('stageSelectedByPromote')
      const reason = text(i.reason ?? '', LIMITS.reason, 'reason').trim()
      if (stage === 'dropped' && !reason) fail('dropReasonRequired')
      const loaded = await this.requireResearch()
      const { candidate, body } = await this.candidateOrFail(loaded, i.candidateId)
      if (candidate.promotedTo) fail('alreadyPromoted', { id: candidate.id })
      if (candidate.stage === stage) fail('alreadyStage', { id: candidate.id, stage })
      const next: Candidate = { ...candidate, stage, dropReason: stage === 'dropped' ? reason : '', updatedAt: this.iso() }
      await this.writeRecord('candidate', next, body)
      return this.load()
    })
  }

  /** 「プロジェクトにする」のあと: 候補を selected にし、作ったフォルダを記録する */
  markPromoted(candidateId: string, promotedTo: NonNullable<Candidate['promotedTo']>): Promise<ResearchSnapshot> {
    return this.serial(async () => {
      const loaded = await this.requireResearch()
      const { candidate, body } = await this.candidateOrFail(loaded, candidateId)
      const next: Candidate = { ...candidate, stage: 'selected', dropReason: '', promotedTo, updatedAt: this.iso() }
      await this.writeRecord('candidate', next, body)
      const after = await this.loadAll()
      await this.writeContext(after.data, this.now())
      return this.snapshotOf(after)
    })
  }

  /** いまのデータ（research.yaml が壊れていれば断る） */
  async data(): Promise<ResearchData> {
    return (await this.requireResearch()).data
  }

  // ---- 依頼 ----

  async prompt(input: unknown): Promise<ResearchPromptView> {
    const i = input && typeof input === 'object' ? input as Record<string, unknown> : {}
    if (!isPromptId(i.promptId)) fail('promptNotFound')
    const candidateId = i.candidateId === null || i.candidateId === undefined || i.candidateId === '' ? null : i.candidateId
    if (candidateId !== null && !isResearchId('candidate', candidateId)) fail('badId', { id: String(candidateId).slice(0, 20) })
    const loaded = await this.loadAll()
    if (candidateId !== null && !loaded.data.candidates.some((c) => c.id === candidateId)) fail('notFound', { id: candidateId })
    const built = buildResearchPrompt(i.promptId, loaded.data, candidateId, this.locale())
    return { id: i.promptId, candidateId, text: built.text }
  }

  /** context.md を書き直してから送る。送れたときだけ .research/sent/ に残す。送れなければ ok:false（送ったとは言わない） */
  send(request: unknown, sender: AgentSender): Promise<{ ok: boolean; message: string }> {
    return this.serial(async () => {
      const r = request && typeof request === 'object' ? request as Partial<ResearchSendRequest> : fail('badSend')
      if (!isPromptId(r.promptId)) fail('promptNotFound')
      if (typeof r.text !== 'string' || !r.text.trim()) fail('sendEmpty')
      if (r.text.length > LIMITS.sendText) fail('sendTooLong', { max: LIMITS.sendText })
      const candidateId = typeof r.candidateId === 'string' && isResearchId('candidate', r.candidateId) ? r.candidateId : null
      const target: BusinessSendTarget = parseSendTarget(r.target, () => t('research.error.badTarget' as TranslationKey))
      const loaded = await this.requireResearch()
      const now = this.now()
      // 守ること（researchAgentRules）は main が付ける。画面から来た本文の末尾に無ければ足す（消して送れない）
      const rules = researchAgentRules(this.locale()).trim()
      const body = r.text.trimEnd().endsWith(rules) ? r.text : `${r.text.trimEnd()}\n\n${rules}`
      // 前の版で作ったフォルダにも、いまの案内（CLAUDE.md・AGENTS.md の印の間・README）を送る前に入れる
      await this.writeScaffold(now)
      await this.writeContext(loaded.data, now)
      let outcome: SendOutcome
      try {
        outcome = await sender.send(target, body)
      } catch (err) {
        return { ok: false, message: err instanceof UserFacingError ? err.message : t('research.error.sendFailed' as TranslationKey) }
      }
      if (!outcome.ok) return { ok: false, message: outcome.message || t('research.error.sendFailed' as TranslationKey) }
      const label = outcome.label || (target.kind === 'new' ? (target.agent === 'codex' ? 'Codex' : 'Claude Code') : 'Agent')
      const front = { id: '', at: now.toISOString(), promptId: r.promptId, candidateId, target: label }
      try {
        const base = `${stamp(now)}-${r.promptId}`
        for (let n = 0; n < 20; n++) {
          const id = n === 0 ? base : `${base}-${n + 1}`
          if (await this.fs.writeIfMissing(`${RESEARCH_SENT_DIR}/${id}.md`, formatRecordFile({ ...front, id }, body))) break
        }
      } catch {
        return { ok: true, message: `${outcome.message} ${t('research.error.sentNotSaved' as TranslationKey)}`.trim() }
      }
      return { ok: true, message: outcome.message }
    })
  }
}

/** ナレッジの写しの「写した日」だけが違うときは書き直さない */
function stripStamp(s: string): string {
  return s.replace(/(<!-- ferret-research:knowledge [0-9a-f]+) \/ [^ ]+ -->/, '$1 -->')
}
