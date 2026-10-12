import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { promisify } from 'node:util'
import { accountDisplayName } from '@shared/accounts'
import { agentLabel, BUILTIN_AGENTS } from '@shared/agentCatalog'
import { agentUsesLocalModel } from '@shared/localModels'
import { DEFAULT_LIMIT_FAILOVER, sanitizeLimitFailover, type FailoverLaunchRequest, type FailoverNotice, type LimitFailoverPrefs } from '@shared/failover'
import type { AccountAgent, TuiAgent } from '@shared/types'
import type { UsageState } from '@shared/usage'
import { delay } from '@shared/delay'
import { formatDateTime, formatTime, t } from '@shared/i18n'
import { errorKind, flow, reportHandled } from '@shared/report'
import { currentSettings, updateSettings } from '../settings'
import { claudeChromeAccounts, listAgentAccounts, selectAgentAccount } from '../accounts'
import { getAccountUsage } from '../usage/service'
import { listAgentOptions } from '../agentDetection'
import type { TerminalManager } from '../terminal'
import { limitOnScreen, limitedUntil, maxUsedPercent, mentionsLimit } from './detect'
import { changedFilesFrom, ferretNote, handoffFilePath, LastInputTracker, nextAgentPrompt, updateRequest } from './handoff'
import { appendFileNoFollow, assertContained, isWithin, mkdirContained } from '../sessions/containment'
import { ensureGitExclude } from '../sessions/gitexclude'
import { AUTOMATIC_GIT_CONFIG, trustedGit } from '../github/gitSync'
import {
  DEFAULT_LIMIT_COOLDOWN_MS,
  chromeReturnTarget,
  isAccountAgentId,
  tabsToSwitch,
  limitKey,
  nearLimitTabs,
  planFailover,
  planReturn,
  switchAllowed,
  usableAccounts,
  type AccountCandidate,
  type FailoverTarget,
  type PlanInput,
  type RunningTab
} from './plan'

/**
 * 上限での自動切り替え（つなぎ役）。
 *
 * - Agent のターミナルの出力に上限の知らせが出たら、少し待って画面の末尾にまだ出ているかを確かめ、
 *   同じ Agent の別のアカウント → 優先順位の次の Agent の順に、同じプロジェクトのフォルダで新しいタブを開いて引き継ぐ
 * - 使用量（フッターの Usage）が しきい値 以上になったら、新しく開く Agent のアカウントを余裕のあるものへ切り替える
 * - returnToPreferred なら、優先順位の高い Agent の枠が戻ったとき、手が空いた（待機中の）タブを戻す
 * - Claude in Chrome は拡張機能と同じ claude.ai のアカウントの Claude Code としかつながらない。
 *   切り替え先は Chrome とつながるアカウントを先に選び、そのアカウントの枠が戻ったら新しく開くタブをそちらへ戻す
 *   （returnToPreferred なら、別のアカウントで動いている待機中のタブも引き継いで戻す）。
 *   利用者がこの起動のあいだにフッター・設定で選んだアカウントは上書きしない
 * 引き継ぎはプロジェクトの .ferret/handoff.md で行う（Agent の種類に依存しない。handoff.ts）。
 * 切り替える直前に今の Agent へ「更新して」と頼み、応答が無ければ Ferret が分かる範囲を追記する。
 * 新しいタブは renderer が開き（failover:launch）、開いたら main が「まずこのファイルを読んで」と送る。
 * 済んだら failover:notice でフッターとトーストに知らせ、上限になった古いタブを閉じる。
 * 回数と間隔の上限（plan.ts の switchAllowed）で、切り替えを繰り返し続けないようにする。
 * - 上限の手前（handoffPercent。既定 98%）: 動いているタブのアカウントがそこまで来たら、上限の知らせを待たずに、
 *   手が空いたところで今の Agent に進み具合を引き継ぎのファイルへまとめさせて閉じ、次の優先順位で新しいタブを開いて続ける
 *   （人がいない夜間も、上限で止まったまま・新しいセッションを人が押すのを待つことにならないように）
 * - 端末内・LAN のモデルで動く Agent（起動の設定が `ollama launch …`・Codex の --oss・ローカルの URL など。
 *   @shared/localModels の agentUsesLocalModel）には、上限の知らせ・使用量・上限の手前の引き継ぎのどれでも切り替えをかけない
 *   （提供元の上限が無い。2026-10-12 本人の指摘）
 */

