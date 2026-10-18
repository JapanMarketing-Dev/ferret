import { useEffect, useState } from 'react'
import { Save } from 'lucide-react'
import { EXECUTION_KEYS, type ExecutionItem, type ExecutionKey } from '@shared/research/model'
import type { BusinessData } from '@shared/business/model'
import type { BusinessSnapshot } from '@shared/business/ipc'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { Badge, Button, useToast } from '../ui'
import { ExecutionList } from '../research/ExecutionList'
import { sameJson } from '../research/view'
import { useBusinessApi } from './api'
import { Section } from './fields'
import '../styles/research.css'

function emptyExecution(): Record<ExecutionKey, ExecutionItem> {
  return Object.fromEntries(EXECUTION_KEYS.map((k) => [k, { plan: '', confirmed: false }])) as Record<ExecutionKey, ExecutionItem>
}

/**
 * ダッシュボードの「実行条件」（business.yaml の execution）。需要の検証だけでは事業は始まらないので、
 * 最初の有料取引・供給・最初の実験・利益と運用の4点を、プロジェクトにした後も並べておく（特に供給）。
 * 直したら保存を押す（business:updateBusiness の execution）
 */
export function ExecutionPanel({ data, onSaved }: { data: BusinessData; onSaved: (s: BusinessSnapshot) => void }) {
  const t = useT()
  const api = useBusinessApi()
  const toast = useToast()
  const saved = data.business.execution ?? emptyExecution()
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  const savedKey = JSON.stringify(saved)
  // biome-ignore lint/correctness/useExhaustiveDependencies: savedKey は保存済みの値が変わった合図
  useEffect(() => { setDraft(saved) }, [savedKey])
  const dirty = !sameJson(draft, saved)
  const save = async () => {
    setBusy(true)
    try {
      onSaved(await api.invoke('business:updateBusiness', { execution: draft }))
      toast({ tone: 'success', message: t('research.ws.saved') })
    } catch (err) {
      toast({ tone: 'danger', message: t('research.ws.saveFailed'), detail: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <Section
      title={t('business.exec.title')}
      testId="dash-execution"
      actions={
        <>
          {dirty && <Badge tone="warning">{t('research.ws.unsaved')}</Badge>}
          <Button icon={<Save size={13} />} disabled={!dirty} busy={busy} onClick={() => void save()} data-testid="dash-execution-save">{t('research.ws.save')}</Button>
        </>
      }
    >
      <p className="biz-muted">{t('business.exec.note')}</p>
      {!data.business.execution && <p className="biz-muted" data-testid="dash-execution-empty">{t('business.exec.empty')}</p>}
      <ExecutionList value={draft} onChange={(k, item) => setDraft((d) => ({ ...d, [k]: item }))} testId="dash-execution-list" />
    </Section>
  )
}
