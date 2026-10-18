import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Briefcase } from 'lucide-react'
import type { Project } from '@shared/types'
import type { VentureStatus } from '@shared/venture/ipc'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, useToast } from '../ui'
import { useVentureApi } from './api'
import { VentureWorkspace } from './VentureWorkspace'
import '../styles/venture.css'

/**
 * オーケストラのダッシュボードの入口。venture:status でビジネスか確かめ、
 * ビジネスなら VentureWorkspace、そうでなければ今までのダッシュボード（orchestra）と、上に小さな「ビジネスとして追う」の帯
 */
export function VentureOrOrchestra({ projectId, projects, onOpenFile, onOpenProject, orchestra }: {
  /** 開いているプロジェクト（変われば確かめ直す） */
  projectId?: string | null
  projects: readonly Project[]
  onOpenFile?: (path: string) => void
  onOpenProject: (projectId: string) => void
  orchestra: ReactNode
}) {
  const t = useT()
  const toast = useToast()
  const api = useVentureApi()
  const [status, setStatus] = useState<VentureStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [converting, setConverting] = useState(false)

  const check = useCallback(() => {
    let alive = true
    api.invoke('venture:status').then((s) => {
      if (!alive) return
      setStatus(s)
      setStatusError(null)
    }).catch((err) => {
      if (!alive) return
      setStatus(null)
      setStatusError(errorMessage(err))
    })
    return () => { alive = false }
  }, [api])

  // biome-ignore lint/correctness/useExhaustiveDependencies: projectId は確かめ直す合図
  useEffect(() => {
    setStatus(null)
    return check()
  }, [check, projectId])
  useEffect(() => api.onChanged(() => { check() }), [api, check])

  const convert = () => {
    if (converting) return
    setConverting(true)
    api.invoke('venture:convert').then(() => {
      toast({ tone: 'success', message: t('venture.convert.done') })
      check()
    }).catch((err) => toast({ tone: 'warning', message: t('venture.convert.failed'), detail: errorMessage(err) }))
      .finally(() => setConverting(false))
  }

  const settled = status !== null
  if (settled && status.isVenture) {
    return <VentureWorkspace key={status.projectId ?? 'venture'} projects={projects} onOpenFile={onOpenFile} onOpenProject={onOpenProject} orchestra={orchestra} />
  }

  // 確かめ終わるまでは何も出さない（ビジネスなのに一瞬オーケストラが出て読み込みを始めないように）
  if (!settled && !statusError) return <div className="vt-host" data-testid="venture-status-pending" />

  return <div className="vt-host">
    {settled && status.isOrchestra && <div className="vt-band" data-testid="venture-convert-band">
      <Briefcase size={14} aria-hidden="true" />
      <span className="vt-band__text">{t('venture.convert.hint')}</span>
      <Button busy={converting} onClick={convert} data-testid="venture-convert">{t('venture.convert.button')}</Button>
    </div>}
    {statusError && <p className="vt-band vt-band--muted" data-testid="venture-status-error" title={statusError}>{t('venture.status.failed', { reason: statusError })}</p>}
    <div className="vt-host__body">{orchestra}</div>
  </div>
}
