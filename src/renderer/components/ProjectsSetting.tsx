import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { archivedProjects } from '@shared/projectArchive'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useToast } from '../ui'

/**
 * 設定の「プロジェクト」。作業用のフォルダ「work」をサイドバーに出す・隠す（隠す＝アーカイブ。src/main/workProject.ts）と、
 * アーカイブしたプロジェクト・オーケストラの一覧と「元に戻す」（@shared/projectArchive）。
 * 自分で一覧を読み、変えたら main の project:update ですぐ保存する
 */
export function ProjectsSetting() {
  const t = useT()
  const toast = useToast()
  const [projects, setProjects] = useState<Project[] | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.ade.invoke('project:list').then((list) => { if (!cancelled) setProjects(list.projects) }).catch(() => undefined) // 失敗は main の IPC が Sentry へ送る
    const off = window.ade.on('projects:changed', (state) => setProjects(state.projects))
    return () => { cancelled = true; off() }
  }, [])

  if (!projects) return null
  const work = projects.find((p) => p.work)
  const archived = archivedProjects(projects)
  const setArchived = (project: Project, value: boolean) => {
    void window.ade.invoke('project:update', { id: project.id, archived: value })
      .then((state) => setProjects(state.projects))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  return <div className="st-page__group" data-testid="projects-setting">
    {work && <>
      <label className="st-row st-row--switch" data-testid="work-project-setting">
        <span className="st-row__label">{t('workProject.show')}</span>
        <input type="checkbox" role="switch" className="st-switch" checked={!work.archived} onChange={(e) => setArchived(work, !e.target.checked)} />
      </label>
      <p className="st-note">{t('workProject.hint', { path: work.folderPath })}</p>
    </>}
    <h3 className="st-page__subheading">{t('archive.settingsTitle')}</h3>
    <p className="st-note">{t('archive.hint')}</p>
    {archived.length === 0
      ? <p className="st-note" data-testid="archive-empty">{t('archive.empty')}</p>
      : archived.map((p) => <div key={p.id} className="st-row" data-testid={`archive-row-${p.id}`}>
        <span className="st-row__label" title={p.folderPath}>{p.name}</span>
        <button type="button" className="st-link" onClick={() => setArchived(p, false)} data-testid={`archive-restore-${p.id}`}>{t('archive.restore')}</button>
      </div>)}
  </div>
}
