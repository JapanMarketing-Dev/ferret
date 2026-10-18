import { useCallback, useState, type ReactNode } from 'react'
import type { VentureSnapshot } from '@shared/venture/ipc'
import type { Channel } from '@shared/venture/model'
import type { TranslationKey } from '@shared/i18n'
import type { TFunction } from '../lib/i18n'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useToast } from '../ui'

/** 見出しつきの枠 */
export function Card({ title, actions, children, testId, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; testId?: string; className?: string }) {
  return <section className={['vt-card', className ?? ''].join(' ').trim()} data-testid={testId}>
    {(title || actions) && <div className="vt-card__head">
      {title && <h3 className="vt-card__title">{title}</h3>}
      {actions && <div className="vt-card__actions">{actions}</div>}
    </div>}
    {children}
  </section>
}

/** 数の札（値・名前・補足） */
/** compact … 日付の範囲など長い値（小さめの字で折り返す） */
export function Stat({ label, value, hint, testId, tone, compact = false }: { label: string; value: string; hint?: string; testId?: string; tone?: 'danger' | 'warning' | 'ok'; compact?: boolean }) {
  return <div className={`vt-stat${tone ? ` vt-stat--${tone}` : ''}${compact ? ' vt-stat--compact' : ''}`} data-testid={testId}>
    <span className="vt-stat__value" title={value}>{value}</span>
    <span className="vt-stat__label">{label}</span>
    {hint && <span className="vt-stat__hint">{hint}</span>}
  </div>
}

/** 横に長い表は枠の中で横に送る（狭い幅で崩さない） */
export function TableScroll({ children, testId }: { children: ReactNode; testId?: string }) {
  return <div className="vt-table-scroll" data-testid={testId}><table className="vt-table">{children}</table></div>
}

/** 経路の表示名（'*' は全体） */
export function channelLabel(t: TFunction, channel: Channel | '*' | string): string {
  if (channel === '*') return t('venture.channel.all')
  return t(tk(`venture.channel.${channel}`))
}

/** 組み立てたキー（venture.stage.<id> など）。辞書の網羅は i18n のテストと ui.en.ts の型で見る */
export const tk = (key: string): TranslationKey => key as TranslationKey

/**
 * main の操作（新しい snapshot を返す。null はやめた）を走らせる。失敗はトーストで出し、成功なら snapshot を置き換える
 */
export function useVentureAction(onSnapshot: (snapshot: VentureSnapshot) => void): {
  busy: string | null
  run: (key: string, fn: () => Promise<VentureSnapshot | null>, done?: string) => Promise<VentureSnapshot | null>
} {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState<string | null>(null)
  const run = useCallback(async (key: string, fn: () => Promise<VentureSnapshot | null>, done?: string) => {
    setBusy(key)
    try {
      const next = await fn()
      if (next) {
        onSnapshot(next)
        if (done) toast({ tone: 'success', message: done })
      }
      return next
    } catch (err) {
      toast({ tone: 'warning', message: t('venture.action.failed'), detail: errorMessage(err) })
      return null
    } finally {
      setBusy(null)
    }
  }, [onSnapshot, t, toast])
  return { busy, run }
}
