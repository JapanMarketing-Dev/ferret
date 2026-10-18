import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cli = vi.hoisted(() => ({ run: vi.fn(async () => ({ code: 0, stdout: '{}', stderr: '' })) }))
vi.mock('@video/app/main/cli/run', () => ({ runVideoCli: cli.run }))
vi.mock('electron', () => ({ shell: { openPath: vi.fn() } }))

import { setLocale } from '@shared/i18n'
import { reviewHandlers, timelineFrames } from '@video/app/main/review/ipc'
import type { VideoMainContext } from '@video/app/main/context'
import { encodeWav } from '@video/app/shared/wav'
import { inboxDir } from '@video/app/main/review/feedback'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
let root: string
let v: string
let ctx: VideoMainContext & { sent: string[] }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-video-rv-')))
  v = join(root, '2026-10-18-a')
  mkdirSync(join(v, 'renders', 'youtube'), { recursive: true })
  writeFileSync(join(v, 'ferret-video.json'), JSON.stringify({ title: 'A', language: 'ja' }))
  writeFileSync(join(v, 'timeline.json'), JSON.stringify({ canvas: { fps: { num: 25, den: 1 } }, segments: [{ range: { start: 0, end: 250 } }, { range: { start: 250, end: 500 } }], review: { feedback: [], openItems: [] } }))
  writeFileSync(join(v, 'renders', 'youtube', 'preview.mp4'), '')
  const sent: string[] = []
  ctx = {
    sent,
    folderPath: () => root,
    project: () => null,
    send: (c: string) => { sent.push(c) },
    mainWindow: () => null,
    userDataDir: root,
    appOutDir: root,
    isPackaged: false,
    sendToAgent: async () => ({ ok: true, message: '' }),
    reportHandled: vi.fn()
  } as unknown as VideoMainContext & { sent: string[] }
  cli.run.mockClear()
  setLocale('en')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('timelineFrames', () => {
  it('is the end of the last segment', () => {
    expect(timelineFrames({ segments: [{ range: { end: 10 } }, { range: { end: 5 } }] })).toBe(10)
    expect(timelineFrames({ segments: [{}, null, { range: { end: 'x' } }] })).toBe(0)
    expect(timelineFrames(undefined)).toBe(0)
  })
})

describe('video:review:open', () => {
  it('returns the render path from the channel, fps, length and language', () => {
    const r = reviewHandlers(ctx)['video:review:open']('2026-10-18-a')
    expect(r).toMatchObject({ name: '2026-10-18-a', dir: v, title: 'A', render: '2026-10-18-a/renders/youtube/preview.mp4', fps: { num: 25, den: 1 }, durationFrames: 500, lang: 'ja', saved: [] })
  })
  it('has no render before the first export', () => {
    rmSync(join(v, 'renders'), { recursive: true })
    expect((reviewHandlers(ctx)['video:review:open']('2026-10-18-a') as { render: unknown }).render).toBeNull()
  })
  it('refuses names that leave the channel', () => {
    expect(() => reviewHandlers(ctx)['video:review:open']('../etc')).toThrow(/invalid/)
    expect(() => reviewHandlers(ctx)['video:review:open']('2026-10-18-a/../..')).toThrow(/invalid/)
  })
})