/** 上限の知らせを見てから、画面の末尾で確かめるまで（描き直しの途中の誤検出を避ける） */
const CONFIRM_DELAY_MS = 2500
/** 新しいタブが開くまで・入力を受け付けるまで待つ上限 */
const CREATE_TIMEOUT_MS = 20_000
const READY_TIMEOUT_MS = 60_000
/** 使用量からのアカウントの切り替えを、同じ Agent で続けて行わない間 */
const USAGE_SWITCH_GAP_MS = 10 * 60 * 1000
/** 枠が戻ったかを見る間隔（returnToPreferred） */
const RETURN_CHECK_MS = 5 * 60 * 1000
/** 「どれも上限です」を同じプロジェクトで繰り返し出さない間 */
const WAITING_NOTICE_GAP_MS = 30 * 60 * 1000
/** 「引き継ぎのファイルを更新して」と頼んだあと、Agent が動き出すのを待つ間（動き出さなければ止まっているとみなす） */
const UPDATE_START_MS = 8000
/** 動き出した Agent が更新を終えるのを待つ上限 */
const UPDATE_TIMEOUT_MS = 120_000

interface PendingLaunch {
  agent: TuiAgent
  created: (id: string) => void
}

let terminals: TerminalManager | null = null
let emitLaunch: (req: FailoverLaunchRequest) => void = () => {}
let emitNotice: (notice: FailoverNotice) => void = () => {}

const inputs = new Map<string, LastInputTracker>()
const confirmTimers = new Map<string, NodeJS.Timeout>()
/** そのタブの Agent を起動したときのアカウント（Claude Code / Codex。null はシステムの既定） */
const launchedAccount = new Map<string, string | null>()
/** 切り替えで開いたタブ（returnToPreferred の対象） */
const failoverTabs = new Set<string>()
const pending = new Map<string, PendingLaunch>()
/** 上限とみなしている間（limitKey → 時刻） */
const limited = new Map<string, number>()
/** プロジェクト（作業フォルダ）ごとの切り替えの時刻 */
const history = new Map<string, number[]>()
/** 切り替えの途中のプロジェクト */
const busy = new Set<string>()
const usageSwitchAt: Record<AccountAgent, number> = { claude: 0, codex: 0 }
const waitingNoticeAt = new Map<string, number>()
/** この起動のあいだに利用者がフッター・設定で選んだアカウント（Chrome のアカウントへ自動では戻さない） */
const manualChoice: Partial<Record<AccountAgent, string | null>> = {}
/** Chrome とつながるアカウントへ戻せるかを、使用量の知らせのたびではなくこの間隔で見る */
const CHROME_RETURN_GAP_MS = 5 * 60 * 1000
let chromeReturnCheckAt = 0
/** 引き継ぎの指示文を送っている途中のタブ（それを「直前の依頼」として覚えない） */
const handoffSending = new Set<string>()
let returnTimer: NodeJS.Timeout | null = null
/** 上限の手前の確かめ（handoffPercent） */
let nearLimitTimer: NodeJS.Timeout | null = null
/** 上限の手前の引き継ぎを始めたタブ（同じタブで繰り返さない） */
const nearLimitStarted = new Set<string>()
/** 上限の手前の確かめの間隔 */
const NEAR_LIMIT_CHECK_MS = 60 * 1000
/** 作業中のタブが手を空けるのを待つ上限。過ぎたら Ferret が分かる範囲を書いて引き継ぐ（上限で止まるより先に） */
const NEAR_LIMIT_IDLE_WAIT_MS = 10 * 60 * 1000

export function failoverPrefs(): LimitFailoverPrefs {
  const raw = currentSettings().limitFailover
  return raw ? sanitizeLimitFailover(raw) : DEFAULT_LIMIT_FAILOVER
}

export function setFailoverPrefs(next: unknown): LimitFailoverPrefs {
  const prefs = sanitizeLimitFailover(next)
  updateSettings({ limitFailover: prefs })
  syncReturnTimer()
  syncNearLimitTimer()
  return prefs
}

/** 端末内・LAN のモデルで動く Agent（組み込みとカスタムの起動の設定、Ferret が受け継いだ接続先の環境変数から） */
function localAgents(): Set<TuiAgent> {
  const prefs = currentSettings().agents
  const all: TuiAgent[] = [...BUILTIN_AGENTS, ...(Array.isArray(prefs?.customAgents) ? prefs.customAgents.map((c) => c.id) : [])]
  return new Set(all.filter((agent) => agentUsesLocalModel(agent, prefs, process.env)))
}

function activeAccountId(agent: AccountAgent): string | null {
  const list = currentSettings().agentAccounts?.[agent]
  return list && list.accounts.some((a) => a.id === list.activeAccountId) ? list.activeAccountId : null
}

function label(agent: TuiAgent): string {
  return agentLabel(agent, currentSettings().agents)
}

