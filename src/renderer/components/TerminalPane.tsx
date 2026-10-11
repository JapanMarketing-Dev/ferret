import { foregroundAgentOf, isReopenTerminalKey } from '../terminal/terminalKeys'
import { hasExternalFiles, readDrop } from '../lib/externalDrop'
import { shellPathsText, shellQuotingFor, treePathsForTerminal } from '@shared/externalDrop'
import { hasTreePaths, treeDragPaths } from '../lib/treeDrag'
import { droppedProjectPath, hasProjectDrag } from '../lib/projectDrag'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Columns2, Plus, Rows2, SquareTerminal, X } from 'lucide-react'
import { TUI_AGENT_LABEL, type AccountLoginRequest, type AgentOption, type Project, type TuiAgent } from '@shared/types'
import { SHORTCUTS, formatShortcut } from '../lib/shortcut'
import { Button, EmptyState, IconTile } from '../ui'
import { acquireTerminal, getTerminal, holdPtyResize, releaseTerminal } from '../terminal/terminalClient'
import { hasBusyAgent, publishAgentActivity } from '../terminal/agentActivity'
import { AttentionThrottle, INITIAL_TRACK, advancePaneState, attentionEvents, type AttentionPane, type PaneTrack } from '../terminal/agentAttention'
import { onAccountLoginRequest } from '../lib/accountLogin'
import { SpawnQueue, partitionSpawns, type SpawnCandidate } from '../terminal/spawnQueue'
import { panesDueForPoll } from '../terminal/pollSchedule'
import { onTerminalCommandRequest } from '../lib/terminalCommand'
import { onAgentLaunchRequest } from '../lib/agentLaunchRequest'
import type { TerminalPreset } from '@shared/codexAudit'
import {
  ACTIVE_PANE_OPACITY,
  DIVIDER_HIT_PADDING_PX,
  hasLeaf,
  DIVIDER_THICKNESS_PX,
  INACTIVE_PANE_OPACITY,
  leaf,
  leafIds,
  neighborLeaf,
  ratioFromDrag,
  removeLeaf,
  resolvePaneDropZone,
  resolveRootEdge,
  setRatio,
  splitLeaf,
  type PaneNode,
  type PanePath,
  type PaneSplitDirection
} from '../terminal/paneTree'
import { AgentIcon } from './AgentIcon'
import { useT } from '../lib/i18n'
import { t as tNow, type TranslationKey } from '@shared/i18n'
import { QuickLaunchButton, type QuickLaunchAgent, type QuickLaunchSearch } from './QuickLaunchButton'
import { agentLabel } from '@shared/agentCatalog'
import { applyTerminalDrop, type TerminalDragSource, type TerminalDropTarget } from '../terminal/paneDrop'
import {
  TERMINAL_SNAPSHOT_KEY,
  buildTerminalSnapshot,
  dropRestoredPanes,
  maxKeySeq,
  parseTerminalSnapshot,
  planTerminalRestore,
  type TerminalSnapshot
} from '../terminal/restorePlan'
import { reportHandled } from '@shared/report'
import { errorMessage } from '../lib/errors'
import {
  formatRestoreTime,
  panesToResume,
  remapRestoreKeys,
  restoreReplayText,
  type RestorePane,
  type RestoreTab,
  type TerminalRestoreSnapshot
} from '@shared/terminalRestore'

/**
 * 内蔵ターミナル（WS-4）。タブで複数のシェルを開き、閉じられる。
 *
 * xterm のインスタンスは terminalClient が持ち、ここは「どのタブ・ペインを見せるか」と
 * リサイズの追従だけを担う。非表示のペインは寸法が0になるので fit は見えているペインにだけ行う。
 *
 * タブはプロジェクトごとに分ける（Orcaのワークスペースごとのタブと同じ）。表示中のプロジェクトの
 * タブだけを見せ、別のプロジェクトへ切り替えても裏のPTY・Agentと分割の形は止めずに生かしておく。
 * 初めて開いたプロジェクトでは、設定の startupAgents の順にAgentタブを自動で開く。
 *
 * 1つのタブの中は、Orca と同じく左右・上下に何度でも分割できる（⌘D で右、⌘⇧D で下）。
 * ペインごとに別のPTYで、「Agentへ送信」の宛先はフォーカス中のペインになる。
 * タブ（分割中ならペインのつまみ）をドラッグして、ペインの辺に落とすと分割、中央かタブ列に落とすとタブになる
 * （組み替えは terminal/paneDrop.ts。ペインのキーに PTY が結びついているので、動かしても作り直さない）。
 * Orca由来: ~/bench/orca/src/renderer/src/components/terminal-pane/terminal-shortcut-policy.ts,
 *           ~/bench/orca/src/shared/keybindings/definitions-core-4.ts,
 *           ~/bench/orca/src/renderer/src/lib/pane-manager/pane-divider.ts,
 *           ~/bench/orca/src/renderer/src/lib/pane-manager/pane-divider-drag.ts（MIT, Copyright 2026 Lovecast Inc.）
 */

/**
 * Agent の状態（04_benchmark 4.1-13 / herdr の seen フラグ）。
 *
 * 要点は done と idle を分けること。「終わった」のではなく
 * 「終わったのに、まだこちらが気づいていない」を表せる。
 * フィードバックモードで録画している間に Agent が終わった場合、
 * モードを戻した瞬間にそれが分かる。
 * 検知の実装は後続。ここでは印の見た目と置き場所を用意する。
 */
export type AgentState = 'working' | 'blocked' | 'done' | 'idle' | 'unknown'

const AGENT_STATE_LABEL: Record<AgentState, TranslationKey> = {
  working: 'terminal.state.working',
  blocked: 'terminal.state.blocked',
  done: 'terminal.state.done',
  idle: 'terminal.state.idle',
  unknown: 'terminal.state.unknown'
}

/** 分割したタブの印に出す順。気づいてほしいものほど先 */
const STATE_PRIORITY: AgentState[] = ['blocked', 'done', 'working', 'idle', 'unknown']

/** 1つのペイン（＝1つのPTY） */
interface Pane {
  key: string
  title: string
  /** Agentの状態（検知結果） */
  state: AgentState
  /** 起動したAgent。素のシェルなら null */
  launch: TuiAgent | null
  /** 起動時のカレント。省略時は main 側で開いているプロジェクトのフォルダ */
  cwd: string | null
  /** アカウント追加・再ログインのためのタブ（`claude auth login` などを起動する） */
  accountLogin?: AccountLoginRequest | null
  /** シェル起動後に実行する1行（設定の GitHub 節の `gh auth login` など） */
  command?: string | null
  /** 依頼元が決めたタブ名 */
  customTitle?: string | null
  /** プロジェクトを開いたときの自動起動。main は権限確認を省く引数を付けない（security-3 [1]） */
  autoStart?: boolean
  /** 上限での自動切り替えで開くタブ（main の failover:launch の token） */
  failoverToken?: string | null
  /** Agent どうしの依頼で開くタブ（main の agentMail:launch の token） */
  agentMailToken?: string
  /** 決まった起動（@shared/codexAudit）。開くときに1回だけ使う */
  preset?: TerminalPreset
  /** 起動したアカウント（Claude Code / Codex。main の返事）。null はシステムの既定。戻したタブではこのアカウントで開く */
  accountId?: string | null
  /** 戻したタブ: 前の会話を続けて起動する（@shared/terminalRestore の panesToResume） */
  resume?: boolean
  /** 戻したタブ: 閉じたとき作業の途中だった。起動したら続きから再開するよう Agent に頼む（main の terminal:continueWork） */
  continueWork?: boolean
  /** 戻したタブ: PTY を作る前に xterm に書く、前の画面の文字と区切りの行 */
  restoreText?: string | null
  /** 戻したタブ: まだ xterm を作っていない間に、覚え直すときに使う前の画面の文字 */
  savedScrollback?: string | null
}

/** 終了・閉じたあとに戻すペイン。アカウントのログインと1回きりのコマンド（gh auth login など）は戻さない */
function isRestorable(pane: Pane): boolean {
  return !pane.accountLogin && !pane.command
}

function toRestorePane(pane: Pane, scrollback: string): RestorePane {
  // 作業の途中（実行中・確認待ち）か。戻したばかりでまだ状態が分からないペインは、前の印を引き継ぐ
  const working = pane.launch && (pane.state === 'working' || pane.state === 'blocked' || (pane.state === 'unknown' && pane.continueWork))
  return { key: pane.key, title: pane.title, launch: pane.launch, cwd: pane.cwd, accountId: pane.accountId ?? null, scrollback, ...(working ? { working: true as const } : {}) }
}

/** 覚えていたペインから、戻すペインを作る（前の画面の文字を書いてから PTY を作る） */
function paneFromRestore(saved: RestorePane, banner: string, resume: boolean): Pane {
  return {
    key: saved.key,
    title: saved.title || (saved.launch ? agentLabel(saved.launch) : tNow('terminal.shell')),
    state: 'unknown',
    launch: saved.launch,
    cwd: saved.cwd,
    accountId: saved.accountId,
    resume,
    ...(resume && saved.working ? { continueWork: true } : {}),
    restoreText: restoreReplayText(saved.scrollback, banner),
    savedScrollback: saved.scrollback
  }
}

/**
 * 戻すときの今のスクロールバックを、変わったときだけ取り出し直す間隔。取り出しは全ペインの画面の文字を読むので重い。
 * タブを開いた・閉じた・切り替えたときと終了の直前（terminal:restoreCollect）は、この間隔を待たずに送る
 */
const RESTORE_PUSH_MS = 60_000

/** 閉じたターミナルを開き直すキーの表示 */
function reopenShortcut(): string {
  return globalThis.window?.ade?.platform === 'darwin' ? formatShortcut('Mod', 'Shift', 'T') : formatShortcut('Ctrl', 'Shift', 'T')
}

interface Tab {
  key: string
  /** どのプロジェクトのタブか。プロジェクト未登録のフォルダなら null */
  projectId: string | null
  /** ペインの分割の形 */
  layout: PaneNode
  /** フォーカス中のペイン */
  activePane: string
}

