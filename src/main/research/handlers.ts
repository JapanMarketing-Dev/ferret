/**
 * ビジネスリサーチの IPC（research:*）の処理。src/main/business/wire.ts から `...researchHandlers(deps)` で入れる。
 * フォルダは deps.root()（開いているプロジェクトのフォルダ）だけ。renderer からパスは受け取らない
 * （「プロジェクトにする」の新しいフォルダも、親は main のダイアログで選ばせ、renderer からは1つの名前だけを受け取る）。
 * 記録の読み書きは store.ts（ResearchStore）
 */
import { lstat, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { ResearchIpcRequests, PromoteResult } from '@shared/research/ipc'
import { RESEARCH_PROMPT_IDS } from '@shared/research/ipc'
import { STAGES, type ExecutionItem, type ExecutionKey } from '@shared/business/model'
import { defaultExecution } from '@shared/business/records'
import { isResearchId } from '@shared/research/model'
import { canPromote } from '@shared/research/gates'
import { buildPromotion } from '@shared/research/promote'
import { t, type TranslationKey } from '@shared/i18n'
import { BusinessStore, type AgentSender, type ConfirmFn } from '../business/store'
import { FileApprovalLedger, MemoryApprovalLedger, type ApprovalLedger } from '../business/approvalLedger'
import { createSendPasses } from '../business/sendPass'
import type { KeepGoingJob } from './keepGoing'
import { ResearchStore, fail, localizeError } from './store'

export interface ResearchDeps {
  /** 開いているプロジェクトのフォルダ（SSH のプロジェクト・未選択なら null） */
  root(): string | null
  now?: () => Date
  /** 画面の言語（依頼文・README・context.md の言語） */
  locale(): 'ja' | 'en'
  /** Agent へ送る（business と同じ terminalSender） */
  sender: AgentSender
  /** Agent へ送る許可（アプリの窓での本物のクリック・キーの直後に1回だけ。gestures.consume('send')） */
  consentSend(): boolean
  /** 「プロジェクトにする」などの確認（アプリの窓のネイティブのダイアログ） */
  confirm: ConfirmFn
  /** フォルダを選ぶダイアログ。選ばなければ null */
  pickFolder(options: { title: string; defaultPath?: string; create?: boolean }): Promise<string | null>
  /** フォルダをリサーチのプロジェクト（research: true。オーケストラに入れない）として登録して開く */
  registerResearch(folder: string): { projectId: string }
  /** ビジネスのフォルダをプロジェクトとして登録し、オーケストラに入れる（開かない） */
  registerBusiness(folder: string, name: string, orchestraId: string | null): { projectId: string }
  /** resources/business/手法.md の本文（作るビジネスのフォルダに写す） */
  manual: string
  /** 集客の5原則のナレッジの本文（docs/business-research/knowledge.md。英語の画面は knowledge.en.md）。principles/knowledge.md に写す */
  knowledge: string
  /** ゲートの人の判断の正本を置くフォルダ（userData/research-gates）と HMAC の鍵。省略時は起動中だけ */
  ledger?: { dir: string; key: () => Promise<Buffer> }
  /** 使っている人の状況（Ferret の「あなたの状況」）。リサーチの前提として context.md に入れる */
  founder?: () => Promise<string>
  /** 「参入先を決め切る」を送ったターミナルを、決め切るまで止めない見張り（keepGoing.ts。どの Agent でも） */
  keepGoing?: { start(job: KeepGoingJob): unknown }
}

export type ResearchHandlers = { [C in keyof ResearchIpcRequests]: (...args: Parameters<ResearchIpcRequests[C]>) => unknown }

/** 新しいフォルダの名前の上限 */
export const MAX_FOLDER_NAME = 100
/** 「空」とみなしてよいもの（Finder が作る） */
const IGNORABLE = new Set(['.DS_Store'])

/** renderer から来たフォルダの名前を、1つの名前として確かめる（区切り・..・制御文字・使えない文字・長さ）。だめなら UserFacingError */
export function checkFolderName(raw: unknown): string {
  if (typeof raw !== 'string') fail('folderNameInvalid')
  const name = raw.trim()
  if (!name || name.length > MAX_FOLDER_NAME) fail('folderNameInvalid')
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f/\\:*?"<>|]/.test(name) || name.includes('..') || name.startsWith('.')) fail('folderNameInvalid')
  return name
}

/** 候補の題名から名前を作る（使えない文字は - にする）。何も残らなければ候補の ID */
export function folderNameFrom(title: string, fallback: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = title.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-').replace(/\.{2,}/g, '.').replace(/^[.\s-]+/, '').replace(/\s+/g, ' ').trim().slice(0, 80).trim()
  return cleaned || fallback
}

/** 実在する普通のフォルダか（リンクは断る） */
async function assertPlainDir(folder: string): Promise<void> {
  if (!path.isAbsolute(folder)) fail('folderInvalid')
  const st = await lstat(folder).catch(() => null)
  if (!st || st.isSymbolicLink() || !st.isDirectory()) fail('folderInvalid')
}

/** 新しいフォルダを用意する。無ければ作り、既にあれば普通の空のフォルダのときだけ使う */
async function prepareEmptyFolder(target: string): Promise<void> {
  const st = await lstat(target).catch((err: unknown) => {
    if ((err as { code?: unknown }).code === 'ENOENT') return null
    throw err
  })
  if (!st) {
    await mkdir(target)
    return
  }
  if (st.isSymbolicLink() || !st.isDirectory()) fail('promoteFolderInvalid')
  const entries = await readdir(target)
  if (entries.some((e) => !IGNORABLE.has(e))) fail('promoteFolderNotEmpty')
}

/** a が b の中（同じも含む）か */
function inside(a: string, b: string): boolean {
  const rel = path.relative(b, a)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

export function researchHandlers(deps: ResearchDeps): ResearchHandlers {
  let cached: ResearchStore | null = null
  const ledgers = new Map<string, ApprovalLedger>()
  const ledgerFor = (root: string): ApprovalLedger => {
    let l = ledgers.get(root)
    if (!l) {
      l = deps.ledger ? new FileApprovalLedger(deps.ledger.dir, root, deps.ledger.key) : new MemoryApprovalLedger()
      ledgers.set(root, l)
    }
    return l
  }
  const storeFor = (root: string): ResearchStore => {
    if (!cached || cached.root !== root) {
      cached = new ResearchStore({ root, locale: deps.locale, knowledge: deps.knowledge, ledger: ledgerFor(root), ...(deps.founder ? { founder: deps.founder } : {}), ...(deps.now ? { now: deps.now } : {}) })
    }
    return cached
  }
  const store = (): ResearchStore => {
    const root = deps.root()
    if (!root) fail('noFolder')
    return storeFor(root)
  }
  const iso = () => (deps.now ? deps.now() : new Date()).toISOString()
  const msg = (key: string) => () => t(`research.error.${key}` as TranslationKey)
  // 送る許可の札（business/sendPass.ts。ビジネスと同じ仕組み）
  const passes = createSendPasses({
    root: deps.root,
    consent: deps.consentSend,
    ...(deps.now ? { now: deps.now } : {}),
    isPromptId: (id): id is string => typeof id === 'string' && (RESEARCH_PROMPT_IDS as readonly string[]).includes(id),
    messages: { needsAction: msg('needsAction'), badPrompt: msg('promptNotFound'), badText: msg('badSendText'), badTarget: msg('badTarget'), noRoot: msg('noFolder') }
  })
  /** 「プロジェクトにする」を進めている候補（二重に押されても1回だけ） */
  const promoting = new Set<string>()

  const promote = async (request: unknown): Promise<PromoteResult | null> => {
    const r = request && typeof request === 'object' ? request as Record<string, unknown> : fail('badPatch')
    if (!isResearchId('candidate', r.candidateId)) fail('badId', { id: String(r.candidateId).slice(0, 20) })
    const candidateId = r.candidateId
    const orchestraId = r.orchestraId === null || r.orchestraId === undefined || r.orchestraId === '' ? null
      : typeof r.orchestraId === 'string' && r.orchestraId.length <= 200 ? r.orchestraId : fail('badOrchestra')
    const folderName = r.folderName === undefined || r.folderName === null || (typeof r.folderName === 'string' && !r.folderName.trim()) ? null : checkFolderName(r.folderName)
    const s = store()
    const key = `${s.root}\n${candidateId}`
    if (promoting.has(key)) fail('promoteInProgress')
    promoting.add(key)
    try {
      // 記録は main が読み直して確かめる（ゲートは正本と合うものだけが pass。renderer の言い分は使わない）
      const check = async () => {
        const data = await s.data()
        const candidate = data.candidates.find((c) => c.id === candidateId)
        if (!candidate) fail('notFound', { id: candidateId })
        const can = canPromote(candidate, data)
        if (!can.ok) fail('promoteBlocked', { missing: can.missing.join(', ') })
        return { data, candidate }
      }
      const first = await check()
      const name = folderName ?? folderNameFrom(first.candidate.title, first.candidate.id)
      const ok = await deps.confirm({
        message: t('research.error.promoteConfirm' as TranslationKey, { id: first.candidate.id, title: first.candidate.title.slice(0, 200) }),
        detail: t('research.error.promoteConfirmDetail' as TranslationKey, { name }),
        confirmLabel: t('research.error.promoteConfirmLabel' as TranslationKey)
      })
      if (!ok) fail('promoteCancelled')
      const parent = await deps.pickFolder({ title: t('research.error.promotePickParent' as TranslationKey), defaultPath: path.dirname(s.root), create: true })
      if (!parent) return null
      await assertPlainDir(parent)
      const target = path.join(parent, name)
      if (path.dirname(target) !== path.resolve(parent)) fail('folderNameInvalid')
      if (inside(target, s.root) || inside(s.root, target)) fail('promoteInsideResearch')
      // 確認・ダイアログの間に変わっていないか、もう一度確かめる
      const { data, candidate } = await check()
      const plan = buildPromotion(data, candidate.id, iso(), deps.locale())
      await prepareEmptyFolder(target)

      const business = new BusinessStore({ root: target, manual: deps.manual, ...(deps.now ? { now: deps.now } : {}) })
      await business.init({ name: plan.name, target: plan.target })
      const save = async (kind: 'hypothesis' | 'evidence' | 'alternative' | 'experiment', record: { id: string }) => {
        const result = await business.saveRecord(kind, record, '')
        if (!result.ok) fail('promoteRecordRejected', { id: record.id, message: result.issues.filter((i) => i.severity === 'error').map((i) => `${i.field}: ${i.message}`).join(' / ').slice(0, 500) })
      }
      // 証拠を先に（仮説・実験が指す）
      for (const e of plan.evidence) await save('evidence', e)
      await save('hypothesis', plan.hypothesis)
      for (const a of plan.alternatives) await save('alternative', a)
      for (const x of plan.experiments) await save('experiment', x)
      // 段階は保存では変わらない（人が押すのと同じく1つずつ進め、履歴に由来を残す）
      const to = STAGES.indexOf(plan.hypothesis.stage)
      for (let i = 1; i <= to; i++) {
        await business.advanceStage(plan.hypothesis.id, STAGES[i], t('research.error.promoteStageNote' as TranslationKey, { id: candidate.id }))
      }
      // 実行条件の4点は候補のものをそのまま引き継ぐ（PromotionPlan の execution を優先）。未入力の項目は既定の問いで埋める
      const planned = (plan as { execution?: Partial<Record<ExecutionKey, Partial<ExecutionItem>>> }).execution
      const execution = defaultExecution(deps.locale(), planned ?? candidate.execution)
      await business.updateBusiness({ step: 'S6', currentHypothesis: plan.hypothesis.id, execution })
      await business.fs.write('RESEARCH.md', plan.researchMd)
      const { projectId } = deps.registerBusiness(target, plan.name, orchestraId)
      const snapshot = await s.markPromoted(candidate.id, { folder: target, projectId, at: iso() })
      return { snapshot, projectId, folder: target }
    } finally {
      promoting.delete(key)
    }
  }

  const handlers: ResearchHandlers = {
    'research:status': async () => {
      const root = deps.root()
      if (!root) return { root: null, isResearch: false, name: null }
      return { root, ...(await storeFor(root).status()) }
    },
    'research:addProject': async () => {
      const folder = await deps.pickFolder({ title: t('research.sidebar.addDialogTitle'), create: true })
      if (!folder) return null
      await assertPlainDir(folder)
      const { projectId } = deps.registerResearch(folder)
      const s = storeFor(folder)
      if (!(await s.isResearch())) await s.init({ name: path.basename(folder), scope: '' })
      return { projectId }
    },
    'research:init': (input) => store().init(input),
    'research:load': () => store().load(),
    'research:saveRecord': (kind, record, body) => store().saveRecord(kind, record, body),
    'research:deleteRecord': (kind, id) => store().deleteRecord(kind, id),
    'research:updateResearch': (patch) => store().updateResearch(patch),
    'research:decideGate': (input) => store().decideGate(input),
    'research:setStage': (input) => store().setStage(input),
    'research:prompt': (input) => store().prompt(input),
    'research:armSend': (input) => passes.arm(input),
    'research:send': async (request) => {
      // 送るボタンを押した直後に作った札と、依頼・本文・送り先・フォルダが合うときだけ送る
      if (!passes.use(request)) fail('needsAction')
      const root = deps.root()
      let terminalId: string | undefined
      const sender: AgentSender = {
        send: async (target, text) => {
          const outcome = await deps.sender.send(target, text)
          terminalId = outcome.terminalId
          return outcome
        }
      }
      const result = await store().send(request, sender)
      // 「参入先を決め切る」は、送ったターミナルの Agent を conclusion.md が決め切った条件を満たすまで止めない
      const promptId = request && typeof request === 'object' ? (request as { promptId?: unknown }).promptId : undefined
      if (result.ok && promptId === 'decide' && terminalId && root) deps.keepGoing?.start({ terminalId, root, locale: deps.locale() })
      return result
    },
    'research:promote': (request) => promote(request)
  }
  // 失敗の文（fsx.ts の日本語の文）を画面の言語にそろえる
  const out = {} as Record<string, (...args: unknown[]) => unknown>
  for (const [channel, fn] of Object.entries(handlers) as Array<[string, (...args: unknown[]) => unknown]>) {
    out[channel] = async (...args: unknown[]) => {
      try {
        return await fn(...args)
      } catch (err) {
        throw localizeError(err)
      }
    }
  }
  return out as ResearchHandlers
}
