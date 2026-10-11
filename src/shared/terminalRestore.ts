import type { BuiltinAgent, TuiAgent } from './types'
import { isBuiltinAgent } from './agentCatalog'
import { isRecord } from './guards'

/**
 * ターミナルのタブを、アプリを終了・再起動したあと・閉じたあとに戻す（純粋関数だけ。main・renderer・単体テストから使う）。
 *
 * 画面の読み込み直し（⌘R）は restorePlan.ts が生きている PTY につなぎ直す。こちらは PTY が終わったあとの話で、
 * タブ・分割の形・作業フォルダ・起動した Agent とアカウント、画面に出ていた文字（スクロールバック）を userData に書いておき、
 * 次に開いたときは同じ並びでタブを作り、前の文字を xterm に書いてから新しい PTY を起動する。
 * Agent のタブは、会話を続ける引数（Claude Code の --continue、Codex の resume --last）で起動する。
 *
 * 書くのは xterm の画面から取り出した文字だけ（色・制御シーケンスは書かない）。流し直したときに、昔の出力の中の
 * 問い合わせ・クリップボードへのコピー（OSC 52）・画面の切り替えが新しいシェルで動かないようにするため。
 * 読むときも制御文字を落としてから使う。
 */

/** 1つのペインで覚える行数（折り返しを戻した行で数える） */
export const RESTORE_LINE_LIMIT = 2000
/** 1つのペインで覚える大きさ（UTF-8） */
export const RESTORE_PANE_BYTES = 512 * 1024
/** ファイル全体（開いていたタブ ＋ 閉じたタブ）で覚えるスクロールバックの合計 */
export const RESTORE_TOTAL_BYTES = 5 * 1024 * 1024
/** 読むファイルの上限。超えていれば読まない */
export const RESTORE_FILE_MAX_BYTES = 8 * 1024 * 1024
/** 閉じたタブを覚えておく数（新しいものから） */
export const CLOSED_STACK_LIMIT = 10
/** 会話を続ける引数を知っている Agent */
export const RESUMABLE_AGENTS: readonly BuiltinAgent[] = ['claude', 'codex']

const MAX_TABS = 200
const MAX_PANES = 400
const MAX_TITLE = 200
const MAX_PATH = 4096
const MAX_DEPTH = 16
const KEY_PATTERN = /^(tab|pane)\d{1,9}$/
const CUSTOM_AGENT_PATTERN = /^custom:[a-z0-9][a-z0-9-]{0,47}$/
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export type RestoreLayout =
  | { type: 'leaf'; leafId: string }
  | { type: 'split'; direction: 'vertical' | 'horizontal'; first: RestoreLayout; second: RestoreLayout; ratio: number }

export interface RestorePane {
  key: string
  title: string
  /** 起動した Agent。素のシェルなら null */
  launch: TuiAgent | null
  /** 開いたときの作業フォルダ。null ならプロジェクトのフォルダ */
  cwd: string | null
  /** 起動したときのアカウント（Claude Code / Codex）。null はシステムの既定アカウント */
  accountId: string | null
  /** 画面に出ていた文字（制御文字なし。行は \n で区切る） */
  scrollback: string
  /** 閉じたとき Agent が作業の途中だった（実行中・確認待ち）。開き直したら会話を続け、続きから再開するよう頼む */
  working?: true
}

export interface RestoreTab {
  key: string
  projectId: string | null
  layout: RestoreLayout
  activePane: string
}

/** 終了したときに開いていたタブ */
export interface TerminalRestoreSnapshot {
  tabs: RestoreTab[]
  panes: RestorePane[]
  activeByProject: Record<string, string | null>
  savedAt: number
}

/** 閉じたタブ1枚（分割していれば中のペインすべて） */
export interface ClosedTerminal {
  projectId: string | null
  tab: RestoreTab
  panes: RestorePane[]
  closedAt: number
}

export interface TerminalRestoreFile {
  version: 1
  session: TerminalRestoreSnapshot | null
  closed: ClosedTerminal[]
}

// ───────────────────────── 文字の上限 ─────────────────────────

/** UTF-8 での大きさ（Buffer の無い renderer でも数えられるように） */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      bytes += 4
      i += 1
    } else bytes += 3
  }
  return bytes
}

