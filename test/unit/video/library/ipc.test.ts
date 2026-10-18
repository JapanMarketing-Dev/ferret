import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const cli = vi.hoisted(() => ({ run: vi.fn() }))
const shell = vi.hoisted(() => ({ openPath: vi.fn(async () => '') }))
vi.mock('@video/app/main/cli/run', () => ({ runVideoCli: cli.run }))
vi.mock('electron', () => ({ shell }))
vi.mock('@video/settings', () => ({
  loadSettings: () => ({ prompts: {} }),
  renderPromptById: (id: string, vars: Record<string, string>, lang: string) => ({ text: `${id}:${lang}:${vars.project}:${vars.template}` })
}))

import { setLocale } from '@shared/i18n'
import { libraryHandlers, videoLanguage } from '@video/app/main/library/ipc'
import type { VideoMainContext } from '@video/app/main/context'

let root: string
let ctx: VideoMainContext & { sent: string[] }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-video-ipc-')))
  const sent: string[] = []
  ctx = {
    sent,
    folderPath: () => root,
    project: () => ({ id: 'p', name: 'ch' }),
    send: (channel: string) => { sent.push(channel) },
    mainWindow: () => null,
    userDataDir: root,
    appOutDir: root,
    isPackaged: false,
    sendToAgent: async () => ({ ok: true, message: '' }),
    reportHandled: vi.fn()
  } as unknown as VideoMainContext & { sent: string[] }
  cli.run.mockReset()
  setLocale('en')
  shell.openPath.mockClear()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function video(name: string, json: object = { title: name }): string {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'ferret-video.json'), JSON.stringify(json))
  return join(root, name)
}

describe('video:isChannel / video:list', () => {
  it('answers from the folder contents', () => {
    const h = libraryHandlers(ctx)
    expect(h['video:isChannel'](root)).toBe(false)
    video('v')
    expect(h['video:isChannel'](root)).toBe(true)
    expect(h['video:isChannel'](42 as unknown as string)).toBe(false)
  })
  it('lists the open channel, or nothing without a project', () => {
    video('v')
    expect((libraryHandlers(ctx)['video:list']() as { videos: unknown[] }).videos).toHaveLength(1)
    ctx.folderPath = () => null
    expect(libraryHandlers(ctx)['video:list']()).toEqual({ root: '', exists: false, videos: [] })
  })
})