describe('video:review:transcribe', () => {
  it('saves the voice and returns the transcript with a fresh id', async () => {
    ctx.transcribe = vi.fn(async () => ({ segments: [{ t0: 0, t1: 500, text: 'ここ' }, { t0: Number.NaN, t1: 1, text: 'x' }] }))
    const r = await reviewHandlers(ctx)['video:review:transcribe']('2026-10-18-a', encodeWav([new Int16Array(1600)])) as { id: string; pieces: unknown[] }
    expect(r.id).toMatch(/^fb_\d{8}-\d{6}$/)
    expect(r.pieces).toEqual([{ t0: 0, t1: 500, text: 'ここ' }])
    expect(existsSync(join(inboxDir(v, r.id), 'voice.wav'))).toBe(true)
    expect(ctx.transcribe).toHaveBeenCalledWith(join(inboxDir(v, r.id), 'voice.wav'), { language: 'ja' })
  })
  it('gives a new id when the same second is already used', async () => {
    const h = reviewHandlers(ctx)
    const a = await h['video:review:transcribe']('2026-10-18-a', encodeWav([new Int16Array(10)])) as { id: string }
    const b = await h['video:review:transcribe']('2026-10-18-a', encodeWav([new Int16Array(10)])) as { id: string }
    expect(b.id).not.toBe(a.id)
  })
  it('returns no pieces without audio (pen only) and does not call whisper', async () => {
    ctx.transcribe = vi.fn()
    const r = await reviewHandlers(ctx)['video:review:transcribe']('2026-10-18-a', null) as { pieces: unknown[]; warning?: string }
    expect(r.pieces).toEqual([])
    expect(r.warning).toBeUndefined()
    expect(ctx.transcribe).not.toHaveBeenCalled()
    const empty = await reviewHandlers(ctx)['video:review:transcribe']('2026-10-18-a', encodeWav([])) as { pieces: unknown[] }
    expect(empty.pieces).toEqual([])
  })
  it('warns when transcription is not wired or fails', async () => {
    const none = await reviewHandlers(ctx)['video:review:transcribe']('2026-10-18-a', encodeWav([new Int16Array(10)])) as { warning?: string }
    expect(none.warning).toMatch(/not available/)
    ctx.transcribe = vi.fn(async () => { throw new Error('whisper crashed') })
    const failed = await reviewHandlers(ctx)['video:review:transcribe']('2026-10-18-a', encodeWav([new Int16Array(10)])) as { warning?: string }
    expect(failed.warning).toBe('whisper crashed')
    expect(ctx.reportHandled).toHaveBeenCalled()
    ctx.transcribe = vi.fn(async () => ({ segments: [], warning: 'no model' }))
    const warned = await reviewHandlers(ctx)['video:review:transcribe']('2026-10-18-a', encodeWav([new Int16Array(10)])) as { warning?: string }
    expect(warned.warning).toBe('no model')
  })
  it('refuses data that is not a WAV', async () => {
    await expect(reviewHandlers(ctx)['video:review:transcribe']('2026-10-18-a', new Uint8Array(100)) as Promise<unknown>).rejects.toThrow(/WAV/)
  })
})

describe('video:review:snapshot', () => {
  const win = (png: Uint8Array, empty = false) => {
    const capturePage = vi.fn(async () => ({ isEmpty: () => empty, toPNG: () => Buffer.from(png) }))
    return { capturePage, window: { isDestroyed: () => false, webContents: { getZoomFactor: () => 1.25, capturePage } } }
  }
  it('captures the rect (scaled by zoom) into the inbox', async () => {
    const w = win(PNG)
    ctx.mainWindow = () => w.window as never
    const ok = await reviewHandlers(ctx)['video:review:snapshot']('2026-10-18-a', 'fb_1', 2, { x: 10, y: 20, width: 400, height: 225 })
    expect(ok).toBe(true)
    expect(w.capturePage).toHaveBeenCalledWith({ x: 13, y: 25, width: 500, height: 281 })
    expect(readFileSync(join(inboxDir(v, 'fb_1'), '02.png'))).toEqual(Buffer.from(PNG))
  })
  it('is false without a window, for a tiny rect or an empty image', async () => {
    expect(await reviewHandlers(ctx)['video:review:snapshot']('2026-10-18-a', 'fb_1', 1, { x: 0, y: 0, width: 100, height: 100 })).toBe(false)
    const w = win(PNG, true)
    ctx.mainWindow = () => w.window as never
    expect(await reviewHandlers(ctx)['video:review:snapshot']('2026-10-18-a', 'fb_1', 1, { x: 0, y: 0, width: 1, height: 1 })).toBe(false)
    expect(w.capturePage).not.toHaveBeenCalled()
    expect(await reviewHandlers(ctx)['video:review:snapshot']('2026-10-18-a', 'fb_1', 1, { x: 0, y: 0, width: 100, height: 100 })).toBe(false)
  })
  it('treats garbage coordinates as 0', async () => {
    const w = win(PNG)
    ctx.mainWindow = () => w.window as never
    await reviewHandlers(ctx)['video:review:snapshot']('2026-10-18-a', 'fb_1', 1, { x: Number.NaN, y: -50, width: 100, height: 100 })
    expect(w.capturePage).toHaveBeenCalledWith({ x: 0, y: 0, width: 125, height: 125 })
  })
  it('refuses a bad id or index', async () => {
    const w = win(PNG)
    ctx.mainWindow = () => w.window as never
    await expect(reviewHandlers(ctx)['video:review:snapshot']('2026-10-18-a', '../x', 1, { x: 0, y: 0, width: 10, height: 10 }) as Promise<unknown>).rejects.toThrow(/invalid feedback id/)
    await expect(reviewHandlers(ctx)['video:review:snapshot']('2026-10-18-a', 'fb_1', 0, { x: 0, y: 0, width: 10, height: 10 }) as Promise<unknown>).rejects.toThrow(/index/)
  })
})