function accountLabel(agent: AccountAgent, accountId: string | null): string {
  if (accountId === null) return t('accounts.systemDefault')
  const account = currentSettings().agentAccounts?.[agent].accounts.find((a) => a.id === accountId)
  return account ? accountDisplayName(account) : t('accounts.systemDefault')
}

function notify(notice: Omit<FailoverNotice, 'at'>): void {
  emitNotice({ ...notice, at: Date.now() })
}

// ───────────────────────── ターミナルからの合図 ─────────────────────────

/** TerminalManager に渡す口（terminal.ts の failover） */
export const terminalFailoverHooks = {
  input(id: string, data: string): void {
    let tracker = inputs.get(id)
    if (!tracker) inputs.set(id, (tracker = new LastInputTracker()))
    tracker.push(data)
  },
  sent(id: string, text: string): void {
    if (handoffSending.has(id)) return
    let tracker = inputs.get(id)
    if (!tracker) inputs.set(id, (tracker = new LastInputTracker()))
    tracker.record(text)
  },
  output(id: string, text: string): void {
    if (confirmTimers.has(id) || !mentionsLimit(text)) return
    if (!failoverPrefs().enabled) return
    const timer = setTimeout(() => {
      confirmTimers.delete(id)
      void onLimitSeen(id).catch((err: unknown) => reportHandled(errorKind(err), { area: 'accounts', op: 'handle limit' }))
    }, CONFIRM_DELAY_MS)
    timer.unref?.()
    confirmTimers.set(id, timer)
  },
  /**
   * Agent のタブを開いた。token があれば切り替えで開いたタブ。
   * accountId はそのタブを実際に起動したアカウント（タブを戻したときは前のアカウントで開くので、選択中と違うことがある）
   */
  launched(id: string, agent: TuiAgent, token: string | null, accountId?: string | null): void {
    if (isAccountAgentId(agent)) launchedAccount.set(id, accountId !== undefined ? accountId : activeAccountId(agent))
    const launch = token ? pending.get(token) : undefined
    if (launch && launch.agent === agent) {
      pending.delete(token!)
      failoverTabs.add(id)
      launch.created(id)
    }
  },
  closed(id: string): void {
    inputs.delete(id)
    launchedAccount.delete(id)
    failoverTabs.delete(id)
    nearLimitStarted.delete(id)
    const timer = confirmTimers.get(id)
    if (timer) clearTimeout(timer)
    confirmTimers.delete(id)
  }
}

async function onLimitSeen(id: string): Promise<void> {
  const prefs = failoverPrefs()
  if (!prefs.enabled || !terminals) return
  const info = terminals.list().find((s) => s.id === id)
  if (!info) return
  const state = await terminals.agentState(id)
  const agent = state.agent
  if (!agent || state.kind === 'unknown') return
  // ローカルのモデルで動く Agent には提供元の上限が無い。上限らしい行が出ても切り替えない
  if (localAgents().has(agent)) return
  if (!limitOnScreen(agent, terminals.screenText(id))) return
  const from: FailoverTarget = isAccountAgentId(agent) ? { agent, accountId: launchedAccount.get(id) ?? activeAccountId(agent) } : { agent }
  flow('failover limit', { agent: isAccountAgentId(agent) ? agent : 'other' })
  await switchFrom(id, info.cwd, from, 'limit')
}

// ───────────────────────── 選んで切り替える ─────────────────────────

async function planInput(from: FailoverTarget): Promise<PlanInput> {
  const prefs = failoverPrefs()
  const [accounts, options] = await Promise.all([listAgentAccounts(), listAgentOptions(currentSettings().agents)])
  const candidates = {} as Record<AccountAgent, AccountCandidate[]>
  for (const agent of ['claude', 'codex'] as const) {
    const view = accounts[agent]
    // 使用量は切り替えに関わる Agent のぶんだけ取る（アカウント別の内訳と同じ取り方。60秒以内は取り直さない）
    const wanted = from.agent === agent || prefs.agentOrder.includes(agent)
    const usage = wanted ? await getAccountUsage(agent).catch(() => []) : []
    const used = (accountId: string | null) => maxUsedPercent(usage.find((u) => u.accountId === accountId)?.rateLimits)
    for (const row of usage) {
      const until = limitedUntil(row.rateLimits, prefs.thresholdPercent)
      if (until) markLimited({ agent, accountId: row.accountId }, until)
    }
    candidates[agent] = [
      // 選択中のシステムの既定は、ログインが見えなくても使える（API キーの環境変数などで動かしている場合がある）
      { accountId: null, signedIn: view.systemDefault.signedIn || view.activeAccountId === null, usedPercent: used(null), active: view.activeAccountId === null },
      ...view.accounts
        .filter((a) => a.lastAuthenticatedAt !== null && !a.problem)
        .map((a) => ({ accountId: a.id, signedIn: a.signedIn, usedPercent: used(a.id), active: view.activeAccountId === a.id }))
    ]
  }
  // Claude in Chrome とつながるアカウント（拡張機能と同じ claude.ai のアカウント）を先に選ぶための印
  const chrome = await claudeChromeAccounts().catch(() => new Set<string | null>())
  candidates.claude = candidates.claude.map((c) => (chrome.has(c.accountId) ? { ...c, chrome: true } : c))
  const available = new Set(options.filter((o) => o.installed && o.enabled).map((o) => o.id))
  return { prefs, from, accounts: candidates, available, limited, now: Date.now(), local: localAgents() }
}

