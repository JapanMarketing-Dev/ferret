import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject, type PointerEvent as ReactPointerEvent } from 'react'
import { Maximize, Minus, Plus } from 'lucide-react'
import {
  DEFAULT_VIEW,
  applyWheel,
  fitContent,
  fitRect,
  gridSize,
  scaleLabel,
  stepScale,
  zoomAt,
  type BoardView
} from '@shared/whiteboard'
import { IconButton } from '../ui'
import { useT } from '../lib/i18n'

/**
 * 無限ホワイトボード（ビジュアルレビュー・価値ユースケースのタブ）。中身はふつうの HTML の並びのまま、
 * 全体を translate + scale で動かす（画像の上の囲みは getBoundingClientRect の割合で取るので、倍率に関係なく合う）。
 *
 * - 動かす: 何もないところ・カードの上のドラッグ、2本指スクロール、スペースを押しながらのドラッグ（いつでも）
 * - 拡大縮小: ピンチ・⌘/Ctrl+ホイール（カーソルの位置を中心に）、右上の − ＋・全体を表示・100%
 * - ダブルクリックしたカード（data-board-card）へ寄る
 * - 見ている位置は文書ごと（viewKey）に、Ferret を閉じるまで覚える。
 * - 人がボードを触るまでは、中身の大きさが変わるたび（画像が読み込まれた・Agent が書き足した）に全体を表示し直す。
 *   触ったら（ドラッグ・ホイール・拡大縮小・寄る）もう勝手に動かさない。「全体を表示」を押すと、また合わせ直すようにする
 * - overlay はボードの上に浮かぶもの（承認・フィードバック。ズームしても動かない）
 */

/** 文書ごとの見ている位置と、人が触ったか（Ferret を閉じるまで） */
const views = new Map<string, { view: BoardView; touched: boolean }>()

/** 動かすドラッグを始めない場所（押す・打つ・囲むもの）。スペースを押していれば、ここでも動かす */
const NO_PAN = 'button, a, input, textarea, select, label, [contenteditable="true"], .is-drawing, [data-no-pan]'

const isTyping = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))

