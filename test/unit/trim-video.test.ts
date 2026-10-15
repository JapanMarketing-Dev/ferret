import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 削った版を作る非表示ウィンドウ（trimVideo.ts）。ページの処理は Electron の中でしか動かないので、
 * executeJavaScript の結果だけを差し替えて、やり直しと失敗の扱いを確かめる
 */
const page = vi.hoisted(() => ({ runs: [] as Array<() => Promise<unknown>>, windows: 0, destroyed: 0, blockers: new Set<number>(), nextBlocker: 1, blockerStarts: [] as string[] }))
vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: (type: string) => { page.blockerStarts.push(type); const id = page.nextBlocker++; page.blockers.add(id); return id },
    stop: (id: number) => { page.blockers.delete(id) },
    isStarted: (id: number) => page.blockers.has(id)
  },
  BrowserWindow: class {
    private gone = false
    webContents = {
      setAudioMuted: () => {},
      executeJavaScript: (code: string) => {
        if (code.startsWith('window.__trimPull')) return Promise.resolve(Buffer.from('webm').toString('base64'))
        const run = page.runs.shift()
        return run ? run() : Promise.resolve(4)
      }
    }
    constructor() { page.windows++ }
    loadURL() { return Promise.resolve() }
    isDestroyed() { return this.gone }
    destroy() { this.gone = true; page.destroyed++ }
  }
}))

let dir = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ferret-trimvideo-'))
  page.runs = []
  page.windows = 0
  page.destroyed = 0
  page.blockers.clear()
  page.blockerStarts = []
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('削った版を作る（renderTrimmedVideo）', () => {
  it('1回目がページの中で失敗しても、新しいウィンドウでやり直して書き出す', async () => {
    // e2e で見つかった形: Error でない値（中身の無い DOMException）で reject される
    page.runs = [() => Promise.reject({}), () => Promise.resolve(4)]
    const { renderTrimmedVideo } = await import('../../src/main/trimVideo')
    const out = join(dir, 'out.webm')
    await renderTrimmedVideo('ade-media://review/x/recording.webm', out, [{ start: 0, end: 1000 }])
    expect(await readFile(out, 'utf8')).toBe('webm')
    expect(page.windows).toBe(2)
    expect(page.destroyed).toBe(2)
  })

  it('やり直しても失敗したら、理由の読める Error で投げ、途中のファイルを残さない', async () => {
    page.runs = [() => Promise.reject({ name: 'AbortError', message: 'The play() request was interrupted' }), () => Promise.reject({})]
    const { renderTrimmedVideo } = await import('../../src/main/trimVideo')
    const out = join(dir, 'out.webm')
    const err = await renderTrimmedVideo('ade-media://review/x/recording.webm', out, [{ start: 0, end: 1000 }]).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/^trim failed: /)
    expect(existsSync(out)).toBe(false)
    expect(page.destroyed).toBe(2)
  })

  it('中身の無い結果は失敗として扱う', async () => {
    page.runs = [() => Promise.resolve(0)]
    const { renderTrimmedVideo } = await import('../../src/main/trimVideo')
    await expect(renderTrimmedVideo('ade-media://review/x/recording.webm', join(dir, 'out.webm'), [{ start: 0, end: 1000 }], { attempts: 1 }))
      .rejects.toThrow('trim produced no data')
  })
})

describe('時間切れは動いていた時間だけで数える（FERRET-1Y: 裏に回して App Nap・スリープで止められていた）', () => {
  it('間が詰まって進むときは、合計が時間切れの長さに届いたところで切れる（境界）', async () => {
    const { AwakeDeadline } = await import('../../src/main/trimVideo')
    const d = new AwakeDeadline(3000, 0)
    expect(d.tick(1000)).toBe(false)
    expect(d.tick(2000)).toBe(false)
    expect(d.tick(2999)).toBe(false)
    expect(d.tick(3000)).toBe(true)
  })

  it('止められていた長い間（5秒を超える空き）は数えない', async () => {
    const { AwakeDeadline } = await import('../../src/main/trimVideo')
    const d = new AwakeDeadline(3000, 0)
    expect(d.tick(1000)).toBe(false)
    // 6分半止められていた（FERRET-1Y の形）
    expect(d.tick(1000 + 390_000)).toBe(false)
    expect(d.tick(1000 + 390_000 + 1000)).toBe(false)
    expect(d.tick(1000 + 390_000 + 2000)).toBe(true)
  })

  it('ちょうど5秒の空きは数え、5秒を1ms超えたら数えない', async () => {
    const { AwakeDeadline } = await import('../../src/main/trimVideo')
    expect(new AwakeDeadline(5000, 0).tick(5000)).toBe(true)
    expect(new AwakeDeadline(5000, 0).tick(5001)).toBe(false)
  })

  it('時計が戻っても（負の間）数えず、時間切れにしない', async () => {
    const { AwakeDeadline } = await import('../../src/main/trimVideo')
    const d = new AwakeDeadline(1000, 10_000)
    expect(d.tick(5000)).toBe(false)
    expect(d.tick(5900)).toBe(false)
    expect(d.tick(6000)).toBe(true)
  })

  it('削っている間だけ App Nap を止め、成功でも失敗でも必ず外す', async () => {
    const { renderTrimmedVideo } = await import('../../src/main/trimVideo')
    page.runs = [() => Promise.resolve(4)]
    await renderTrimmedVideo('ade-media://review/x/recording.webm', join(dir, 'ok.webm'), [{ start: 0, end: 1000 }])
    page.runs = [() => Promise.reject(new Error('boom'))]
    await expect(renderTrimmedVideo('ade-media://review/x/recording.webm', join(dir, 'ng.webm'), [{ start: 0, end: 1000 }], { attempts: 1 })).rejects.toThrow('boom')
    expect(page.blockerStarts).toEqual(['prevent-app-suspension', 'prevent-app-suspension'])
    expect(page.blockers.size).toBe(0)
  })

  it('ページが終わらなければ、動いていた時間で時間切れにしてウィンドウと App Nap の止めを片付ける', async () => {
    const { renderTrimmedVideo } = await import('../../src/main/trimVideo')
    page.runs = [() => new Promise(() => {})]
    const out = join(dir, 'never.webm')
    await expect(renderTrimmedVideo('ade-media://review/x/recording.webm', out, [{ start: 0, end: 1000 }], { attempts: 1, timeoutMs: 50 })).rejects.toThrow('trim timed out')
    expect(existsSync(out)).toBe(false)
    expect(page.destroyed).toBe(1)
    expect(page.blockers.size).toBe(0)
  })
})
