import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VideoIpcHandlers, VideoMainContext } from '../context'
import type { VideoReviewIpc } from '../../shared/ipc/review'
import { fixFeedbackPrompt, fpsOf, isFeedbackId, newFeedbackId, type TranscriptPiece } from '../../shared/review'
import { channelRelative, latestRender, readVideo, resolveVideoDir } from '../library/videos'
import { cli, videoLanguage } from '../library/ipc'
import { discardInbox, inboxDir, listSavedFeedback, reviewRegisterOps, saveFeedback, writeSnapshot, writeVoice } from './feedback'

function readTimeline(dir: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, 'timeline.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** timeline の長さ（区間の終わりのいちばん後ろ。フレーム） */
export function timelineFrames(timeline: unknown): number {
  const segs = (timeline as { segments?: unknown } | undefined)?.segments
  if (!Array.isArray(segs)) return 0
  let end = 0
  for (const s of segs) {
    const e = (s as { range?: { end?: unknown } } | null)?.range?.end
    if (typeof e === 'number' && Number.isFinite(e)) end = Math.max(end, e)
  }
  return Math.max(0, Math.floor(end))
}

/** 同じ秒に2回始めても別のフォルダになるように */
function freshId(dir: string): string {
  const base = newFeedbackId()
  let id = base
  for (let i = 2; existsSync(join(dir, 'feedback', id)) || existsSync(inboxDir(dir, id)); i++) id = `${base}-${i}`
  return id
}

/** 完成動画の確認・タイムコード付きの指摘（担当: 動画タブ） */
export function reviewHandlers(ctx: VideoMainContext): VideoIpcHandlers<VideoReviewIpc> {
  const videoDir = (name: string) => {
    const root = ctx.folderPath()
    return { root: root ?? '', dir: resolveVideoDir(root, name) }
  }

  return {
    'video:review:open': (name) => {
      const { root, dir } = videoDir(name)
      const entry = readVideo(dir, name)
      const tl = readTimeline(dir)
      const rendered = latestRender(dir)
      return {
        name,
        dir,
        title: entry.title,
        render: rendered ? channelRelative(root, dir, rendered) : null,
        fps: fpsOf(tl),
        durationFrames: timelineFrames(tl),
        lang: videoLanguage(dir),
        saved: listSavedFeedback(dir, tl)
      }
    },

    'video:review:transcribe': async (name, wav) => {
      const { dir } = videoDir(name)
      const id = freshId(dir)
      if (!wav || wav.length <= 44) return { id, pieces: [] }
      const path = writeVoice(dir, id, wav instanceof Uint8Array ? wav : new Uint8Array(wav))
      if (!ctx.transcribe) return { id, pieces: [], warning: 'transcription is not available' }
      try {
        const r = await ctx.transcribe(path, { language: videoLanguage(dir) })
        const pieces: TranscriptPiece[] = r.segments
          .filter((s) => Number.isFinite(s.t0) && Number.isFinite(s.t1) && typeof s.text === 'string')
          .map((s) => ({ t0: s.t0, t1: s.t1, text: s.text }))
        return r.warning ? { id, pieces, warning: r.warning } : { id, pieces }
      } catch (err) {
        ctx.reportHandled(err, { area: 'video', op: 'transcribe review' })
        return { id, pieces: [], warning: err instanceof Error ? err.message : String(err) }
      }
    },

    'video:review:snapshot': async (name, id, index, rect) => {
      const { dir } = videoDir(name)
      const win = ctx.mainWindow()
      if (!win || win.isDestroyed()) return false
      const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const zoom = win.webContents.getZoomFactor() || 1
      const r = { x: Math.max(0, Math.round(n(rect?.x) * zoom)), y: Math.max(0, Math.round(n(rect?.y) * zoom)), width: Math.round(n(rect?.width) * zoom), height: Math.round(n(rect?.height) * zoom) }
      if (r.width < 2 || r.height < 2) return false
      const image = await win.webContents.capturePage(r)
      if (image.isEmpty()) return false
      writeSnapshot(dir, id, index, new Uint8Array(image.toPNG()))
      return true
    },

    'video:review:save': async (name, input) => {
      const { dir } = videoDir(name)
      const tl = readTimeline(dir)
      const lang = videoLanguage(dir)
      const saved = saveFeedback(dir, { id: input?.id, session: input?.session, items: input?.items, fps: fpsOf(tl), lang })
      const warnings: string[] = []
      // `ferret-video feedback done <id>` が見つけられるよう timeline の review にも載せる（CLI が動かなくても保存は済んでいる）
      if (tl !== undefined) {
        try {
          const r = await cli(['edit', '--ops', JSON.stringify(reviewRegisterOps(tl, saved.id, saved.count, lang)), '--json'], dir)
          if (r.code !== 0) warnings.push(r.stderr.trim().split(/\r?\n/).at(-1) ?? 'ferret-video edit failed')
        } catch (err) {
          warnings.push(err instanceof Error ? err.message : String(err))
        }
      }
      ctx.send('video:review:changed')
      return { id: saved.id, path: join(dir, saved.path), count: saved.count, prompt: fixFeedbackPrompt(dir, saved.id, lang), warnings }
    },

    'video:review:discard': (name, id) => {
      const { dir } = videoDir(name)
      if (isFeedbackId(id)) discardInbox(dir, id)
    },

    'video:review:prompt': (name, id) => {
      const { dir } = videoDir(name)
      if (!isFeedbackId(id)) throw new Error(`invalid feedback id: ${String(id)}`)
      return fixFeedbackPrompt(dir, id, videoLanguage(dir))
    }
  }
}
