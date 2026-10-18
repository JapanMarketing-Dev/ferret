import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, RotateCcw, Save, Trash2 } from 'lucide-react'
import { RECORD_KINDS, type RecordKind, type RecordTypes } from '@shared/business/model'
import type { BusinessSnapshot } from '@shared/business/ipc'
import { hasErrors, validateRecord, type Issue } from '@shared/business/rules'
import { Badge, Button, useToast } from '../ui'
import { useBusinessApi } from './api'
import { IssueLines, TextArea } from './fields'
import { errorText, recordsOf, sameRecord } from './view'

/** 開いているフォームの未保存の状態（画面を離れるときの確認に使う） */
export interface EditorGuard {
  dirty: boolean
  save: () => Promise<boolean>
  label: string
}

export interface FormProps<K extends RecordKind> {
  draft: RecordTypes[K]
  set: (patch: Partial<RecordTypes[K]>) => void
  issues: Issue[]
  snapshot: BusinessSnapshot
  dirty: boolean
}

/**
 * 記録1件の編集の枠（見出し・保存・未保存の表示・ほかで変わったときの知らせ）。
 * 中身のフォームは render で受け取る。
 */
export function RecordEditor<K extends RecordKind>({
  kind,
  id,
  initial,
  snapshot,
  onSaved,
  onBack,
  guardRef,
  title,
  headerExtra,
  render
}: {
  kind: K
  id: string
  /** 新しい記録のときの空の形。既存なら null */
  initial: RecordTypes[K] | null
  snapshot: BusinessSnapshot
  onSaved: (snapshot: BusinessSnapshot) => void
  onBack: () => void
  guardRef: { current: EditorGuard | null }
  title: (record: RecordTypes[K]) => string
  headerExtra?: (record: RecordTypes[K], dirty: boolean) => ReactNode
  render: (props: FormProps<K>) => ReactNode
}) {
  const api = useBusinessApi()
  const toast = useToast()
  const onDisk = useMemo(
    () => (recordsOf(snapshot.data, kind) as Array<RecordTypes[K]>).find((r) => r.id === id) ?? null,
    [snapshot, kind, id]
  )
  const diskBody = snapshot.bodies[id] ?? ''
  const [base, setBase] = useState<RecordTypes[K]>(() => onDisk ?? initial!)
  const [draft, setDraft] = useState<RecordTypes[K]>(() => onDisk ?? initial!)
  const [baseBody, setBaseBody] = useState(diskBody)
  const [body, setBody] = useState(diskBody)
  const [isNew, setIsNew] = useState(!onDisk)
  const [stale, setStale] = useState<null | 'changed' | 'deleted'>(null)
  const [saving, setSaving] = useState(false)
  const [refused, setRefused] = useState<Issue[]>([])
  const [savedAt, setSavedAt] = useState<string | null>(null)

  const dirty = !sameRecord(draft, base) || body !== baseBody

  // ディスクの記録が変わった（Agent が書いた・別の画面で保存した）
  // 読むのは今の値だけで、変わっても読み直さない（base は保存・読み直しのときだけ変える）
  const latest = useRef({ dirty, base, baseBody, isNew })
  latest.current = { dirty, base, baseBody, isNew }
  useEffect(() => {
    const now = latest.current
    if (!onDisk) {
      if (!now.isNew) setStale('deleted')
      return
    }
    if (sameRecord(onDisk, now.base) && diskBody === now.baseBody) return
    if (!now.dirty) {
      setBase(onDisk)
      setDraft(onDisk)
      setBaseBody(diskBody)
      setBody(diskBody)
      setIsNew(false)
      setStale(null)
    } else setStale('changed')
  }, [onDisk, diskBody])

  const issues = useMemo(() => validateRecord(kind, draft, snapshot.data), [kind, draft, snapshot])
  const blocked = hasErrors(issues)

  const save = async (): Promise<boolean> => {
    if (blocked) return false
    setSaving(true)
    try {
      const result = await api.invoke('business:saveRecord', kind, draft, body)
      if (!result.ok) {
        setRefused(result.issues)
        toast({ tone: 'danger', message: '保存できませんでした', detail: result.issues.find((i) => i.severity === 'error')?.message })
        return false
      }
      setRefused([])
      setBase(draft)
      setBaseBody(body)
      setIsNew(false)
      setStale(null)
      setSavedAt(new Date().toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }))
      onSaved(result.snapshot)
      return true
    } catch (err) {
      toast({ tone: 'danger', message: '保存できませんでした', detail: errorText(err) })
      return false
    } finally {
      setSaving(false)
    }
  }

  guardRef.current = { dirty, save, label: `${RECORD_KINDS[kind].label} ${id}` }
  useEffect(() => () => { guardRef.current = null }, [guardRef])

  const reloadFromDisk = () => {
    if (onDisk) {
      setBase(onDisk)
      setDraft(onDisk)
      setBaseBody(diskBody)
      setBody(diskBody)
    }
    setStale(null)
  }

  const remove = async () => {
    try {
      const next = await api.invoke('business:deleteRecord', kind, id)
      onSaved(next)
      setBase(draft)
      setBaseBody(body)
      guardRef.current = null
      toast({ tone: 'success', message: `${id} を削除しました` })
      onBack()
    } catch (err) {
      toast({ tone: 'danger', message: '削除できませんでした', detail: errorText(err) })
    }
  }

  const [confirmDelete, setConfirmDelete] = useState(false)
  const refusedOnly = refused.filter((r) => !issues.some((i) => i.message === r.message))
  const name = title(draft)

  return (
    <div className="biz-editor" data-testid={`editor-${kind}`} data-dirty={dirty || undefined}>
      <header className="biz-editor__head">
        <Button variant="ghost" icon={<ChevronLeft size={14} />} onClick={onBack} data-testid="editor-back">
          {RECORD_KINDS[kind].label}
        </Button>
        <h2 className="biz-editor__title" title={name}>
          <span className="biz-mono">{id}</span>
          {name && <span className="biz-editor__name">{name}</span>}
        </h2>
        {headerExtra?.(draft, dirty)}
        <span className="biz-spacer" />
        <span className="biz-editor__state" aria-live="polite">
          {dirty ? <Badge tone="warning">未保存</Badge> : isNew ? <Badge>新規</Badge> : savedAt ? <span className="biz-muted">{savedAt} に保存</span> : null}
        </span>
        {!isNew && (
          confirmDelete ? (
            <span className="biz-inline-confirm">
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>キャンセル</Button>
              <Button variant="danger" onClick={() => void remove()} data-testid="editor-delete-confirm">削除する</Button>
            </span>
          ) : (
            <Button variant="ghost" icon={<Trash2 size={14} />} onClick={() => setConfirmDelete(true)} data-testid="editor-delete">削除</Button>
          )
        )}
        <Button
          variant="primary"
          icon={<Save size={14} />}
          onClick={() => void save()}
          disabled={!dirty || blocked}
          busy={saving}
          title={blocked ? 'エラーを直すと保存できます' : undefined}
          data-testid="editor-save"
        >
          保存
        </Button>
      </header>
      {stale && (
        <div className="biz-notice" role="status" data-testid="editor-stale">
          <span>{stale === 'deleted' ? 'この記録はほかで削除されました' : 'この記録はほかで変更されました'}</span>
          {stale === 'changed' && <Button variant="ghost" icon={<RotateCcw size={13} />} onClick={reloadFromDisk} data-testid="editor-reload">読み直す</Button>}
        </div>
      )}
      {(blocked || refusedOnly.length > 0) && (
        <div className="biz-editor__errors" data-testid="editor-errors">
          <IssueLines issues={[...issues.filter((i) => i.severity === 'error'), ...refusedOnly]} />
        </div>
      )}
      <div className="biz-editor__body">
        {render({ draft, set: (patch) => setDraft((d) => ({ ...d, ...patch })), issues, snapshot, dirty })}
        <div className="biz-form">
          <TextArea label="メモ" value={body} onChange={setBody} rows={4} testId="editor-body" />
        </div>
      </div>
    </div>
  )
}
