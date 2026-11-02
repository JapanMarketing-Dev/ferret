import type { TerminalSessionInfo, TuiAgent } from '@shared/types'
import { leaf, leafIds, removeLeaf, type PaneNode } from './paneTree'

/**
 * 画面を読み込み直した（⌘R・HMR）あと、生きているターミナルにタブをつなぎ直す計画（純粋関数。単体テストの対象）。
 *
 * Orca由来: ~/bench/orca/src/shared/terminal-tab-types.ts（TerminalLayoutSnapshot: root / activeLeafId /
 *           ptyIdsByLeafId「タブの移動など、同じセッションの中での再マウントでは生きている PTY につなぎ直す」）,
 *           ~/bench/orca/src/main/ipc/pty/register-handlers.ts（読み込み直しのあと、どの画面にも属さない PTY だけを片付ける）
 *           （MIT, Copyright 2026 Lovecast Inc.）
 *
 * main の PTY は画面を読み込み直しても生きている。renderer は読み込み直しの前に、タブと分割の形と
 * 各ペインの PTY の id を sessionStorage（同じウインドウの読み込み直しでは残る）に書いておき、
 * 読み込み直したあとはそれと main の一覧を突き合わせて、新しく作らずにつなぎ直す。
 * - 記録にあって生きているもの → 元のタブ・分割の形のまま戻す（終わったペインだけ外す）
 * - 記録に無いが、登録済みのプロジェクトのフォルダで開いていたもの → そのプロジェクトに1枚ずつタブを作って戻す
 * - 戻す先が無いもの（プロジェクトが消えた、記録にもプロジェクトにも当てはまらない）→ 片付ける
 */

export const TERMINAL_SNAPSHOT_KEY = 'ade.terminal.snapshot.v1'

interface SnapshotPane {
  key: string
  title: string
  launch: TuiAgent | null
  cwd: string | null
  /** main のターミナルID。まだ作っている途中なら null */
  ptyId: string | null
  /** PTY を作らずに置いているペイン（裏のプロジェクトの戻したタブ・休ませたタブ）。画面の文字は main の覚えから戻す */
  dormant?: boolean
}

interface SnapshotTab {
  key: string
  projectId: string | null
  layout: PaneNode
  activePane: string
}

export interface TerminalSnapshot {
  version: 1
  tabs: SnapshotTab[]
  panes: SnapshotPane[]
  activeByProject: Record<string, string | null>
}

interface RestorePlan {
  tabs: SnapshotTab[]
  /** すべて ptyId 付き（つなぎ直す先） */
  panes: Array<SnapshotPane & { ptyId: string }>
  activeByProject: Record<string, string | null>
  /** 片付ける（閉じる）ターミナルID */
  close: string[]
  /** PTY を作らずに置いていたペイン。タブの分割の形には残してあり、画面の文字は main の覚え（terminal:restorePeek）から戻す */
  dormant: SnapshotPane[]
}

/** 記録を読む。壊れていれば null（そのときは main の一覧だけで戻す） */
export function parseTerminalSnapshot(raw: string | null | undefined): TerminalSnapshot | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<TerminalSnapshot>
    if (value.version !== 1 || !Array.isArray(value.tabs) || !Array.isArray(value.panes)) return null
    return {
      version: 1,
      tabs: value.tabs.filter((tab) => tab && typeof tab.key === 'string' && tab.layout && typeof tab.activePane === 'string'),
      panes: value.panes.filter((pane) => pane && typeof pane.key === 'string'),
      activeByProject: value.activeByProject && typeof value.activeByProject === 'object' ? value.activeByProject : {}
    }
  } catch {
    return null
  }
}