/** 改行とタブ以外の制御文字（ESC・C1 を含む）を落とし、改行を \n にそろえる */
export function stripControls(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
}

/** 末尾から bytes 以内に収まる位置で切る（前を捨てる。サロゲートの途中では切らない） */
function tailWithinBytes(text: string, bytes: number): string {
  if (bytes <= 0) return ''
  if (utf8Length(text) <= bytes) return text
  let used = 0
  let i = text.length
  while (i > 0) {
    const low = text.charCodeAt(i - 1)
    const pair = low >= 0xdc00 && low <= 0xdfff && i >= 2
    const size = pair ? 4 : low < 0x80 ? 1 : low < 0x800 ? 2 : 3
    if (used + size > bytes) break
    used += size
    i -= pair ? 2 : 1
  }
  const cut = text.slice(i)
  // 行の途中から始まるなら、次の行の頭からにする（1行しか無ければそのまま）
  const newline = cut.indexOf('\n')
  return i > 0 && newline >= 0 && newline < cut.length - 1 ? cut.slice(newline + 1) : cut
}

/**
 * 覚える文字にする。制御文字を落とし、末尾の空行を外し、新しい側の lines 行・bytes までにする
 */
export function capScrollback(text: string, lines = RESTORE_LINE_LIMIT, bytes = RESTORE_PANE_BYTES): string {
  const rows = stripControls(text).split('\n').map((row) => row.replace(/\s+$/, ''))
  while (rows.length > 0 && rows[rows.length - 1] === '') rows.pop()
  const kept = rows.slice(Math.max(0, rows.length - lines))
  while (kept.length > 0 && kept[0] === '') kept.shift()
  return tailWithinBytes(kept.join('\n'), bytes)
}

/**
 * xterm の行（折り返しで続く行は wrapped）を、折り返す前の1行ずつに戻す。
 * 幅の違うウインドウで開き直しても、xterm が今の幅で折り返し直せるようにする
 */
export function joinWrappedRows(rows: ReadonlyArray<{ text: string; wrapped: boolean }>): string[] {
  const lines: string[] = []
  for (const row of rows) {
    if (row.wrapped && lines.length > 0) lines[lines.length - 1] += row.text
    else lines.push(row.text)
  }
  return lines.map((line) => line.replace(/\s+$/, ''))
}

/**
 * 全体の上限に収める。小さいものはそのまま残し、大きいものから同じ幅で削る（どのタブも新しい側を残す）
 */
export function fitTotalBudget(texts: readonly string[], total = RESTORE_TOTAL_BYTES): string[] {
  const sizes = texts.map(utf8Length)
  if (sizes.reduce((a, b) => a + b, 0) <= total) return [...texts]
  const order = sizes.map((size, i) => ({ size, i })).sort((a, b) => a.size - b.size)
  const allowance = new Array<number>(texts.length).fill(0)
  let left = total
  order.forEach(({ size, i }, n) => {
    const share = Math.floor(left / (order.length - n))
    allowance[i] = Math.min(size, share)
    left -= allowance[i]!
  })
  return texts.map((text, i) => (sizes[i]! <= allowance[i]! ? text : tailWithinBytes(text, allowance[i]!)))
}

// ───────────────────────── 読む・書く ─────────────────────────

const isKey = (value: unknown): value is string => typeof value === 'string' && KEY_PATTERN.test(value)

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = stripControls(value).replace(/\n/g, ' ').trim()
  return text.length > 0 && text.length <= max ? text : null
}

export function isRestorableAgent(value: unknown): value is TuiAgent {
  return isBuiltinAgent(value) || (typeof value === 'string' && CUSTOM_AGENT_PATTERN.test(value))
}

/** 分割の形を確かめる。おかしければ null */
export function parseRestoreLayout(value: unknown, depth = 0): RestoreLayout | null {
  if (!isRecord(value) || depth > MAX_DEPTH) return null
  if (value.type === 'leaf') return isKey(value.leafId) ? { type: 'leaf', leafId: value.leafId } : null
  if (value.type !== 'split' || (value.direction !== 'vertical' && value.direction !== 'horizontal')) return null
  const ratio = typeof value.ratio === 'number' && Number.isFinite(value.ratio) ? Math.min(0.95, Math.max(0.05, value.ratio)) : 0.5
  const first = parseRestoreLayout(value.first, depth + 1)
  const second = parseRestoreLayout(value.second, depth + 1)
  return first && second ? { type: 'split', direction: value.direction, first, second, ratio } : null
}

