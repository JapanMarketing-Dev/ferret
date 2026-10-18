import { ExternalDropOverlay, useExternalDrop } from '../hooks/useExternalDrop'
import { readDrop } from '../lib/externalDrop'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  ArrowDown,
  ArrowUp,
  Briefcase,
  Check,
  ChevronDown,
  CircleSlash,
  Ellipsis,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  MessageCircleQuestionMark,
  Network,
  Pencil,
  Plus,
  Settings2,
  Star,
  Trash2,
  ListFilter
} from 'lucide-react'
import type { Project, ProjectsState } from '@shared/types'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, EmptyState, Field, IconButton, useToast } from '../ui'
import { ProjectEditDialog } from './ProjectTargetsEditor'
import { CreateRepoDialog } from './CreateRepoDialog'
import { AddProjectDialog, ProjectSourceIcon } from './AddProjectDialog'
import type { ProjectSource } from '@shared/projectSource'
import { sshTargetLabel } from '@shared/sshCommand'
import type { TranslationKey } from '@shared/i18n'
import { toReviewSession, type ReviewSession } from './ReviewList'
import { SetupProgressLink } from '../onboarding/SetupChecklist'
import { FeedbackLink } from './FeedbackDialog'
import { useProjectActivity } from '../terminal/agentActivity'
import { dropPositionAt, stepAmongVisible, type DropPosition } from '@shared/reorder'
import { PROJECT_SORTS, filterProjects, sanitizeProjectView, sortProjects, type ProjectListView } from '@shared/projectOrder'
import { isOrchestra, orchestraIdOf, treeDrop, treeRows } from '@shared/orchestras'
import { PROJECT_DRAG_TYPE } from '../lib/projectDrag'
import { useVentureIds } from '../venture/useVentureIds'

export { toReviewSession, type ReviewSession }

/**
 * 左サイドバー（240px）。登録したプロジェクトの一覧と、オーケストラの下に入れ子でサブフォルダのプロジェクト。
 * レビューの履歴・新しいレビュー・MTG の取り込みは「指摘」のページ（ReviewHub.tsx）に置く（2026-10-11 本人指示。サイドバーでは見にくい）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/sidebar/ の Projects 節（MIT）。
 *   - 節の見出し「Projects」と右端の ＋（SidebarHeader.tsx）
 *   - プロジェクトの行: 色つきのアイコン・太字の名前・触れたときだけ出る … と折りたたみ
 *     （worktree-list/rows/SectionHeader.tsx, ProjectHeaderActions.tsx）
 *   - 子の行を1段（18px）字下げして並べる（worktree-list/rows/indentation.ts の SIDEBAR_TREE_INDENT）
 *   - 右クリック／… のメニュー（repo-header-project-actions.tsx）。名前の変更と登録解除だけ
 * プロジェクトの行はドラッグ＆ドロップ・Alt+↑↓・メニューの「上へ」「下へ」で並べ替えられる（順は settings の projects の並び）。
 * 並び順（手動・動いている順・最近使った順・名前順・追加した順）と「☆ のみ」は見出しの漏斗のパネルで選ぶ。☆ は上にまとめる。
 * 色・グループ・Finder連携は持ち込まない。
 */

/** プロジェクトの並び順と「☆ のみ」。この端末だけの好み（@shared/projectOrder） */
const VIEW_KEY = 'ade.sidebar.projectView'
function loadView(): ProjectListView {
  try {
    return sanitizeProjectView(JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}'))
  } catch {
    // ストレージが使えない・壊れた値（想定内。手動の順で続ける）
    return sanitizeProjectView(null)
  }
}
function saveView(view: ProjectListView): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    // 保存できなくても、この起動の間は効く
  }
}

/** Agent が最後に動いた（作業中・確認待ちになった）時刻。「最近使った順」「動いている順」に使う */
const AGENT_AT_KEY = 'ade.sidebar.agentActiveAt'
function loadAgentActiveAt(): Record<string, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(AGENT_AT_KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'number' && Number.isFinite(v))) as Record<string, number>
  } catch {
    // ストレージが使えない・壊れた値（想定内）
    return {}
  }
}

