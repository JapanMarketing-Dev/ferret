/**
 * ビジネスの画面の、描く前に決められること（純粋。test/unit/venture-view.test.ts）。
 * タブの並び・注意の並び・承認の並び・返信待ちの抽出・予算のバー・読み直す合図のパスなど。
 */
import type { Project } from '@shared/types'
import {
  CANONICAL_EXAMPLE
} from '@shared/venture/records'
import {
  MEMBER_ROLES,
  type ApprovalView,
  type BudgetUsage,
  type CheckItem,
  type CheckResult,
  type ExternalActionView,
  type FunnelStep,
  type GuardrailAlert,
  type ImportIssue,
  type MemberRole,
  type PeriodPreset,
  type StageCheck,
  type Stream,
  type StreamRecords,
  type SupportTicket
} from '@shared/venture/model'
import type { MemberView, VentureSendTarget } from '@shared/venture/ipc'

// ---------------------------------------------------------------- タブ・期間

/** ビジネスの画面のタブ（この順に並べる） */
export const WORKSPACE_TABS = ['overview', 'guardrails', 'streams', 'data', 'members', 'orchestra'] as const
export type WorkspaceTab = (typeof WORKSPACE_TABS)[number]

export function isWorkspaceTab(value: unknown): value is WorkspaceTab {
  return typeof value === 'string' && (WORKSPACE_TABS as readonly string[]).includes(value)
}

/** 期間の切替（この順） */
export const PERIOD_PRESETS: readonly PeriodPreset[] = ['30d', '90d', 'month', 'all']

export function isPeriodPreset(value: unknown): value is PeriodPreset {
  return typeof value === 'string' && (PERIOD_PRESETS as readonly string[]).includes(value)
}

/** 業務の画面の左の並び（動画を発信の後に置く） */
export const STREAM_ORDER: readonly Stream[] = ['ads', 'content', 'image', 'video', 'support', 'satisfaction', 'checks']

/** 業務ごとの記録（StreamRecords の鍵）。動画はメンバーへのリンクなので記録を持たない */
export const STREAM_RECORD_KEY: Record<Stream, keyof StreamRecords | null> = {
  ads: 'ads',
  content: 'content',
  image: 'images',
  video: null,
  support: 'support',
  satisfaction: 'satisfaction',
  checks: 'checks'
}

/** 業務の記録の件数（動画は null） */
export function streamRecordCount(stream: Stream, records: StreamRecords | null | undefined): number | null {
  const key = STREAM_RECORD_KEY[stream]
  if (!key || !records) return key ? 0 : null
  const list = records[key]
  return Array.isArray(list) ? list.length : 0
}

// ---------------------------------------------------------------- 注意

/** 危ない（danger）を先に。同じ重さの中は元の順（main の並び）を保つ */
export function sortAlerts(alerts: readonly GuardrailAlert[] | null | undefined): GuardrailAlert[] {
  const list = [...(alerts ?? [])]
  return list
    .map((alert, index) => ({ alert, index }))
    .sort((a, b) => levelRank(a.alert.level) - levelRank(b.alert.level) || a.index - b.index)
    .map((x) => x.alert)
}

const levelRank = (level: GuardrailAlert['level']): number => (level === 'danger' ? 0 : 1)

export function alertCounts(alerts: readonly GuardrailAlert[] | null | undefined): { danger: number; warning: number; total: number } {
  let danger = 0
  let warning = 0
  for (const a of alerts ?? []) {
    if (a.level === 'danger') danger++
    else warning++
  }
  return { danger, warning, total: danger + warning }
}

// ---------------------------------------------------------------- フェーズ

export type StageState = 'ok' | 'unknown' | 'fail'

/** StageCheck.ok を画面の3つの状態に（true 満たした / null 未確認 / false 満たさない） */
export function stageState(check: Pick<StageCheck, 'ok'> | null | undefined): StageState {
  if (!check || check.ok === null || check.ok === undefined) return 'unknown'
  return check.ok ? 'ok' : 'fail'
}

// ---------------------------------------------------------------- ファネル

/** 横棒の長さ（一番多い段階を 100）。数が無い・最大が 0 なら 0 */
export function funnelBarPercent(count: number | null | undefined, steps: readonly Pick<FunnelStep, 'count'>[]): number {
  const max = steps.reduce((m, s) => (typeof s.count === 'number' && Number.isFinite(s.count) && s.count > m ? s.count : m), 0)
  if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0 || max <= 0) return 0
  return Math.min(100, Math.max(1, (count / max) * 100))
}

