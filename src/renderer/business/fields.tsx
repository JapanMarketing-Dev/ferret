import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CircleAlert, TriangleAlert, X } from 'lucide-react'
import type { Issue } from '@shared/business/rules'
import { Tooltip } from '../ui'
import { contentKeys, parseNumberInput } from './view'

/**
 * ビジネスの記録フォームの入力部品。
 * 欄のエラーは欄のすぐ下に出す（教訓: 入力欄でのエラーは、その欄の下にすぐ出す）。
 */

export function IssueLines({ issues, testId }: { issues: readonly Issue[]; testId?: string }) {
  if (issues.length === 0) return null
  const keys = contentKeys(issues, (x) => `${x.severity}:${x.ref}:${x.field}:${x.message}`)
  return (
    <ul className="biz-issues" data-testid={testId}>
      {issues.map((issue, i) => (
        <li key={keys[i]} className={`biz-issue biz-issue--${issue.severity}`} data-severity={issue.severity}>
          {issue.severity === 'error' ? <CircleAlert size={12} aria-hidden="true" /> : <TriangleAlert size={12} aria-hidden="true" />}
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  )
}

/** 1つの欄（見出し＋入力＋その欄の検査結果） */
export function FieldRow({
  label,
  tip,
  issues = [],
  wide = false,
  children,
  id,
  testId
}: {
  label: string
  /** 用語の説明（見出しの上に重ねたときだけ出す） */
  tip?: string
  issues?: readonly Issue[]
  wide?: boolean
  /** 入力の id（label と結ぶ）。無ければ見出しだけ */
  id?: string
  children: ReactNode
  testId?: string
}) {
  const head = <label className="biz-field__label" htmlFor={id}>{label}</label>
  return (
    <div className={`biz-field${wide ? ' biz-field--wide' : ''}${issues.some((i) => i.severity === 'error') ? ' has-error' : ''}`} data-testid={testId}>
      {tip ? <Tooltip label={tip} side="bottom">{head}</Tooltip> : head}
      <div className="biz-field__control">
        {children}
        <IssueLines issues={issues} />
      </div>
    </div>
  )
}

export function TextInput({
  label,
  value,
  onChange,
  issues,
  tip,
  wide,
  placeholder,
  mono,
  disabled,
  type = 'text',
  testId
}: {
  label: string
  value: string
  onChange: (value: string) => void
  issues?: readonly Issue[]
  tip?: string
  wide?: boolean
  placeholder?: string
  mono?: boolean
  disabled?: boolean
  type?: 'text' | 'date' | 'url'
  testId?: string
}) {
  const id = useId()
  const invalid = !!issues?.some((i) => i.severity === 'error')
  return (
    <FieldRow label={label} tip={tip} issues={issues} wide={wide} id={id}>
      <div className={`field${invalid ? ' is-invalid' : ''}`} data-disabled={disabled || undefined}>
        <input
          id={id}
          className={`field__input${mono ? ' field__input--mono' : ''}`}
          type={type}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
      </div>
    </FieldRow>
  )
}

export function TextArea({
  label,
  value,
  onChange,
  issues,
  tip,
  rows = 3,
  disabled,
  placeholder,
  testId,
  wide = true
}: {
  label: string
  value: string
  onChange: (value: string) => void
  issues?: readonly Issue[]
  tip?: string
  rows?: number
  disabled?: boolean
  placeholder?: string
  testId?: string
  wide?: boolean
}) {
  const id = useId()
  const invalid = !!issues?.some((i) => i.severity === 'error')
  return (
    <FieldRow label={label} tip={tip} issues={issues} wide={wide} id={id}>
      <textarea
        id={id}
        className={`biz-textarea${invalid ? ' is-invalid' : ''}`}
        rows={rows}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </FieldRow>
  )
}

export function SelectInput<T extends string>({
  label,
  value,
  options,
  onChange,
  issues,
  tip,
  disabled,
  testId,
  wide
}: {
  label: string
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
  issues?: readonly Issue[]
  tip?: string
  disabled?: boolean
  testId?: string
  wide?: boolean
}) {
  const id = useId()
  return (
    <FieldRow label={label} tip={tip} issues={issues} id={id} wide={wide}>
      <select id={id} className="biz-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)} data-testid={testId}>
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </FieldRow>
  )
}

/** 0/1/2/U やはい/いいえ/U の選択（ラジオの組） */
export function ChoicePicker<T extends string | number>({
  label,
  value,
  choices,
  onChange,
  testId,
  disabled
}: {
  /** 読み上げ用の名前（D1 急ぐ理由 など） */
  label: string
  value: T
  choices: readonly T[]
  onChange: (value: T) => void
  testId?: string
  disabled?: boolean
}) {
  // ふつうのラジオボタンにする（矢印キーで選び直せる・グループで1つだけ Tab で止まる）
  const name = useId()
  return (
    <div className="biz-choice" role="radiogroup" aria-label={label} data-testid={testId}>
      {choices.map((choice) => (
        <label key={String(choice)} className={`biz-choice__item${choice === 'U' ? ' biz-choice__item--u' : ''}`} data-value={String(choice)}>
          <input
            type="radio"
            className="biz-choice__input"
            name={name}
            value={String(choice)}
            checked={choice === value}
            disabled={disabled}
            onChange={() => onChange(choice)}
          />
          {String(choice)}
        </label>
      ))}
    </div>
  )
}

/** ID の複数選択（選んだものは札、残りはセレクトから追加） */
export function IdPicker({
  label,
  value,
  options,
  onChange,
  testId,
  emptyText = '候補がありません'
}: {
  label: string
  value: readonly string[]
  options: ReadonlyArray<{ id: string; label: string }>
  onChange: (value: string[]) => void
  testId?: string
  emptyText?: string
}) {
  const rest = options.filter((o) => !value.includes(o.id))
  const titleOf = (id: string) => options.find((o) => o.id === id)?.label ?? 'ありません'
  return (
    <div className="biz-ids" data-testid={testId}>
      {value.map((id) => (
        <span key={id} className="biz-id-chip" title={titleOf(id)}>
          <span>{id}</span>
          <button type="button" aria-label={`${id} を外す`} onClick={() => onChange(value.filter((v) => v !== id))}>
            <X size={11} aria-hidden="true" />
          </button>
        </span>
      ))}
      {options.length === 0 && value.length === 0 ? (
        <span className="biz-muted">{emptyText}</span>
      ) : rest.length > 0 ? (
        <select
          className="biz-select biz-select--add"
          aria-label={`${label}に追加`}
          value=""
          onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]) }}
        >
          <option value="">追加</option>
          {rest.map((o) => <option key={o.id} value={o.id}>{o.id}　{o.label.slice(0, 40)}</option>)}
        </select>
      ) : null}
    </div>
  )
}

