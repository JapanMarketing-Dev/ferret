import { useCallback, useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Download } from 'lucide-react'
import type { WhisperModelList, WhisperModelName, WhisperModelProgress } from '@shared/types'
import { Button } from '../ui'
import { useT } from '../lib/i18n'
import { errorMessage } from '../lib/errors'

/** 1.6 GB / 465 MB の形にする（単位は言語によらず同じ） */
function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}

type Status = { kind: 'idle' | 'running' | 'done' | 'aborted' } | { kind: 'failed'; message: string }

/**
 * 設定の文字起こしの欄（端末内）の「モデルをダウンロード」。
 * 一覧・進み具合・中止・再試行をここで持ち、終わったら onChanged で使える状態を読み直してもらう。
 * whisper-cli 自体が無ければ、OS ごとの入れ方を案内するだけにする（実行ファイルは落とさない）。
 */
export function WhisperModelSection({ disabled, onPickModel, onChanged }: { disabled: boolean; onPickModel: () => void; onChanged: () => void }) {
  const t = useT()
  const [list, setList] = useState<WhisperModelList | null>(null)
  const [choice, setChoice] = useState<WhisperModelName | null>(null)
  const [progress, setProgress] = useState<WhisperModelProgress | null>(null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })

  const reload = useCallback(() => window.ade.invoke('capture:whisperModels').then((next) => {
    setList(next)
    setChoice((prev) => prev ?? next.downloading ?? next.selected ?? next.models.find((m) => m.recommended)?.id ?? null)
    if (next.downloading) setStatus({ kind: 'running' })
  }).catch(() => undefined), []) // 失敗は main の IPC が Sentry へ送る（ここは既定のまま続ける）

  useEffect(() => {
    void reload()
    return window.ade.on('capture:modelProgress', setProgress)
  }, [reload])

  const start = () => {
    if (!choice) return
    setStatus({ kind: 'running' })
    setProgress(null)
    void window.ade.invoke('capture:downloadModel', choice)
      .then((r) => setStatus(r.ok ? { kind: 'done' } : r.reason === 'aborted' ? { kind: 'aborted' } : { kind: 'failed', message: r.message }))
      .catch((e: unknown) => setStatus({ kind: 'failed', message: errorMessage(e) }))
      .finally(() => { void reload(); onChanged() })
  }

  if (!list) return null
  const model = list.models.find((m) => m.id === choice)
  const running = status.kind === 'running'
  const hint = list.installHint

  return <div className="st-model" data-testid="whisper-model">
    {!list.binaryFound && <div className="st-note st-note--warn">
      <span><CircleAlert size={12} aria-hidden="true" />{t('stt.binary.missing')}</span>
      <span>{t(window.ade.platform === 'darwin' ? 'stt.binary.mac' : window.ade.platform === 'win32' ? 'stt.binary.windows' : 'stt.binary.linux')}</span>
      {hint.command && <code className="st-model__cmd">{hint.command}</code>}
      <code className="st-model__cmd">{hint.url}</code>
    </div>}
    {list.gpu === false && <div className="st-note" data-testid="whisper-cpu-only">
      <span><CircleAlert size={12} aria-hidden="true" />{t('stt.gpu.cpuOnly')}</span>
      <span>{t(window.ade.platform === 'win32' ? 'stt.gpu.windows' : window.ade.platform === 'darwin' ? 'stt.gpu.mac' : 'stt.gpu.linux')}</span>
    </div>}
    <label className="st-row"><span className="st-row__label">{t('stt.model.label')}</span>
      <span className="rv-select"><select className="st-select" aria-label={t('stt.model.label')} value={choice ?? ''} disabled={disabled || running} onChange={(e) => setChoice(e.target.value as WhisperModelName)}>
        {list.models.map((m) => <option key={m.id} value={m.id}>
          {t(m.downloaded ? 'stt.model.optionDownloaded' : m.recommended ? 'stt.model.optionRecommended' : 'stt.model.option', { name: m.id, size: formatSize(m.bytes) })}
        </option>)}
      </select></span>
    </label>
    {running && progress && progress.modelId === choice && <>
      <progress className="st-model__bar" max={progress.totalBytes} value={progress.receivedBytes} style={{ width: '100%' }} />
      <p className="st-note">{progress.phase === 'verify' ? t('stt.model.verifying')
        : t('stt.model.downloading', { received: formatSize(progress.receivedBytes), total: formatSize(progress.totalBytes) })}</p>
    </>}
    {status.kind === 'done' && <p className="st-note st-note--ok"><CircleCheck size={12} aria-hidden="true" />{t('stt.model.done')}</p>}
    {status.kind === 'aborted' && <p className="st-note">{t('stt.model.aborted')}</p>}
    {status.kind === 'failed' && <p className="st-note st-note--warn" role="alert"><CircleAlert size={12} aria-hidden="true" />{t('stt.model.failed', { message: status.message })}</p>}
    {status.kind !== 'done' && list.selected && list.selected === choice && !running &&
      <p className="st-note st-note--ok"><CircleCheck size={12} aria-hidden="true" />{t('stt.model.inUse', { name: list.selected })}</p>}
    <div className="st-key__actions">
      <Button variant="ghost" disabled={disabled || running} onClick={onPickModel}>{t('stt.model.pickFile')}</Button>
      {running
        ? <Button variant="ghost" onClick={() => void window.ade.invoke('capture:cancelModelDownload')}>{t('stt.model.cancel')}</Button>
        : model && !(model.downloaded && list.selected === model.id) && <Button icon={<Download size={14} />} disabled={disabled} onClick={start} data-testid="whisper-model-download">
          {status.kind === 'failed' ? t('stt.model.retry') : model.downloaded ? t('stt.model.use') : model.partialBytes > 0 ? t('stt.model.resume') : t('stt.model.download')}
        </Button>}
    </div>
    <p className="st-note">{t('stt.model.source')}</p>
  </div>
}