export function restoreLeafIds(node: RestoreLayout): string[] {
  return node.type === 'leaf' ? [node.leafId] : [...restoreLeafIds(node.first), ...restoreLeafIds(node.second)]
}

function parsePane(value: unknown): RestorePane | null {
  if (!isRecord(value) || !isKey(value.key)) return null
  const launch = value.launch === null || value.launch === undefined ? null : isRestorableAgent(value.launch) ? value.launch : undefined
  if (launch === undefined) return null
  const cwd = value.cwd === null || value.cwd === undefined ? null : cleanText(value.cwd, MAX_PATH)
  const accountId = typeof value.accountId === 'string' && ACCOUNT_ID_PATTERN.test(value.accountId) ? value.accountId : null
  return {
    key: value.key,
    title: cleanText(value.title, MAX_TITLE) ?? '',
    launch,
    cwd,
    accountId,
    scrollback: typeof value.scrollback === 'string' ? capScrollback(value.scrollback) : '',
    ...(value.working === true && launch ? { working: true as const } : {})
  }
}

function parseTab(value: unknown): RestoreTab | null {
  if (!isRecord(value) || !isKey(value.key)) return null
  const layout = parseRestoreLayout(value.layout)
  if (!layout) return null
  const leaves = restoreLeafIds(layout)
  if (new Set(leaves).size !== leaves.length) return null
  const projectId = typeof value.projectId === 'string' && value.projectId.length <= 200 ? value.projectId : null
  const activePane = typeof value.activePane === 'string' && leaves.includes(value.activePane) ? value.activePane : leaves[0]!
  return { key: value.key, projectId, layout, activePane }
}

/** タブと中のペインをそろえる。ペインの欠けたタブ・どのタブにも無いペインは捨てる */
function pairTabs(rawTabs: unknown, rawPanes: unknown): { tabs: RestoreTab[]; panes: RestorePane[] } {
  const panes = new Map<string, RestorePane>()
  for (const value of Array.isArray(rawPanes) ? rawPanes.slice(0, MAX_PANES) : []) {
    const pane = parsePane(value)
    if (pane && !panes.has(pane.key)) panes.set(pane.key, pane)
  }
  const tabs: RestoreTab[] = []
  const used = new Set<string>()
  const tabKeys = new Set<string>()
  for (const value of Array.isArray(rawTabs) ? rawTabs.slice(0, MAX_TABS) : []) {
    const tab = parseTab(value)
    if (!tab || tabKeys.has(tab.key)) continue
    const leaves = restoreLeafIds(tab.layout)
    if (leaves.some((key) => !panes.has(key) || used.has(key))) continue
    for (const key of leaves) used.add(key)
    tabKeys.add(tab.key)
    tabs.push(tab)
  }
  return { tabs, panes: [...panes.values()].filter((pane) => used.has(pane.key)) }
}

/** renderer から届いた・ファイルから読んだ、開いていたタブの記録を確かめる */
export function sanitizeRestoreSnapshot(value: unknown, now = Date.now()): TerminalRestoreSnapshot | null {
  if (!isRecord(value)) return null
  const { tabs, panes } = pairTabs(value.tabs, value.panes)
  const tabKeys = new Set(tabs.map((tab) => tab.key))
  const activeByProject: Record<string, string | null> = {}
  if (isRecord(value.activeByProject)) {
    for (const [project, key] of Object.entries(value.activeByProject).slice(0, MAX_TABS)) {
      if (typeof key === 'string' && tabKeys.has(key)) activeByProject[project] = key
    }
  }
  const savedAt = typeof value.savedAt === 'number' && Number.isFinite(value.savedAt) ? value.savedAt : now
  return { tabs, panes, activeByProject, savedAt }
}

/** 閉じたタブ1枚の記録を確かめる */
export function sanitizeClosedTerminal(value: unknown, now = Date.now()): ClosedTerminal | null {
  if (!isRecord(value)) return null
  const { tabs, panes } = pairTabs([value.tab], value.panes)
  const tab = tabs[0]
  if (!tab) return null
  const closedAt = typeof value.closedAt === 'number' && Number.isFinite(value.closedAt) ? value.closedAt : now
  return { projectId: tab.projectId, tab, panes, closedAt }
}

