import { useState } from 'react'
import { FolderOpen, FolderPlus, Plus, Trash2 } from 'lucide-react'
import type { Project } from '@shared/types'
import type { MemberRole } from '@shared/venture/model'
import type { MemberView, VentureSnapshot } from '@shared/venture/ipc'
import { useT } from '../lib/i18n'
import { Badge, Button } from '../ui'
import { useVentureApi } from './api'
import { Card, tk, useVentureAction } from './parts'
import { candidateProjects, membersByRole } from './view'

export function MembersTab({ snapshot, projects, onSnapshot, onOpenProject }: {
  snapshot: VentureSnapshot
  projects: readonly Project[]
  onSnapshot: (s: VentureSnapshot) => void
  onOpenProject: (projectId: string) => void
}) {
  const t = useT()
  return <div className="vt-stack" data-testid="venture-members">
    <p className="vt-muted vt-small">{t('venture.members.note')}</p>
    {membersByRole(snapshot.members).map(({ role, members }) => <RoleCard key={role} role={role} members={members} all={snapshot.members} projects={projects} ventureProjectId={snapshot.projectId} onSnapshot={onSnapshot} onOpenProject={onOpenProject} />)}
  </div>
}

function RoleCard({ role, members, all, projects, ventureProjectId, onSnapshot, onOpenProject }: {
  role: MemberRole
  members: MemberView[]
  all: MemberView[]
  projects: readonly Project[]
  ventureProjectId: string
  onSnapshot: (s: VentureSnapshot) => void
  onOpenProject: (projectId: string) => void
}) {
  const t = useT()
  const api = useVentureApi()
  const { busy, run } = useVentureAction(onSnapshot)
  const candidates = candidateProjects(projects, all, role, ventureProjectId)
  const [pick, setPick] = useState('')
  const chosen = candidates.some((p) => p.id === pick) ? pick : ''
  const selectId = `vt-member-${role}`
  return <Card title={t(tk(`venture.role.${role}`))} testId={`venture-role-${role}`}>
    <p className="vt-muted vt-small">{t(tk(`venture.role.${role}.hint`))}</p>
    {members.length === 0 ? <p className="vt-muted">{t('venture.members.none')}</p> : <ul className="vt-list">
      {members.map((m) => <li key={m.folder} className="vt-member" data-testid={`venture-member-${role}`}>
        <span className="vt-member__name">{m.name}</span>
        <span className="vt-muted vt-mono vt-small vt-ellipsis" title={m.folder}>{m.folder}</span>
        {!m.exists && <Badge tone="danger">{t('venture.members.missing')}</Badge>}
        {m.exists && !m.inOrchestra && <Badge tone="warning">{t('venture.members.outside')}</Badge>}
        <span className="vt-spacer" />
        {m.projectId && <Button variant="ghost" icon={<FolderOpen size={13} />} onClick={() => onOpenProject(m.projectId!)}>{t('venture.members.open')}</Button>}
        <Button variant="ghost" icon={<Trash2 size={13} />} busy={busy === `remove-${m.folder}`} onClick={() => void run(`remove-${m.folder}`, () => api.invoke('venture:removeMember', { role, folder: m.folder }))} data-testid={`venture-member-remove-${role}`}>{t('venture.members.remove')}</Button>
      </li>)}
    </ul>}
    <div className="vt-form-row">
      <label className="vt-field vt-grow" htmlFor={selectId}>
        <span>{t('venture.members.fromProjects')}</span>
        <select id={selectId} className="vt-select" value={chosen} onChange={(e) => setPick(e.target.value)} disabled={candidates.length === 0} data-testid={`venture-member-select-${role}`}>
          <option value="">{candidates.length === 0 ? t('venture.members.noCandidates') : t('venture.members.choose')}</option>
          {candidates.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>
      <Button icon={<Plus size={13} />} disabled={!chosen} busy={busy === 'add'} onClick={() => void run('add', () => api.invoke('venture:addMember', { role, projectId: chosen })).then((next) => { if (next) setPick('') })} data-testid={`venture-member-add-${role}`}>{t('venture.members.add')}</Button>
      <Button variant="ghost" icon={<FolderPlus size={13} />} busy={busy === 'pick'} onClick={() => void run('pick', () => api.invoke('venture:addMember', { role }))} data-testid={`venture-member-pick-${role}`}>{t('venture.members.pickFolder')}</Button>
    </div>
  </Card>
}