describe('video:create', () => {
  it('makes the dated folder and runs init there', async () => {
    cli.run.mockImplementation(async (_argv: string[], o: { cwd: string }) => {
      writeFileSync(join(o.cwd, 'ferret-video.json'), '{}')
      return { code: 0, stdout: '{"ok":true}', stderr: '' }
    })
    const r = await libraryHandlers(ctx)['video:create']({ title: ' Claude の小技 ', template: 'talk' }) as { ok: boolean; name: string; dir: string }
    expect(r.ok).toBe(true)
    expect(r.name).toMatch(/^\d{4}-\d{2}-\d{2}-Claude-の小技$/)
    expect(r.dir).toBe(join(root, r.name))
    const [argv, opts] = cli.run.mock.calls[0]!
    expect(argv).toEqual(['init', '--template', 'talk', '--title', 'Claude の小技', '--json'])
    expect(opts.cwd).toBe(r.dir)
    expect(ctx.sent).toContain('video:changed')
  })
  it('adds -2 when the folder exists and uses the folder name as title without one', async () => {
    cli.run.mockImplementation(async (_a: string[], o: { cwd: string }) => {
      writeFileSync(join(o.cwd, 'ferret-video.json'), '{}')
      return { code: 0, stdout: '', stderr: '' }
    })
    const h = libraryHandlers(ctx)
    const a = await h['video:create']({ title: 'same' }) as { name: string }
    const b = await h['video:create']({ title: 'same' }) as { name: string }
    expect(b.name).toBe(`${a.name}-2`)
    const untitled = await h['video:create']({ title: '' }) as { name: string }
    expect(cli.run.mock.calls[2]![0]).toEqual(['init', '--template', 'tech', '--title', untitled.name, '--json'])
  })
  it('falls back to the default template for unsafe ids', async () => {
    cli.run.mockResolvedValue({ code: 1, stdout: '', stderr: 'x' })
    await libraryHandlers(ctx)['video:create']({ title: 't', template: '../evil' })
    expect(cli.run.mock.calls[0]![0]).toContain('tech')
    expect(cli.run.mock.calls[0]![0]).not.toContain('../evil')
  })
  it('removes the empty folder and returns the CLI error on failure', async () => {
    cli.run.mockResolvedValue({ code: 1, stdout: '{"ok":false,"error":{"message":"no template"}}', stderr: '' })
    const r = await libraryHandlers(ctx)['video:create']({ title: 'x' })
    expect(r).toEqual({ ok: false, error: 'no template' })
    expect(readdirSync(root)).toEqual([])
    expect(ctx.sent).not.toContain('video:changed')
  })
  it('keeps a half-written folder for inspection', async () => {
    cli.run.mockImplementation(async (_a: string[], o: { cwd: string }) => {
      writeFileSync(join(o.cwd, 'timeline.json'), '{}')
      return { code: 0, stdout: '', stderr: '' }
    })
    const r = await libraryHandlers(ctx)['video:create']({ title: 'half' }) as { ok: boolean }
    expect(r.ok).toBe(false)
    expect(readdirSync(root)).toHaveLength(1)
  })
  it('caps a very long title', async () => {
    cli.run.mockResolvedValue({ code: 1, stdout: '', stderr: '' })
    await libraryHandlers(ctx)['video:create']({ title: 'あ'.repeat(500) })
    const title = cli.run.mock.calls[0]![0][4] as string
    expect(title).toHaveLength(200)
  })
  it('throws without an open project', async () => {
    ctx.folderPath = () => null
    await expect(libraryHandlers(ctx)['video:create']({ title: 'x' }) as Promise<unknown>).rejects.toThrow(/no project/)
  })
})

describe('video:detail', () => {
  it('parses status --json and finds the render', async () => {
    const v = video('v', { title: 'T' })
    mkdirSync(join(v, 'renders', 'youtube'), { recursive: true })
    writeFileSync(join(v, 'renders', 'youtube', 'final.mp4'), '')
    cli.run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true, steps: [{ step: 'ingest', state: 'done' }], next: { step: 'captions', state: 'ready', why: 'w' } }), stderr: '' })
    const d = await libraryHandlers(ctx)['video:detail']('v') as Awaited<ReturnType<ReturnType<typeof libraryHandlers>['video:detail']>> & object
    expect(d).toMatchObject({ entry: { title: 'T', status: 'done' }, steps: [{ step: 'ingest', state: 'done' }], next: { step: 'captions' }, render: 'v/renders/youtube/final.mp4' })
    expect(cli.run.mock.calls[0]).toEqual([['status', '--json', '--lang', 'en'], { cwd: v }])
  })
  it('falls back to status.json with the error when the CLI fails', async () => {
    const v = video('v')
    mkdirSync(join(v, '.ferret-video'))
    writeFileSync(join(v, '.ferret-video', 'status.json'), JSON.stringify({ steps: [{ step: 'ingest', state: 'running' }] }))
    cli.run.mockResolvedValue({ code: 1, stdout: '', stderr: 'boom' })
    const d = await libraryHandlers(ctx)['video:detail']('v') as { steps: unknown[]; error?: string }
    expect(d.steps).toEqual([{ step: 'ingest', state: 'running' }])
    expect(d.error).toBe('boom')
  })
  it('does not call the CLI for a legacy project', async () => {
    mkdirSync(join(root, 'old'))
    writeFileSync(join(root, 'old', 'solocut.json'), '{}')
    const d = await libraryHandlers(ctx)['video:detail']('old') as { error?: string; entry: { legacy?: boolean } }
    expect(d.error).toBe('legacy')
    expect(d.entry.legacy).toBe(true)
    expect(cli.run).not.toHaveBeenCalled()
  })
  it('refuses names outside the channel', async () => {
    await expect(Promise.resolve().then(() => libraryHandlers(ctx)['video:detail']('../x'))).rejects.toThrow(/invalid/)
  })
})