function markLimited(target: FailoverTarget, until: number): void {
  const key = limitKey(target)
  limited.set(key, Math.max(limited.get(key) ?? 0, until))
}

async function switchFrom(id: string, cwd: string, from: FailoverTarget, reason: 'limit' | 'return' | 'switch', planned?: FailoverTarget): Promise<void> {
  if (busy.has(cwd)) return
  const now = Date.now()
  if (reason === 'limit') markLimited(from, now + DEFAULT_LIMIT_COOLDOWN_MS)
  // 利用者がフッター・設定で選び直した（switch）ときは、回数の制限をかけない（自動の切り替えの暴走を止めるためのもの）
  const allowed = reason === 'switch' ? { ok: true as const } : switchAllowed(history.get(cwd) ?? [], now)
  if (!allowed.ok) {
    if (reason === 'limit') notify({ message: t('failover.notice.paused', { time: formatTime(allowed.retryAt) }), toLabel: null, toTerminalId: null, fromTerminalId: null })
    return
  }
  busy.add(cwd)
  try {
    const input = await planInput(from)
    const target = planned ?? (reason === 'limit' ? planFailover(input) : null)
    if (!target) {
      const last = waitingNoticeAt.get(cwd) ?? 0
      if (reason === 'limit' && now - last > WAITING_NOTICE_GAP_MS) {
        waitingNoticeAt.set(cwd, now)
        notify({ message: t('failover.notice.waiting', { agent: label(from.agent) }), toLabel: null, toTerminalId: null, fromTerminalId: null })
      }
      return
    }
    if (reason !== 'switch') history.set(cwd, [...(history.get(cwd) ?? []).filter((at) => now - at < 60 * 60 * 1000), now])
    await launchTarget(id, cwd, from, target, reason)
  } finally {
    busy.delete(cwd)
  }
}

async function launchTarget(fromId: string, cwd: string, from: FailoverTarget, target: FailoverTarget, reason: 'limit' | 'return' | 'switch'): Promise<void> {
  if (!terminals) return
  const sameAgent = target.agent === from.agent
  const fromLabel = label(from.agent)
  const toLabel = label(target.agent)
  // 切り替える前に、引き継ぎのファイルを今の Agent に更新させる（できなければ Ferret が追記する）
  const path = await prepareHandoff(fromId, cwd, fromLabel)
  if (isAccountAgentId(target.agent) && target.accountId !== undefined && target.accountId !== activeAccountId(target.agent)) {
    await selectAgentAccount(target.agent, target.accountId)
  }
  const prompt = nextAgentPrompt({
    reason,
    from: fromLabel,
    to: sameAgent && isAccountAgentId(target.agent) ? `${toLabel} (${accountLabel(target.agent, target.accountId ?? null)})` : toLabel,
    path
  })
  const token = randomUUID()
  const created = new Promise<string | null>((resolve) => {
    pending.set(token, { agent: target.agent, created: resolve })
    setTimeout(() => resolve(null), CREATE_TIMEOUT_MS).unref?.()
  })
  emitLaunch({ token, agent: target.agent, cwd, fromTerminalId: fromId })
  const newId = await created
  pending.delete(token)
  if (!newId) {
    notify({ message: t('failover.notice.notOpened', { agent: toLabel }), toLabel: null, toTerminalId: null, fromTerminalId: null })
    return
  }
  // 直前の依頼は新しいタブへ引き継ぐ（さらに切り替えるとき、Ferret が追記に使う）
  inputs.set(newId, inputs.get(fromId) ?? new LastInputTracker())
  handoffSending.add(newId)
  let sent: { ok: boolean } | null = null
  try {
    sent = (await waitReady(newId)) ? await terminals.sendReview(newId, prompt) : null
  } finally {
    handoffSending.delete(newId)
  }
  const message = !sent?.ok
    ? t('failover.notice.notReady', { agent: toLabel })
    : (reason === 'switch' || (reason === 'return' && sameAgent)) && isAccountAgentId(target.agent)
      ? t('failover.notice.switched', { agent: toLabel, account: accountLabel(target.agent, target.accountId ?? null) })
      : reason === 'return'
      ? t('failover.notice.return', { from: fromLabel, to: toLabel })
      : sameAgent && isAccountAgentId(target.agent)
        ? t('failover.notice.account', { agent: toLabel, account: accountLabel(target.agent, target.accountId ?? null) })
        : t('failover.notice.agent', { from: fromLabel, to: toLabel })
  flow('failover switched', { kind: sameAgent ? 'account' : 'agent', sent: sent?.ok ? 1 : 0 })
  // 引き継げたら古いタブを閉じる（枠が戻ったとき、古い Agent が同じ作業を続けないように）
  notify({ message, toLabel, toTerminalId: newId, fromTerminalId: sent?.ok ? fromId : null })
}

