import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fitRegion, normalizeCursor, parseRegion, regionScreenBounds, type DisplayInfo, type Rect } from '../../shared/record/region'
import type { TakeCursorInfo } from '../../shared/record/take'

/**
 * テイクのカーソルの記録（編集でカーソルを追うズームに使う）。screen.getCursorScreenPoint() を 30Hz で読み、
 * 録ったディスプレイ（範囲を録るときはその範囲）に対する 0〜1 にして、media/takes/<id>/cursor.jsonl へ {t_ms, x, y} を足す。
 * t_ms はテイクの時計（テイクを始めてからの ms。take.json と同じ起点）。旧 Solocut の main/services/cursor.ts から移した。
 * クリック・キー入力はまだ記録しない（全体の入力のフックが要る）。
 */

export interface ScreenLike {
  getAllDisplays(): Array<{ id: number | string; bounds: Rect; scaleFactor: number }>
  getDisplayNearestPoint(p: { x: number; y: number }): { id: number | string; bounds: Rect; scaleFactor: number }
  getCursorScreenPoint(): { x: number; y: number }
}

export const CURSOR_HZ = 30

interface Session {
  timer: ReturnType<typeof setInterval>
  flush: ReturnType<typeof setInterval>
  buf: string[]
  path: string
}

export class CursorLog {
  private readonly sessions = new Map<string, Session>()

  constructor(private readonly screen: ScreenLike, private readonly clock: () => number = () => performance.timeOrigin + performance.now()) {}

  /**
   * 記録を始める。displayId は録る画面のディスプレイ（ウインドウを録るときは null。カーソルの近くのディスプレイに対する座標になる）
   * @param epochStartMs テイクを始めた時刻（epoch ms。録画ウインドウの timeOrigin + startedAtMs）
   */
  start(takeId: string, takeDir: string, displayId: string | null, epochStartMs: number, regionIn?: unknown): TakeCursorInfo {
    this.stop(takeId)
    const found = displayId ? this.screen.getAllDisplays().find((d) => String(d.id) === displayId) : undefined
    const display = found ?? this.screen.getDisplayNearestPoint(this.screen.getCursorScreenPoint())
    const info: DisplayInfo = { id: String(display.id), bounds: display.bounds, scaleFactor: display.scaleFactor }
    const parsed = parseRegion(regionIn)
    const region = found && parsed ? fitRegion(parsed, info) : null
    const b = region ? regionScreenBounds(region, info) : display.bounds
    const bounds = { x: b.x, y: b.y, width: b.width, height: b.height }
    const path = join(takeDir, 'cursor.jsonl')
    writeFileSync(path, '')
    let last = ''
    const buf: string[] = []
    const timer = setInterval(() => {
      const t = Math.round(this.clock() - epochStartMs)
      const p = normalizeCursor(this.screen.getCursorScreenPoint(), bounds)
      const key = `${p.x},${p.y}`
      // 止まっている間はファイルを小さく保つ。ただし1秒に1回は書く
      if (key === last && t % 1000 >= 1000 / CURSOR_HZ) return
      last = key
      buf.push(JSON.stringify({ t_ms: t, x: p.x, y: p.y }))
    }, 1000 / CURSOR_HZ)
    const session: Session = { timer, buf, path, flush: setInterval(() => flushSession(session), 1000) }
    timer.unref?.()
    session.flush.unref?.()
    this.sessions.set(takeId, session)
    return {
      file: 'cursor.jsonl', hz: CURSOR_HZ, displayId: info.id, bounds, scaleFactor: display.scaleFactor, window: !found,
      ...(region ? { region } : {})
    }
  }

  stop(takeId: string): void {
    const s = this.sessions.get(takeId)
    if (!s) return
    clearInterval(s.timer)
    clearInterval(s.flush)
    flushSession(s)
    this.sessions.delete(takeId)
  }

  stopAll(): void {
    for (const id of [...this.sessions.keys()]) this.stop(id)
  }
}

function flushSession(s: { buf: string[]; path: string }): void {
  if (s.buf.length === 0) return
  const lines = s.buf.splice(0).join('\n') + '\n'
  try {
    appendFileSync(s.path, lines)
  } catch {
    // ディスクがいっぱい・消された。カーソルの記録は無くても録画は続ける
  }
}
