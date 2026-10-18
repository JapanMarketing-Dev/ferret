import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { CircleCheck, CircleDashed, CircleX, X } from 'lucide-react'
import type { Issue } from '@shared/business/rules'
import type { TranslationKey } from '@shared/i18n'
import type { ResearchIssue } from '@shared/research/ipc'
import type { Maybe, Score } from '@shared/research/model'
import { useT, type TFunction } from '../lib/i18n'
import { FieldRow } from '../business/fields'
import { numberToInput, parseIdList, parseNumberField, parseRateField, rateToInput, stripUnfilled, type Parsed } from './view'

/**
 * ビジネスリサーチの入力部品。見た目は business の部品（biz-field・biz-select・biz-textarea）にそろえ、文言は i18n で引く。
 * 欄のエラーは欄のすぐ下に出す。
 */

/** 辞書に無いキーは fallback（Check の id・main の検査の code が増えても、キーそのものを画面に出さない） */
export function tryT(t: TFunction, key: string, fallback: string, params?: Record<string, string | number>): string {
  const text = t(key as TranslationKey, params)
  return text === key ? fallback : text
}

/**
 * Check（principles・gates・stage・decision が出す）の文。キーは research.check.<principle>.<id>。
 * params の中の識別子（condition: 成立条件のキー）は画面の言葉に置き換え、渡されなかった {{穴}} は括弧ごと消す
 */
export function checkText(t: TFunction, c: { id: string; principle?: string; params?: Record<string, string | number> }, fallbackPrinciple = ''): string {
  const params = c.params && typeof c.params.condition === 'string'
    ? { ...c.params, condition: tryT(t, `research.cond.${c.params.condition}`, c.params.condition) }
    : c.params
  return stripUnfilled(tryT(t, `research.check.${c.principle ?? fallbackPrinciple}.${c.id}`, c.id, params))
}

/** main の検査（ResearchIssue）を、business の欄の部品が読む形へ（文は research.issue.* を引く） */
export function toFieldIssues(t: TFunction, issues: readonly ResearchIssue[], field?: string): Issue[] {
  return issues
    .filter((i) => field === undefined || i.field === field || i.field.startsWith(`${field}.`))
    .map((i) => ({ severity: i.level, ref: '', field: i.field, message: tryT(t, `research.issue.${i.code}`, i.code, i.params) }))
}

export function Txt({ label, value, onChange, rows, placeholder, wide, tip, testId, issues, mono, type = 'text' }: {
  label: string
  value: string
  onChange: (value: string) => void
  /** 指定すれば複数行 */
  rows?: number
  placeholder?: string
  wide?: boolean
  tip?: string
  testId?: string
  issues?: readonly Issue[]
  mono?: boolean
  type?: 'text' | 'url' | 'date'
}) {
  const id = useId()
  const invalid = !!issues?.some((i) => i.severity === 'error')
  return (
    <FieldRow label={label} tip={tip} issues={issues} wide={wide ?? rows !== undefined} id={id}>
      {rows !== undefined ? (
        <textarea id={id} className={`biz-textarea${invalid ? ' is-invalid' : ''}`} rows={rows} value={value} placeholder={placeholder} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
      ) : (
        <div className={`field${invalid ? ' is-invalid' : ''}`}>
          <input id={id} className={`field__input${mono ? ' field__input--mono' : ''}`} type={type} value={value} placeholder={placeholder} spellCheck={false} aria-invalid={invalid || undefined} onChange={(e) => onChange(e.target.value)} data-testid={testId} />
        </div>
      )}
    </FieldRow>
  )
}

export type NumKind = 'number' | 'integer' | 'rate' | 'yen' | 'months'

function parseByKind(kind: NumKind, text: string): Parsed<number | null> {
  if (kind === 'rate') return parseRateField(text)
  return parseNumberField(text, { integer: kind === 'integer' || kind === 'months' })
}

function toText(kind: NumKind, value: number | null): string {
  return kind === 'rate' ? rateToInput(value) : numberToInput(value)
}

/**
 * 数の欄（空は未確認＝null。0 と書かない）。打っている途中の文字はそのまま持ち、読めたときだけ親へ渡す。
 * rate は 0〜1 で持ち、% で見せる
 */
