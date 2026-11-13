import { useCallback, useEffect, useRef, useState } from 'react'
import type { ViewBounds } from '@shared/types'
import { setViewBoundsForToasts } from '../lib/toastPlacement'

/**
 * 内蔵ブラウザ（WebContentsView）を置く領域を実測して main へ渡す。
 *
 * WebContentsView は renderer のDOMとは別のレイヤーに描かれるため、
 * 「どこに置くか」をこちらで測って送らないと位置がずれる。
 * レイアウト変化（分割幅のドラッグ、モード切替、ウィンドウリサイズ）はすべて
 * ここを通るので、測定とIPCは requestAnimationFrame で1フレーム1回にまとめる。
 *
 * `layoutKey` にはレイアウトを決める値（モード・分割幅・表示幅）を連結した文字列を渡す。
 * 戻り値を置き場所の要素の `ref` に渡す。モード切替で要素が入れ替わっても、
 * 新しい要素の位置を測り直すだけで、ビュー自体は作り直さない（ページは再読込されない）。
 */
/** 予備の測り直しの間隔。変化は ResizeObserver（自分・祖先・その前の兄弟）とウインドウのイベントで追い、これは取りこぼしの予備 */
export const HEAL_MS = 5000

/**
 * 位置を動かしうる要素。自分と祖先（body の手前まで）と、それぞれの前の兄弟（上・左に並ぶツールバーなど）。
 * これらの大きさが変われば、自分の大きさが同じでも位置が動く
 */
export function layoutNeighbors(node: Element): Element[] {
  const out: Element[] = []
  for (let el: Element | null = node; el && el.tagName !== 'BODY' && el.tagName !== 'HTML'; el = el.parentElement) {
    out.push(el)
    for (let s = el.previousElementSibling; s; s = s.previousElementSibling) out.push(s)
  }
  return out
}

export function useViewBounds(
  layoutKey: string,
  /**
   * ビューを見せるか。false の間は 0 サイズを送って隠す。
   * 空状態や部品見本をDOMで出すときに使う（ネイティブのビューはDOMの上に
   * 必ず重なるので、隠さないと下に入ったDOMが見えない）。
   */
  visible = true
): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null)
  const lastRef = useRef<string>('')
  const frameRef = useRef<number | null>(null)

  const schedule = useCallback((force?: unknown) => {
    if (!visible) {
      if (lastRef.current === 'hidden') return
      lastRef.current = 'hidden'
      setViewBoundsForToasts(null)
      void window.ade.invoke('browser:setBounds', null)
      return
    }
    if (!node || frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      const rect = node.getBoundingClientRect()
      const bounds: ViewBounds = {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
      const key = `${bounds.x},${bounds.y},${bounds.width},${bounds.height}`
      // force（定期の置き直し）は同じ値でも送る。main 側のビューだけがずれたときも戻すため
      if (key === lastRef.current && force !== true) return
      lastRef.current = key
      // トーストはビューに隠れない場所へ置く（toastPlacement.ts）ので、位置を知らせる
      setViewBoundsForToasts(bounds)
      void window.ade.invoke('browser:setBounds', bounds)
    })
  }, [node, visible])

  useEffect(() => {
    if (!node || !visible) {
      schedule()
      return
    }
    schedule()
    // 大きさが同じまま位置だけが動く（上のツールバーの高さが変わる）のも拾うよう、前に並ぶ要素と祖先も見る
    const observer = new ResizeObserver(() => schedule())
    for (const el of layoutNeighbors(node)) observer.observe(el)
    window.addEventListener('resize', schedule)
    // フォント読み込みなどで後からレイアウトが動く場合に取りこぼさない
    const timer = window.setTimeout(schedule, 150)
    /*
     * ResizeObserver で拾えない動き（一時的に違う位置で測った・兄弟が足された・main 側のビューだけがずれた）の予備に、
     * 見せている間は HEAL_MS ごとに測り、同じ値でも置き直す（以前は 1 秒ごとに測っていた）。
     * 最小化・裏の間は置き直さない（表に戻ったら visibilitychange ですぐ置き直す）
     */
    const healer = window.setInterval(() => {
      if (document.hidden) return
      schedule(true)
    }, HEAL_MS)
    const onVisible = () => { if (!document.hidden) schedule(true) }
    document.addEventListener('visibilitychange', onVisible)
    const onFocus = () => schedule(true)
    window.addEventListener('focus', onFocus)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', schedule)
      window.removeEventListener('focus', onFocus)
      window.clearInterval(healer)
      document.removeEventListener('visibilitychange', onVisible)
      window.clearTimeout(timer)
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current)
        frameRef.current = null
      }
    }
    // レイアウトが変わったら（モード・分割幅・表示幅）、見る要素を集め直して測り直す
  }, [node, visible, schedule, layoutKey])

  return setNode
}
