import { useState, type ReactNode } from 'react'
import { Archive, ArchiveRestore, ChevronDown } from 'lucide-react'
import type { Project } from '@shared/types'
import { archivedProjects } from '@shared/projectArchive'
import { useT } from '../lib/i18n'
import '../styles/archive.css'

/**
 * サイドバーの一覧の下の「アーカイブ済み（n）」。しばらく使わない・待ちのプロジェクトとオーケストラ（@shared/projectArchive）。
 * 既定は畳んでおき、開くと名前と「元に戻す」を並べる。戻すと前と同じ場所・設定で一覧に戻る。
 * 何もアーカイブしていなければ出さない
 */
export function ArchivedProjects({ projects, onRestore, onMenu, confirm }: {
  projects: readonly Project[]
  onRestore: (project: Project) => void
  /** 右クリックで、一覧と同じメニュー（元に戻す・一覧から外す）を開く */
  onMenu?: (project: Project, clientX: number, clientY: number) => void
  /** 行の下に出す確かめ（一覧から外すとき） */
  confirm?: (project: Project) => ReactNode
}) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const archived = archivedProjects(projects)
  if (!archived.length) return null
  return <div className="sb-archive" data-testid="sidebar-archive">
    <button type="button" className="sb-archive__head" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="sidebar-archive-toggle">
      <ChevronDown size={12} strokeWidth={2} className={open ? '' : 'is-collapsed'} />
      <Archive size={13} strokeWidth={1.75} />
      <span>{t('archive.section', { count: archived.length })}</span>
    </button>
    {open && <ul className="sb-archive__list">
      {archived.map((p) => <li key={p.id}>
        <div className="sb-archive__item" data-testid={`sidebar-archived-${p.id}`}
          onContextMenu={onMenu ? (e) => { e.preventDefault(); onMenu(p, e.clientX, e.clientY) } : undefined}>
        <span className="sb-archive__name" title={p.folderPath}>{p.name}</span>
        <button type="button" className="st-link sb-archive__restore" onClick={() => onRestore(p)} data-testid={`sidebar-archive-restore-${p.id}`}>
          <ArchiveRestore size={12} strokeWidth={1.75} />{t('archive.restore')}
        </button>
        </div>
        {confirm?.(p)}
      </li>)}
    </ul>}
  </div>
}
