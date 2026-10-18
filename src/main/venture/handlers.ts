/**
 * ビジネスの IPC（venture:*）の処理。wire.ts の ventureOpsHandlers がつなぐ。
 * フォルダは開いているプロジェクト（オーケストラで venture.json があるもの）だけ。renderer からパスは受け取らない
 * （新しいフォルダ・メンバーのフォルダ・取り込むファイルは main のダイアログで選ばせる）。入力はすべて確かめる。
 * 人の判断（承認・却下・予算の上限・運営）は main がファイルを読み直し、ネイティブのダイアログで確かめてから台帳に書く
 */
import { lstat, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { isUserFacingError } from '@shared/errors'
import { t, type TranslationKey } from '@shared/i18n'
import { isOrchestra } from '@shared/orchestras'
import type { Project, ProjectsState } from '@shared/types'
import { IMPORT_LIMITS, parseImportFile } from '@shared/venture/import'
import type { ImportOutcome, VentureListItem, VenturePromptView, VentureSnapshot, VentureStatus } from '@shared/venture/ipc'
import { APPROVAL_KINDS, CHANNELS, MEMBER_ROLES, SOURCE_KINDS, VENTURE_PATHS } from '@shared/venture/model'
import type { ApprovalKind, BudgetCap, Channel, MemberRole, OperationsDecision, PeriodPreset, SourceKind } from '@shared/venture/model'
import { isVenturePromptId, renderVenturePrompt, ventureRules } from '@shared/venture/prompts'
import { RECORD_TEXT_LIMITS } from '@shared/venture/records'
import { FileTooLargeError } from '../boundedFile'
import { readFileNoFollow } from '../sessions/containment'
import { LEDGER_LIMITS, MemoryVentureLedger, isBudgetAmount, isBudgetKey, recordHash, type BudgetEntry, type VentureLedger } from './ledger'
import { createSendPasses } from './sendPass'
import type { AgentSender, ConfirmFn } from './sender'
import { VentureStore, fail, importFileName, localDate, localizeError, promptContext, toVentureError, type VentureErrorKey } from './store'
import type { VentureOpsHandlers, VentureOpsWiring } from './wire'

/** 入力の上限 */
export const VENTURE_INPUT_LIMITS = {
  name: 80,
  title: 200,
  detail: 20000,
  refs: 20,
  refLength: 40,
  answer: LEDGER_LIMITS.answer,
  sendText: 200_000,
  memberFolder: 1000,
  projectId: 200,
  /** 確かめのダイアログに出す中身の先頭 */
  dialogDetail: 1200
} as const

export const PERIOD_PRESETS: readonly PeriodPreset[] = ['30d', '90d', 'month', 'all']

/** 「空」とみなしてよいもの（Finder・Explorer が作る） */
const IGNORABLE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** フォルダを選ぶ・ファイルを選ぶ（選ばなければ null） */
export interface VenturePickers {
  pickFolder(options: { title: string; defaultPath?: string; create: boolean }): Promise<string | null>
  pickFile(options: { title: string; filters: Array<{ name: string; extensions: string[] }> }): Promise<string | null>
}

export interface VentureHandlerDeps {
  wiring: VentureOpsWiring
  /** そのフォルダの台帳（無ければ起動中だけのもの） */
  ledgerFor?(root: string): VentureLedger
  confirm: ConfirmFn
  sender: AgentSender
  pickers: VenturePickers
  now?(): Date
}

/** 名前を整える（制御文字・フォルダ名に使えない文字は -、.. は .、先頭の . - 空白は外す、80 文字まで）。空なら '' */
export function cleanVentureName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-').replace(/\.{2,}/g, '.').replace(/\s+/g, ' ').replace(/^[.\s-]+/, '').trim()
    .slice(0, VENTURE_INPUT_LIMITS.name).replace(/[.\s]+$/, '').trim()
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

function input(v: unknown): Record<string, unknown> {
  return isObj(v) ? v : fail('badInput')
}

function oneOf<T extends string>(v: unknown, list: readonly T[], key: VentureErrorKey): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? v as T : fail(key)
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/

/** 実在する普通のフォルダ（絶対パス・リンクでない） */
async function plainDir(folder: unknown): Promise<string | null> {
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) return null
  const st = await lstat(folder).catch(() => null)
  return st && !st.isSymbolicLink() && st.isDirectory() ? path.resolve(folder) : null
}