// ---------------------------------------------------------------- 予算

/** 月の消化と上限の比（上限が無い・0 なら null。表示の長さは 0〜100 に丸める） */
export function budgetBar(usage: Pick<BudgetUsage, 'monthSpend' | 'cap'>): { ratio: number | null; percent: number } {
  const monthly = usage.cap?.monthly
  if (typeof monthly !== 'number' || !Number.isFinite(monthly) || monthly <= 0) return { ratio: null, percent: 0 }
  const spend = Number.isFinite(usage.monthSpend) ? Math.max(0, usage.monthSpend) : 0
  const ratio = spend / monthly
  return { ratio, percent: Math.min(100, ratio * 100) }
}

/** 予算の行の色（over 赤・near 黄・noCap 黄・ok 無色） */
export function budgetTone(status: BudgetUsage['status']): 'danger' | 'warning' | 'neutral' {
  if (status === 'over') return 'danger'
  if (status === 'near' || status === 'noCap') return 'warning'
  return 'neutral'
}

/** 未承認の案があるか */
export function hasProposedBudgets(budgets: readonly BudgetUsage[] | null | undefined): boolean {
  return (budgets ?? []).some((b) => b.proposed !== null && b.proposed !== undefined)
}

// ---------------------------------------------------------------- 承認・外部への操作

const APPROVAL_RANK: Record<ApprovalView['status'], number> = { changed: 0, pending: 1, approved: 2, rejected: 3 }

/** 中身が変わった → 承認待ち → 承認済み → 却下。同じ状態の中は新しい依頼が先 */
export function sortApprovals(approvals: readonly ApprovalView[] | null | undefined): ApprovalView[] {
  return [...(approvals ?? [])].sort((a, b) => (APPROVAL_RANK[a.status] ?? 9) - (APPROVAL_RANK[b.status] ?? 9) || compareDesc(a.createdAt, b.createdAt))
}

/** 人が決める必要のある承認（待ち・変わった） */
export function needsDecision(approval: Pick<ApprovalView, 'status'>): boolean {
  return approval.status === 'pending' || approval.status === 'changed'
}

/** 新しい順。flag が ok 以外は赤で出す */
export function sortActions(actions: readonly ExternalActionView[] | null | undefined): ExternalActionView[] {
  return [...(actions ?? [])].sort((a, b) => compareDesc(a.at, b.at))
}

export function isFlaggedAction(action: Pick<ExternalActionView, 'flag'>): boolean {
  return action.flag !== 'ok'
}

function compareDesc(a: string | undefined, b: string | undefined): number {
  const x = a ?? ''
  const y = b ?? ''
  return x < y ? 1 : x > y ? -1 : 0
}