export function NumField({ label, value, onChange, kind = 'number', unit, tip, testId, compact }: {
  label: string
  value: Maybe<number>
  onChange: (value: Maybe<number>) => void
  kind?: NumKind
  unit?: string
  tip?: string
  testId?: string
  /** 表の中など、見出しを出さない（読み上げの名前だけ） */
  compact?: boolean
}) {
  const t = useT()
  const id = useId()
  const [text, setText] = useState(toText(kind, value))
  const [error, setError] = useState<string | null>(null)
  const textRef = useRef(text)
  textRef.current = text
  useEffect(() => {
    const parsed = parseByKind(kind, textRef.current)
    if (!parsed.ok || parsed.value !== value) {
      setText(toText(kind, value))
      setError(null)
    }
  }, [value, kind])
  const trailing = unit ?? (kind === 'rate' ? '%' : kind === 'yen' ? t('research.ws.unit.yen') : kind === 'months' ? t('research.ws.unit.months') : undefined)
  const input = (
    <div className="rs-num">
      <div className={`field rs-num__field${error ? ' is-invalid' : ''}`}>
        <input
          id={id}
          className="field__input"
          inputMode="decimal"
          aria-label={compact ? label : undefined}
          value={text}
          placeholder={t('research.ws.unknown')}
          aria-invalid={!!error || undefined}
          onChange={(e) => {
            setText(e.target.value)
            const parsed = parseByKind(kind, e.target.value)
            if (parsed.ok) {
              setError(null)
              onChange(parsed.value)
            } else setError(t(`research.ws.input.${parsed.error}` as const))
          }}
          data-testid={testId}
        />
        {trailing && <span className="field__trailing">{trailing}</span>}
      </div>
      {error && <span className="biz-issue biz-issue--error" role="alert">{error}</span>}
    </div>
  )
  if (compact) return input
  return <FieldRow label={label} tip={tip} id={id}>{input}</FieldRow>
}

/** 1〜5 点（— は未採点） */
export function ScoreSelect({ label, value, onChange, testId, compact }: { label: string; value: Maybe<Score>; onChange: (v: Maybe<Score>) => void; testId?: string; compact?: boolean }) {
  const id = useId()
  const t = useT()
  const select = (
    <select id={id} className="biz-select rs-score-select" aria-label={compact ? label : undefined} value={value ?? ''} onChange={(e) => onChange(e.target.value ? (Number(e.target.value) as Score) : null)} data-testid={testId}>
      <option value="">{t('research.ws.unscored')}</option>
      {[1, 2, 3, 4, 5].map((n) => <option key={n} value={n}>{n}</option>)}
    </select>
  )
  if (compact) return select
  return <FieldRow label={label} id={id}>{select}</FieldRow>
}

/** はい／いいえ／未判断 */
export function TriSelect({ label, value, onChange, testId, tip }: { label: string; value: Maybe<boolean>; onChange: (v: Maybe<boolean>) => void; testId?: string; tip?: string }) {
  const id = useId()
  const t = useT()
  return (
    <FieldRow label={label} id={id} tip={tip}>
      <select id={id} className="biz-select" value={value === null ? '' : value ? 'yes' : 'no'} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value === 'yes')} data-testid={testId}>
        <option value="">{t('research.ws.undecided')}</option>
        <option value="yes">{t('research.ws.yes')}</option>
        <option value="no">{t('research.ws.no')}</option>
      </select>
    </FieldRow>
  )
}

export function EnumSelect<T extends string>({ label, value, options, labelOf, onChange, testId, allowNull, tip, compact }: {
  label: string
  value: T | null
  options: readonly T[]
  labelOf: (v: T) => string
  onChange: (v: T | null) => void
  testId?: string
  /** 未選択（null）を許す */
  allowNull?: boolean
  tip?: string
  compact?: boolean
}) {
  const id = useId()
  const t = useT()
  const select = (
    <select id={id} className="biz-select" aria-label={compact ? label : undefined} value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : (e.target.value as T))} data-testid={testId}>
      {(allowNull || value === null) && <option value="">{t('research.ws.notSet')}</option>}
      {options.map((o) => <option key={o} value={o}>{labelOf(o)}</option>)}
    </select>
  )
  if (compact) return select
  return <FieldRow label={label} id={id} tip={tip}>{select}</FieldRow>
}

/** 証拠 ID などの並び（"E001, E002"）。形が違う語は欄の下に出す */
export function IdListField({ label, value, onChange, prefix, known, testId }: {
  label: string
  value: readonly string[]
  onChange: (v: string[]) => void
  prefix: 'C' | 'E' | 'X'
  /** データにある ID（無い ID を知らせる） */
  known: readonly string[]
  testId?: string
}) {
  const t = useT()
  const id = useId()
  const [text, setText] = useState(value.join(', '))
  const [invalid, setInvalid] = useState<string[]>([])
  const joined = value.join(', ')
  const textRef = useRef(text)
  textRef.current = text
  useEffect(() => {
    if (parseIdList(textRef.current, prefix).value.join(', ') !== joined) {
      setText(joined)
      setInvalid([])
    }
  }, [joined, prefix])
  const unknown = value.filter((v) => !known.includes(v))
  const issues: Issue[] = [
    ...(invalid.length ? [{ severity: 'error' as const, ref: '', field: '', message: t('research.ws.input.badIds', { ids: invalid.join(', ') }) }] : []),
    ...(unknown.length ? [{ severity: 'warning' as const, ref: '', field: '', message: t('research.ws.input.unknownIds', { ids: unknown.join(', ') }) }] : [])
  ]
  return (
    <FieldRow label={label} id={id} issues={issues}>
      <div className="field">
        <input
          id={id}
          className="field__input field__input--mono"
          value={text}
          placeholder={`${prefix}001, ${prefix}002`}
          spellCheck={false}
          onChange={(e) => {
            setText(e.target.value)
            const parsed = parseIdList(e.target.value, prefix)
            setInvalid(parsed.invalid)
            onChange(parsed.value)
          }}
          data-testid={testId}
        />
      </div>
    </FieldRow>
  )
}