/**
 * 数の入力（空は未計測）。打っている途中の文字はそのまま持ち、読めたときだけ親へ渡す。
 * 読めない値は欄の下にすぐ出す。
 */
export function NumberInput({
  label,
  value,
  onChange,
  disabled,
  unit,
  testId,
  placeholder = '未計測'
}: {
  label: string
  value: number | null
  onChange: (value: number | null) => void
  disabled?: boolean
  unit?: string
  testId?: string
  /** 空のときの表示（数なら未計測、上限なら未設定） */
  placeholder?: string
}) {
  const [text, setText] = useState(value === null ? '' : String(value))
  const [error, setError] = useState<string | null>(null)
  // 親の値が変わったときだけ合わせる（打っている途中の文は読むだけ）
  const textRef = useRef(text)
  textRef.current = text
  useEffect(() => {
    const parsed = parseNumberInput(textRef.current)
    if (!parsed.ok || parsed.value !== value) {
      setText(value === null ? '' : String(value))
      setError(null)
    }
  }, [value])
  return (
    <div className="biz-num">
      <div className={`field biz-num__field${error ? ' is-invalid' : ''}`} data-disabled={disabled || undefined}>
        <input
          className="field__input"
          inputMode="decimal"
          aria-label={label}
          value={text}
          disabled={disabled}
          placeholder={disabled ? '' : placeholder}
          aria-invalid={!!error || undefined}
          onChange={(e) => {
            setText(e.target.value)
            const parsed = parseNumberInput(e.target.value)
            if (parsed.ok) {
              setError(null)
              onChange(parsed.value)
            } else setError(parsed.message)
          }}
          data-testid={testId}
        />
        {unit && <span className="field__trailing">{unit}</span>}
      </div>
      {error && <span className="biz-issue biz-issue--error" role="alert">{error}</span>}
    </div>
  )
}

export function Section({ title, actions, children, testId, id }: { title: string; actions?: ReactNode; children: ReactNode; testId?: string; id?: string }) {
  return (
    <section className="biz-section" data-testid={testId} id={id} aria-label={title}>
      <header className="biz-section__head">
        <h3 className="biz-section__title">{title}</h3>
        {actions && <div className="biz-section__actions">{actions}</div>}
      </header>
      {children}
    </section>
  )
}