export function planTerminalRestore(args: {
  snapshot: TerminalSnapshot | null
  live: readonly TerminalSessionInfo[]
  /** 登録済みのプロジェクト */
  projects: ReadonlyArray<{ id: string; folderPath: string }>
  /** 新しく作るタブ・ペインのキー */
  newKey: (kind: 'tab' | 'pane') => string
}): RestorePlan {
  const liveById = new Map(args.live.map((terminal) => [terminal.id, terminal]))
  const projectIds = new Set(args.projects.map((project) => project.id))
  const claimed = new Set<string>()
  const close = new Set<string>()
  const tabs: SnapshotTab[] = []
  const panes: RestorePlan['panes'] = []
  const dormant: SnapshotPane[] = []
  const paneByKey = new Map((args.snapshot?.panes ?? []).map((pane) => [pane.key, pane]))

  for (const tab of args.snapshot?.tabs ?? []) {
    const keys = safeLeafIds(tab.layout)
    // プロジェクトの登録を外していたら、そのタブのターミナルは戻す先が無い
    if (tab.projectId !== null && !projectIds.has(tab.projectId)) {
      for (const key of keys) {
        const ptyId = paneByKey.get(key)?.ptyId
        if (ptyId && liveById.has(ptyId)) close.add(ptyId)
      }
      continue
    }
    let layout: PaneNode | null = tab.layout
    for (const key of keys) {
      const pane = paneByKey.get(key)
      const alive = pane?.ptyId && liveById.has(pane.ptyId) && !claimed.has(pane.ptyId)
      if (alive) {
        claimed.add(pane.ptyId!)
        panes.push({ ...pane!, ptyId: pane!.ptyId! })
      } else if (pane?.dormant && !pane.ptyId) {
        dormant.push(pane)
      } else if (layout) {
        // 終わったペイン（作っている途中で読み込み直したものを含む）は外す
        layout = removeLeaf(layout, key)
      }
    }
    if (!layout) continue
    const remaining = leafIds(layout)
    tabs.push({ ...tab, layout, activePane: remaining.includes(tab.activePane) ? tab.activePane : remaining[0]! })
  }

  // 記録に無いターミナル。登録済みのプロジェクトのフォルダで開いていたなら、そのプロジェクトに戻す
  for (const terminal of args.live) {
    if (claimed.has(terminal.id) || close.has(terminal.id)) continue
    const project = args.projects.find((p) => samePath(p.folderPath, terminal.cwd))
    if (!project) {
      close.add(terminal.id)
      continue
    }
    const paneKey = args.newKey('pane')
    claimed.add(terminal.id)
    panes.push({ key: paneKey, title: terminal.title, launch: terminal.agent, cwd: terminal.cwd, ptyId: terminal.id })
    tabs.push({ key: args.newKey('tab'), projectId: project.id, layout: leaf(paneKey), activePane: paneKey })
  }

  const tabKeys = new Set(tabs.map((tab) => tab.key))
  const activeByProject: Record<string, string | null> = {}
  for (const [project, key] of Object.entries(args.snapshot?.activeByProject ?? {})) {
    if (key && tabKeys.has(key)) activeByProject[project] = key
  }
  return { tabs, panes, activeByProject, close: [...close], dormant }
}

function safeLeafIds(layout: PaneNode): string[] {
  try {
    return leafIds(layout)
  } catch {
    return []
  }
}

/** 末尾の / の有無だけの違いは同じフォルダとみなす */
function samePath(a: string, b: string): boolean {
  const norm = (path: string) => path.replace(/[\\/]+$/, '')
  return norm(a) === norm(b)
}

/** 記録用に、今のタブとペインを書き出す */
export function buildTerminalSnapshot(args: {
  tabs: ReadonlyArray<SnapshotTab>
  panes: ReadonlyArray<Omit<SnapshotPane, 'ptyId'>>
  ptyIdOf: (paneKey: string) => string | null
  /** PTY を作らずに置いているペインか（無ければどれも違う） */
  dormantOf?: (paneKey: string) => boolean
  activeByProject: Record<string, string | null>
}): TerminalSnapshot {
  return {
    version: 1,
    tabs: args.tabs.map(({ key, projectId, layout, activePane }) => ({ key, projectId, layout, activePane })),
    panes: args.panes.map(({ key, title, launch, cwd }) => {
      const ptyId = args.ptyIdOf(key)
      return { key, title, launch, cwd, ptyId, ...(!ptyId && args.dormantOf?.(key) ? { dormant: true } : {}) }
    }),
    activeByProject: args.activeByProject
  }
}

/** つなぎ直せなかった（そのあいだに終了した）ペインを計画から外す */
export function dropRestoredPanes(plan: RestorePlan, deadKeys: ReadonlySet<string>): RestorePlan {
  if (deadKeys.size === 0) return plan
  const tabs: SnapshotTab[] = []
  for (const tab of plan.tabs) {
    let layout: PaneNode | null = tab.layout
    for (const key of deadKeys) if (layout) layout = removeLeaf(layout, key)
    if (!layout) continue
    const remaining = leafIds(layout)
    tabs.push({ ...tab, layout, activePane: remaining.includes(tab.activePane) ? tab.activePane : remaining[0]! })
  }
  const tabKeys = new Set(tabs.map((tab) => tab.key))
  return {
    ...plan,
    tabs,
    panes: plan.panes.filter((pane) => !deadKeys.has(pane.key)),
    dormant: plan.dormant.filter((pane) => !deadKeys.has(pane.key)),
    activeByProject: Object.fromEntries(Object.entries(plan.activeByProject).filter(([, key]) => key && tabKeys.has(key)))
  }
}

/** 記録にあるキーの通し番号の最大（新しいタブ・ペインのキーと重ならないようにする） */
export function maxKeySeq(keys: readonly string[], prefix: 'tab' | 'pane'): number {
  let max = 0
  for (const key of keys) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(key)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return max
}