const isSsh = (p: Project) => p.source === 'ssh' || !!p.ssh

export function ventureHandlers(deps: VentureHandlerDeps): VentureOpsHandlers {
  const w = deps.wiring
  const now = () => (deps.now ? deps.now() : new Date())
  const ledgers = new Map<string, VentureLedger>()
  const ledgerFor = (root: string): VentureLedger => {
    const key = path.resolve(root)
    let l = ledgers.get(key)
    if (!l) {
      l = deps.ledgerFor ? deps.ledgerFor(root) : new MemoryVentureLedger()
      ledgers.set(key, l)
    }
    return l
  }
  /** 直前に読んだ期間（取り込み・依頼文のまとめに使う） */
  let lastPeriod: PeriodPreset = '30d'

  const storeOf = (root: string, projectId: string) => new VentureStore({
    root,
    projectId,
    ledger: ledgerFor(root),
    projects: () => w.projects(),
    ...(w.videoCount ? { videoCount: (folder: string) => w.videoCount!(folder) } : {})
  })

  /** 開いているプロジェクト（この PC のフォルダ） */
  const opened = (): { root: string; project: Project | null } => {
    const root = w.root()
    if (!root) fail('noFolder')
    const id = w.openProjectId()
    const project = id ? w.projects().find((p) => p.id === id) ?? null : null
    return { root, project }
  }

  /** 開いているビジネス（オーケストラで venture.json があるもの） */
  const venture = async (): Promise<{ store: VentureStore; project: Project }> => {
    const { root, project } = opened()
    if (!project || !isOrchestra(project) || isSsh(project)) fail('noVenture')
    const store = storeOf(root, project.id)
    if (!(await store.isVenture())) fail('noVenture')
    return { store, project }
  }

  const snapshot = (store: VentureStore) => store.load(lastPeriod, localDate(now()))
  const changed = async (store: VentureStore): Promise<VentureSnapshot> => {
    w.notify()
    return snapshot(store)
  }

  const kindLabel = (kind: ApprovalKind) => t(`venture.dialog.kind.${kind}` as TranslationKey)
  const channelLabel = (channel: Channel | '*') => (channel === '*' ? t('venture.dialog.allChannels') : channel)
  const amount = (v: number | null) => (v === null ? t('venture.dialog.noLimit') : v.toLocaleString('en-US'))
  const budgetLine = (b: BudgetCap) => t('venture.dialog.budgetLine', { channel: channelLabel(b.channel), daily: amount(b.daily), monthly: amount(b.monthly) })

  const passes = createSendPasses({
    root: () => w.root(),
    consent: () => w.consentSend(),
    ...(deps.now ? { now: deps.now } : {}),
    isPromptId: isVenturePromptId,
    messages: {
      needsAction: () => t('venture.error.needsAction'),
      badPrompt: () => t('venture.error.badPrompt'),
      badText: () => t('venture.error.badText'),
      badTarget: () => t('venture.error.badTarget'),
      noRoot: () => t('venture.error.noFolder')
    }
  })

  const handlers: VentureOpsHandlers = {
    'venture:list': async (): Promise<VentureListItem[]> => {
      const out: VentureListItem[] = []
      for (const p of w.projects()) {
        if (!isOrchestra(p) || isSsh(p) || typeof p.folderPath !== 'string' || !path.isAbsolute(p.folderPath)) continue
        if (await storeOf(p.folderPath, p.id).isVenture()) out.push({ projectId: p.id, name: p.name, folder: p.folderPath })
      }
      return out
    },

    'venture:status': async (): Promise<VentureStatus> => {
      const root = w.root()
      const projectId = w.openProjectId()
      if (!root) return { root: null, projectId, isVenture: false, isOrchestra: false }
      const project = projectId ? w.projects().find((p) => p.id === projectId) ?? null : null
      const orchestra = !!project && isOrchestra(project) && !isSsh(project)
      const isVenture = orchestra && await storeOf(root, project.id).isVenture()
      return { root, projectId, isVenture, isOrchestra: orchestra }
    },

    'venture:create': async (raw): Promise<ProjectsState | null> => {
      const i = input(raw)
      const name = cleanVentureName(i.name)
      if (!name) fail('nameEmpty')
      w.assertNotRecording()
      const picked = await deps.pickers.pickFolder({ title: t('venture.dialog.pickParent'), create: true })
      if (!picked) return null
      const parent = await plainDir(picked)
      if (!parent) fail('parentInvalid')
      const target = path.join(parent, name)
      if (path.dirname(target) !== parent) fail('nameEmpty')
      const st = await lstat(target).catch((err: unknown) => {
        if ((err as { code?: unknown }).code === 'ENOENT') return null
        throw toVentureError(err)
      })
      if (st) {
        if (st.isSymbolicLink() || !st.isDirectory()) fail('folderNotEmpty', { name })
        const entries = await readdir(target).catch(() => ['?'])
        if (entries.some((e) => !IGNORABLE.has(e))) fail('folderNotEmpty', { name })
      }
      // ダイアログの間に録画を始めていないか
      w.assertNotRecording()
      if (!st) await mkdir(target).catch((err: unknown) => { throw toVentureError(err) })
      const store = new VentureStore({ root: target, projectId: '', ledger: ledgerFor(target), projects: () => w.projects() })
      await store.init({ name, createdAt: now().toISOString(), locale: w.locale(), members: [] })
      const project = w.registerFolder(target, { name, orchestra: true })
      w.openProject(project.id)
      w.notify()
      return w.projectsState()
    },

    'venture:convert': async (): Promise<VentureSnapshot> => {
      const { root, project } = opened()
      if (!project || !isOrchestra(project) || isSsh(project)) fail('notOrchestra')
      const store = storeOf(root, project.id)
      if (await store.isVenture()) fail('alreadyVenture')
      // venture.json がリンク・フォルダなど普通でないものなら、雛形で隠さない
      if ((await store.fs.kind(VENTURE_PATHS.config)) !== null) fail('configBroken')
      await store.init({ name: cleanVentureName(project.name) || path.basename(root), createdAt: now().toISOString(), locale: w.locale(), members: [] })
      return changed(store)
    },

    'venture:load': async (raw): Promise<VentureSnapshot> => {
      const period = oneOf(input(raw).period, PERIOD_PRESETS, 'badPeriod')
      const { store } = await venture()
      lastPeriod = period
      return snapshot(store)
    },

    'venture:addMember': async (raw): Promise<VentureSnapshot | null> => {
      const i = input(raw)
      const role = oneOf<MemberRole>(i.role, MEMBER_ROLES, 'badRole')
      if (i.projectId !== undefined && i.projectId !== null && (typeof i.projectId !== 'string' || !i.projectId || i.projectId.length > VENTURE_INPUT_LIMITS.projectId)) fail('memberProject')
      const { store, project: self } = await venture()
      let folder: string
      if (typeof i.projectId === 'string') {
        const p = w.projects().find((x) => x.id === i.projectId)
        if (!p || isOrchestra(p) || isSsh(p) || p.id === self.id) fail('memberProject')
        const dir = await plainDir(p.folderPath)
        if (!dir) fail('memberProject')
        folder = dir
      } else {
        const picked = await deps.pickers.pickFolder({ title: t('venture.dialog.pickMember'), defaultPath: path.dirname(store.root), create: false })
        if (!picked) return null
        const dir = await plainDir(picked)
        if (!dir) fail('memberFolder')
        folder = dir
      }
      if (path.resolve(folder) === path.resolve(store.root)) fail('memberFolder')
      const registered = w.projects().find((p) => !isSsh(p) && typeof p.folderPath === 'string' && path.resolve(p.folderPath) === folder)
      if (registered && isOrchestra(registered)) fail('memberFolder')
      // 登録済みでも、このビジネス（オーケストラ）に入れる
      const member = w.registerFolder(folder, { orchestraId: self.id })
      await store.updateMembers((members) => {
        const same = members.find((m) => m.role === role && path.resolve(m.folder) === folder)
        if (same) return members.map((m) => (m === same ? { ...m, folder, projectId: member.id } : m))
        return [...members, { role, folder, projectId: member.id }]
      })
      return changed(store)
    },

    'venture:removeMember': async (raw): Promise<VentureSnapshot> => {
      const i = input(raw)
      const role = oneOf<MemberRole>(i.role, MEMBER_ROLES, 'badRole')
      if (typeof i.folder !== 'string' || !i.folder || i.folder.length > VENTURE_INPUT_LIMITS.memberFolder || CONTROL.test(i.folder)) fail('memberFolder')
      const folder = i.folder
      const { store } = await venture()
      // venture.json から外すだけ（プロジェクトは消さない・フォルダには触らない）
      await store.updateMembers((members) => members.filter((m) => !(m.role === role && (m.folder === folder || (path.isAbsolute(folder) && path.resolve(m.folder) === path.resolve(folder))))))
      return changed(store)
    },

    'venture:importFile': async (raw): Promise<ImportOutcome | null> => {
      const source = oneOf<SourceKind>(input(raw).source, SOURCE_KINDS, 'badSource')
      const { store } = await venture()
      const picked = await deps.pickers.pickFile({
        title: t('venture.dialog.pickImport'),
        filters: [{ name: t('venture.dialog.importFilter'), extensions: ['csv', 'tsv', 'txt', 'json'] }]
      })
      if (!picked) return null
      if (!path.isAbsolute(picked)) fail('importExtension')
      const name = importFileName(picked)
      if (!name) fail('importExtension')
      let bytes: Buffer
      try {
        bytes = await readFileNoFollow(picked, null, { maxBytes: IMPORT_LIMITS.maxBytes })
      } catch (err) {
        if (err instanceof FileTooLargeError) fail('importTooLarge', { max: Math.round(IMPORT_LIMITS.maxBytes / 1024 / 1024) })
        throw toVentureError(err)
      }
      const rel = await store.saveImport(source, name, bytes, now())
      const loaded = await store.loadFull(lastPeriod, localDate(now()))
      const parsed = parseImportFile({ path: rel, source, bytes, currency: loaded.snapshot.config.currency })
      w.notify()
      return { snapshot: loaded.snapshot, path: rel, rows: parsed.rows.length, issues: parsed.issues }
    },

    'venture:requestApproval': async (raw): Promise<VentureSnapshot> => {
      const i = input(raw)
      const kind = oneOf<ApprovalKind>(i.kind, APPROVAL_KINDS, 'badKind')
      const title = typeof i.title === 'string' ? i.title.trim() : ''
      if (!title || title.length > VENTURE_INPUT_LIMITS.title || CONTROL.test(title) || /[\r\n]/.test(title)) fail('badTitle', { max: VENTURE_INPUT_LIMITS.title })
      if (typeof i.detail !== 'string' || i.detail.length > VENTURE_INPUT_LIMITS.detail || CONTROL.test(i.detail)) fail('badDetail', { max: VENTURE_INPUT_LIMITS.detail })
      const detail = i.detail
      const refsRaw = i.refs === undefined ? [] : i.refs
      if (!Array.isArray(refsRaw) || refsRaw.length > VENTURE_INPUT_LIMITS.refs) fail('badRefs', { max: VENTURE_INPUT_LIMITS.refs })
      const refs: string[] = []
      for (const r of refsRaw) {
        if (typeof r !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(r.trim())) fail('badRefs', { max: VENTURE_INPUT_LIMITS.refs })
        if (!refs.includes(r.trim())) refs.push(r.trim())
      }
      const { store } = await venture()
      await store.addApproval({ kind, title, detail, refs, by: 'human', createdAt: now().toISOString() })
      return changed(store)
    },

    'venture:decide': async (raw): Promise<VentureSnapshot | null> => {
      const i = input(raw)
      const id = typeof i.approvalId === 'string' ? i.approvalId.trim() : ''
      if (!id || id.length > RECORD_TEXT_LIMITS.id) fail('badInput')
      const decision = oneOf(i.decision, ['approve', 'reject'] as const, 'badDecision')
      const answer = i.answer === undefined || i.answer === null ? '' : i.answer
      if (typeof answer !== 'string' || answer.length > VENTURE_INPUT_LIMITS.answer || CONTROL.test(answer)) fail('badAnswer', { max: VENTURE_INPUT_LIMITS.answer })
      const { store } = await venture()
      // renderer の言い分ではなく、ファイルを読み直した中身で確かめる
      const find = async () => {
        const rec = await store.records()
        const found = rec.requests.find((r) => r.id === id)
        if (!found) fail('approvalNotFound', { id })
        return found
      }
      const request = await find()
      const hash = recordHash(request)
      const detail = request.detail.length > VENTURE_INPUT_LIMITS.dialogDetail ? `${request.detail.slice(0, VENTURE_INPUT_LIMITS.dialogDetail)}…` : request.detail
      const ok = await deps.confirm({
        message: t(decision === 'approve' ? 'venture.dialog.approveMessage' : 'venture.dialog.rejectMessage', { title: request.title, kind: kindLabel(request.kind) }),
        detail: t('venture.dialog.decisionDetail', { id: request.id, refs: request.refs.join(', ') || t('venture.dialog.none'), detail: detail || t('venture.dialog.none') }),
        confirmLabel: t(decision === 'approve' ? 'venture.dialog.approveLabel' : 'venture.dialog.rejectLabel')
      })
      if (!ok) return null
      // 確かめている間に中身が変わっていれば書かない
      const again = await find()
      if (recordHash(again) !== hash) fail('approvalChanged', { id })
      await ledgerFor(store.root).putApproval(id, {
        status: decision === 'approve' ? 'approved' : 'rejected',
        answer: answer.trim(),
        decidedAt: now().toISOString(),
        kind: again.kind,
        recordHash: hash
      })
      return changed(store)
    },

    'venture:setBudget': async (raw): Promise<VentureSnapshot | null> => {
      const i = input(raw)
      if (!isBudgetKey(i.channel)) fail('badChannel')
      const channel = i.channel
      const daily = i.daily === undefined ? null : i.daily
      const monthly = i.monthly === undefined ? null : i.monthly
      if (!isBudgetAmount(daily) || !isBudgetAmount(monthly)) fail('badAmount')
      const { store } = await venture()
      // guardrails.json が壊れていれば、確かめる前に断る（ファイルと台帳を合わせられない）
      const rec = await store.records()
      if (rec.guardrailsBroken) fail('fileBroken', { file: VENTURE_PATHS.guardrails })
      const ok = await deps.confirm({
        message: t('venture.dialog.budgetMessage', { channel: channelLabel(channel) }),
        detail: t('venture.dialog.budgetDetail', { line: budgetLine({ channel, daily, monthly }) }),
        confirmLabel: t('venture.dialog.budgetLabel')
      })
      if (!ok) return null
      await ledgerFor(store.root).putBudget(channel, daily === null && monthly === null ? null : { daily, monthly, decidedAt: now().toISOString() })
      await store.setGuardrailBudget(channel, daily, monthly, w.locale())
      return changed(store)
    },

    'venture:approveBudgets': async (): Promise<VentureSnapshot | null> => {
      const { store } = await venture()
      const read = async () => {
        const rec = await store.records()
        if (rec.guardrailsBroken) fail('fileBroken', { file: VENTURE_PATHS.guardrails })
        return rec.guardrails.budgets.filter((b) => isBudgetAmount(b.daily) && isBudgetAmount(b.monthly))
      }
      const proposals = await read()
      const shown = JSON.stringify(proposals)
      const ok = await deps.confirm({
        message: t('venture.dialog.approveBudgetsMessage'),
        detail: t('venture.dialog.approveBudgetsDetail', { lines: proposals.map(budgetLine).join('\n') || t('venture.dialog.none') }),
        confirmLabel: t('venture.dialog.approveBudgetsLabel')
      })
      if (!ok) return null
      const again = await read()
      if (JSON.stringify(again) !== shown) fail('budgetsChanged')
      const decidedAt = now().toISOString()
      const budgets: Record<string, BudgetEntry> = {}
      for (const b of again) if (b.daily !== null || b.monthly !== null) budgets[b.channel] = { daily: b.daily, monthly: b.monthly, decidedAt }
      await ledgerFor(store.root).replaceBudgets(budgets)
      return changed(store)
    },

    'venture:decideOperations': async (raw): Promise<VentureSnapshot | null> => {
      const d = input(raw).decision
      if (d !== 'pass' && d !== 'fail' && d !== null) fail('badDecision')
      const decision = d as OperationsDecision
      const { store } = await venture()
      const label = decision === 'pass' ? t('venture.dialog.operationsPass') : decision === 'fail' ? t('venture.dialog.operationsFail') : t('venture.dialog.operationsClear')
      const ok = await deps.confirm({
        message: t('venture.dialog.operationsMessage', { decision: label }),
        detail: t('venture.dialog.operationsDetail'),
        confirmLabel: t('venture.dialog.operationsLabel')
      })
      if (!ok) return null
      await ledgerFor(store.root).putOperations({ decision, decidedAt: now().toISOString() })
      return changed(store)
    },

    'venture:prompt': async (raw): Promise<VenturePromptView> => {
      const id = input(raw).promptId
      if (!isVenturePromptId(id)) fail('badPrompt')
      const { store } = await venture()
      const loaded = await store.loadFull(lastPeriod, localDate(now()))
      const locale = w.locale()
      return { id, text: renderVenturePrompt(id, promptContext(loaded, locale), locale) }
    },

    'venture:armSend': async (raw) => {
      await venture()
      return passes.arm(raw)
    },

    'venture:send': async (raw): Promise<{ ok: boolean; message: string }> => {
      const r = input(raw)
      // 送るボタンを押した直後に作った札と、依頼・本文・送り先・フォルダが合うときだけ送る
      if (!passes.use(r)) fail('needsAction')
      const text = r.text as string
      if (!text.trim() || text.length > VENTURE_INPUT_LIMITS.sendText) fail('badText')
      await venture()
      const target = r.target as Parameters<AgentSender['send']>[0]
      // 守ること（ventureRules）は main が付ける。本文の末尾に無ければ足す（消して送れない）
      const rules = ventureRules(w.locale())
      const body = text.trimEnd().endsWith(rules) ? text : `${text.trimEnd()}\n\n${rules}`
      try {
        const outcome = await deps.sender.send(target.kind === 'terminal' ? { kind: 'terminal', id: target.id } : { kind: 'active' }, body)
        if (!outcome.ok) return { ok: false, message: outcome.message || t('venture.error.sendFailed') }
        return { ok: true, message: outcome.message }
      } catch (err) {
        return { ok: false, message: isUserFacingError(err) ? (err as Error).message : t('venture.error.sendFailed') }
      }
    }
  }

  // 失敗はパスを含まない利用者向けの文にそろえる
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
  return out as VentureOpsHandlers
}

/** 経路の一覧（画面の select と同じ。テストで使う） */
export const BUDGET_CHANNELS: ReadonlyArray<Channel | '*'> = ['*', ...CHANNELS]
