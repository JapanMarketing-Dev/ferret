import { useCallback, useEffect, useRef, useState } from 'react'
import type { PeriodPreset } from '@shared/venture/model'
import type { VentureSnapshot } from '@shared/venture/ipc'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'
import { useToast } from '../ui'
import { useVentureApi } from './api'
import { touchesVentureRecords } from './view'

/** ファイルの変更が続いたときにまとめて読み直す待ち */
const FS_RELOAD_DEBOUNCE_MS = 400

export interface VentureState {
  snapshot: VentureSnapshot | null
  /** 最後の読み込みの失敗（成功すれば null）。前の snapshot が残っていても出す */
  error: string | null
  loading: boolean
  reload: () => void
  /** 操作の結果（main が返した新しい snapshot）で置き換える */
  setSnapshot: (snapshot: VentureSnapshot) => void
}

/**
 * venture:load を呼び、'venture:changed' と 'fs:changed'（ビジネスの記録のパス）で読み直す。
 * 失敗はトーストと error で正直に出す（空のふりをしない）。古い読み込みの結果で新しいものを上書きしない
 */
export function useVenture(period: PeriodPreset): VentureState {
  const api = useVentureApi()
  const toast = useToast()
  const t = useT()
  const [snapshot, setSnapshotState] = useState<VentureSnapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const seq = useRef(0)
  const periodRef = useRef(period)
  periodRef.current = period

  const load = useCallback((quiet: boolean) => {
    const id = ++seq.current
    setLoading(true)
    api.invoke('venture:load', { period: periodRef.current }).then((next) => {
      if (id !== seq.current) return
      setSnapshotState(next)
      setError(null)
    }).catch((err) => {
      if (id !== seq.current) return
      const message = errorMessage(err)
      setError(message)
      if (!quiet) toast({ tone: 'warning', message: t('venture.load.failed'), detail: message })
    }).finally(() => {
      if (id === seq.current) setLoading(false)
    })
  }, [api, toast, t])

  // biome-ignore lint/correctness/useExhaustiveDependencies: period は periodRef で読む（変われば読み直す）
  useEffect(() => { load(false) }, [load, period])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => load(true), FS_RELOAD_DEBOUNCE_MS)
    }
    const offChanged = api.onChanged(() => load(true))
    const offFs = api.onFsChanged((paths) => { if (touchesVentureRecords(paths)) later() })
    return () => {
      offChanged()
      offFs()
      if (timer) clearTimeout(timer)
    }
  }, [api, load])

  const setSnapshot = useCallback((next: VentureSnapshot) => {
    seq.current++
    setSnapshotState(next)
    setError(null)
    setLoading(false)
  }, [])

  return { snapshot, error, loading, reload: useCallback(() => load(false), [load]), setSnapshot }
}