describe('video:review:save', () => {
  it('writes the feedback, registers it on the timeline and returns the fix prompt', async () => {
    const r = await reviewHandlers(ctx)['video:review:save']('2026-10-18-a', {
      id: 'fb_1',
      session: { schema: 1, playback: [], strokes: [], notes: [] },
      items: [{ index: 1, atMs: 0, frame: 50, speech: '字幕が遅い', strokes: [], notes: [], targets: [] }]
    }) as { id: string; path: string; count: number; prompt: string; warnings: string[] }
    expect(r).toMatchObject({ id: 'fb_1', path: join(v, 'feedback', 'fb_1', 'feedback.md'), count: 1, warnings: [] })
    expect(readFileSync(r.path, 'utf8')).toContain('## 1. [00:00:02:00] 字幕が遅い')
    expect(r.prompt).toContain(`${v}/feedback/fb_1/feedback.md`)
    expect(r.prompt).toContain(`cd "${v}"`)
    const [argv, opts] = cli.run.mock.calls[0] as unknown as [string[], { cwd: string }]
    expect(argv[0]).toBe('edit')
    expect(argv[1]).toBe('--ops')
    expect(JSON.parse(argv[2]!)[0].patch.feedback).toEqual([{ id: 'fb_1', status: 'open', items: 1 }])
    expect(opts.cwd).toBe(v)
    expect(argv.slice(-2)).toEqual(['--lang', 'en'])
    expect(ctx.sent).toContain('video:review:changed')
  })
  it('keeps the saved feedback and warns when the timeline edit fails', async () => {
    cli.run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'edit: bad op' })
    const r = await reviewHandlers(ctx)['video:review:save']('2026-10-18-a', { id: 'fb_2', session: { schema: 1, playback: [], strokes: [], notes: [] }, items: [{ speech: 'x' }] as never }) as { warnings: string[]; path: string }
    expect(r.warnings).toEqual(['edit: bad op'])
    expect(existsSync(r.path)).toBe(true)
  })
  it('skips the timeline edit without timeline.json', async () => {
    rmSync(join(v, 'timeline.json'))
    await reviewHandlers(ctx)['video:review:save']('2026-10-18-a', { id: 'fb_3', session: { schema: 1, playback: [], strokes: [], notes: [] }, items: [{ speech: 'x' }] as never })
    expect(cli.run).not.toHaveBeenCalled()
  })
  it('refuses empty items', async () => {
    await expect(reviewHandlers(ctx)['video:review:save']('2026-10-18-a', { id: 'fb_4', session: { schema: 1, playback: [], strokes: [], notes: [] }, items: [] }) as Promise<unknown>).rejects.toThrow(/no feedback items/)
  })
})

describe('video:review:discard / video:review:prompt', () => {
  it('discards the inbox and ignores bad ids', () => {
    mkdirSync(inboxDir(v, 'fb_1'), { recursive: true })
    reviewHandlers(ctx)['video:review:discard']('2026-10-18-a', 'fb_1')
    expect(existsSync(inboxDir(v, 'fb_1'))).toBe(false)
    expect(() => reviewHandlers(ctx)['video:review:discard']('2026-10-18-a', '../../x')).not.toThrow()
  })
  it('builds the prompt and refuses bad ids', () => {
    expect(reviewHandlers(ctx)['video:review:prompt']('2026-10-18-a', 'fb_1')).toContain('feedback/fb_1/feedback.md')
    expect(() => reviewHandlers(ctx)['video:review:prompt']('2026-10-18-a', 'fb_../x')).toThrow(/invalid/)
  })
})
