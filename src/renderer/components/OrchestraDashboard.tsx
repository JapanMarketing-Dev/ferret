import type { Project } from '@shared/types'
import { orchestraMembers } from '@shared/orchestras'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useProjectActivity } from '../terminal/agentActivity'
import { useToast } from '../ui'
import { AgentRequestsSection } from './AgentRequestsSection'
import { OrchestraComposer } from './OrchestraComposer'

/**
 * オーケストラのダッシュボード。全体への指示と依頼の雛形を送り、プロダクトを開く・対象から外す・アーカイブするだけ。
 * - 全体への指示の欄（開いているオーケストラの Agent へ文を送る）
 * - Agent への依頼（雛形を選んで送る・まとめて送る・1回きりのものは隠す）
 * - プロダクトの表：オーケストラの対象・対象外、Agent の動き、開く・アーカイブ
 * 未対応の指摘・確認リスト（human.md）・インフラのコスト・今月／今年の集計は、使われていなかったので出さない（2026-11-13 本人指示）
 */
export function OrchestraDashboard({ projects, orchestraId, onOpenProject }: {
  projects: readonly Project[]
  /** 開いているオーケストラの id */
  orchestraId: string
  onOpenProject: (projectId: string) => void
}) {
  const t = useT()
  const toast = useToast()
  const activity = useProjectActivity()
  const rows = orchestraMembers(projects, orchestraId, { includeExcluded: true })

  const toggleIncluded = (id: string, included: boolean) => {
    void window.ade.invoke('project:update', { id, orchestraExcluded: !included })
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  /** プロダクトをアーカイブする（消さずに一覧・オーケストラから隠す。元に戻すのはサイドバーの「アーカイブ済み」） */
  const archive = (id: string, name: string) => {
    void window.ade.invoke('project:update', { id, archived: true })
      .then(() => toast({ tone: 'success', message: t('archive.archived', { name }) }))
      .catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  return <div className="orchestra" data-testid="orchestra-dashboard">
    <header className="orchestra__head">
      <h2 className="orchestra__title">{t('orchestra.dashboardTitle')}</h2>
    </header>
    <OrchestraComposer />
    <section className="orchestra__section" data-testid="orchestra-requests">
      <h3>{t('orchestra.requestsTitle')}</h3>
      <AgentRequestsSection />
    </section>
    <section className="orchestra__section" data-testid="orchestra-projects">
      <h3>{t('orchestra.projectsTitle')}</h3>
      {rows.length === 0 ? <p className="st-note">{t('orchestra.noProducts')}</p> : <table className="orchestra__table">
        <thead>
          <tr>
            <th>{t('orchestra.colIncluded')}</th>
            <th>{t('orchestra.colProject')}</th>
            <th>{t('orchestra.colAgent')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const state = activity[r.id]
            const included = !r.orchestraExcluded
            return <tr key={r.id} className={included ? '' : 'is-excluded'} data-testid={`orchestra-row-${r.id}`}>
              <td><input type="checkbox" checked={included} aria-label={t('orchestra.colIncluded')} onChange={(e) => toggleIncluded(r.id, e.target.checked)} data-testid={`orchestra-include-${r.id}`} /></td>
              <td className="orchestra__name">{r.name}</td>
              <td><span className={`orchestra__state orchestra__state--${state ?? 'idle'}`}>{t(state === 'working' ? 'orchestra.stateWorking' : state === 'blocked' ? 'orchestra.stateBlocked' : 'orchestra.stateIdle')}</span></td>
              <td className="orchestra__cell-actions"><button type="button" className="st-link" onClick={() => onOpenProject(r.id)} data-testid={`orchestra-open-${r.id}`}>{t('orchestra.openProject')}</button>
                {' '}<button type="button" className="st-link" onClick={() => archive(r.id, r.name)} data-testid={`orchestra-archive-${r.id}`}>{t('archive.archive')}</button></td>
            </tr>
          })}
        </tbody>
      </table>}
    </section>
  </div>
}
