/**
 * 分解が終わっていない記録を開いたときの復元（src/main/review.ts の recoverReview）。
 * FERRET-25: 素材が何も残っていない記録を開くと「復元できる記録がありません。」を不具合として Sentry に送っていた
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionPaths } from '../../src/main/sessions/paths'
import { isUserFacingError } from '../../src/shared/errors'
import { wrapIpcHandler } from '../../src/shared/telemetry'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'ferret-review-recover-unit'), getLocale: () => 'ja' },
  clipboard: {}, shell: {}, nativeImage: { createFromPath: () => ({ isEmpty: () => true }) }
}))

const ID = '20261029-093000'
let base = ''
let paths: ReturnType<typeof sessionPaths>
beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'ferret-review-recover-'))
  paths = sessionPaths(base, ID, '.ferret')
  await mkdir(paths.dir, { recursive: true })
})
afterEach(async () => { await rm(base, { recursive: true, force: true }) })

async function load(): Promise<unknown> {
  const { loadReviewAt } = await import('../../src/main/review')
  return loadReviewAt(paths)
}
async function failure(): Promise<unknown> {
  return load().then(() => { throw new Error('should have failed') }, (err: unknown) => err)
}

describe('素材の無い記録（想定内。利用者に理由を出すだけ）', () => {
  it('空のフォルダは「復元できる記録がありません」の UserFacingError。IPC で包んでも送らない', async () => {
    const err = await failure()
    expect(isUserFacingError(err)).toBe(true)
    expect((err as Error).message).toMatch(/復元できる記録がありません|Nothing to recover/)
    // renderer が本文を取り出す形（name は Error のまま）
    expect((err as Error).name).toBe('Error')

    const report = vi.fn()
    const handler = wrapIpcHandler('review:load', () => load(), report)
    await expect(handler()).rejects.toThrow()
    expect(report).not.toHaveBeenCalled()
  })

  it('空の操作ログ・空の音声と静止画のフォルダ（数えると0件）も同じ', async () => {
    await writeFile(paths.eventsJsonl, '')
    await mkdir(paths.audioDir, { recursive: true })
    await writeFile(join(paths.audioDir, 'note.txt'), 'not audio') // .wav でないものは数えない
    await mkdir(paths.framesDir, { recursive: true })
    const err = await failure()
    expect(isUserFacingError(err)).toBe(true)
  })

  it('壊れた session.json だけが残っているときは「壊れている」の UserFacingError。session.json は移さない', async () => {
    await writeFile(paths.sessionJson, '{ broken')
    const err = await failure()
    expect(isUserFacingError(err)).toBe(true)
    expect((err as Error).message).toMatch(/壊れて|corrupted/)
    expect(await readFile(paths.sessionJson, 'utf8')).toBe('{ broken')
    expect(existsSync(`${paths.sessionJson}.broken`)).toBe(false)
  })
})

describe('素材が残っていれば今までどおり復元する', () => {
  it('操作ログが1行でもあれば開ける', async () => {
    await writeFile(paths.eventsJsonl, JSON.stringify({ t: 1200, type: 'nav', url: 'http://localhost/', title: 'top' }) + '\n')
    const review = await load() as { document: { meta: { durationMs: number } } }
    expect(review.document.meta.durationMs).toBe(1200)
  })

  it('壊れた session.json と素材があれば、session.json を .broken へ移してから作り直す', async () => {
    await writeFile(paths.sessionJson, '{ broken')
    await writeFile(paths.eventsJsonl, JSON.stringify({ t: 10, type: 'nav', url: 'http://localhost/', title: '' }) + '\n')
    await load()
    expect(await readFile(`${paths.sessionJson}.broken`, 'utf8')).toBe('{ broken')
  })
})