/** 右クリック／… で開くメニュー。サイドバーの中に収める（右へはみ出すとネイティブのビューに隠れる） */
const MENU_WIDTH = 188
/** メニューのおよその高さ（下端で上へ寄せるのに使う） */
const MENU_HEIGHT = 208

/**
 * プロジェクトの行を並べ替えるドラッグの型。外からのファイル（'Files'）・ファイルツリーの行（treeDrag.ts）とは別の型にして、
 * 外からのドロップ（プロジェクトの追加）やターミナル・エディタへのドロップと取り違えない
 */
/** 畳んだオーケストラ（この PC の localStorage。サイドバーの見た目だけ） */
const COLLAPSED_ORCHESTRAS_KEY = 'ferret.sidebar.collapsedOrchestras'
function loadCollapsedOrchestras(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_ORCHESTRAS_KEY) ?? '[]') as unknown
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 200) : [])
  } catch {
    // 壊れた値・保存できない環境（想定内）
    return new Set()
  }
}

export function Sidebar({
  projects,
  activeProjectId,
  onOverlayChange
}: {
  projects: ProjectsState
  /** 開いているプロジェクト */
  activeProjectId: string | null
  /** 「プロジェクトを編集」のダイアログの開閉。開いている間は内蔵ブラウザのビューを隠す */
  onOverlayChange?: (open: boolean) => void
}) {
  const toast = useToast()
  /** ビジネスのオーケストラ（行の印をブリーフケースにする） */
  const ventureIds = useVentureIds()
  const t = useT()
  const rootRef = useRef<HTMLElement | null>(null)
  /** ターミナルで Agent が動いているプロジェクト（行に「実行中」の印を出す） */
  const projectActivity = useProjectActivity()
  /** 並び順・「☆ のみ」のパネル */
  const [viewOpen, setViewOpen] = useState(false)
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const [renaming, setRenamingState] = useState<{ id: string; name: string } | null>(null)
  const renamingRef = useRef<{ id: string; name: string } | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  /** 「プロジェクトを編集」で開いているプロジェクト */
  const [editingId, setEditingId] = useState<string | null>(null)
  /** 並べ替えのドラッグ中のプロジェクトと、落とす位置（線を出す行と、その上か下か） */
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ id: string; position: DropPosition } | null>(null)
  /** キーボードで動かしたあと、並び直した行へフォーカスを戻す */
  const refocus = useRef<string | null>(null)
  const openEdit = (id: string | null) => {
    setEditingId(id)
    onOverlayChange?.(id !== null)
  }
  /** 「GitHub で private リポジトリを作る」を開いているプロジェクト（ダイアログの間は内蔵ブラウザのビューを隠す） */
  const [repoCreateId, setRepoCreateId] = useState<string | null>(null)
  const openRepoCreate = (id: string | null) => {
    setRepoCreateId(id)
    onOverlayChange?.(id !== null)
  }

  const setRenaming = (next: { id: string; name: string } | null) => {
    renamingRef.current = next
    setRenamingState(next)
  }

  const run = useCallback((fn: () => Promise<unknown>) => {
    void fn().catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }, [toast])


  // メニューは外側のクリックと Esc で閉じる
  useEffect(() => {
    if (!menu) return
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.sb-menu')) setMenu(null)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null) }
    window.addEventListener('mousedown', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [menu])

  const openMenuAt = (id: string, clientX: number, clientY: number) => {
    const box = rootRef.current?.getBoundingClientRect()
    if (!box) return
    const x = Math.max(4, Math.min(clientX - box.left, box.width - MENU_WIDTH - 4))
    // 下端では上へ寄せる
    setMenu({ id, x, y: Math.max(4, Math.min(clientY - box.top, box.height - MENU_HEIGHT)) })
  }

  /** 並び順と「☆ のみ」。☆ はどの並び順でも上にまとめる */
  const [view, setViewState] = useState<ProjectListView>(loadView)
  const setView = (next: ProjectListView) => {
    setViewState(next)
    saveView(next)
  }
  const [agentActiveAt, setAgentActiveAt] = useState<Record<string, number>>(loadAgentActiveAt)
  useEffect(() => {
    const busy = Object.entries(projectActivity).filter(([, state]) => state === 'working' || state === 'blocked').map(([id]) => id)
    if (busy.length === 0) return
    setAgentActiveAt((prev) => {
      const next = { ...prev, ...Object.fromEntries(busy.map((id) => [id, Date.now()])) }
      try { localStorage.setItem(AGENT_AT_KEY, JSON.stringify(next)) } catch { /* 保存できなくても、この起動の間は効く */ }
      return next
    })
  }, [projectActivity])
  // オーケストラを親のフォルダにし、属するプロジェクトをその下に字下げして並べる（@shared/orchestras）。子の並びは今の並び順
  const displayed = sortProjects(projects.projects, view.sort, { activity: projectActivity, agentActiveAt })
  const [collapsedOrchestras, setCollapsedOrchestras] = useState<Set<string>>(loadCollapsedOrchestras)
  const toggleOrchestra = (id: string) => setCollapsedOrchestras((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    try { localStorage.setItem(COLLAPSED_ORCHESTRAS_KEY, JSON.stringify([...next])) } catch { /* 保存できなくても、この起動の間は効く */ }
    return next
  })
  const rows = treeRows(projects.projects, filterProjects(displayed, view), collapsedOrchestras)
  const shown = rows.map((r) => r.project)
  const depthOf = new Map(rows.map((r) => [r.project.id, r.depth]))
  const rowOf = new Map(rows.map((r) => [r.project.id, r]))

  /**
   * 並べ替え。全体の並びは今の表示の順で、☆ の中・外のそれぞれの中で動かす（☆ は上にまとめるため）。
   * 手動以外の並び順で動かしたら、その時点の並びを手動の順として保存して「手動」に切り替える。
   * 並びは main が settings に保存し、projects:changed で一覧が届く
   */
  const projectIds = displayed.map((p) => p.id)
  const shownIds = shown.map((p) => p.id)
  const starredOf = (id: string) => !!projects.projects.find((p) => p.id === id)?.starred
  const orchestraOfId = (id: string) => {
    const p = projects.projects.find((x) => x.id === id)
    return p ? (isOrchestra(p) ? `o:${p.id}` : orchestraIdOf(projects.projects, p)) : null
  }
  // キーボードの並べ替えは、☆ の中・外とオーケストラが同じもの同士（オーケストラ同士はオーケストラの中で）
  const sameGroup = (id: string) => (other: string) => starredOf(other) === starredOf(id) && (orchestraOfId(id)?.startsWith('o:') ? !!orchestraOfId(other)?.startsWith('o:') : orchestraOfId(other) === orchestraOfId(id))
  /** ツリーの中へ落としたとき（別のオーケストラへ移す・並べ替える） */
  const dropInTree = (draggingId: string, targetId: string, position: 'before' | 'after') => {
    const move = treeDrop(projects.projects, rows, draggingId, targetId, position)
    if (!move) return
    run(() => window.ade.invoke('project:move', move.id, move.to, move.before))
    if (view.sort !== 'manual') {
      setView({ ...view, sort: 'manual' })
      toast({ tone: 'info', message: t('sidebar.sort.switchedToManual') })
    }
  }
  const reorder = (next: string[] | null) => {
    if (!next) return
    run(() => window.ade.invoke('project:reorder', next))
    if (view.sort !== 'manual') {
      setView({ ...view, sort: 'manual' })
      toast({ tone: 'info', message: t('sidebar.sort.switchedToManual') })
    }
  }
  const stepOf = (id: string, delta: -1 | 1) => stepAmongVisible(projectIds, shownIds, id, delta, sameGroup(id))
  const moveProject = (id: string, delta: -1 | 1) => reorder(stepOf(id, delta))
  const toggleStar = (project: Project) => run(() => window.ade.invoke('project:update', { id: project.id, starred: !project.starred }))
  /** 以前の版で作ったオーケストレーターをやめる（Ferret が書いた subagent などを外す。いまは「すべてのプロジェクト」を使う） */
  const stopOrchestrator = (project: Project) => run(async () => {
    await window.ade.invoke('project:orchestrator', project.id, false)
    toast({ tone: 'success', message: t('orchestrator.disabled') })
  })
  const endDrag = () => {
    setDragging(null)
    setDropAt(null)
  }
  useEffect(() => {
    const id = refocus.current
    if (!id) return
    refocus.current = null
    rootRef.current?.querySelector<HTMLElement>(`[data-project-row="${CSS.escape(id)}"]`)?.focus()
  }, [projects])

  // 足したら、種類と確認先を決めてもらうため「プロジェクトを編集」を開く
  // 「プロジェクトを追加」は、自分の PC / GitHub から取得 / SSH を選ぶダイアログ（AddProjectDialog）
  const [adding, setAdding] = useState(false)
  const addProject = () => {
    setAdding(true)
    onOverlayChange?.(true)
  }
  // 足したら、種類と確認先を決めてもらうため「プロジェクトを編集」を開く（SSH はリモートの開発サーバーが分からないので開かない。
  // オーケストレーターは確認先を持たない（レビューは下のプロダクトで行う）ので開かない）
  const onAdded = (before: ReadonlySet<string>) => (state: ProjectsState, source: ProjectSource) => {
    const added = state.projects.find((p) => !before.has(p.id))
    if (added && source !== 'ssh' && !added.orchestrator) openEdit(added.id)
  }

  const switchTo = (project: Project) => run(() => window.ade.invoke('project:switch', project.id))

  const commitRename = (project: Project) => {
    const current = renamingRef.current
    setRenaming(null)
    const name = current?.id === project.id ? current.name.trim() : ''
    if (!name || name === project.name) return
    run(() => window.ade.invoke('project:update', { ...project, name }))
  }

  // 外からフォルダを落とすと、プロジェクトとして追加して開く（登録済みならそれに切り替える）。
  // ファイルだけのときは、どこを足すかを推し量らずにフォルダを落とすよう案内する
  const projectDrop = useExternalDrop((dataTransfer) => run(async () => {
    const entries = await readDrop(dataTransfer)
    const folders = entries.filter((entry) => entry.kind === 'dir')
    if (folders.length === 0) {
      toast({ tone: 'warning', message: t(entries.length > 0 ? 'drop.errors.notFolder' : 'drop.errors.unreadable') })
      return
    }
    for (const folder of folders) await window.ade.invoke('project:addDropped', folder.path)
  }))

  const menuProject = menu ? projects.projects.find((p) => p.id === menu.id) : undefined
  const editingProject = editingId ? projects.projects.find((p) => p.id === editingId) : undefined

  return (
    <aside className="sidebar" aria-label={t('sidebar.projects')} data-testid="sidebar" ref={rootRef} data-file-drop={projectDrop.over || undefined} {...projectDrop.props}>
      {projectDrop.over && <ExternalDropOverlay label={t('drop.sidebar.hint')} testId="sidebar-file-drop" />}
      <div className="sidebar__list">
        <div className="sb-head">
          <span className="sb-head__title">{t('sidebar.projects')}</span>
          {/* Tooltip はサイドバーの右端からはみ出して横スクロールを生むので、OS標準の title にする */}
          <IconButton
            size="sm"
            label={t('sidebar.addProject')}
            title={t('sidebar.addProject')}
            icon={<Plus size={14} strokeWidth={1.5} />}
            onClick={addProject}
            data-testid="sidebar-add-project"
          />
          {projects.projects.length > 0 && <IconButton
            size="sm"
            label={t('sidebar.viewOptions')}
            title={t('sidebar.viewOptions')}
            className={`rv-filter__toggle${view.starredOnly ? ' is-active' : ''}`}
            selected={viewOpen}
            icon={<ListFilter size={14} strokeWidth={1.75} />}
            onClick={() => setViewOpen(!viewOpen)}
            data-testid="sidebar-view-toggle"
          />}
          {/* プロジェクト一覧を閉じる（開き直すのはタイトルバー右の開閉ボタン・⌘B・設定ページ） */}
        </div>

        {viewOpen && projects.projects.length > 0 && (
          <div className="rv-filter__panel sb-view" data-testid="sidebar-view-panel">
            <div className="rv-filter__label">{t('sidebar.sort.label')}</div>
            <select className="rv-filter__select" aria-label={t('sidebar.sort.label')} value={view.sort} data-testid="sidebar-project-sort"
              onChange={(e) => setView({ ...view, sort: sanitizeProjectView({ sort: e.target.value }).sort })}>
              {PROJECT_SORTS.map((sort) => <option key={sort} value={sort}>{t(`sidebar.sort.${sort}`)}</option>)}
            </select>
            <label className="rv-filter__check">
              <input type="checkbox" checked={view.starredOnly} onChange={(e) => setView({ ...view, starredOnly: e.target.checked })} data-testid="sidebar-starred-only" />
              <span>{t('sidebar.starredOnly')}</span>
            </label>
          </div>
        )}

        {projects.projects.length === 0 ? (
          <EmptyState
            size="sm"
            testId="sidebar-empty"
            art={<EmptyStackArt />}
            title={t('sidebar.emptyTitle')}
            description={t('sidebar.emptyStartReviewing')}
            actions={<Button icon={<FolderPlus size={14} />} onClick={addProject}>{t('sidebar.addProject')}</Button>}
          />
        ) : (
          <div className="sb-tree" role="tree" aria-label={t('sidebar.projects')}>
            {shown.length === 0 && <p className="sb-tree__empty" data-testid="sidebar-no-starred">{t('sidebar.noStarred')}</p>}
            {shown.map((project) => {
              const active = project.id === activeProjectId
              const collapsed = rowOf.get(project.id)?.collapsed ?? false
              return (
                <div
                  key={project.id}
                  className={`sb-project${depthOf.get(project.id) === 1 ? ' sb-project--member' : ''}${isOrchestra(project) ? ' sb-project--orchestra' : ''}${active ? ' is-active' : ''}${dragging === project.id ? ' is-dragging' : ''}${dropAt?.id === project.id ? ` is-drop-${dropAt.position}` : ''}`}
                  data-testid="sidebar-project"
                  onDragOver={(e) => {
                    if (!dragging || !Array.from(e.dataTransfer.types).includes(PROJECT_DRAG_TYPE) || !treeDrop(projects.projects, rows, dragging, project.id, 'before')) return
                    e.preventDefault()
                    e.dataTransfer.dropEffect = 'move'
                    // 上か下かは見出しの行で決める
                    const row = (e.currentTarget.firstElementChild as HTMLElement | null)?.getBoundingClientRect()
                    const position = row ? dropPositionAt(e.clientY - row.top, row.height) : 'after'
                    if (dropAt?.id !== project.id || dropAt.position !== position) setDropAt({ id: project.id, position })
                  }}
                  onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null) && dropAt?.id === project.id) setDropAt(null)
                  }}
                  onDrop={(e) => {
                    if (!dragging || !Array.from(e.dataTransfer.types).includes(PROJECT_DRAG_TYPE)) return
                    e.preventDefault()
                    const row = (e.currentTarget.firstElementChild as HTMLElement | null)?.getBoundingClientRect()
                    const position = row ? dropPositionAt(e.clientY - row.top, row.height) : 'after'
                    dropInTree(dragging, project.id, position)
                    endDrag()
                  }}
                >
                  {renaming?.id === project.id ? (
                    <div className="sb-project__row is-editing">
                      <Field
                        autoFocus
                        aria-label={t('sidebar.projectName')}
                        value={renaming.name}
                        onChange={(e) => setRenaming({ id: project.id, name: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.nativeEvent.isComposing) commitRename(project)
                          if (e.key === 'Escape') setRenaming(null)
                        }}
                        onBlur={() => commitRename(project)}
                      />
                    </div>
                  ) : (
                    <div
                      role="treeitem"
                      tabIndex={0}
                      aria-selected={active}
                      {...(isOrchestra(project) ? { 'aria-expanded': !collapsed } : {})}
                      className="sb-project__row"
                      title={project.source === 'ssh' && project.ssh ? sshTargetLabel(project.ssh) : project.folderPath}
                      draggable
                      data-project-row={project.id}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(PROJECT_DRAG_TYPE, project.id)
                        // 並べ替え（move）と、ターミナルへのパスの挿入（copy）の両方を受ける
                        e.dataTransfer.effectAllowed = 'copyMove'
                        setDragging(project.id)
                      }}
                      onDragEnd={endDrag}
                      onClick={() => (active ? (isOrchestra(project) && toggleOrchestra(project.id)) : switchTo(project))}
                      onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return
                        // Alt+↑ / Alt+↓ で1つ上・下へ並べ替える
                        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                          e.preventDefault()
                          refocus.current = project.id
                          moveProject(project.id, e.key === 'ArrowUp' ? -1 : 1)
                          return
                        }
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          if (active) { if (isOrchestra(project)) toggleOrchestra(project.id) } else switchTo(project)
                        }
                        if (isOrchestra(project) && ((e.key === 'ArrowRight' && collapsed) || (e.key === 'ArrowLeft' && !collapsed))) toggleOrchestra(project.id)
                      }}
                      onContextMenu={(e) => {
                        e.preventDefault()
                        openMenuAt(project.id, e.clientX, e.clientY)
                      }}
                      data-testid={`sidebar-project-${project.id}`}
                    >
                      {isOrchestra(project) && <button type="button" className="sb-project__twisty" aria-label={t(rowOf.get(project.id)?.collapsed ? 'sidebar.orchestraExpand' : 'sidebar.orchestraCollapse', { name: project.name })} aria-expanded={!rowOf.get(project.id)?.collapsed}
                        onClick={(e) => { e.stopPropagation(); toggleOrchestra(project.id) }} data-testid={`sidebar-orchestra-toggle-${project.id}`}>
                        <ChevronDown size={12} strokeWidth={2} className={rowOf.get(project.id)?.collapsed ? 'is-collapsed' : ''} />
                      </button>}
                      <span className="sb-project__icon" aria-hidden="true" title={t(`projectSource.source.${project.source ?? 'local'}` as TranslationKey)}>
                        {project.source && project.source !== 'local'
                          ? <ProjectSourceIcon project={project} />
                          : active ? <FolderOpen size={14} strokeWidth={1.5} /> : <Folder size={14} strokeWidth={1.5} />}
                      </span>
                      <span className="sb-project__name" title={project.name}>{project.name}</span>
                      {project.orchestraExcluded && (
                        <span className="sb-project__starred sb-project__excluded" role="img" aria-label={t('orchestra.excludedBadge')} title={t('orchestra.excludedBadge')} data-testid="sidebar-project-excluded">
                          <CircleSlash size={11} strokeWidth={2} />
                        </span>
                      )}
                      {project.orchestrator && (
                        <span className="sb-project__starred" role="img" aria-label={t(project.editorWorkspace ? 'editorWorkspace.hint' : 'orchestrator.badge')} title={t(project.editorWorkspace ? 'editorWorkspace.hint' : 'orchestrator.badge')} data-testid={project.editorWorkspace ? 'sidebar-editor-workspace' : 'sidebar-project-orchestrator'}>
                          {ventureIds.has(project.id) ? <Briefcase size={11} strokeWidth={2} aria-label={t('venture.sidebarBadge')} data-testid="sidebar-venture" /> : <Network size={11} strokeWidth={2} />}
                        </span>
                      )}
                      {project.starred && (
                        <span className="sb-project__starred" role="img" aria-label={t('sidebar.starred')} title={t('sidebar.starred')} data-testid="sidebar-project-starred">
                          <Star size={11} strokeWidth={2} fill="currentColor" />
                        </span>
                      )}
                      {projectActivity[project.id] === 'working' && (
                        <span className="sb-project__working" role="img" aria-label={t('sidebar.agentWorking')} title={t('sidebar.agentWorking')} data-testid="sidebar-project-working">
                          <span /><span /><span />
                        </span>
                      )}
                      {/* Agent が確認（許可・質問）を待っている */}
                      {projectActivity[project.id] === 'blocked' && (
                        <span className="sb-project__agent sb-project__agent--blocked" role="img" aria-label={t('sidebar.agentBlocked')} title={t('sidebar.agentBlocked')} data-testid="sidebar-project-blocked">
                          <MessageCircleQuestionMark size={12} strokeWidth={2} />
                        </span>
                      )}
                      {/* Agent の作業が終わり、まだそのタブを見ていない（見ると消える） */}
                      {projectActivity[project.id] === 'done' && (
                        <span className="sb-project__agent sb-project__agent--done" role="img" aria-label={t('sidebar.agentDone')} title={t('sidebar.agentDone')} data-testid="sidebar-project-done">
                          <Check size={12} strokeWidth={2.5} />
                        </span>
                      )}
                      <span className="sb-project__actions" onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className={`sb-project__action${project.starred ? ' is-starred' : ''}`}
                          aria-label={project.starred ? t('sidebar.unstar') : t('sidebar.star')}
                          title={project.starred ? t('sidebar.unstar') : t('sidebar.star')}
                          aria-pressed={!!project.starred}
                          onClick={() => toggleStar(project)}
                          data-testid="sidebar-project-star"
                        >
                          <Star size={14} strokeWidth={1.5} fill={project.starred ? 'currentColor' : 'none'} />
                        </button>
                        <button
                          type="button"
                          className="sb-project__action"
                          aria-label={t('sidebar.projectMenu', { name: project.name })}
                          onClick={(e) => {
                            const r = e.currentTarget.getBoundingClientRect()
                            openMenuAt(project.id, r.right - MENU_WIDTH, r.bottom + 2)
                          }}
                          data-testid="sidebar-project-menu"
                        >
                          <Ellipsis size={14} strokeWidth={1.5} />
                        </button>
                      </span>
                    </div>
                  )}

                  {confirmRemove === project.id && (
                    <div className="sb-confirm">
                      <span>{t(isOrchestra(project) ? 'sidebar.removeOrchestraConfirm' : 'sidebar.removeConfirm', { name: project.name })}</span>
                      <span className="sb-confirm__actions">
                        <Button variant="ghost" onClick={() => setConfirmRemove(null)}>{t('sidebar.keep')}</Button>
                        <Button
                          variant="danger"
                          onClick={() => {
                            setConfirmRemove(null)
                            run(() => window.ade.invoke('project:remove', project.id))
                          }}
                          data-testid="sidebar-project-remove-confirm"
                        >
                          {t('sidebar.remove')}
                        </Button>
                      </span>
                    </div>
                  )}

                </div>
              )
            })}
          </div>
        )}
      </div>

      {menu && menuProject && (
        <div className="sb-menu" role="menu" style={{ left: menu.x, top: menu.y, width: MENU_WIDTH }} data-testid="sidebar-project-context">
          <button type="button" role="menuitem" onClick={() => { setMenu(null); setRenaming({ id: menuProject.id, name: menuProject.name }) }}>
            <Pencil size={13} strokeWidth={1.75} />{t('sidebar.rename')}
          </button>
          <button type="button" role="menuitem" onClick={() => { setMenu(null); openEdit(menuProject.id) }} data-testid="sidebar-project-edit">
            <Settings2 size={13} strokeWidth={1.75} />{t('projectTargets.edit')}
          </button>
          {/* オーケストラの対象・対象外（全体の subagent・巡回・全体への依頼に巻き込まない） */}
          {!menuProject.editorWorkspace && !menuProject.orchestrator && menuProject.source !== 'ssh' && <button type="button" role="menuitem" onClick={() => { setMenu(null); run(() => window.ade.invoke('project:update', { id: menuProject.id, orchestraExcluded: !menuProject.orchestraExcluded })) }} data-testid="sidebar-project-orchestra-toggle">
            <Network size={13} strokeWidth={1.75} />{menuProject.orchestraExcluded ? t('orchestra.include') : t('orchestra.exclude')}
          </button>}
          <button type="button" role="menuitem" onClick={() => { setMenu(null); toggleStar(menuProject) }} data-testid="sidebar-project-star-menu">
            <Star size={13} strokeWidth={1.75} />{menuProject.starred ? t('sidebar.unstar') : t('sidebar.star')}
          </button>
          <button type="button" role="menuitem" disabled={!stepOf(menuProject.id, -1)} onClick={() => { setMenu(null); moveProject(menuProject.id, -1) }} data-testid="sidebar-project-move-up">
            <ArrowUp size={13} strokeWidth={1.75} />{t('sidebar.moveUp')}
          </button>
          <button type="button" role="menuitem" disabled={!stepOf(menuProject.id, 1)} onClick={() => { setMenu(null); moveProject(menuProject.id, 1) }} data-testid="sidebar-project-move-down">
            <ArrowDown size={13} strokeWidth={1.75} />{t('sidebar.moveDown')}
          </button>
          {/* SSH のプロジェクトは手元のフォルダがレビューの置き場なので出さない */}
          {menuProject.source !== 'ssh' && <>
            <div className="sb-menu__sep" role="separator" />
            {menuProject.orchestrator && !menuProject.editorWorkspace && <button type="button" role="menuitem" onClick={() => { setMenu(null); stopOrchestrator(menuProject) }} data-testid="sidebar-project-orchestrator-menu">
              <Network size={13} strokeWidth={1.75} />{t('orchestrator.off')}
            </button>}
            <button type="button" role="menuitem" onClick={() => { setMenu(null); openRepoCreate(menuProject.id) }} data-testid="sidebar-project-create-repo">
              <FolderGit2 size={13} strokeWidth={1.75} />{t('repoCreate.menu')}
            </button>
          </>}
          <div className="sb-menu__sep" role="separator" />
          {/* 「すべてのプロジェクト」は外せない（Ferret が持つエディタ全体） */}
          {(!menuProject.editorWorkspace || projects.projects.filter(isOrchestra).length > 1) && <button type="button" role="menuitem" className="is-danger" onClick={() => { setMenu(null); setConfirmRemove(menuProject.id) }}>
            <Trash2 size={13} strokeWidth={1.75} />{t('sidebar.removeFromList')}
          </button>}
        </div>
      )}
      {/* セットアップが全部済むまで、下に小さな進み具合（Setup n/7）を出す。済んだら消える */}
      <SetupProgressLink />
      <FeedbackLink />
      {editingProject && <ProjectEditDialog project={editingProject} onClose={() => openEdit(null)} />}
      {(() => {
        const repoProject = repoCreateId ? projects.projects.find((p) => p.id === repoCreateId) : undefined
        return repoProject ? <CreateRepoDialog project={repoProject} onClose={() => openRepoCreate(null)} /> : null
      })()}
      {adding && <AddProjectDialog
        onClose={() => { setAdding(false); onOverlayChange?.(false) }}
        onAdded={onAdded(new Set(projects.projects.map((p) => p.id)))}
      />}
    </aside>
  )
}

/** 空のときの絵。重なったカードに、ペンの輪 */
function EmptyStackArt() {
  const id = useId()
  return (
    <svg
      className="sidebar__empty-art"
      width="96"
      height="64"
      viewBox="0 0 96 64"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="var(--brand-rose)" />
          <stop offset="1" stopColor="var(--brand-iris)" />
        </linearGradient>
      </defs>
      <rect x="22" y="6" width="56" height="16" rx="5" className="steps__card" opacity="0.5" />
      <rect x="16" y="16" width="64" height="18" rx="6" className="steps__card" opacity="0.75" />
      <rect x="10" y="28" width="76" height="28" rx="7" className="steps__card" />
      <rect x="18" y="36" width="12" height="12" rx="3" className="steps__ink steps__ink--strong" />
      <rect x="36" y="37" width="26" height="4" rx="2" className="steps__ink steps__ink--strong" />
      <rect x="36" y="45" width="18" height="3" rx="1.5" className="steps__ink" />
      <path
        className="steps__draw"
        d="M70 36c4 1 7 4 6 8-1 5-8 7-12 4-4-2-3-9 2-11"
        stroke={`url(#${id})`}
        strokeWidth="2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