export function Whiteboard({ viewKey, children, overlay, testId }: {
  viewKey: string
  children: ReactNode
  overlay?: ReactNode
  testId?: string
}) {
  const t = useT()
  const viewportRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const [view, setViewState] = useState<BoardView>(() => views.get(viewKey)?.view ?? DEFAULT_VIEW)
  const viewRef = useRef(view)
  /** 人が触った（もう全体表示し直さない） */
  const touched = useRef(views.get(viewKey)?.touched ?? false)
  const [space, setSpace] = useState(false)
  const [panning, setPanning] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; view: BoardView } | null>(null)

  /** 位置を変える。by が 'user' なら、人が触ったことにする（以後は勝手に合わせ直さない） */
  const setView = useCallback((next: BoardView | ((current: BoardView) => BoardView), by: 'user' | 'fit' = 'user') => {
    const value = typeof next === 'function' ? next(viewRef.current) : next
    if (by === 'user') touched.current = true
    viewRef.current = value
    views.set(viewKey, { view: value, touched: touched.current })
    setViewState(value)
  }, [viewKey])

  const viewportSize = (): { width: number; height: number } => {
    const el = viewportRef.current
    return { width: el?.clientWidth ?? 0, height: el?.clientHeight ?? 0 }
  }
  const contentSize = (): { width: number; height: number } => {
    const el = worldRef.current
    return { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 }
  }

  /** 全体を表示し、また中身に合わせて表示し直すようにする */
  const fitAll = useCallback(() => {
    touched.current = false
    const next = fitContent(contentSize(), viewportSize())
    if (next) setView(next, 'fit')
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 大きさは呼んだときに測る
  }, [setView])

  // 人が触るまでは、中身・ボードの大きさが変わるたびに全体を表示し直す
  useLayoutEffect(() => {
    const world = worldRef.current
    const viewport = viewportRef.current
    if (!world || !viewport) return
    const tryFit = (): void => {
      if (touched.current) return
      const next = fitContent(contentSize(), viewportSize())
      if (next) setView(next, 'fit')
    }
    tryFit()
    const observer = new ResizeObserver(tryFit)
    observer.observe(world)
    observer.observe(viewport)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 文書ごとに見張る
  }, [viewKey])

  // ホイールは既定の動き（ページのスクロール・拡大）を止めるため、passive でない登録にする
  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const rect = viewport.getBoundingClientRect()
      setView((current) => applyWheel(current, e, { x: e.clientX - rect.left, y: e.clientY - rect.top }))
    }
    viewport.addEventListener('wheel', onWheel, { passive: false })
    return () => viewport.removeEventListener('wheel', onWheel)
  }, [setView])

  // スペースを押している間は、どこをドラッグしても動かす（文字を打っているときは除く）
  useEffect(() => {
    const down = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return
      if (!viewportRef.current?.isConnected) return
      setSpace(true)
    }
    const up = (e: KeyboardEvent): void => { if (e.code === 'Space') setSpace(false) }
    const blur = (): void => setSpace(false)
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    window.addEventListener('blur', blur)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      window.removeEventListener('blur', blur)
    }
  }, [])

  const startPan = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 && e.button !== 1) return
    const target = e.target as HTMLElement
    if (!space && e.button === 0 && target.closest(NO_PAN)) return
    // 画像の上で囲む（フィードバック）より先に取る（スペース・中ボタンのとき）
    e.preventDefault()
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, view: viewRef.current }
    setPanning(true)
  }
  const movePan = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d || d.id !== e.pointerId) return
    setView({ ...d.view, x: d.view.x + e.clientX - d.x, y: d.view.y + e.clientY - d.y })
  }
  const endPan = (e: ReactPointerEvent<HTMLDivElement>): void => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    setPanning(false)
  }

  /** ダブルクリックしたカードへ寄る（文字を選ぶ・打つところでは何もしない） */
  const zoomToCard = (e: ReactMouseEvent<HTMLDivElement>): void => {
    // ドラッグのためにポインターを掴んでいると e.target はボードになるので、押した位置の要素から探す
    const target = document.elementFromPoint(e.clientX, e.clientY)
    if (!(target instanceof Element) || target.closest(NO_PAN)) return
    const card = target.closest<HTMLElement>('[data-board-card]')
    const world = worldRef.current
    if (!card || !world) return
    const w = world.getBoundingClientRect()
    const c = card.getBoundingClientRect()
    const scale = viewRef.current.scale
    const next = fitRect({ x: (c.left - w.left) / scale, y: (c.top - w.top) / scale, width: c.width / scale, height: c.height / scale }, viewportSize(), { maxScale: 2 })
    if (next) setView(next)
  }

  const zoomStep = (dir: 1 | -1): void => {
    const { width, height } = viewportSize()
    setView((current) => zoomAt(current, stepScale(current.scale, dir), { x: width / 2, y: height / 2 }))
  }
  const actualSize = (): void => {
    const { width, height } = viewportSize()
    setView((current) => zoomAt(current, 1, { x: width / 2, y: height / 2 }))
  }

  const grid = gridSize(view.scale)
  return (
    <div className="wb" data-testid={testId}>
      <div
        ref={viewportRef}
        className={`wb__viewport${space ? ' is-space' : ''}${panning ? ' is-panning' : ''}`}
        style={{ backgroundSize: `${grid}px ${grid}px`, backgroundPosition: `${view.x}px ${view.y}px` }}
        onPointerDownCapture={space ? startPan : undefined}
        onPointerDown={space ? undefined : startPan}
        onPointerMove={movePan}
        onPointerUp={endPan}
        onPointerCancel={endPan}
        onDoubleClick={zoomToCard}
      >
        <div
          ref={worldRef}
          className="wb__world"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        >
          {children}
        </div>
      </div>
      <div className="wb__tools" role="toolbar" aria-label={t('whiteboard.tools')} data-no-pan>
        <IconButton label={t('whiteboard.zoomOut')} icon={<Minus size={14} />} size="sm" onClick={() => zoomStep(-1)} />
        <button type="button" className="wb__scale" title={t('whiteboard.actualSize')} onClick={actualSize} data-testid="whiteboard-scale">{scaleLabel(view.scale)}</button>
        <IconButton label={t('whiteboard.zoomIn')} icon={<Plus size={14} />} size="sm" onClick={() => zoomStep(1)} />
        <span className="wb__sep" aria-hidden="true" />
        <button type="button" className="wb__fit" onClick={fitAll} data-testid="whiteboard-fit"><Maximize size={13} aria-hidden="true" />{t('whiteboard.fit')}</button>
      </div>
      {overlay}
    </div>
  )
}

/**
 * ボードの上の線（画像の上の枠 → 付箋）。from・to は data-wb-from / data-wb-to の値。
 * 世界の座標で引く（倍率・位置が変わっても引き直さない。中身の大きさが変わったときだけ測り直す）
 */
export function useConnectors(worldRef: RefObject<HTMLElement | null>, deps: unknown[]): Array<{ key: string; x1: number; y1: number; x2: number; y2: number; kind?: string }> {
  const [lines, setLines] = useState<Array<{ key: string; x1: number; y1: number; x2: number; y2: number; kind?: string }>>([])
  useLayoutEffect(() => {
    const world = worldRef.current
    if (!world) return
    const measure = (): void => {
      const w = world.getBoundingClientRect()
      // 世界の幅（変形前）と画面の上の幅の比が今の倍率
      const scale = world.offsetWidth > 0 ? w.width / world.offsetWidth : 1
      if (!(scale > 0)) return
      const at = (r: DOMRect): { x: number; y: number; w: number; h: number } => ({ x: (r.left - w.left) / scale, y: (r.top - w.top) / scale, w: r.width / scale, h: r.height / scale })
      const next: Array<{ key: string; x1: number; y1: number; x2: number; y2: number; kind?: string }> = []
      for (const to of world.querySelectorAll<HTMLElement>('[data-wb-to]')) {
        const key = to.dataset.wbTo!
        const from = world.querySelector<HTMLElement>(`[data-wb-from="${CSS.escape(key)}"]`)
        if (!from) continue
        const a = at(from.getBoundingClientRect())
        const b = at(to.getBoundingClientRect())
        next.push({ key, x1: a.x + a.w / 2, y1: a.y + a.h, x2: b.x + b.w / 2, y2: b.y, kind: to.dataset.wbKind })
      }
      setLines((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(world)
    for (const img of world.querySelectorAll('img')) observer.observe(img)
    return () => observer.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 中身が変わったときだけ
  }, deps)
  return lines
}