/** 寸法が測れない（非表示の）ペインを作るときの大きさ。表示したときに合わせ直す */
const FALLBACK_SIZE = { cols: 80, rows: 24 }
/** ターミナルのタブをドラッグするときのデータの種類（中央のタブ 'application/x-ade-center-tab' とは別） */
const TAB_DRAG_TYPE = 'application/x-ade-terminal-tab'
/** 分割中のペインのつまみをドラッグするときのデータの種類（パネルの移動・ファイルのドロップとも別） */
const PANE_DRAG_TYPE = 'application/x-ade-terminal-pane'
/** ドラッグ中に落とす先の案内（.terminal-surfaces の中の位置） */
interface DropHint {
  target: TerminalDropTarget
  box: { left: number; top: number; width: number; height: number }
}
function isTerminalDrag(e: React.DragEvent): boolean {
  return e.dataTransfer.types.includes(TAB_DRAG_TYPE) || e.dataTransfer.types.includes(PANE_DRAG_TYPE)
}
function dropLabel(target: TerminalDropTarget): TranslationKey {
  if (target.kind === 'tabbar') return 'terminal.drop.tabbar'
  if (target.kind === 'root') {
    return ({ left: 'terminal.drop.rootLeft', right: 'terminal.drop.rootRight', top: 'terminal.drop.rootTop', bottom: 'terminal.drop.rootBottom' } as const)[target.edge]
  }
  return `terminal.drop.${target.zone}` as const
}
/** Resource Manager（フッター）から、そのターミナルのタブへ移るよう頼むイベント。detail は { id: ptyId } */
const FOCUS_TERMINAL_EVENT = 'ade:focus-terminal'
/** 通知が入のとき、裏で状態を読む間隔（秒）。表では 1 秒ごと */
const BACKGROUND_POLL_EVERY = 5
/** 分割元のカレントを調べるのを待つ上限。macOS の lsof は初回だけ遅いことがある（Orca と同じ値） */
const SPLIT_CWD_TIMEOUT_MS = 1000
/** 区切り線の掴める幅（見える線 ＋ 両側の余白） */
const DIVIDER_HIT_SIZE = DIVIDER_THICKNESS_PX + DIVIDER_HIT_PADDING_PX * 2

let tabSeq = 0
let paneSeq = 0

interface PaneSpec {
  launch?: TuiAgent | null
  cwd: string | null
  accountLogin?: AccountLoginRequest | null
  command?: string | null
  title?: string | null
  autoStart?: boolean
  failoverToken?: string | null
  agentMailToken?: string | null
  preset?: TerminalPreset | null
}

function newPane({ launch = null, cwd, accountLogin = null, command = null, title = null, autoStart = false, failoverToken = null, agentMailToken = null, preset = null }: PaneSpec): Pane {
  const label =
    title ||
    (accountLogin ? tNow('terminal.loginTitle', { agent: TUI_AGENT_LABEL[accountLogin.agent] }) : launch ? agentLabel(launch) : tNow('terminal.shell'))
  return { key: `pane${++paneSeq}`, title: label, state: 'unknown', launch, cwd, accountLogin, command, customTitle: title, autoStart, failoverToken, ...(agentMailToken ? { agentMailToken } : {}), ...(preset ? { preset } : {}) }
}

/** 読み込み直しの前に書いた記録（同じウインドウの読み込み直しでは残る sessionStorage）。読めなければ null */
function readSnapshot(): string | null {
  try {
    return window.sessionStorage.getItem(TERMINAL_SNAPSHOT_KEY)
  } catch {
    // ストレージが使えない環境（想定内。main の一覧から戻せる）
    return null
  }
}

function writeSnapshot(snapshot: TerminalSnapshot): void {
  try {
    window.sessionStorage.setItem(TERMINAL_SNAPSHOT_KEY, JSON.stringify(snapshot))
  } catch {
    /* 書けなくても、main の一覧から戻せる */
  }
}

/** fs:search の結果からファイルの相対パスだけを取り出す（ファイル名の検索） */
async function searchFileNames(query: string): Promise<string[]> {
  const result = await window.ade.invoke('fs:search', query, 'names')
  return result.files
}

/** Orca と同じ割り当て。macOS は ⌘D / ⌘⇧D、それ以外は Ctrl+Shift+D / Alt+Shift+D */
function splitShortcut(direction: PaneSplitDirection): string {
  const mac = globalThis.window?.ade?.platform === 'darwin'
  if (direction === 'vertical') return mac ? formatShortcut('Mod', 'D') : formatShortcut('Ctrl', 'Shift', 'D')
  return mac ? formatShortcut('Mod', 'Shift', 'D') : formatShortcut('Alt', 'Shift', 'D')
}

/**
 * ⌘D / ⌘⇧D（Orca と同じ割り当て）。ターミナルにフォーカスがあるときだけ効かせる
 * （Orca の terminal-shortcut-policy と同じ。エディタの ⌘D を奪わない）
 */
function splitDirectionForKey(event: React.KeyboardEvent): PaneSplitDirection | null {
  if (event.code !== 'KeyD') return null
  if (window.ade.platform === 'darwin') {
    if (!event.metaKey || event.ctrlKey || event.altKey) return null
    return event.shiftKey ? 'horizontal' : 'vertical'
  }
  if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey) return 'vertical'
  if (event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey) return 'horizontal'
  return null
}

/**
 * ⌘W をターミナル以外（エディタなど）に譲るためのイベント。⌘W はメニューが受けるので、
 * ターミナルにフォーカスが無いときはこれを投げ、だれかが preventDefault() したらターミナルは閉じない
 */
export const CLOSE_REQUEST_EVENT = 'ade:close-request'