/** 全体の上限に収める（開いていたタブを先に、閉じたタブは新しいものから同じ扱い） */
function fitFile(file: TerminalRestoreFile): TerminalRestoreFile {
  const groups = [file.session?.panes ?? [], ...file.closed.map((entry) => entry.panes)]
  const fitted = fitTotalBudget(groups.flat().map((pane) => pane.scrollback))
  let at = 0
  const refit = (panes: RestorePane[]) => panes.map((pane) => ({ ...pane, scrollback: fitted[at++]! }))
  const session = file.session ? { ...file.session, panes: refit(file.session.panes) } : null
  return { version: 1, session, closed: file.closed.map((entry) => ({ ...entry, panes: refit(entry.panes) })) }
}

export function emptyRestoreFile(): TerminalRestoreFile {
  return { version: 1, session: null, closed: [] }
}

/** ファイルの中身を読む。壊れていれば空 */
export function parseRestoreFile(text: string, now = Date.now()): TerminalRestoreFile {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return emptyRestoreFile()
  }
  if (!isRecord(value) || value.version !== 1) return emptyRestoreFile()
  const session = value.session === null || value.session === undefined ? null : sanitizeRestoreSnapshot(value.session, now)
  const closed = (Array.isArray(value.closed) ? value.closed : [])
    .slice(-CLOSED_STACK_LIMIT)
    .map((entry) => sanitizeClosedTerminal(entry, now))
    .filter((entry): entry is ClosedTerminal => entry !== null)
  return fitFile({ version: 1, session, closed })
}

export function serializeRestoreFile(file: TerminalRestoreFile): string {
  return `${JSON.stringify(fitFile(file))}\n`
}

// ───────────────────────── 閉じたタブ ─────────────────────────

export function pushClosedTerminal(stack: readonly ClosedTerminal[], entry: ClosedTerminal, limit = CLOSED_STACK_LIMIT): ClosedTerminal[] {
  return [...stack, entry].slice(-limit)
}

/** そのプロジェクトで最後に閉じたものを取り出す。無ければ null */
export function popClosedTerminal(stack: readonly ClosedTerminal[], projectId: string | null): { entry: ClosedTerminal | null; rest: ClosedTerminal[] } {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]!.projectId === projectId) return { entry: stack[i]!, rest: [...stack.slice(0, i), ...stack.slice(i + 1)] }
  }
  return { entry: null, rest: [...stack] }
}

// ───────────────────────── 戻す ─────────────────────────

/**
 * 終了したときのタブのうち、戻すもの。登録を外したプロジェクトのタブは戻さない
 * （プロジェクトでないフォルダ＝ projectId が null のタブは戻す）
 */
export function planSessionRestore(snapshot: TerminalRestoreSnapshot | null, projectIds: ReadonlySet<string>): TerminalRestoreSnapshot | null {
  if (!snapshot) return null
  const tabs = snapshot.tabs.filter((tab) => tab.projectId === null || projectIds.has(tab.projectId))
  if (tabs.length === 0) return null
  const keep = new Set(tabs.flatMap((tab) => restoreLeafIds(tab.layout)))
  const tabKeys = new Set(tabs.map((tab) => tab.key))
  const activeByProject = Object.fromEntries(Object.entries(snapshot.activeByProject).filter(([, key]) => key !== null && tabKeys.has(key)))
  return { ...snapshot, tabs, panes: snapshot.panes.filter((pane) => keep.has(pane.key)), activeByProject }
}

interface ResumeCandidate {
  key: string
  launch: TuiAgent | null
  cwd: string | null
  accountId: string | null
}

/**
 * 会話を続けて起動するペイン。Claude Code の --continue・Codex の resume --last は「そのフォルダの最後の会話」を開くので、
 * 同じ Agent・フォルダ・アカウントのペインが複数あっても続けるのは最初の1つだけ（2つが同じ会話を続けないように）。
 * もう動いている（live）組み合わせは続けない
 */
