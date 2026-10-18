import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderPlus, Plus, Search } from 'lucide-react'
import type { AppMode, ProjectsState, WorkspaceState } from '@shared/types'
import { Button, EmptyState, ErrorBoundary, IconButton, useToast } from '../ui'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { latestResearchProject, researchProjects } from '../lib/businessShell'
import { ResearchWorkspace } from './ResearchWorkspace'

/**
 * 上のモード切替（エディタ・フィードバック・ビジネスリサーチ）の「ビジネスリサーチ」。選んだときだけ中央にリサーチの画面を出す。
 * - 入ると、リサーチのフォルダ（research: true のプロジェクト）を開く（最後に開いたもの）。ターミナルの Agent もそのフォルダで動くので、
 *   依頼を送ると Agent がそのフォルダの記録を書く
 * - エディタ・フィードバックへ戻ると、入る前に開いていたプロジェクトへ戻す
 * - 「プロジェクトにする」で作ったビジネスは、エディタでそのプロジェクトを開く（「ビジネス」タブ S1〜S10 はエディタの中）
 * main のモード（mode:set）は変えない（リサーチの画面はエディタの枠の中で中央を差し替えるだけ）
 */
export interface ResearchMode {
  active: boolean
  enter: (mode: AppMode, changeMode: (mode: AppMode) => void) => void
  leave: (next: AppMode, changeMode: (mode: AppMode) => void) => void
  /** 作ったビジネスのプロジェクトをエディタで開く */
  openProject: (id: string) => void
}

export function useResearchMode(projects: ProjectsState, workspace: WorkspaceState, mode: AppMode): ResearchMode {
  const [active, setActive] = useState(false)
  /** 入る前に開いていたプロジェクト（戻るときに開き直す） */
  const previous = useRef<string | null>(null)
  const current = projects.projects.find((p) => p.id === workspace.projectId)
  const currentRef = useRef(current)
  currentRef.current = current
  const projectsRef = useRef(projects)
  projectsRef.current = projects

  // リサーチのフォルダを開いた（起動時に戻した・ほかから切り替えた）ら、リサーチの画面にする
  useEffect(() => {
    if (current?.research) setActive(true)
  }, [current?.id, current?.research])
  // 録画などでフィードバックへ移ったら、リサーチの画面は閉じる
  useEffect(() => {
    if (mode === 'feedback') setActive(false)
  }, [mode])

  const enter = useCallback((mode: AppMode, changeMode: (mode: AppMode) => void) => {
    if (mode === 'feedback') changeMode('editor')
    setActive(true)
    const now = currentRef.current
    if (now?.research) return
    previous.current = now?.id ?? null
    const target = latestResearchProject(projectsRef.current.projects)
    if (target) void window.ade.invoke('project:switch', target.id).catch(() => undefined)
  }, [])

  const leave = useCallback((next: AppMode, changeMode: (mode: AppMode) => void) => {
    setActive(false)
    const back = previous.current
    previous.current = null
    if (currentRef.current?.research && back && projectsRef.current.projects.some((p) => p.id === back)) {
      void window.ade.invoke('project:switch', back).catch(() => undefined)
    }
    changeMode(next)
  }, [])

  const openProject = useCallback((id: string) => {
    setActive(false)
    previous.current = null
    void window.ade.invoke('project:switch', id).catch(() => undefined)
  }, [])

  return { active, enter, leave, openProject }
}

/** 中央の画面（リサーチのフォルダの切り替え ＋ 開いているリサーチ） */
export function ResearchModeView({ projects, workspace, onOpenProject }: { projects: ProjectsState; workspace: WorkspaceState; onOpenProject: (id: string) => void }) {
  const t = useT()
  const toast = useToast()
  const list = researchProjects(projects.projects)
  const current = list.find((p) => p.id === workspace.projectId) ?? null
  const run = (task: () => Promise<unknown>) => { void task().catch((err: unknown) => toast({ tone: 'danger', message: errorMessage(err) })) }
  const add = () => run(() => window.ade.invoke('research:addProject'))
  return (
    <div className="rs-mode" data-testid="research-mode">
      {list.length > 0 && (
        <div className="rs-mode__bar" role="tablist" aria-label={t('research.mode.folders')}>
          {list.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={p.id === current?.id} className="rs-mode__folder" title={p.folderPath}
              onClick={() => { if (p.id !== current?.id) run(() => window.ade.invoke('project:switch', p.id)) }} data-testid={`research-mode-folder-${p.id}`}>
              <Search size={12} strokeWidth={1.75} /><span>{p.name}</span>
            </button>
          ))}
          <IconButton size="sm" label={t('research.sidebar.add')} title={t('research.sidebar.add')} icon={<Plus size={14} strokeWidth={1.5} />} onClick={add} data-testid="research-mode-add" />
        </div>
      )}
      <div className="rs-mode__body">
        {current ? (
          <ErrorBoundary name="research"><ResearchWorkspace projectKey={current.id} onOpenProject={onOpenProject} /></ErrorBoundary>
        ) : (
          <div className="editor-area">
            <EmptyState
              className="empty--hero"
              title={t(list.length ? 'research.mode.pickTitle' : 'research.mode.emptyTitle')}
              description={t('research.sidebar.empty')}
              actions={<Button variant="primary" icon={<FolderPlus size={15} strokeWidth={2} />} onClick={add} data-testid="research-mode-empty-add">{t('research.sidebar.add')}</Button>}
            />
          </div>
        )}
      </div>
    </div>
  )
}