/** 「T001, AD01 P001」→ ['T001','AD01','P001']（空・重複を除く） */
export function parseRefs(text: string): string[] {
  const out: string[] = []
  for (const part of String(text ?? '').split(/[\s,、，]+/)) {
    const v = part.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

// ---------------------------------------------------------------- サポート

/** 返信待ちの状態 */
export const WAITING_TICKET_STATUSES: ReadonlySet<SupportTicket['status']> = new Set(['open', 'drafted', 'awaitingApproval'])

/** 返信待ち（open・drafted・awaitingApproval）を古い順に */
export function waitingTickets(tickets: readonly SupportTicket[] | null | undefined): SupportTicket[] {
  return (tickets ?? []).filter((t) => WAITING_TICKET_STATUSES.has(t.status)).sort((a, b) => -compareDesc(a.receivedAt, b.receivedAt))
}

/** 返信待ちを上に、残りは新しい順 */
export function sortTickets(tickets: readonly SupportTicket[] | null | undefined): SupportTicket[] {
  const waiting = waitingTickets(tickets)
  const rest = (tickets ?? []).filter((t) => !WAITING_TICKET_STATUSES.has(t.status)).sort((a, b) => compareDesc(a.receivedAt, b.receivedAt))
  return [...waiting, ...rest]
}

// ---------------------------------------------------------------- チェック

/** チェック項目ごとの最新の結果（checkedAt が一番新しいもの）。結果の無い項目は null */
export function latestCheckResults(items: readonly CheckItem[] | null | undefined, results: readonly CheckResult[] | null | undefined): Array<{ item: CheckItem; latest: CheckResult | null }> {
  const latest = new Map<string, CheckResult>()
  for (const r of results ?? []) {
    const prev = latest.get(r.checkId)
    if (!prev || (r.checkedAt ?? '') > (prev.checkedAt ?? '')) latest.set(r.checkId, r)
  }
  return (items ?? []).map((item) => ({ item, latest: latest.get(item.id) ?? null }))
}

// ---------------------------------------------------------------- データ

/** 問題の数をファイルごとに（多い順、同数はファイル名順） */
export function issuesByFile(issues: readonly ImportIssue[] | null | undefined): Array<{ file: string; count: number }> {
  const counts = new Map<string, number>()
  for (const i of issues ?? []) counts.set(i.file, (counts.get(i.file) ?? 0) + 1)
  return [...counts].map(([file, count]) => ({ file, count })).sort((a, b) => b.count - a.count || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
}

/** 規定の形の見本（画面に出す整形した JSON） */
export function canonicalExampleText(): string {
  return JSON.stringify(CANONICAL_EXAMPLE, null, 2)
}

/** ビジネスの記録のパス（ここが変われば読み直す）。フォルダからの相対パス */
const RECORD_FILES: ReadonlySet<string> = new Set(['venture.json', 'guardrails.json'])
const RECORD_DIRS = ['approvals/', 'log/', 'data/', 'streams/', 'reports/']

export function isVentureRecordPath(path: unknown): boolean {
  if (typeof path !== 'string') return false
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
  if (p === '') return false
  if (RECORD_FILES.has(p)) return true
  return RECORD_DIRS.some((d) => p.startsWith(d) || p === d.slice(0, -1))
}

/** fs:changed の中にビジネスの記録があるか */
export function touchesVentureRecords(paths: readonly unknown[] | null | undefined): boolean {
  return (paths ?? []).some(isVentureRecordPath)
}

// ---------------------------------------------------------------- メンバー

/** 役割ごと（MEMBER_ROLES の順。空の役割も出す） */
export function membersByRole(members: readonly MemberView[] | null | undefined): Array<{ role: MemberRole; members: MemberView[] }> {
  return MEMBER_ROLES.map((role) => ({ role, members: (members ?? []).filter((m) => m.role === role) }))
}

/**
 * その役割に足せる登録済みのプロジェクト（オーケストラ・SSH・ビジネス自身・同じ役割に入っているものを除く）。名前順
 */
export function candidateProjects(projects: readonly Project[] | null | undefined, members: readonly MemberView[] | null | undefined, role: MemberRole, ventureProjectId: string | null): Project[] {
  const taken = (members ?? []).filter((m) => m.role === role)
  const takenIds = new Set(taken.map((m) => m.projectId).filter((id): id is string => typeof id === 'string'))
  const takenFolders = new Set(taken.map((m) => normalizeFolder(m.folder)))
  return (projects ?? [])
    .filter((p) => !p.editorWorkspace && p.source !== 'ssh' && p.id !== ventureProjectId && !takenIds.has(p.id) && !takenFolders.has(normalizeFolder(p.folderPath)))
    .sort((a, b) => a.name.localeCompare(b.name))
}

const normalizeFolder = (folder: string): string => String(folder ?? '').replace(/\\/g, '/').replace(/\/+$/, '')

/** 動画チャンネルのメンバー（開けるもの＝登録済みのものを先に） */
export function videoMembers(members: readonly MemberView[] | null | undefined): MemberView[] {
  return (members ?? []).filter((m) => m.role === 'video').sort((a, b) => Number(!!b.projectId) - Number(!!a.projectId))
}

// ---------------------------------------------------------------- Agent への依頼

export type TargetValue = 'active' | 'claude' | 'codex'

/** 送り先の選択肢（この順） */
export const AGENT_TARGETS: ReadonlyArray<{ value: TargetValue; target: VentureSendTarget }> = [
  { value: 'active', target: { kind: 'active' } },
  { value: 'claude', target: { kind: 'new', agent: 'claude' } },
  { value: 'codex', target: { kind: 'new', agent: 'codex' } }
]

export function targetOf(value: TargetValue): VentureSendTarget {
  return (AGENT_TARGETS.find((x) => x.value === value) ?? AGENT_TARGETS[0]!).target
}