export function panesToResume(panes: readonly ResumeCandidate[], live: ReadonlyArray<Omit<ResumeCandidate, 'key'>> = []): Set<string> {
  const id = (pane: Omit<ResumeCandidate, 'key'>) => `${pane.launch}\u0000${pane.cwd ?? ''}\u0000${pane.accountId ?? ''}`
  const taken = new Set(live.filter((pane) => pane.launch !== null).map(id))
  const resume = new Set<string>()
  for (const pane of panes) {
    if (!pane.launch || !isBuiltinAgent(pane.launch) || !RESUMABLE_AGENTS.includes(pane.launch)) continue
    if (taken.has(id(pane))) continue
    taken.add(id(pane))
    resume.add(pane.key)
  }
  return resume
}

/** Claude Code の、続ける・選び直す・別の会話を指すフラグ（これがあれば --continue を足さない） */
const CLAUDE_SESSION_FLAGS = ['-c', '--continue', '-r', '--resume', '--session-id', '--from-pr', '-p', '--print', '--teleport']

/**
 * 会話を続けて起動するための引数（Claude Code 2.1.289 の `-c, --continue`、Codex 0.160.0 の `codex resume --last`。
 * どちらも `--help` で確認。2026-10）。lead は実行ファイルのすぐ後ろ、trail は最後に足す。続けられなければ null
 *
 * @param commandTail 設定のコマンドの欄の、実行ファイルより後ろの語（サブコマンド）
 * @param args 権限の引数を含む、残りの引数
 */
export function resumeArgs(agent: TuiAgent, commandTail: readonly string[], args: readonly string[]): { lead: string[]; trail: string[] } | null {
  if (agent === 'claude') {
    const words = [...commandTail, ...args]
    if (words.some((word) => CLAUDE_SESSION_FLAGS.includes(word) || CLAUDE_SESSION_FLAGS.some((flag) => flag.startsWith('--') && word.startsWith(`${flag}=`)))) return null
    return { lead: [], trail: ['--continue'] }
  }
  if (agent === 'codex') {
    // サブコマンドを書いていれば（codex exec など）、resume を差し込めない
    if (commandTail.length > 0) return null
    if (args.some((word) => !word.startsWith('-') && ['resume', 'exec', 'e', 'fork', 'review'].includes(word))) return null
    return { lead: ['resume', '--last'], trail: [] }
  }
  return null
}

/** Claude Code が会話を置くフォルダの名前（~/.claude/projects/<これ>）。英数字以外を - にする */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** 区切りの行に出す日時（手元の時刻。YYYY-MM-DD HH:mm） */
export function formatRestoreTime(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * xterm に書く文字。前の文字（制御文字は落とす）のあとに、薄い色の区切りの行を出す。
 * 前の文字が無ければ区切りだけ
 */
export function restoreReplayText(scrollback: string, banner: string): string {
  const text = capScrollback(scrollback)
  const body = text ? `${text.split('\n').join('\r\n')}\r\n` : ''
  return `${body}\u001b[0m\u001b[2m${stripControls(banner).replace(/\n/g, ' ')}\u001b[0m\r\n`
}

/**
 * 覚えたタブ・ペインのキーを、今の画面のキーと重ならない新しいものに付け替える（前回のキーは今回のものと重なりうる）
 */
export function remapRestoreKeys(
  input: { tabs: readonly RestoreTab[]; panes: readonly RestorePane[]; activeByProject?: Record<string, string | null> },
  newKey: (kind: 'tab' | 'pane') => string
): { tabs: RestoreTab[]; panes: RestorePane[]; activeByProject: Record<string, string | null> } {
  const paneKeys = new Map(input.panes.map((pane) => [pane.key, newKey('pane')]))
  const tabKeys = new Map(input.tabs.map((tab) => [tab.key, newKey('tab')]))
  const relayout = (node: RestoreLayout): RestoreLayout =>
    node.type === 'leaf'
      ? { type: 'leaf', leafId: paneKeys.get(node.leafId) ?? node.leafId }
      : { ...node, first: relayout(node.first), second: relayout(node.second) }
  return {
    tabs: input.tabs.map((tab) => ({ ...tab, key: tabKeys.get(tab.key)!, layout: relayout(tab.layout), activePane: paneKeys.get(tab.activePane) ?? tab.activePane })),
    panes: input.panes.map((pane) => ({ ...pane, key: paneKeys.get(pane.key)! })),
    activeByProject: Object.fromEntries(
      Object.entries(input.activeByProject ?? {}).flatMap(([project, key]) => (key && tabKeys.has(key) ? [[project, tabKeys.get(key)!]] : []))
    )
  }
}