export function TerminalPane({
  layoutKey,
  onReady,
  commandRef,
  onActiveTerminal,
  projectId = null,
  cwd = null,
  startupAgents = [],
  onOpenAgentSettings,
  onOpenFile,
  notify = false,
  restore = true
}: {
  /** 分割幅など、レイアウトが変わったことを知らせる値 */
  layoutKey: string
  onReady?: () => void
  /** フォーカス中のペインのPTY（「Agentへ送信」の宛先） */
  onActiveTerminal?: (id: string | null) => void
  /** メニュー（ショートカット）からタブ操作を呼べるようにする窓口 */
  commandRef?: React.RefObject<{ add: () => void; close: () => void; reopen: () => void } | null>
  /** 表示中のプロジェクト。タブはこれごとに分かれる */
  projectId?: string | null
  /** 新しいタブのカレント（プロジェクトのフォルダ） */
  cwd?: string | null
  /** 初めて開いたプロジェクトで自動で開くAgent（順序どおり）。空なら素のシェル1つ */
  startupAgents?: TuiAgent[]
  /** 「＋」メニューの「Agent設定…」。渡されたときだけ出す */
  onOpenAgentSettings?: () => void
  /** 「＋」の検索でファイルを選んだとき（エディタで開く）。渡されたときだけファイルを検索する */
  onOpenFile?: (path: string) => void
  /** Agent が終わった・確認を待っているときに OS の通知を出す（設定の agents.notify） */
  notify?: boolean
  /** タブと画面の文字を覚えて、終了・閉じたあとに戻す（設定の agents.restoreTerminals） */
  restore?: boolean
}) {
  const sectionRef = useRef<HTMLElement | null>(null)
  const t = useT()
  const [tabs, setTabs] = useState<Tab[]>([])
  const [panes, setPanes] = useState<Record<string, Pane>>({})
  /** プロジェクトごとの選択中タブ。切り替えて戻ったときに同じタブを見せる */
  const [activeByProject, setActiveByProject] = useState<Record<string, string | null>>({})
  /** ペインの描画先（xterm の器を入れる場所） */
  const nodesRef = useRef(new Map<string, HTMLDivElement>())
  const leafRefs = useRef(new Map<string, (node: HTMLDivElement | null) => void>())
  /** 一度でもタブを開いたプロジェクト。全部閉じても自動では開き直さない */
  const seededRef = useRef(new Set<string>())
  /** PTYを作り始めたペイン。終了したペインを勝手に作り直さないよう、1ペイン1回だけ */
  const spawnedRef = useRef(new Set<string>())
  /**
   * 画面を読み込み直したあとの、生きているターミナルへのつなぎ直しが済んだか。
   * 済むまでは、初めて開いたプロジェクトのタブの自動作成を待つ（作ってしまうと PTY が重なる）
   */
  const [restored, setRestored] = useState(false)
  const panesRef = useRef(panes)
  panesRef.current = panes

  const projectKey = projectId ?? ''
  const visibleTabs = useMemo(
    () => tabs.filter((tab) => (tab.projectId ?? '') === projectKey),
    [tabs, projectKey]
  )
  const activeKey = activeByProject[projectKey] ?? null
  const activeTab = visibleTabs.find((tab) => tab.key === activeKey) ?? null
  const focusedPane = activeTab?.activePane ?? null
  const focusedPaneRef = useRef(focusedPane)
  focusedPaneRef.current = focusedPane

  const setActiveKey = useCallback(
    (key: string | null) => setActiveByProject((prev) => ({ ...prev, [projectKey]: key })),
    [projectKey]
  )

  /**
   * 寸法を合わせ、PTYにも伝える。器の大きさの変化は TerminalHandle が自分で追うので、
   * ここは表示を切り替えた直後など、念のため合わせ直したいときだけ呼ぶ（非表示なら何もしない）
   */
  const fitPane = useCallback((key: string) => {
    getTerminal(key)?.scheduleFit()
  }, [])

  const fitVisible = useCallback(() => {
    if (!activeTab) return
    for (const key of leafIds(activeTab.layout)) fitPane(key)
  }, [activeTab, fitPane])

  /**
   * ペインの描画先を登録する。分割で木の形が変わるとDOMが作り直されるので、
   * そのたびに xterm の器を新しい場所へ移す。キーごとに同じ関数を返し、毎回の描画で付け外ししない
   */
  const leafRef = useCallback((key: string) => {
    let ref = leafRefs.current.get(key)
    if (!ref) {
      ref = (node) => {
        const previous = nodesRef.current.get(key)
        if (!node) {
          if (nodesRef.current.get(key) === previous) nodesRef.current.delete(key)
          return
        }
        nodesRef.current.set(key, node)
        getTerminal(key)?.open(node)
      }
      leafRefs.current.set(key, ref)
    }
    return ref
  }, [])

  const releasePane = useCallback((key: string) => {
    releaseTerminal(key)
    nodesRef.current.delete(key)
    leafRefs.current.delete(key)
    spawnedRef.current.delete(key)
  }, [])

  /** タブを開く。agent を渡すとそのAgentが起動した状態のタブになる */
  const addTab = useCallback(
    (launch: TuiAgent | null = null, extra: Omit<PaneSpec, 'launch' | 'cwd'> & { cwd?: string | null } = {}) => {
      const pane = newPane({ ...extra, launch, cwd: extra.cwd ?? cwd })
      const key = `tab${++tabSeq}`
      setPanes((prev) => ({ ...prev, [pane.key]: pane }))
      setTabs((prev) => [...prev, { key, projectId, layout: leaf(pane.key), activePane: pane.key }])
      setActiveKey(key)
    },
    [projectId, cwd, setActiveKey]
  )

  /**
   * フォーカス中のペインを分割し、新しいペインを右（下）に置いてフォーカスを移す。
   * 新しいペインのカレントは、分割元のシェルの「今の」カレント（cd した先。Orca の
   * terminal-pane-split-with-inherited-cwd / resolve-split-cwd と同じ）。調べられなければ起動時のカレント
   */
  const splitPane = useCallback(
    async (direction: PaneSplitDirection, launch: TuiAgent | null = null) => {
      if (!activeTab) return
      const tabKey = activeTab.key
      const sourceKey = activeTab.activePane
      const source = panesRef.current[sourceKey]
      const ptyId = getTerminal(sourceKey)?.ptyId ?? null
      const live = ptyId
        ? await Promise.race([
            // 終了済みのターミナル（想定内。プロジェクトのフォルダで開く）
      window.ade.invoke('terminal:cwd', ptyId).catch(() => null),
            new Promise<null>((done) => setTimeout(() => done(null), SPLIT_CWD_TIMEOUT_MS))
          ])
        : null
      const pane = newPane({ launch, cwd: live || source?.cwd || cwd })
      setPanes((prev) => ({ ...prev, [pane.key]: pane }))
      setTabs((prev) =>
        prev.map((tab) =>
          tab.key === tabKey && hasLeaf(tab.layout, sourceKey)
            ? { ...tab, layout: splitLeaf(tab.layout, sourceKey, direction, pane.key), activePane: pane.key }
            : tab
        )
      )
    },
    [activeTab, cwd]
  )

  const focusPane = useCallback((tabKey: string, paneKey: string) => {
    setTabs((prev) =>
      prev.some((tab) => tab.key === tabKey && tab.activePane !== paneKey)
        ? prev.map((tab) => (tab.key === tabKey ? { ...tab, activePane: paneKey } : tab))
        : prev
    )
  }, [])

  /**
   * 利用者が閉じたタブ（またはペイン）を、開き直せるように main へ渡す。xterm を捨てる前に画面の文字を取り出す。
   * keys がタブのペインすべてならタブの分割の形のまま、1つならそのペインだけのタブとして覚える
   */
  const restoreRef = useRef(restore)
  restoreRef.current = restore
  const rememberClosed = useCallback((tab: Tab, keys: string[]) => {
    if (!restoreRef.current) return
    const kept = keys.filter((key) => {
      const pane = panesRef.current[key]
      return pane !== undefined && isRestorable(pane)
    })
    if (kept.length === 0) return
    let layout: PaneNode | null = keys.length === leafIds(tab.layout).length ? tab.layout : leaf(kept[0]!)
    for (const key of keys) if (layout && !kept.includes(key)) layout = removeLeaf(layout, key)
    if (!layout) return
    const remaining = leafIds(layout)
    const panes = remaining.map((key) => toRestorePane(panesRef.current[key]!, getTerminal(key)?.scrollbackText() ?? panesRef.current[key]!.savedScrollback ?? ''))
    void window.ade.invoke('terminal:closedPush', {
      projectId: tab.projectId,
      tab: { key: tab.key, projectId: tab.projectId, layout, activePane: remaining.includes(tab.activePane) ? tab.activePane : remaining[0]! },
      panes,
      closedAt: Date.now()
    }).catch((err: unknown) => reportHandled(err, { area: 'terminal', op: 'remember closed terminal' }))
  }, [])

  const closeTab = useCallback(
    (key: string, remember = true) => {
      const tab = tabs.find((t) => t.key === key)
      if (!tab) return
      const keys = leafIds(tab.layout)
      if (remember) rememberClosed(tab, keys)
      for (const paneKey of keys) releasePane(paneKey)
      // 更新関数の中で別の state を更新しない（Reactが更新を捨てることがある）。
      // 選択中のタブを閉じたときの移動は、下の effect に任せる。
      setTabs((prev) => prev.filter((t) => t.key !== key))
      setPanes((prev) => {
        const next = { ...prev }
        for (const paneKey of keys) delete next[paneKey]
        return next
      })
    },
    [tabs, releasePane, rememberClosed]
  )

  /**
   * 利用者が閉じる（× や ⌘W）とき、Agent が作業中・確認待ちのペインがあれば確かめる。
   * 確認なしに閉じると、動いている Agent ごと止まり作業が失われる（Orca #14817 #24426）
   */
  const confirmCloseRunning = useCallback((keys: string[]) => {
    return !hasBusyAgent(keys.map((key) => panes[key]?.state)) || window.confirm(tNow('terminal.confirmCloseRunning'))
  }, [panes])

  /** ペインを閉じる。最後の1枚ならタブごと閉じる（Orca の closeActivePane と同じ） */
  const closePane = useCallback(
    (tabKey: string, paneKey: string, remember = true) => {
      const tab = tabs.find((t) => t.key === tabKey)
      if (!tab) return
      const layout = removeLeaf(tab.layout, paneKey)
      if (!layout) {
        closeTab(tabKey, remember)
        return
      }
      if (remember) rememberClosed(tab, [paneKey])
      releasePane(paneKey)
      const nextActive = tab.activePane === paneKey ? (neighborLeaf(tab.layout, paneKey) ?? leafIds(layout)[0]!) : tab.activePane
      setTabs((prev) => prev.map((t) => (t.key === tabKey ? { ...t, layout, activePane: nextActive } : t)))
      setPanes((prev) => {
        const next = { ...prev }
        delete next[paneKey]
        return next
      })
    },
    [tabs, closeTab, releasePane, rememberClosed]
  )

  /** 区画の右クリックのメニュー（右に分割・下に分割・区画を閉じる） */
  const [paneMenu, setPaneMenu] = useState<{ x: number; y: number; tabKey: string; paneKey: string; split: boolean } | null>(null)

  const setSplitRatio = useCallback((tabKey: string, path: PanePath, ratio: number) => {
    setTabs((prev) => prev.map((tab) => (tab.key === tabKey ? { ...tab, layout: setRatio(tab.layout, path, ratio) } : tab)))
  }, [])

  // アカウントの追加・再ログインの依頼が来たら、ログイン用のタブを開いて選択する
  const addTabRef = useRef(addTab)
  addTabRef.current = addTab
  useEffect(() => onAccountLoginRequest((req) => addTabRef.current(null, { accountLogin: req })), [])
  // 「新しいタブでこの1行を実行して」の依頼（設定の GitHub 節の `gh auth login` など）。
  // コマンドは Agent と同じく、シェルの最初のプロンプトで実行させる（main の起動ファイルの仕組み）
  useEffect(
    () => onTerminalCommandRequest((req) => addTabRef.current(null, { command: req.command || null, title: req.title ?? null, cwd: req.cwd ?? null })),
    []
  )
  // 「Agentへ送信」でどこにも Agent が居なかったとき、既定の Agent のタブを開く（ReviewFindings）
  useEffect(() => onAgentLaunchRequest((agent, preset) => addTabRef.current(agent, preset ? { preset } : {})), [])

  // メニューの「右に分割／下に分割」をクリックしたとき（キーは下の onKeyDownCapture が拾う）
  const splitPaneRef = useRef<(direction: PaneSplitDirection) => void>(() => undefined)
  splitPaneRef.current = (direction) => void splitPane(direction)
  useEffect(
    () =>
      window.ade.on('menu:command', (command) => {
        if (command === 'splitTerminalRight') splitPaneRef.current('vertical')
        if (command === 'splitTerminalDown') splitPaneRef.current('horizontal')
      }),
    []
  )

  // Resource Manager の行から、そのターミナル（main の id ＝ ptyId）のタブへ移る
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  useEffect(() => {
    const onFocusTerminal = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (!id) return
      const paneKey = Object.keys(panesRef.current).find((key) => getTerminal(key)?.ptyId === id)
      const tab = paneKey ? tabsRef.current.find((t) => hasLeaf(t.layout, paneKey)) : undefined
      if (!paneKey || !tab) return
      setActiveByProject((prev) => ({ ...prev, [tab.projectId ?? '']: tab.key }))
      focusPane(tab.key, paneKey)
    }
    window.addEventListener(FOCUS_TERMINAL_EVENT, onFocusTerminal)
    return () => window.removeEventListener(FOCUS_TERMINAL_EVENT, onFocusTerminal)
  }, [focusPane])

  // 上限での自動切り替え（main の failover/service.ts）。上限になったタブと同じプロジェクトに、引き継ぐ Agent のタブを開く。
  // 引き継げたら古いタブを閉じて（枠が戻ったとき古い Agent が同じ作業を続けないように）、新しいタブを見せる
  const closePaneRef = useRef(closePane)
  closePaneRef.current = closePane
  useEffect(() => {
    const paneOf = (ptyId: string) => {
      const paneKey = Object.keys(panesRef.current).find((key) => getTerminal(key)?.ptyId === ptyId)
      const tab = paneKey ? tabsRef.current.find((t) => hasLeaf(t.layout, paneKey)) : undefined
      return paneKey && tab ? { paneKey, tab } : null
    }
    const offLaunch = window.ade.on('failover:launch', (request) => {
      const from = paneOf(request.fromTerminalId)
      const pane = newPane({ launch: request.agent, cwd: request.cwd, failoverToken: request.token })
      const key = `tab${++tabSeq}`
      const tabProject = from ? from.tab.projectId : projectId
      setPanes((prev) => ({ ...prev, [pane.key]: pane }))
      setTabs((prev) => {
        const tab = { key, projectId: tabProject, layout: leaf(pane.key), activePane: pane.key }
        const at = from ? prev.findIndex((t) => t.key === from.tab.key) : -1
        return at >= 0 ? [...prev.slice(0, at + 1), tab, ...prev.slice(at + 1)] : [...prev, tab]
      })
    })
    const offNotice = window.ade.on('failover:notice', (notice) => {
      if (notice.fromTerminalId && notice.toTerminalId) {
        const from = paneOf(notice.fromTerminalId)
        // 引き継いだ古いタブは、閉じたタブとして覚えない（開き直すと上限の Agent に戻ってしまう）
        if (from) closePaneRef.current(from.tab.key, from.paneKey, false)
      }
      if (notice.toTerminalId) window.dispatchEvent(new CustomEvent(FOCUS_TERMINAL_EVENT, { detail: { id: notice.toTerminalId } }))
    })
    // Agent どうしの依頼: 宛先の Agent が居ないので、送り手のペインを上下に分けて開く（送り手も相手も見える）。
    // 送り手のペインが見つからなければ（別のプロジェクトのタブなど）新しいタブで開く。フォーカスは送り手のまま
    const offMail = window.ade.on('agentMail:launch', (request) => {
      const from = paneOf(request.fromTerminalId)
      const pane = newPane({ launch: request.agent, cwd: request.cwd, agentMailToken: request.token })
      setPanes((prev) => ({ ...prev, [pane.key]: pane }))
      if (from) {
        setTabs((prev) => prev.map((tab) => (tab.key === from.tab.key && hasLeaf(tab.layout, from.paneKey)
          ? { ...tab, layout: splitLeaf(tab.layout, from.paneKey, 'horizontal', pane.key) }
          : tab)))
        return
      }
      setTabs((prev) => [...prev, { key: `tab${++tabSeq}`, projectId, layout: leaf(pane.key), activePane: pane.key }])
    })
    return () => { offLaunch(); offNotice(); offMail() }
  }, [projectId])

  // 「＋」の検索に出す登録URL（全プロジェクト分）
  // 「＋」と分割のメニューに出すエージェント。Orca と同じく、インストール済みか登録したもので、無効にしていないもの
  const [agentOptions, setAgentOptions] = useState<AgentOption[]>([])
  useEffect(() => {
    let stopped = false
    void window.ade
      .invoke('agents:list')
      .then((options) => {
        if (!stopped) setAgentOptions(options)
      })
      // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
      .catch(() => undefined)
    const off = window.ade.on('agents:changed', setAgentOptions)
    return () => {
      stopped = true
      off()
    }
  }, [])
  const menuAgents = useMemo<QuickLaunchAgent[]>(
    // カスタムは書きかけ（コマンドが空）のあいだは出さない
    () =>
      agentOptions
        .filter((o) => o.enabled && (o.installed || (o.custom && o.command.trim() !== '')))
        .map((o) => ({ id: o.id, label: o.label, ...(o.icon ? { icon: o.icon } : {}) })),
    [agentOptions]
  )
  const agentOptionsRef = useRef(agentOptions)
  agentOptionsRef.current = agentOptions

  const [projects, setProjects] = useState<Project[]>([])
  useEffect(() => {
    let stopped = false
    void window.ade
      .invoke('project:list')
      .then((state) => {
        if (!stopped) setProjects(state.projects)
      })
      // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）
      .catch(() => undefined)
    const off = window.ade.on('projects:changed', (state) => setProjects(state.projects))
    return () => {
      stopped = true
      off()
    }
  }, [])

  // 閉じたタブが選択中だったら、表示中のプロジェクトに残っている最後のタブへ移る
  useEffect(() => {
    if (activeKey !== null && visibleTabs.some((tab) => tab.key === activeKey)) return
    const next = visibleTabs.length > 0 ? (visibleTabs[visibleTabs.length - 1]?.key ?? null) : null
    if (next !== activeKey) setActiveKey(next)
  }, [visibleTabs, activeKey, setActiveKey])

  // 初めて開いたプロジェクトでは、startupAgents の順にAgentタブを開く（空なら素のシェル1つ）。
  // 最初のタブを選択状態にする
  useEffect(() => {
    if (!restored || seededRef.current.has(projectKey)) return
    seededRef.current.add(projectKey)
    if (visibleTabs.length > 0) return
    // 無効にしたエージェントは開かない（一覧がまだ届いていなければそのまま）
    const disabled = new Set(agentOptionsRef.current.filter((o) => !o.enabled).map((o) => o.id))
    const enabledStartup = startupAgents.filter((agent) => !disabled.has(agent))
    // プロジェクトを開いていないとき（ホームなど）はエージェントを自動で起動しない。素のシェルを1つだけ開く。
    // 登録したプロジェクトでだけ起動する。自動起動は普通の（権限確認のある）起動で、フォルダの信頼は
    // 利用者が設定で許したプロジェクトにだけ main が書く（security-3 [1]。登録＝信頼とはみなさない）
    const launches: Array<TuiAgent | null> = projectId && enabledStartup.length > 0 ? enabledStartup : [null]
    const created = launches.map((launch) => newPane({ launch, cwd, autoStart: launch !== null }))
    const createdTabs: Tab[] = created.map((pane) => ({
      key: `tab${++tabSeq}`,
      projectId,
      layout: leaf(pane.key),
      activePane: pane.key
    }))
    setPanes((prev) => ({ ...prev, ...Object.fromEntries(created.map((pane) => [pane.key, pane])) }))
    setTabs((prev) => [...prev, ...createdTabs])
    setActiveKey(createdTabs[0]?.key ?? null)
    // プロジェクトが切り替わったとき（とつなぎ直しが済んだとき）だけ動かす（設定の変更で開き直さない）
  }, [projectKey, restored])

  // 画面を読み込み直した（⌘R・HMR）あとは、main で生きているターミナルに新しく作らずつなぎ直す。
  // 読み込み直しの前に書いておいたタブ・分割の形（sessionStorage）と main の一覧を突き合わせる（restorePlan.ts）。
  // 戻す先の無いもの（登録を外したプロジェクトのものなど）だけを閉じる
  useEffect(() => {
    let stopped = false
    // アプリを起動し直したとき（生きているターミナルが無いとき）は、前に終了したときのタブを戻す（@shared/terminalRestore）。
    // タブ・分割の形・作業フォルダ・Agent とアカウントはそのまま、前の画面の文字を書いてから新しい PTY を作る。
    // Agent は会話を続けて起動する（同じ Agent・フォルダ・アカウントのタブが複数あれば最初の1つだけ）
    const restoreSavedSession = async () => {
      const saved = await window.ade.invoke('terminal:restoreTake').catch((err: unknown) => {
        reportHandled(err, { area: 'terminal', op: 'take terminal restore' })
        return null
      })
      if (stopped || !saved || saved.tabs.length === 0) return
      const mapped = remapRestoreKeys(saved, (kind) => (kind === 'tab' ? `tab${++tabSeq}` : `pane${++paneSeq}`))
      const paneByKey = new Map(mapped.panes.map((pane) => [pane.key, pane]))
      const resume = panesToResume(mapped.tabs.flatMap((tab) => leafIds(tab.layout)).flatMap((key) => paneByKey.get(key) ?? []))
      const banner = tNow('terminal.restoredSeparator', { time: formatRestoreTime(saved.savedAt) })
      setPanes((prev) => ({
        ...prev,
        ...Object.fromEntries(mapped.panes.map((pane): [string, Pane] => [pane.key, paneFromRestore(pane, banner, resume.has(pane.key))]))
      }))
      setTabs((prev) => [...prev, ...mapped.tabs])
      setActiveByProject((prev) => ({ ...mapped.activeByProject, ...prev }))
      // 戻したタブのあるプロジェクトは、もう自動でタブを作らない
      for (const tab of mapped.tabs) seededRef.current.add(tab.projectId ?? '')
    }
    void (async () => {
      try {
        const [live, projectsState] = await Promise.all([
          window.ade.invoke('terminal:list'),
          window.ade.invoke('project:list')
        ])
        if (stopped) return
        if (live.length === 0) {
          await restoreSavedSession()
          return
        }
        const snapshot = parseTerminalSnapshot(readSnapshot())
        tabSeq = Math.max(tabSeq, maxKeySeq(snapshot?.tabs.map((tab) => tab.key) ?? [], 'tab'))
        paneSeq = Math.max(paneSeq, maxKeySeq(snapshot?.panes.map((pane) => pane.key) ?? [], 'pane'))
        let plan = planTerminalRestore({
          snapshot,
          live,
          projects: projectsState.projects,
          newKey: (kind) => (kind === 'tab' ? `tab${++tabSeq}` : `pane${++paneSeq}`)
        })
        for (const id of plan.close) void window.ade.invoke('terminal:close', id)
        const attached = await Promise.all(
          plan.panes.map(async (pane) => [pane, await window.ade.invoke('terminal:attach', pane.ptyId).catch(() => null /* 終了済みの PTY（想定内） */)] as const)
        )
        if (stopped) return
        const dead = new Set(attached.filter(([, info]) => !info).map(([pane]) => pane.key))
        plan = dropRestoredPanes(plan, dead)
        for (const [pane, info] of attached) {
          if (!info) continue
          const handle = acquireTerminal(pane.key)
          spawnedRef.current.add(pane.key)
          handle.reattach(info.id, info.history, info.size)
        }
        setPanes((prev) => ({
          ...prev,
          ...Object.fromEntries(
            plan.panes.map((pane): [string, Pane] => [
              pane.key,
              { key: pane.key, title: pane.title, state: 'unknown', launch: pane.launch, cwd: pane.cwd }
            ])
          )
        }))
        setTabs((prev) => [...prev, ...plan.tabs])
        setActiveByProject((prev) => ({ ...plan.activeByProject, ...prev }))
        // 戻したタブのあるプロジェクトは、もう自動でタブを作らない
        for (const tab of plan.tabs) seededRef.current.add(tab.projectId ?? '')
      } catch (err) {
        console.warn('[terminal] 読み込み直しのあと、ターミナルにつなぎ直せませんでした', err)
        reportHandled(err, { area: 'terminal', op: 'reattach after reload' })
      } finally {
        if (!stopped) setRestored(true)
      }
    })()
    return () => {
      stopped = true
    }
  }, [])

  // 読み込み直しに備えて、タブ・分割の形と各ペインの PTY の id を書いておく
  useEffect(() => {
    if (!restored) return
    writeSnapshot(
      buildTerminalSnapshot({
        tabs,
        panes: Object.values(panes),
        ptyIdOf: (key) => getTerminal(key)?.ptyId ?? null,
        activeByProject
      })
    )
  }, [tabs, panes, activeByProject, restored])

  // 終了・閉じたあとに戻すため、タブと画面の文字を main へ送る（main が userData に書く。設定の agents.restoreTerminals）。
  // 画面の文字は、書き足されたペインだけ取り出し直す。終了の直前には main が terminal:restoreCollect で最後の分を頼む
  const activeByProjectRef = useRef(activeByProject)
  activeByProjectRef.current = activeByProject
  const restoredRef = useRef(restored)
  restoredRef.current = restored
  const scrollbackCacheRef = useRef(new Map<string, { seq: number; text: string }>())
  const lastRestoreRef = useRef('')
  const buildRestoreSnapshot = useCallback((): TerminalRestoreSnapshot => {
    const current = panesRef.current
    const restoreTabs: RestoreTab[] = []
    for (const tab of tabsRef.current) {
      let layout: PaneNode | null = tab.layout
      for (const key of leafIds(tab.layout)) {
        const pane = current[key]
        if (layout && (!pane || !isRestorable(pane))) layout = removeLeaf(layout, key)
      }
      if (!layout) continue
      const remaining = leafIds(layout)
      restoreTabs.push({ key: tab.key, projectId: tab.projectId, layout, activePane: remaining.includes(tab.activePane) ? tab.activePane : remaining[0]! })
    }
    const keys = restoreTabs.flatMap((tab) => leafIds(tab.layout))
    const cache = scrollbackCacheRef.current
    for (const key of [...cache.keys()]) if (!keys.includes(key)) cache.delete(key)
    const restorePanes = keys.map((key) => {
      const handle = getTerminal(key)
      let entry = cache.get(key)
      if (handle && entry?.seq !== handle.outputSeq) {
        entry = { seq: handle.outputSeq, text: handle.scrollbackText() }
        cache.set(key, entry)
      }
      return toRestorePane(current[key]!, entry?.text ?? current[key]!.savedScrollback ?? '')
    })
    const tabKeys = new Set(restoreTabs.map((tab) => tab.key))
    const active = Object.fromEntries(Object.entries(activeByProjectRef.current).filter(([, key]) => key !== null && tabKeys.has(key)))
    return { tabs: restoreTabs, panes: restorePanes, activeByProject: active, savedAt: Date.now() }
  }, [])
  const pushRestore = useCallback((force: boolean) => {
    if (!restoredRef.current || !restoreRef.current) return
    const signature = JSON.stringify([
      tabsRef.current.map((tab) => [tab.key, tab.projectId, tab.layout, tab.activePane]),
      activeByProjectRef.current,
      Object.values(panesRef.current).map((pane) => [pane.key, pane.title, pane.accountId ?? null, pane.state, getTerminal(pane.key)?.outputSeq ?? -1])
    ])
    if (!force && signature === lastRestoreRef.current) return
    lastRestoreRef.current = signature
    void window.ade.invoke('terminal:restoreSave', buildRestoreSnapshot())
      .catch((err: unknown) => reportHandled(err, { area: 'terminal', op: 'save terminal restore' }))
  }, [buildRestoreSnapshot])
  useEffect(() => {
    const timer = setInterval(() => pushRestore(false), RESTORE_PUSH_MS)
    return () => clearInterval(timer)
  }, [pushRestore])
  useEffect(() => window.ade.on('terminal:restoreCollect', () => pushRestore(true)), [pushRestore])
  // タブを開いた・閉じた・並べ替えたときは少し待ってから送る
  useEffect(() => {
    if (!restored) return
    const timer = setTimeout(() => pushRestore(false), 1000)
    return () => clearTimeout(timer)
  }, [tabs, activeByProject, restored, pushRestore])

  /**
   * 最後に閉じたターミナル（表示中のプロジェクトのもの）を開き直す。前の画面の文字を書き、Agent は会話を続けて起動する。
   * 同じ Agent・フォルダ・アカウントのタブがもう開いていれば、会話は続けずに新しく起動する（同じ会話を2か所で続けない）
   */
  const reopenClosed = useCallback(async () => {
    const entry = await window.ade.invoke('terminal:closedPop', projectId).catch((err: unknown) => {
      reportHandled(err, { area: 'terminal', op: 'reopen closed terminal' })
      return null
    })
    if (!entry) return
    const mapped = remapRestoreKeys({ tabs: [entry.tab], panes: entry.panes }, (kind) => (kind === 'tab' ? `tab${++tabSeq}` : `pane${++paneSeq}`))
    const tab = mapped.tabs[0]
    if (!tab) return
    const paneByKey = new Map(mapped.panes.map((pane) => [pane.key, pane]))
    const live = Object.values(panesRef.current).map((pane) => ({ launch: pane.launch, cwd: pane.cwd, accountId: pane.accountId ?? null }))
    const resume = panesToResume(leafIds(tab.layout).flatMap((key) => paneByKey.get(key) ?? []), live)
    const banner = tNow('terminal.reopenedSeparator', { time: formatRestoreTime(entry.closedAt) })
    setPanes((prev) => ({
      ...prev,
      ...Object.fromEntries(mapped.panes.map((pane): [string, Pane] => [pane.key, paneFromRestore(pane, banner, resume.has(pane.key))]))
    }))
    setTabs((prev) => [...prev, { ...tab, projectId }])
    setActiveKey(tab.key)
  }, [projectId, setActiveKey])

  const onReadyRef = useRef(onReady)
  onReadyRef.current = onReady
  const onActiveTerminalRef = useRef(onActiveTerminal)
  onActiveTerminalRef.current = onActiveTerminal
  /** ペインの PTY を作る（1 ペイン 1 回だけ）。作り終える（失敗も含む）と解決する */
  const spawnPane = useCallback((key: string): Promise<void> => {
    const pane = panesRef.current[key]
    const node = nodesRef.current.get(key)
    const handle = getTerminal(key)
    if (!pane || !node || !handle || handle.ptyId !== null || spawnedRef.current.has(key)) return Promise.resolve()
    spawnedRef.current.add(pane.key)
    // 戻したタブ: 前の画面の文字と区切りの行を先に書く
    if (pane.restoreText) handle.restoreScreen(pane.restoreText)
    const measurable = node.offsetWidth > 0 && node.offsetHeight > 0
    const size = (measurable ? handle.fit() : null) ?? FALLBACK_SIZE
    return window.ade
      .invoke('terminal:create', {
        size,
        cwd: pane.cwd,
        agent: pane.launch,
        accountLogin: pane.accountLogin ?? null,
        command: pane.command ?? null,
        title: pane.customTitle ?? null,
        autoStart: pane.autoStart === true,
        failoverToken: pane.failoverToken ?? null,
        ...(pane.agentMailToken ? { agentMailToken: pane.agentMailToken } : {}),
        ...(pane.preset ? { preset: pane.preset } : {}),
        // 戻したタブ: 前の会話を続け、前と同じアカウントで開く
        ...(pane.resume ? { resume: true } : {}),
        ...(pane.accountId !== undefined ? { accountId: pane.accountId } : {})
      })
      .then((info) => {
        // 作っている間にペインを閉じたら、できたPTYもすぐ閉じる
        if (getTerminal(pane.key) !== handle) {
          void window.ade.invoke('terminal:close', info.id)
          return
        }
        // 先に起動しておいたシェル（main の TerminalManager.spare）は、それまでの出力（プロンプト）を流し直してからつなぐ
        if (info.history) handle.reattach(info.id, info.history, undefined, false)
        else handle.bindPty(info.id)
        if (pane.key === focusedPaneRef.current) onActiveTerminalRef.current?.(info.id)
        getTerminal(pane.key)?.scheduleFit()
        // 閉じたとき作業の途中だった Agent：会話を続けて起動したので、入力欄が出たら続きから再開するよう頼む（main が待って送る）
        if (pane.continueWork) {
          void window.ade.invoke('terminal:continueWork', info.id).catch((err: unknown) => reportHandled(err, { area: 'terminal', op: 'continue interrupted work' }))
        }
        setPanes((prev) =>
          prev[pane.key]
            ? { ...prev, [pane.key]: { ...prev[pane.key]!, title: info.title, accountId: info.accountId ?? null, restoreText: null, savedScrollback: null } }
            : prev
        )
        onReadyRef.current?.()
      })
      .catch((err: unknown) => {
        // IPC の前置き（Error invoking remote method '…': Error:）を外して本文だけを出す
        const message = errorMessage(err)
        handle.write(`\r\n\u001b[31m${tNow('terminal.startFailed', { message })}\u001b[0m\r\n`)
        if (message.includes('node-pty')) {
          handle.write(
            `\u001b[2m${tNow('terminal.nodePtyHint')}\u001b[0m\r\n`
          )
        }
      })
  }, [])

  // ペインごとに xterm を開き、PTYを結びつける。
  // 非表示のペイン（裏のタブ）もPTYを作る。寸法が測れなければ 80x24 で作り、表示時に合わせる。
  // 表示中のプロジェクトのペインはすぐ作り、裏のプロジェクトのペイン（戻したタブなど）は順に作る（terminal/spawnQueue.ts）
  const spawnQueueRef = useRef<SpawnQueue | null>(null)
  spawnQueueRef.current ??= new SpawnQueue()
  useEffect(() => () => spawnQueueRef.current?.dispose(), [])
  useEffect(() => {
    const queue = spawnQueueRef.current!
    const candidates: SpawnCandidate[] = []
    for (const pane of Object.values(panes)) {
      const node = nodesRef.current.get(pane.key)
      if (!node) continue
      const handle = acquireTerminal(pane.key)
      handle.open(node)
      if (handle.ptyId !== null || spawnedRef.current.has(pane.key)) continue
      candidates.push({ key: pane.key, projectId: tabsRef.current.find((tab) => hasLeaf(tab.layout, pane.key))?.projectId ?? null })
    }
    const { now, queued } = partitionSpawns(candidates, projectId)
    for (const key of now) {
      // 待っていたペインのプロジェクトを表示した：すぐ作る
      if (!queue.promote(key)) void spawnPane(key)
    }
    for (const key of queued) queue.enqueue(key, () => spawnPane(key))
  }, [panes, tabs, projectId, spawnPane])

  // 「Agentへ送信」の宛先は、フォーカス中のペインのPTY
  useEffect(() => {
    onActiveTerminal?.(focusedPane ? getTerminal(focusedPane)?.ptyId ?? null : null)
  }, [focusedPane, onActiveTerminal])

  // 終わった（まだ見ていない）を導くための、ペインごとの経過と前回の状態（terminal/agentAttention.ts）
  const tracksRef = useRef(new Map<string, PaneTrack>())
  const attentionRef = useRef<AttentionPane[]>([])
  const throttleRef = useRef(new AttentionThrottle())
  const notifyRef = useRef(notify)
  notifyRef.current = notify
  /** 画面に出ているペイン（表示中のプロジェクトの選択中のタブ。分割していれば全部） */
  const shownPanesRef = useRef<string[]>([])
  shownPanesRef.current = activeTab ? leafIds(activeTab.layout) : []

  /** 各ペインの Agent の状態を最後に調べた時刻（裏のプロジェクトのペインは間を空けて調べる） */
  const lastPolledRef = useRef(new Map<string, number>())
  const projectKeyRef = useRef(projectKey)
  projectKeyRef.current = projectKey

  const paneKeys = Object.keys(panes).join(':')
  useEffect(() => {
    let stopped = false
    let tick = 0
    const update = async () => {
      tick += 1
      // 最小化・裏に隠れている間は問い合わせない。Windows ではそのたびに PowerShell でプロセス一覧を取るので、
      // ほかのアプリを使っている間（フォーカスが無い間）も止める（Orca #10686 #12288。戻れば1秒以内に取り直す）。
      // 通知が入なら、終わった・確認待ちを知らせるため、裏でも BACKGROUND_POLL_EVERY 秒ごとに読む
      const background = document.visibilityState === 'hidden' || (window.ade.platform === 'win32' && !document.hasFocus())
      if (background && (!notifyRef.current || tick % BACKGROUND_POLL_EVERY !== 0)) return
      // 表示中のプロジェクトのペインは毎回、裏のプロジェクトのペインは間を空けて調べる（terminal/pollSchedule.ts）。
      // 調べるペインはまとめて1回の IPC で問い合わせる
      const now = Date.now()
      const keys = Object.keys(panesRef.current)
      const foreground = new Set(tabsRef.current.filter((tab) => (tab.projectId ?? '') === projectKeyRef.current).flatMap((tab) => leafIds(tab.layout)))
      const due = panesDueForPoll(keys, foreground, lastPolledRef.current, now)
      for (const key of due) lastPolledRef.current.set(key, now)
      for (const key of lastPolledRef.current.keys()) if (!(key in panesRef.current)) lastPolledRef.current.delete(key)
      const asked = due.flatMap((key) => {
        const id = getTerminal(key)?.ptyId
        return id ? [{ key, id }] : []
      })
      const results = asked.length > 0
        ? await window.ade.invoke('terminal:agentStates', asked.map((entry) => entry.id)).catch(() => null /* 画面の閉じかけなど（想定内） */)
        : []
      const byKey = new Map(asked.map((entry, index) => [entry.key, results?.[index] ?? null]))
      const states = due.map((key) => {
        const handle = getTerminal(key)
        const result = byKey.get(key) ?? null
        if (handle) handle.foregroundAgent = foregroundAgentOf(result)
        return [key, result?.state ?? 'unknown'] as const
      })
      if (stopped) return
      // 見ているペインは「終わった」にせず、見たら done を消す
      const looking = document.visibilityState === 'visible' && document.hasFocus()
      const shown = new Set(shownPanesRef.current)
      const polled = new Set(due)
      const tracked = states.map(([key, detected]) => {
        const seen = looking && shown.has(key)
        const track = advancePaneState(tracksRef.current.get(key) ?? INITIAL_TRACK, detected, seen)
        tracksRef.current.set(key, track)
        return { key, state: track.state, seen }
      })
      // 今回調べなかった（裏のプロジェクトの）ペインは、前の状態のまま通知の判定に含める
      for (const key of keys) {
        if (polled.has(key)) continue
        const track = tracksRef.current.get(key)
        if (track) tracked.push({ key, state: track.state, seen: false })
      }
      for (const key of tracksRef.current.keys()) if (!(key in panesRef.current)) tracksRef.current.delete(key)
      setPanes((current) => {
        let changed = false
        const next = { ...current }
        for (const { key, state } of tracked) {
          const pane = next[key]
          if (pane && pane.state !== state) {
            next[key] = { ...pane, state }
            changed = true
          }
        }
        return changed ? next : current
      })
      // プロジェクトの Agent が全部終わった・確認待ちになったら通知する（同じ出来事は AttentionThrottle で1回に）
      const attention = tracked.map(({ key, state, seen }) => ({
        key, state, seen, projectId: tabsRef.current.find((tab) => hasLeaf(tab.layout, key))?.projectId ?? null
      }))
      const events = attentionEvents(attentionRef.current, attention)
      attentionRef.current = attention
      if (!notifyRef.current) return
      for (const event of events) {
        if (!throttleRef.current.allow(event)) continue
        const pane = panesRef.current[event.paneKey]
        void window.ade.invoke('agentNotify:show', {
          kind: event.kind,
          projectId: event.projectId,
          terminalId: getTerminal(event.paneKey)?.ptyId ?? null,
          tab: pane?.title ?? ''
        }).catch((err: unknown) => reportHandled(err, { area: 'terminal', op: 'agent notification' }))
      }
    }
    const timer = setInterval(() => void update(), 1000)
    return () => { stopped = true; clearInterval(timer) }
  }, [paneKeys])

  // 通知が押されたら、そのプロジェクトへ切り替えてそのタブを開く（main の agentNotify.ts）
  const projectIdRef = useRef(projectId)
  projectIdRef.current = projectId
  useEffect(() => window.ade.on('agentNotify:open', (target) => {
    void (async () => {
      if (target.projectId && target.projectId !== projectIdRef.current) await window.ade.invoke('project:switch', target.projectId)
      if (target.terminalId) window.dispatchEvent(new CustomEvent(FOCUS_TERMINAL_EVENT, { detail: { id: target.terminalId } }))
    })().catch((err: unknown) => reportHandled(err, { area: 'terminal', op: 'open from notification' }))
  }), [])

  // サイドバーの「実行中」の印のため、どのプロジェクトで Agent が動いているかを知らせる（裏のプロジェクトのタブも含む）
  useEffect(() => {
    publishAgentActivity(tabs.flatMap((tab) => leafIds(tab.layout).map((key) => ({ projectId: tab.projectId, state: panes[key]?.state ?? 'unknown' }))))
  }, [tabs, panes])
  useEffect(() => () => publishAgentActivity([]), [])

  // 表示中のタブに寸法を合わせ、フォーカス中のペインへ焦点を移す
  useEffect(() => {
    if (!focusedPane) return
    const frame = requestAnimationFrame(() => {
      fitVisible()
      getTerminal(focusedPane)?.focus()
    })
    return () => cancelAnimationFrame(frame)
    // fitVisible は分割の比率でも変わるが、ドラッグのたびに焦点を取り直さない
  }, [activeKey, focusedPane])

  useEffect(() => {
    fitVisible()
  }, [layoutKey])

  // メニューからのタブ操作をつなぐ
  useEffect(() => {
    if (!commandRef) return
    commandRef.current = {
      // メニューの「新しいタブ」は素のシェル
      add: () => addTab(null),
      // ⌘W はフォーカス中のペインを閉じる（最後の1枚ならタブごと。Orca と同じ）。
      // ターミナルにフォーカスが無いときは先にほかへ譲り、エディタなどが引き受けたらそちらに任せる
      close: () => {
        const focused = sectionRef.current?.contains(document.activeElement) ?? false
        if (!focused && !window.dispatchEvent(new CustomEvent(CLOSE_REQUEST_EVENT, { cancelable: true }))) return
        if (activeTab && confirmCloseRunning([activeTab.activePane])) closePane(activeTab.key, activeTab.activePane)
      },
      // メニューの「閉じたターミナルを開き直す」
      reopen: () => void reopenClosed()
    }
    return () => {
      commandRef.current = null
    }
  }, [commandRef, addTab, closePane, activeTab, confirmCloseRunning, reopenClosed])

  // アンマウント時（＝アプリ終了）にPTYを残さない
  useEffect(
    () => () => {
      for (const key of Object.keys(panesRef.current)) releaseTerminal(key)
      nodesRef.current.clear()
      spawnedRef.current.clear()
    },
    []
  )

  // xterm に届く前に拾い、シェルへは送らない
  const onKeyDownCapture = (event: React.KeyboardEvent) => {
    // ⌘⇧T（Windows・Linux は Ctrl+Shift+T）最後に閉じたターミナルを開き直す
    if (isReopenTerminalKey(event, window.ade.platform)) {
      event.preventDefault()
      event.stopPropagation()
      void reopenClosed()
      return
    }
    const direction = splitDirectionForKey(event)
    if (!direction || !activeTab) return
    event.preventDefault()
    event.stopPropagation()
    void splitPane(direction)
  }

  // タブ・ペインのドラッグ＆ドロップ（Orca のタブ列・ペインの並べ替え・タブを辺に落として分割）。
  // ドラッグ中のものは dragover ではデータを読めないので ref に持つ。データの種類は中央のタブ・パネルの移動・
  // ファイルのドロップと別にして、混ざらないようにする
  const dragRef = useRef<TerminalDragSource | null>(null)
  const [dragging, setDragging] = useState(false)
  const [dropHint, setDropHint] = useState<DropHint | null>(null)
  const [tabDrop, setTabDrop] = useState<{ key: string; before: boolean } | null>(null)
  const [dropAnnouncement, setDropAnnouncement] = useState('')
  /** 外（Finder など）からファイルを落とそうとしているペインと、その枠（.terminal-surfaces の中の位置） */
  const [fileDrop, setFileDrop] = useState<{ paneKey: string; box: DropHint['box'] } | null>(null)

  const startDrag = (e: React.DragEvent<HTMLElement>, source: TerminalDragSource) => {
    e.stopPropagation()
    dragRef.current = source
    e.dataTransfer.setData(source.kind === 'tab' ? TAB_DRAG_TYPE : PANE_DRAG_TYPE, source.kind === 'tab' ? source.tabKey : source.paneKey)
    e.dataTransfer.effectAllowed = 'move'
    // 描き直しでドラッグが始まらなくならないよう、案内の層は次のフレームで出す
    requestAnimationFrame(() => setDragging(true))
  }
  const endDrag = () => {
    dragRef.current = null
    setDragging(false)
    setDropHint(null)
    setTabDrop(null)
  }

  const newDropTab = (projectId: string | null, paneKey: string): Tab => ({ key: `tab${++tabSeq}`, projectId, layout: leaf(paneKey), activePane: paneKey })
  const previewDrop = (target: TerminalDropTarget) =>
    dragRef.current ? applyTerminalDrop(tabs, dragRef.current, target, () => ({ key: '', projectId: null, layout: leaf(''), activePane: '' })) : null
  const commitDrop = (target: TerminalDropTarget) => {
    const source = dragRef.current
    endDrag()
    if (!source) return
    const result = applyTerminalDrop(tabs, source, target, newDropTab)
    if (!result) return
    setTabs(result.tabs)
    setActiveByProject((prev) => ({ ...prev, [projectKey]: result.activeTab }))
    setDropAnnouncement(t('terminal.drop.moved', { title: panes[result.activePane]?.title ?? t('terminal.shell') }))
  }

  // タブ列: タブの左半分なら前、右半分なら後ろ。タブの無いところなら最後
  const tabBarTarget = (key: string | null, before: boolean): TerminalDropTarget => {
    if (key === null) return { kind: 'tabbar', beforeTabKey: null }
    if (before) return { kind: 'tabbar', beforeTabKey: key }
    const index = tabs.findIndex((tab) => tab.key === key)
    return { kind: 'tabbar', beforeTabKey: tabs[index + 1]?.key ?? null }
  }
  const tabDragProps = (key: string) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent<HTMLElement>) => startDrag(e, { kind: 'tab', tabKey: key }),
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!isTerminalDrag(e)) return
      e.stopPropagation()
      const rect = e.currentTarget.getBoundingClientRect()
      const before = e.clientX < rect.left + rect.width / 2
      const target = tabBarTarget(key, before)
      if (!previewDrop(target)) {
        if (tabDrop) setTabDrop(null)
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (tabDrop?.key !== key || tabDrop.before !== before) {
        setTabDrop({ key, before })
        setDropAnnouncement(t('terminal.drop.tabbar'))
      }
    },
    onDragLeave: () => setTabDrop(null),
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      if (!isTerminalDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      const rect = e.currentTarget.getBoundingClientRect()
      commitDrop(tabBarTarget(key, e.clientX < rect.left + rect.width / 2))
    },
    onDragEnd: endDrag,
    'data-drop': tabDrop?.key === key ? (tabDrop.before ? 'before' : 'after') : undefined
  })
  // タブ列の空いているところ（最後のタブの右）
  const tabBarDropProps = {
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!isTerminalDrag(e) || !previewDrop(tabBarTarget(null, false))) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      if (!isTerminalDrag(e)) return
      e.preventDefault()
      commitDrop(tabBarTarget(null, false))
    }
  }

  // 表示中のタブの領域: 外周の帯ならいちばん外側で分割、ペインの上なら辺で分割・中央でタブ
  const surfaceTarget = (e: React.DragEvent<HTMLElement>): DropHint | null => {
    if (!activeTab) return null
    const surfaces = e.currentTarget.getBoundingClientRect()
    const point = { x: e.clientX, y: e.clientY }
    const relative = (rect: { left: number; top: number; width: number; height: number }) => ({
      left: rect.left - surfaces.left,
      top: rect.top - surfaces.top,
      width: rect.width,
      height: rect.height
    })
    const half = (rect: DOMRect, zone: 'left' | 'right' | 'top' | 'bottom' | 'center') => {
      const box = relative(rect)
      if (zone === 'center') return box
      if (zone === 'left' || zone === 'right') return { ...box, width: box.width / 2, left: box.left + (zone === 'right' ? box.width / 2 : 0) }
      return { ...box, height: box.height / 2, top: box.top + (zone === 'bottom' ? box.height / 2 : 0) }
    }
    if (activeTab.layout.type === 'split') {
      const edge = resolveRootEdge(surfaces, point)
      if (edge) {
        const target: TerminalDropTarget = { kind: 'root', tabKey: activeTab.key, edge }
        return previewDrop(target) ? { target, box: half(surfaces, edge) } : null
      }
    }
    const leafEl = (e.target as Element | null)?.closest<HTMLElement>('[data-pane]')
    const paneKey = leafEl?.dataset.pane
    if (!leafEl || !paneKey || !hasLeaf(activeTab.layout, paneKey)) return null
    const rect = leafEl.getBoundingClientRect()
    const zone = resolvePaneDropZone(rect, point)
    const target: TerminalDropTarget = { kind: 'pane', tabKey: activeTab.key, paneKey, zone }
    return previewDrop(target) ? { target, box: half(rect, zone) } : null
  }
  // 外から落としたファイル・フォルダ・画像は、落とした先のペインの入力にパスを入れる（実行はしない。iTerm・VS Code と同じ）。
  // Agent が前面でも同じで、Claude Code は画像のパスを貼ると画像として読む。タブ・ペインの並べ替え（'Files' を運ばない）とは別
  const fileDropPane = (e: React.DragEvent<HTMLElement>): { paneKey: string; box: DropHint['box'] } | null => {
    if (!activeTab) return null
    const leafEl = (e.target as Element | null)?.closest<HTMLElement>('[data-pane]')
    const paneKey = leafEl?.dataset.pane
    if (!leafEl || !paneKey || !hasLeaf(activeTab.layout, paneKey)) return null
    const surfaces = e.currentTarget.getBoundingClientRect()
    const rect = leafEl.getBoundingClientRect()
    return { paneKey, box: { left: rect.left - surfaces.left, top: rect.top - surfaces.top, width: rect.width, height: rect.height } }
  }
  // ファイルツリーの行（TREE_DRAG_TYPE）も同じ。作業フォルダがプロジェクトの根なら相対パス、ほかの場所なら絶対パスで入れる
  // サイドバーのプロジェクト（オーケストラ・サブフォルダのプロジェクト）の行は、そのフォルダの絶対パスを入れる（Agent に対象を伝える）
  const isFileDrop = (dataTransfer: DataTransfer) => hasExternalFiles(dataTransfer) || (hasTreePaths(dataTransfer) && cwd !== null) || hasProjectDrag(dataTransfer)
  const dropFilesInto = async (dataTransfer: DataTransfer, tabKey: string, paneKey: string) => {
    // データはイベントの間しか読めないので、待つ前に読む
    const projectPath = hasProjectDrag(dataTransfer) ? droppedProjectPath(dataTransfer, projects) : null
    if (hasProjectDrag(dataTransfer) && !projectPath) return
    const tree = projectPath ? null : treeDragPaths(dataTransfer)
    const pending = tree || projectPath ? null : readDrop(dataTransfer)
    const pane = panesRef.current[paneKey]
    const ptyId = getTerminal(paneKey)?.ptyId ?? null
    const paths = projectPath ? [projectPath] : tree
      ? treePathsForTerminal(tree, { root: cwd ?? '', cwd: ptyId ? await window.ade.invoke('terminal:cwd', ptyId).catch(() => null) : null, platform: window.ade.platform })
      : (await pending!).map((entry) => entry.path)
    const remote = projects.some((p) => p.id === projectId && p.source === 'ssh')
    const text = shellPathsText(paths, shellQuotingFor(window.ade.platform, { remote, title: pane?.title }))
    if (!text) return
    focusPane(tabKey, paneKey)
    getTerminal(paneKey)?.insertText(text)
  }

  const surfaceDropProps = {
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (!isTerminalDrag(e) && isFileDrop(e.dataTransfer)) {
        const next = fileDropPane(e)
        if (!next) {
          if (fileDrop) setFileDrop(null)
          return
        }
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        if (JSON.stringify(next) !== JSON.stringify(fileDrop)) setFileDrop(next)
        return
      }
      if (!isTerminalDrag(e)) return
      const hint = surfaceTarget(e)
      if (!hint) {
        if (dropHint) setDropHint(null)
        return
      }
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      if (JSON.stringify(hint) !== JSON.stringify(dropHint)) {
        setDropHint(hint)
        setDropAnnouncement(t(dropLabel(hint.target)))
      }
    },
    onDragLeave: (e: React.DragEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
        setDropHint(null)
        setFileDrop(null)
      }
    },
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      if (!isTerminalDrag(e) && isFileDrop(e.dataTransfer)) {
        const target = fileDropPane(e)
        setFileDrop(null)
        if (!target || !activeTab) return
        e.preventDefault()
        void dropFilesInto(e.dataTransfer, activeTab.key, target.paneKey).catch((err: unknown) => reportHandled(err, { area: 'terminal', op: 'drop files' }))
        return
      }
      if (!isTerminalDrag(e)) return
      const hint = surfaceTarget(e)
      e.preventDefault()
      if (hint) commitDrop(hint.target)
      else endDrag()
    }
  }

  const quickSearch = useMemo<QuickLaunchSearch>(
    () => ({
      tabs: visibleTabs.map((tab) => ({ key: tab.key, title: panes[tab.activePane]?.title ?? t('terminal.shell') })),
      // 表示中のプロジェクトのURLを先に出す
      urls: [...projects]
        .sort((a, b) => Number(b.id === projectId) - Number(a.id === projectId))
        .flatMap((project) => project.urls.flatMap((u) => (u.url ? [{ label: u.label, url: u.url, project: project.name }] : []))),
      onSelectTab: setActiveKey,
      onOpenUrl: (url) => void window.ade.invoke('browser:navigate', url),
      ...(onOpenFile ? { searchFiles: searchFileNames, onOpenFile } : {})
    }),
    [visibleTabs, panes, projects, projectId, setActiveKey, onOpenFile, t]
  )

  const renderNode = (tab: Tab, node: PaneNode, path: PanePath, split: boolean): ReactNode => {
    if (node.type === 'leaf') {
      const active = node.leafId === tab.activePane
      return (
        <div
          key={node.leafId}
          className="terminal-leaf"
          data-pane={node.leafId}
          data-active={active}
          data-testid={`terminal-pane-${node.leafId}`}
          style={{ opacity: !split || active ? ACTIVE_PANE_OPACITY : INACTIVE_PANE_OPACITY }}
          data-split={split || undefined}
          data-drag-source={dragging && dragRef.current?.kind === 'pane' && dragRef.current.paneKey === node.leafId ? true : undefined}
          ref={leafRef(node.leafId)}
          onMouseDown={() => focusPane(tab.key, node.leafId)}
          onFocus={() => focusPane(tab.key, node.leafId)}
          onContextMenu={(e) => {
            // 右クリックで分割・区画を閉じる（右上のボタンより見つけやすい）
            e.preventDefault()
            focusPane(tab.key, node.leafId)
            setPaneMenu({ x: e.clientX, y: e.clientY, tabKey: tab.key, paneKey: node.leafId, split })
          }}
        >
          {/* 分割中のペインを動かすつまみ（Orca の .pane-drag-handle）。xterm の器はこの後ろに足される */}
          <div
            className="terminal-leaf__handle"
            draggable={split}
            role="button"
            aria-label={t('terminal.dragPane')}
            title={t('terminal.dragPane')}
            data-testid={`terminal-pane-handle-${node.leafId}`}
            onMouseDown={(e) => e.stopPropagation()}
            onDragStart={(e) => startDrag(e, { kind: 'pane', tabKey: tab.key, paneKey: node.leafId })}
            onDragEnd={endDrag}
          />
        </div>
      )
    }
    const vertical = node.direction === 'vertical'
    return (
      <div key={path} className={`terminal-split ${vertical ? 'is-vertical' : 'is-horizontal'}`}>
        <div className="terminal-split__child" style={{ flex: `${node.ratio} 1 0%` }}>
          {renderNode(tab, node.first, `${path}0`, true)}
        </div>
        <PaneDivider vertical={vertical} onRatio={(ratio) => setSplitRatio(tab.key, path, ratio)} />
        <div className="terminal-split__child" style={{ flex: `${1 - node.ratio} 1 0%` }}>
          {renderNode(tab, node.second, `${path}1`, true)}
        </div>
      </div>
    )
  }

  return (
    <section
      ref={sectionRef}
      onKeyDownCapture={onKeyDownCapture}
      className="terminal-pane"
      data-testid="terminal-pane"
      aria-label={t('terminal.label')}
    >
      <div className="terminal-tabs" role="tablist" {...tabBarDropProps}>
        {visibleTabs.map((tab) => {
          const ids = leafIds(tab.layout)
          const pane = panes[tab.activePane]
          const title = pane?.title ?? t('terminal.shell')
          const state =
            STATE_PRIORITY.find((s) => ids.some((id) => panes[id]?.state === s)) ?? 'unknown'
          return (
            <div
              key={tab.key}
              className="terminal-tab"
              role="tab"
              aria-selected={tab.key === activeKey}
              onClick={() => setActiveKey(tab.key)}
              data-testid={`terminal-tab-${tab.key}`}
              data-active-pane={tab.activePane}
              {...tabDragProps(tab.key)}
            >
              {/* Agentの状態の印（WS-4 / 04 4.1-13）。分割していれば一番気づいてほしいペインの状態 */}
              <span
                className={`terminal-tab__state terminal-tab__state--${state}`}
                title={t(AGENT_STATE_LABEL[state])}
                aria-label={t(AGENT_STATE_LABEL[state])}
              />
              {(pane?.launch ?? pane?.accountLogin?.agent) && (
                <span className="terminal-tab__agent">
                  <AgentIcon agent={(pane.launch ?? pane.accountLogin?.agent)!} label={pane.title} size={12} />
                </span>
              )}
              {/* 通し番号は main が title に含めている（例「1: zsh」）。ここでは足さない */}
              {/* 省略されても全体を読めるように（Orca #2966） */}
              <span className="terminal-tab__title" title={title}>{title}</span>
              {ids.length > 1 && (
                <span className="terminal-tab__count" title={t('terminal.splitInto', { count: ids.length })}>
                  {ids.length}
                </span>
              )}
              <button
                type="button"
                className="terminal-tab__close"
                aria-label={t('terminal.closeNamed', { title })}
                title={t('terminal.closeTab')}
                onClick={(event) => {
                  event.stopPropagation()
                  if (confirmCloseRunning(leafIds(tab.layout))) closeTab(tab.key)
                }}
              >
                <X size={12} strokeWidth={2} />
              </button>
            </div>
          )
        })}
        <QuickLaunchButton
          agents={menuAgents}
          onNewTerminal={() => addTab(null)}
          onLaunchAgent={addTab}
          onOpenAgentSettings={onOpenAgentSettings}
          search={quickSearch}
        />
        <div className="terminal-tabs__actions">
          <QuickLaunchButton
            icon={<Columns2 size={14} strokeWidth={1.75} />}
            label={t('terminal.splitRight')}
            newTerminalShortcut={splitShortcut('vertical')}
            testId="terminal-split-right"
            agents={menuAgents}
            disabled={!activeTab}
            onNewTerminal={() => splitPane('vertical')}
            onLaunchAgent={(agent) => splitPane('vertical', agent)}
          />
          <QuickLaunchButton
            icon={<Rows2 size={14} strokeWidth={1.75} />}
            label={t('terminal.splitDown')}
            newTerminalShortcut={splitShortcut('horizontal')}
            testId="terminal-split-down"
            agents={menuAgents}
            disabled={!activeTab}
            onNewTerminal={() => splitPane('horizontal')}
            onLaunchAgent={(agent) => splitPane('horizontal', agent)}
          />
        </div>
      </div>

      {paneMenu && <PaneContextMenu at={paneMenu} onClose={() => setPaneMenu(null)}
        onSplit={(direction) => { setPaneMenu(null); void splitPane(direction) }}
        onClosePane={() => { setPaneMenu(null); closePane(paneMenu.tabKey, paneMenu.paneKey) }} />}
      <div className="terminal-surfaces" data-dragging={dragging || undefined} {...surfaceDropProps}>
        {visibleTabs.length === 0 && (
          <EmptyState
            size="sm"
            testId="terminal-empty"
            art={
              <IconTile tone="agent" size="lg">
                <SquareTerminal size={22} strokeWidth={1.75} />
              </IconTile>
            }
            title={t('terminal.emptyTitle')}
            description={t('terminal.emptyDescription')}
            actions={
              <>
                <Button
                  variant="default"
                  icon={<Plus size={15} strokeWidth={2} />}
                  onClick={() => addTab(null)}
                >
                  {t('terminal.openShell')}
                </Button>
                {menuAgents.map((agent) => (
                  <Button
                    key={agent.id}
                    variant="ghost"
                    icon={<AgentIcon agent={agent.id} label={agent.icon ?? agent.label} size={15} />}
                    onClick={() => addTab(agent.id)}
                    data-testid={`terminal-empty-launch-${agent.id.replace(':', '-')}`}
                  >
                    {agent.label}
                  </Button>
                ))}
              </>
            }
            hints={
              <>
                <span className="hint">
                  <kbd className="kbd">{SHORTCUTS.newTerminal()}</kbd>{t('terminal.newTab')}
                </span>
                {restore && (
                  <span className="hint">
                    <kbd className="kbd">{reopenShortcut()}</kbd>{t('terminal.reopenClosed')}
                  </span>
                )}
              </>
            }
          />
        )}
        {/* ドラッグ中に、落とすとどうなるかを示す（Orca の .pane-drop-overlay）。マウスは下のペインに通す */}
        {dragging && dropHint && (
          <div
            className="terminal-drop-overlay"
            data-kind={dropHint.target.kind}
            data-testid="terminal-drop-overlay"
            style={{ left: dropHint.box.left, top: dropHint.box.top, width: dropHint.box.width, height: dropHint.box.height }}
          >
            <span className="terminal-drop-overlay__label">{t(dropLabel(dropHint.target))}</span>
          </div>
        )}
        {fileDrop && (
          <div
            className="terminal-drop-overlay"
            data-kind="files"
            data-testid="terminal-file-drop"
            style={{ left: fileDrop.box.left, top: fileDrop.box.top, width: fileDrop.box.width, height: fileDrop.box.height }}
          >
            <span className="terminal-drop-overlay__label">{t('drop.terminal.hint')}</span>
          </div>
        )}
        <div className="visually-hidden" aria-live="polite" data-testid="terminal-drop-live">
          {dropAnnouncement}
        </div>
        {/* 裏のプロジェクトのタブも描画したまま隠す（PTYと分割の形を保つ） */}
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className="terminal-surface"
            hidden={tab.key !== activeKey || (tab.projectId ?? '') !== projectKey}
          >
            {renderNode(tab, tab.layout, '', tab.layout.type === 'split')}
          </div>
        ))}
      </div>
    </section>
  )
}

