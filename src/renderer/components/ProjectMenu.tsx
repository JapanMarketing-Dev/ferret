import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Folder, FolderPlus } from 'lucide-react'
import type { Project, ProjectsState, WorkspaceState } from '@shared/types'
import { SHORTCUTS } from '../lib/shortcut'
import { errorMessage } from '../lib/errors'
import { Tooltip, useToast } from '../ui'
import { useT } from '../lib/i18n'
import { activeProjects } from '@shared/projectArchive'

/**
 * タイトルバーのプロジェクト切替（簡易版）。
 * 一覧・名前変更・登録解除の本体は左サイドバー（Sidebar.tsx）。ここは切替と追加だけを持つ。
 *
 * ⚠ 開いている間は内蔵ブラウザのビューを隠す（onOpenChange）。
 * ネイティブのビューはDOMの上に重なり、下向きに開く一覧が隠れてしまうため。
 */
export function ProjectMenu({
  workspace,
  projects,
  onOpenChange
}: {
  workspace: WorkspaceState
  projects: ProjectsState
  onOpenChange?: (open: boolean) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const toast = useToast()
  const t = useT()

  const setMenu = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }

  // 外側のクリックと Esc で閉じる
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMenu(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
    // setMenu は毎回作り直されるが、中身は open にしか依存しない
  }, [open])

  const run = (fn: () => Promise<unknown>) => {
    setMenu(false)
    void fn().catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  const switchTo = (project: Project) => run(() => window.ade.invoke('project:switch', project.id))
  const activeId = workspace.projectId ?? projects.activeProjectId
  // アーカイブしたものは並べない（元に戻すのはサイドバーの「アーカイブ済み」。@shared/projectArchive）
  const listed = activeProjects(projects.projects)

  return (
    <div className="project-menu" ref={rootRef}>
      <Tooltip label={t('projectMenu.switch')}>
        <button
          type="button"
          className="titlebar__project"
          // 長い名前は省略されるので、全文は OS 標準の title で見せる（Tooltip は操作の説明に使う）
          title={workspace.folderName ?? undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setMenu(!open)}
          data-testid="folder-button"
        >
          <Folder className="titlebar__project-icon" size={13} strokeWidth={1.75} />
          <span
            className={`titlebar__project-name${workspace.folderName ? '' : ' is-empty'}`}
            data-testid="folder-name"
          >
            {workspace.folderName ?? t('projectMenu.noFolder')}
          </span>
          <ChevronDown className="titlebar__project-caret" size={12} strokeWidth={2} />
        </button>
      </Tooltip>

      {open && (
        <div className="project-menu__panel" role="menu" aria-label={t('projectMenu.label')} data-testid="project-menu">
          {listed.length > 0 && (
            <ul className="project-menu__list">
              {listed.map((project) => {
                const active = project.id === activeId
                return (
                  <li key={project.id} className={`project-menu__item${active ? ' is-active' : ''}`}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className="project-menu__row"
                      title={project.folderPath}
                      onClick={() => (active ? setMenu(false) : switchTo(project))}
                      data-testid="project-item"
                    >
                      <span className="project-menu__check" aria-hidden="true">
                        {active && <Check size={13} strokeWidth={2} />}
                      </span>
                      <span className="project-menu__text">
                        <span className="project-menu__name">{project.name}</span>
                        <span className="project-menu__path">{project.folderPath}</span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
          <button
            type="button"
            role="menuitem"
            className="project-menu__add"
            onClick={() => run(() => window.ade.invoke('project:add'))}
            data-testid="project-add"
          >
            <FolderPlus size={14} strokeWidth={1.75} />
            <span>{t('projectMenu.add')}</span>
            <kbd className="project-menu__kbd">{SHORTCUTS.openFolder()}</kbd>
          </button>
        </div>
      )}
    </div>
  )
}