/** 作業フォルダが入っている登録済みのプロジェクトのフォルダ。無ければ作業フォルダ */
function projectDirFor(cwd: string): string {
  const project = currentSettings().projects.find((p) => p.folderPath && isWithin(p.folderPath, cwd))
  return project?.folderPath ?? cwd
}

async function mtimeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    // まだ無い（想定内）
    return 0
  }
}

/**
 * 引き継ぎのファイルを用意して、その絶対パスを返す。
 * 1. 今の Agent が入力を受け付けるなら「更新して」と頼み、動き出したら終わるまで待つ
 * 2. 動き出さない（上限で止まっている）・更新されないときは、Ferret が直前の依頼・feedback.md の場所・変更ファイルを追記する
 */
async function prepareHandoff(fromId: string, cwd: string, fromLabel: string): Promise<string> {
  const projectDir = projectDirFor(cwd)
  const path = handoffFilePath(projectDir)
  if (!terminals) return path
  const before = await mtimeOf(path)
  let updated = false
  const state = await terminals.agentState(fromId).catch(() => null)
  if (state && state.kind !== 'unknown' && state.state === 'idle') {
    handoffSending.add(fromId)
    try {
      const sent = await terminals.sendReview(fromId, updateRequest(path))
      if (sent.ok) updated = await waitForUpdate(fromId, path, before)
    } catch (err) {
      reportHandled(errorKind(err), { area: 'accounts', op: 'ask agent to update handoff' })
    } finally {
      handoffSending.delete(fromId)
    }
  }
  if (!updated) {
    try {
      await appendFerretNote(projectDir, path, fromId, fromLabel, before > 0)
    } catch (err) {
      reportHandled(errorKind(err), { area: 'accounts', op: 'write handoff note' })
    }
  }
  return path
}

/** 頼んだあと、Agent が動き出して（working）ファイルを更新し、待機に戻るまで待つ。動き出さなければすぐ諦める */
async function waitForUpdate(id: string, path: string, before: number): Promise<boolean> {
  if (!terminals) return false
  const started = Date.now()
  let sawWorking = false
  while (Date.now() - started < UPDATE_TIMEOUT_MS) {
    await delay(1000)
    const state = await terminals.agentState(id).catch(() => null)
    if (!state || state.kind === 'unknown') break
    if (state.state === 'working') sawWorking = true
    const changed = (await mtimeOf(path)) > before
    if (changed && state.state === 'idle') return true
    if (!sawWorking && !changed && Date.now() - started >= UPDATE_START_MS) break
  }
  return (await mtimeOf(path)) > before
}

const execFileAsync = promisify(execFile)

/** git status --porcelain の変更ファイル。git でなければ null */
async function changedFiles(projectDir: string): Promise<string[] | null> {
  try {
    // git は信頼できる絶対パスで、リポジトリの fsmonitor・フックを動かさずに（security-7 [5]・[15]）
    const git = await trustedGit(projectDir)
    if (!git) return null
    const { stdout } = await execFileAsync(git, ['-C', projectDir, ...AUTOMATIC_GIT_CONFIG, 'status', '--porcelain'], { timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true })
    return changedFilesFrom(stdout)
  } catch {
    // git ではない・git が無い（想定内）
    return null
  }
}

async function appendFerretNote(projectDir: string, path: string, fromId: string, fromLabel: string, fileExists: boolean): Promise<void> {
  // .ferret/ の先祖にリンクが無く、プロジェクトの中にあることを確かめてから書く（sessions/containment.ts）
  assertContained(projectDir, path)
  await mkdirContained(dirname(path), { root: projectDir })
  assertContained(projectDir, path)
  await ensureGitExclude(projectDir).catch(() => undefined)
  const note = ferretNote({
    time: formatDateTime(Date.now()),
    agent: fromLabel,
    lastRequest: inputs.get(fromId)?.lastRequest() ?? null,
    changedFiles: await changedFiles(projectDir),
    fileExists
  })
  await appendFileNoFollow(path, note)
}