/**
 * ペインの間の区切り線。掴める幅は見える線より広く、線そのものは CSS の ::after で描く（Orca と同じ）。
 * ドラッグ中は1フレームに1回だけ比率を更新する。
 */
function PaneDivider({ vertical, onRatio }: { vertical: boolean; onRatio: (ratio: number) => void }) {
  const [dragging, setDragging] = useState(false)

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const divider = event.currentTarget
    const split = divider.parentElement
    if (!split) return
    const rect = split.getBoundingClientRect()
    const start = vertical ? rect.left : rect.top
    const total = (vertical ? rect.width : rect.height) - DIVIDER_HIT_SIZE
    let frame = 0
    divider.setPointerCapture(event.pointerId)
    setDragging(true)
    holdPtyResize(true)
    const onMove = (move: PointerEvent) => {
      const offset = (vertical ? move.clientX : move.clientY) - start - DIVIDER_HIT_SIZE / 2
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => onRatio(ratioFromDrag(offset, total)))
    }
    const onEnd = () => {
      divider.removeEventListener('pointermove', onMove)
      divider.removeEventListener('pointerup', onEnd)
      divider.removeEventListener('pointercancel', onEnd)
      setDragging(false)
      holdPtyResize(false)
    }
    divider.addEventListener('pointermove', onMove)
    divider.addEventListener('pointerup', onEnd)
    divider.addEventListener('pointercancel', onEnd)
  }

  return (
    <div
      className={`terminal-divider ${vertical ? 'is-vertical' : 'is-horizontal'}${dragging ? ' is-dragging' : ''}`}
      role="separator"
      aria-orientation={vertical ? 'vertical' : 'horizontal'}
      style={{
        [vertical ? 'width' : 'height']: DIVIDER_HIT_SIZE,
        ['--divider-thickness' as string]: `${DIVIDER_THICKNESS_PX}px`,
        ['--divider-extension' as string]: `${DIVIDER_HIT_SIZE / 2}px`
      }}
      onPointerDown={onPointerDown}
      // ダブルクリックで半分ずつに戻す（Orca #9644）
      onDoubleClick={() => onRatio(0.5)}
      data-testid="terminal-divider"
    />
  )
}

