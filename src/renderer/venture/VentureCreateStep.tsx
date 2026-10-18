import { useState } from 'react'
import type { ProjectsState } from '@shared/types'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Button, Field, useToast } from '../ui'
import { useVentureApi } from './api'

/**
 * 「プロジェクトを追加」→「ビジネスを作る」。名前を入れて作る（親のフォルダは main がダイアログで聞き、<親>/<名前> に作って開く）。
 * やめたら何もしない
 */
export function VentureCreateStep({ onDone }: { onDone: (state: ProjectsState) => void }) {
  const t = useT()
  const toast = useToast()
  const api = useVentureApi()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const create = () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    api.invoke('venture:create', { name: trimmed })
      .then((state) => { if (state) onDone(state) })
      .catch((err) => toast({ tone: 'warning', message: t('venture.create.failed'), detail: errorMessage(err) }))
      .finally(() => setBusy(false))
  }
  return <div className="apd__body">
    <label className="pt-field">
      <span>{t('venture.create.name')}</span>
      <Field autoFocus value={name} maxLength={80} placeholder={t('venture.create.namePlaceholder')} disabled={busy}
        onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) create() }} data-testid="venture-create-name" />
    </label>
    <p className="st-note">{t('venture.create.hint')}</p>
    <div className="apd__actions">
      <Button variant="primary" disabled={!name.trim()} busy={busy} onClick={create} data-testid="venture-create">{t('venture.create.button')}</Button>
    </div>
  </div>
}