async function waitReady(id: string): Promise<boolean> {
  if (!terminals) return false
  const deadline = Date.now() + READY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const state = await terminals.agentState(id)
    if (state.kind !== 'unknown' && state.state === 'idle') return true
    // 確認待ち（フォルダの信頼など）は利用者に任せる
    if (state.state === 'blocked') return false
    await delay(500)
  }
  return false
}

// ───────────────────────── 利用者が選び直したとき ─────────────────────────

/**
 * フッター・設定でアカウントを選び直したとき。選んだアカウントは新しく開くタブだけでなく、
 * いま動いているその Agent のタブにも効かせる（以前は新しいタブだけで、動いているタブは前のアカウントのままだった）。
 * 上限での切り替えと同じく、引き継ぎのファイルを書かせてから選んだアカウントで開き直し、続きを頼んで古いタブを閉じる。
 * 同じフォルダのタブは1つずつ順に（switchFrom はフォルダごとに1つしか同時に動かない）。戻り値は切り替えるタブの数
 */
export async function switchRunningAgents(agent: AccountAgent, accountId: string | null): Promise<number> {
  // 利用者が選んだアカウント。Chrome とつながるアカウントへ自動で戻すのは、この起動のあいだは控える
  manualChoice[agent] = accountId
  if (!terminals) return 0
  const tabs = await Promise.all(terminals.list().map(async (info) => {
    const state = await terminals!.agentState(info.id).catch(() => null)
    return { id: info.id, cwd: info.cwd, agent: state && state.kind !== 'unknown' ? state.agent : null, launchedAccount: launchedAccount.get(info.id) }
  }))
  const targets = tabsToSwitch(tabs, agent, accountId).map((tab) => ({ id: tab.id, cwd: tab.cwd, from: tab.launchedAccount ?? null }))
  if (targets.length > 0) notify({ message: t('failover.notice.switching', { count: targets.length, agent: label(agent), account: accountLabel(agent, accountId) }), toLabel: null, toTerminalId: null, fromTerminalId: null })
  void (async () => {
    for (const target of targets) {
      // 作業の途中では切り替えない（途中で切れる）。待機に戻るまで待ち、そのあいだに閉じた・選び直したなら何もしない
      if (!(await waitIdleForSwitch(target.id, agent, accountId))) continue
      await switchFrom(target.id, target.cwd, { agent, accountId: target.from }, 'switch', { agent, accountId })
        .catch((err: unknown) => reportHandled(errorKind(err), { area: 'accounts', op: 'switch running agent' }))
    }
  })()
  return targets.length
}

/** 作業中のタブを切り替えるまで待つ上限 */
const SWITCH_WAIT_MS = 60 * 60 * 1000

/** タブが待機中になるまで待つ。閉じた・その間に別のアカウントを選び直した・上限を過ぎたら false */
async function waitIdleForSwitch(id: string, agent: AccountAgent, accountId: string | null): Promise<boolean> {
  const deadline = Date.now() + SWITCH_WAIT_MS
  while (terminals && Date.now() < deadline) {
    if (activeAccountId(agent) !== accountId) return false
    if (!terminals.list().some((s) => s.id === id)) return false
    const state = await terminals.agentState(id).catch(() => null)
    if (!state || state.agent !== agent) return false
    if (state.state === 'idle') return true
    await delay(2000)
  }
  return false
}

// ───────────────────────── 使用量から ─────────────────────────

/**
 * 使用量が変わったとき。選択中のアカウントが しきい値 以上なら、新しく開く Agent のアカウントを余裕のあるものへ切り替える。
 * 動いている Agent はそのまま（その Agent が上限の知らせを出したら、ターミナルからの切り替えで引き継ぐ）
 */