/**
 * ターミナルの区画の右クリックのメニュー。右に分割・下に分割と、分割しているときは区画を閉じる。
 * 外を押す・Esc で閉じる。画面の端からはみ出さないよう位置を寄せる
 */
function PaneContextMenu({ at, onClose, onSplit, onClosePane }: {
  at: { x: number; y: number; split: boolean }
  onClose: () => void
  onSplit: (direction: PaneSplitDirection) => void
  onClosePane: () => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    return () => { window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key) }
  }, [onClose])
  const left = Math.max(4, Math.min(at.x, window.innerWidth - 200))
  const top = Math.max(4, Math.min(at.y, window.innerHeight - 120))
  return createPortal(
    <div ref={ref} className="pane-menu" role="menu" aria-label={t('terminal.paneMenu')} style={{ left, top }} data-testid="terminal-pane-menu">
      <button type="button" role="menuitem" className="pane-menu__item" onClick={() => onSplit('vertical')} data-testid="terminal-pane-menu-split-right">
        <Columns2 size={14} strokeWidth={1.75} aria-hidden="true" /><span>{t('terminal.splitRight')}</span><kbd className="pane-menu__key">{splitShortcut('vertical')}</kbd>
      </button>
      <button type="button" role="menuitem" className="pane-menu__item" onClick={() => onSplit('horizontal')} data-testid="terminal-pane-menu-split-down">
        <Rows2 size={14} strokeWidth={1.75} aria-hidden="true" /><span>{t('terminal.splitDown')}</span><kbd className="pane-menu__key">{splitShortcut('horizontal')}</kbd>
      </button>
      {at.split && <button type="button" role="menuitem" className="pane-menu__item" onClick={onClosePane} data-testid="terminal-pane-menu-close">
        <X size={14} strokeWidth={1.75} aria-hidden="true" /><span>{t('terminal.closePane')}</span>
      </button>}
    </div>,
    document.body
  )
}
