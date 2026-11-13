import { useEffect, useMemo, useState } from 'react'
import { buildGitDecorations, type FsGitStatus, type GitDecorations } from '@shared/gitDecorations'

/**
 * ファイルツリーの git の色分けの状態（fs:gitStatus）。
 *
 * 読み直すのは、ファイルの変更（fs:changed。保存・Agent の書き換え）、.git の HEAD・index の変化（github:headChanged。コミット・ステージ）、
 * ウインドウを前に出したとき（前回から30秒以上たっていれば）。続けて起きたものはまとめ（前回から GIT_REFRESH_MIN_GAP_MS は空ける）、git を重ねて走らせない（走っている間の変化は、終わってから1回だけ読み直す）。
 * null は「まだ分からない」（色を付けない）。
 */

/** 変更の通知から git を呼ぶまでの待ち（Agent が続けて書くときに1回へまとめる） */
export const GIT_REFRESH_DEBOUNCE_MS = 1500
/**
 * git を続けて走らせるときの最小の間（前回の開始から）。Agent が書き続けている間も、これより多くは走らせない
 * （大きなリポジトリの git status は重く、多くのプロジェクトで Agent を動かすと CPU を使い続けていた）
 */
export const GIT_REFRESH_MIN_GAP_MS = 4000
/** ウインドウを前に出したときに読み直すのは、前回の開始からこれ以上たっていたときだけ */
export const GIT_FOCUS_MIN_GAP_MS = 30_000

/** 次に git を呼ぶまでの待ち。前回の開始から GIT_REFRESH_MIN_GAP_MS は空ける（lastStart が null なら、まだ走らせていない） */
export function gitRefreshDelay(now: number, lastStart: number | null): number {
  const gap = lastStart === null ? 0 : lastStart + GIT_REFRESH_MIN_GAP_MS - now
  return Math.max(GIT_REFRESH_DEBOUNCE_MS, gap)
}

export function useGitDecorations(root: string | null): GitDecorations | null {
  const [status, setStatus] = useState<FsGitStatus | null>(null)

  useEffect(() => {
    setStatus(null)
    if (!root) return
    let disposed = false
    let running = false
    let again = false
    let timer: number | undefined
    let lastStart: number | null = null
    const load = async () => {
      if (running) { again = true; return }
      running = true
      lastStart = Date.now()
      try {
        const next = await window.ade.invoke('fs:gitStatus')
        if (!disposed) setStatus(next)
      } catch {
        // プロジェクトを閉じた・切り替えた直後など（想定内）。色を付けないだけ
        if (!disposed) setStatus({ isGit: false, entries: [], truncated: false })
      } finally {
        running = false
        if (again && !disposed) { again = false; schedule() }
      }
    }
    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), gitRefreshDelay(Date.now(), lastStart))
    }
    void load()
    const offFs = window.ade.on('fs:changed', schedule)
    const offHead = window.ade.on('github:headChanged', schedule)
    // 前に出したときは、前回から GIT_FOCUS_MIN_GAP_MS 以上たっていたときだけ（ファイルと .git の変化は上の通知で追える）
    const onFocus = () => { if (lastStart === null || Date.now() - lastStart >= GIT_FOCUS_MIN_GAP_MS) schedule() }
    window.addEventListener('focus', onFocus)
    return () => {
      disposed = true
      window.clearTimeout(timer)
      offFs()
      offHead()
      window.removeEventListener('focus', onFocus)
    }
  }, [root])

  return useMemo(() => (status ? buildGitDecorations(status) : null), [status])
}