export function onUsageChanged(state: UsageState): void {
  const prefs = failoverPrefs()
  if (!prefs.enabled) return
  const local = localAgents()
  for (const agent of ['claude', 'codex'] as const) {
    // ローカルのモデルで動くなら、アカウントの使用量でアカウントを切り替えない
    if (local.has(agent)) continue
    const limits = state[agent]
    if (limits?.status !== 'ok') continue
    const used = maxUsedPercent(limits)
    if (used === null || used < prefs.thresholdPercent) {
      if (agent === 'claude') maybeReturnNewTabsToChrome(prefs)
      continue
    }
    const from: FailoverTarget = { agent, accountId: activeAccountId(agent) }
    markLimited(from, limitedUntil(limits, prefs.thresholdPercent) ?? Date.now() + DEFAULT_LIMIT_COOLDOWN_MS)
    if (!prefs.switchAccounts || Date.now() - usageSwitchAt[agent] < USAGE_SWITCH_GAP_MS) continue
    usageSwitchAt[agent] = Date.now()
    void (async () => {
      const next = usableAccounts(await planInput(from), agent, from.accountId ?? null)[0]
      if (!next) return
      await selectAgentAccount(agent, next.accountId)
      notify({ message: t('failover.notice.accountForNewTabs', { agent: label(agent), account: accountLabel(agent, next.accountId) }), toLabel: null, toTerminalId: null, fromTerminalId: null })
    })().catch((err: unknown) => reportHandled(errorKind(err), { area: 'accounts', op: 'switch account from usage' }))
  }
}

/** 利用者がこの起動のあいだに選んだアカウントのままにするか */
function keepManualChoice(agent: AccountAgent): boolean {
  return agent in manualChoice && manualChoice[agent] === activeAccountId(agent)
}

/**
 * 新しく開く Claude Code のタブのアカウントが Claude in Chrome とつながらないものなら、
 * つながるアカウントの枠が戻ったときにそちらへ戻す（上限で別のアカウントへ移ったあと、ずっと Chrome が切れたままにならないように）
 */
export function maybeReturnNewTabsToChrome(prefs: LimitFailoverPrefs = failoverPrefs()): void {
  if (!prefs.enabled || !prefs.switchAccounts || keepManualChoice('claude')) return
  const now = Date.now()
  if (now - chromeReturnCheckAt < CHROME_RETURN_GAP_MS) return
  chromeReturnCheckAt = now
  void (async () => {
    const current = activeAccountId('claude')
    // 今のアカウントが Chrome とつながる・どれもつないでいないなら、使用量を取りに行かない
    const chrome = await claudeChromeAccounts()
    if (chrome.size === 0 || chrome.has(current)) return
    const target = chromeReturnTarget(await planInput({ agent: 'claude', accountId: current }), 'claude', current)
    // 調べているあいだに利用者が選び直していたら何もしない
    if (!target || activeAccountId('claude') !== current || keepManualChoice('claude')) return
    await selectAgentAccount('claude', target.accountId)
    flow('failover chrome account', { kind: 'new tabs' })
  })().catch((err: unknown) => reportHandled(errorKind(err), { area: 'accounts', op: 'return to chrome account' }))
}

// ───────────────────────── 優先順位の高い Agent へ戻す ─────────────────────────

async function checkReturn(): Promise<void> {
  const prefs = failoverPrefs()
  if (!prefs.enabled || !prefs.returnToPreferred || !terminals) return
  await returnTabsToChrome(prefs)
  for (const id of [...failoverTabs]) {
    const info = terminals.list().find((s) => s.id === id)
    if (!info || busy.has(info.cwd)) continue
    const state = await terminals.agentState(id)
    if (!state.agent || state.state !== 'idle') continue
    const current = state.agent
    const from: FailoverTarget = isAccountAgentId(current) ? { agent: current, accountId: launchedAccount.get(id) ?? null } : { agent: current }
    const target = planReturn({ ...(await planInput(from)), current })
    if (target) await switchFrom(id, info.cwd, from, 'return', target)
  }
}

/**
 * Claude in Chrome とつながらないアカウントで動いている Claude Code のタブ（上限で移った・別のアカウントで戻したもの）を、
 * つながるアカウントの枠が戻ったら、待機中のものから引き継いで開き直す
 */
async function returnTabsToChrome(prefs: LimitFailoverPrefs): Promise<void> {
  if (!terminals || !prefs.switchAccounts || keepManualChoice('claude')) return
  const chrome = await claudeChromeAccounts().catch(() => new Set<string | null>())
  if (chrome.size === 0) return
  const tabs = [...launchedAccount].filter(([id, accountId]) => !chrome.has(accountId) && terminals!.list().some((s) => s.id === id))
  if (tabs.length === 0) return
  let input: PlanInput | null = null
  for (const [id, accountId] of tabs) {
    const info = terminals.list().find((s) => s.id === id)
    if (!info || busy.has(info.cwd)) continue
    const state = await terminals.agentState(id).catch(() => null)
    if (!state || state.agent !== 'claude' || state.state !== 'idle') continue
    input ??= await planInput({ agent: 'claude', accountId })
    const target = chromeReturnTarget(input, 'claude', accountId)
    if (!target) continue
    await switchFrom(id, info.cwd, { agent: 'claude', accountId }, 'return', { agent: 'claude', accountId: target.accountId })
  }
}