describe('video:finishPrompt', () => {
  it('renders the finish prompt with the video folder', async () => {
    const v = video('v', { title: 'Title', template: { id: 'talk' }, language: 'en' })
    const text = await libraryHandlers(ctx)['video:finishPrompt']('v') as string
    expect(text.startsWith(`Video folder: ${v}\n`)).toBe(true)
    expect(text.endsWith('finish:en:Title:talk')).toBe(true)
  })
  it('uses Japanese and the default template otherwise', async () => {
    video('v', { title: 'T' })
    const text = await libraryHandlers(ctx)['video:finishPrompt']('v') as string
    expect(text).toContain('対象の動画のフォルダ')
    expect(text.endsWith('finish:ja:T:tech')).toBe(true)
  })
})

describe('video:openFolder / video:migrate / video:templates', () => {
  it('opens the real folder and reports errors', async () => {
    const v = video('v')
    await libraryHandlers(ctx)['video:openFolder']('v')
    expect(shell.openPath).toHaveBeenCalledWith(v)
    shell.openPath.mockResolvedValueOnce('denied')
    await expect(libraryHandlers(ctx)['video:openFolder']('v') as Promise<unknown>).rejects.toThrow('denied')
  })
  it('runs migrate in the folder', async () => {
    mkdirSync(join(root, 'old'))
    writeFileSync(join(root, 'old', 'solocut.json'), '{}')
    cli.run.mockResolvedValueOnce({ code: 0, stdout: '{}', stderr: '' })
    expect(await libraryHandlers(ctx)['video:migrate']('old')).toEqual({ ok: true, message: '' })
    expect(ctx.sent).toContain('video:changed')
    cli.run.mockResolvedValueOnce({ code: 2, stdout: '', stderr: 'unknown command' })
    expect(await libraryHandlers(ctx)['video:migrate']('old')).toEqual({ ok: false, message: 'unknown command' })
  })
  it('passes the screen language to commands that print text, but not to init', async () => {
    video('v')
    cli.run.mockResolvedValue({ code: 0, stdout: '{}', stderr: '' })
    setLocale('ja')
    await libraryHandlers(ctx)['video:detail']('v')
    await libraryHandlers(ctx)['video:migrate']('v')
    await libraryHandlers(ctx)['video:templates']()
    await libraryHandlers(ctx)['video:create']({ title: 'x' })
    const calls = cli.run.mock.calls.map((c) => c[0] as string[])
    expect(calls[0]).toEqual(['status', '--json', '--lang', 'ja'])
    expect(calls[1]).toEqual(['migrate', '--json', '--lang', 'ja'])
    expect(calls[2]).toEqual(['templates', '--json', '--lang', 'ja'])
    expect(calls[3]).not.toContain('--lang')
    setLocale('en')
  })
  it('reads templates from the CLI', async () => {
    cli.run.mockResolvedValue({ code: 0, stdout: JSON.stringify({ ok: true, templates: [{ id: 'tech', name: { ja: '技術', en: 'Tech' } }] }), stderr: '' })
    expect(await libraryHandlers(ctx)['video:templates']()).toEqual([{ id: 'tech', name: { ja: '技術', en: 'Tech' } }])
  })
})

describe('videoLanguage', () => {
  it('is en only when the project says so', () => {
    expect(videoLanguage(video('a', { language: 'en' }))).toBe('en')
    expect(videoLanguage(video('b', { language: 'fr' }))).toBe('ja')
    expect(videoLanguage(join(root, 'missing'))).toBe('ja')
    expect(existsSync(join(root, 'missing'))).toBe(false)
  })
})