/** 証拠の選び方（選んだものは札、残りはセレクトから足す）。データに無い ID は札に印を付ける */
export function EvidencePicker({ label, value, options, onChange, testId }: {
  label: string
  value: readonly string[]
  options: ReadonlyArray<{ id: string; label: string }>
  onChange: (v: string[]) => void
  testId?: string
}) {
  const t = useT()
  const rest = options.filter((o) => !value.includes(o.id))
  return (
    <div className="biz-ids" data-testid={testId}>
      {value.map((id) => {
        const known = options.find((o) => o.id === id)
        return (
          <span key={id} className={`biz-id-chip${known ? '' : ' rs-chip--unknown'}`} title={known?.label ?? t('research.ws.input.unknownIds', { ids: id })}>
            <span>{id}</span>
            <button type="button" aria-label={t('research.ws.removeItem', { item: id })} onClick={() => onChange(value.filter((v) => v !== id))}>
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        )
      })}
      {rest.length > 0 ? (
        <select className="biz-select biz-select--add" aria-label={t('research.ws.addTo', { label })} value="" onChange={(e) => { if (e.target.value) onChange([...value, e.target.value]) }}>
          <option value="">{t('research.ws.add')}</option>
          {rest.map((o) => <option key={o.id} value={o.id}>{o.id}　{o.label.slice(0, 40)}</option>)}
        </select>
      ) : value.length === 0 ? <span className="biz-muted">{t('research.ws.noEvidenceToPick')}</span> : null}
    </div>
  )
}

/** 完了条件のチェック（機械の目安）。ok: true 済み / false 未 / null 判断できない */
export function CheckList({ checks, principle, testId }: {
  checks: ReadonlyArray<{ id: string; principle?: string; ok: boolean | null; params?: Record<string, string | number> }>
  principle: string
  testId?: string
}) {
  const t = useT()
  if (checks.length === 0) return <p className="biz-muted">{t('research.ws.noChecks')}</p>
  return (
    <ul className="rs-checks" data-testid={testId}>
      {checks.map((c) => (
        <li key={c.id} className={`rs-check rs-check--${c.ok === true ? 'ok' : c.ok === false ? 'ng' : 'unknown'}`} data-check={c.id}>
          {c.ok === true ? <CircleCheck size={14} aria-label={t('research.ws.check.ok')} /> : c.ok === false ? <CircleX size={14} aria-label={t('research.ws.check.ng')} /> : <CircleDashed size={14} aria-label={t('research.ws.check.unknown')} />}
          <span>{checkText(t, c, principle)}</span>
        </li>
      ))}
    </ul>
  )
}

/** 小さな札の並び（足切り・未根拠の項目など） */
export function Chips({ items, onRemove, label }: { items: readonly string[]; onRemove?: (i: number) => void; label?: string }) {
  const t = useT()
  return (
    <span className="biz-ids">
      {items.map((x, i) => (
        <span key={`${x}:${i}`} className="biz-id-chip">
          <span>{x}</span>
          {onRemove && (
            <button type="button" aria-label={t('research.ws.removeItem', { item: label ? `${label} ${x}` : x })} onClick={() => onRemove(i)}>
              <X size={11} aria-hidden="true" />
            </button>
          )}
        </span>
      ))}
    </span>
  )
}

/** 区切りの見出し付きのまとまり（business の Section と同じ見た目） */
export function Block({ title, actions, children, testId, note }: { title: string; actions?: ReactNode; children: ReactNode; testId?: string; note?: ReactNode }) {
  return (
    <section className="biz-section rs-block" data-testid={testId} aria-label={title}>
      <header className="biz-section__head">
        <h3 className="biz-section__title">{title}</h3>
        {actions && <div className="biz-section__actions">{actions}</div>}
      </header>
      {note && <p className="biz-muted rs-block__note">{note}</p>}
      {children}
    </section>
  )
}