// ───────────────────────── 上限の手前で引き継ぐ ─────────────────────────

/**
 * 動いている Claude Code / Codex のタブのうち、使っているアカウントの使用量が handoffPercent 以上のものを、
 * 手が空いたところで（最長 NEAR_LIMIT_IDLE_WAIT_MS 待つ）引き継ぎのファイルにまとめさせ、次の優先順位のアカウント・Agent で開き直す
 */
export async function checkNearLimit(): Promise<void> {
  const prefs = failoverPrefs()
  if (!prefs.enabled || !terminals || prefs.handoffPercent >= 100) return
  const tabs: RunningTab[] = []
  for (const info of terminals.list()) {
    const state = await terminals.agentState(info.id).catch(() => null)
    const agent = state && state.kind !== 'unknown' ? state.agent : null
    if (!agent || !isAccountAgentId(agent)) continue
    tabs.push({ id: info.id, cwd: info.cwd, agent, accountId: launchedAccount.has(info.id) ? launchedAccount.get(info.id)! : activeAccountId(agent) })
  }
  if (tabs.length === 0) return
  const used = new Map<string, number | null>()
  for (const agent of ['claude', 'codex'] as const) {
    if (!tabs.some((tab) => tab.agent === agent)) continue
    for (const row of await getAccountUsage(agent).catch(() => [])) used.set(limitKey({ agent, accountId: row.accountId }), maxUsedPercent(row.rateLimits))
  }
  const due = nearLimitTabs(tabs, (agent, accountId) => used.get(limitKey({ agent, accountId })) ?? null, prefs.handoffPercent, nearLimitStarted, busy, localAgents())
  for (const tab of due) {
    nearLimitStarted.add(tab.id)
    flow('failover near limit', { agent: tab.agent })
    void handOffNearLimit(tab).catch((err: unknown) => reportHandled(errorKind(err), { area: 'accounts', op: 'hand off near limit' }))
  }
}

async function handOffNearLimit(tab: RunningTab): Promise<void> {
  // 作業の途中で切ると、やりかけが残る。手が空くまで待つ（閉じたら何もしない）
  const deadline = Date.now() + NEAR_LIMIT_IDLE_WAIT_MS
  while (terminals && Date.now() < deadline) {
    if (!terminals.list().some((s) => s.id === tab.id)) return
    const state = await terminals.agentState(tab.id).catch(() => null)
    if (!state || state.agent !== tab.agent) return
    if (state.state === 'idle') break
    await delay(5000)
  }
  if (!terminals?.list().some((s) => s.id === tab.id)) return
  // このアカウントは上限とみなし、次の優先順位（別のアカウント → 次の Agent）を選ぶ
  await switchFrom(tab.id, tab.cwd, { agent: tab.agent, accountId: tab.accountId }, 'limit')
  // 引き継げなかった（どれも上限・回数の上限）ときは、あとでもう一度確かめられるようにする
  if (terminals?.list().some((s) => s.id === tab.id)) setTimeout(() => nearLimitStarted.delete(tab.id), WAITING_NOTICE_GAP_MS).unref?.()
}

function syncNearLimitTimer(): void {
  const prefs = failoverPrefs()
  const want = prefs.enabled && prefs.handoffPercent < 100
  if (want && !nearLimitTimer) {
    nearLimitTimer = setInterval(() => void checkNearLimit().catch((err: unknown) => reportHandled(errorKind(err), { area: 'accounts', op: 'near limit' })), NEAR_LIMIT_CHECK_MS)
    nearLimitTimer.unref?.()
  } else if (!want && nearLimitTimer) {
    clearInterval(nearLimitTimer)
    nearLimitTimer = null
  }
}

function syncReturnTimer(): void {
  const prefs = failoverPrefs()
  const want = prefs.enabled && prefs.returnToPreferred
  if (want && !returnTimer) {
    returnTimer = setInterval(() => void checkReturn().catch((err: unknown) => reportHandled(errorKind(err), { area: 'accounts', op: 'return' })), RETURN_CHECK_MS)
    returnTimer.unref?.()
  } else if (!want && returnTimer) {
    clearInterval(returnTimer)
    returnTimer = null
  }
}

export function initFailover(options: {
  terminals: TerminalManager
  launch: (req: FailoverLaunchRequest) => void
  notice: (notice: FailoverNotice) => void
}): void {
  terminals = options.terminals
  emitLaunch = options.launch
  emitNotice = options.notice
  terminals.failover = terminalFailoverHooks
  syncReturnTimer()
  syncNearLimitTimer()
}
