import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PublishHandoff, PublishWatcher, classifyChange, containedFile, readLog, readResult, videoDirs, type HandoffDeps, type UploadContext, type UploadOutcome } from '../../../../src/video/app/main/publish/handoff'
import { listThumbnails, loadState, resolveVideoDir, setPrivacy, setThumbnail, videoProjectInfo, videoRel } from '../../../../src/video/app/main/publish/data'
import { PICKUP_MS, REQUEST_TTL_MS, parsePublishJson, type PublishTargetId } from '../../../../src/video/app/shared/publish'
import { readHandoffResult, waitForResult } from '../../../../src/video/cli/commands/publish'

const NOW = Date.parse('2026-10-11T00:00:00Z')
let channel: string
let dir: string

beforeEach(() => {
  channel = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-video-pub-')))
  dir = join(channel, '2026-10-11-video')
  mkdirSync(join(dir, 'renders'), { recursive: true })
  mkdirSync(join(dir, '.ferret-video'), { recursive: true })
  writeFileSync(join(dir, 'renders', 'final.mp4'), Buffer.alloc(1000, 1))
})
afterEach(() => rmSync(channel, { recursive: true, force: true }))

const ID = 'req-00000001'
const writeSpec = (o: unknown) => writeFileSync(join(dir, 'publish.json'), typeof o === 'string' ? o : JSON.stringify(o))
const writeReq = (o: Record<string, unknown> = {}) =>
  writeFileSync(join(dir, '.ferret-video', 'publish-request.json'), JSON.stringify({ id: ID, targets: [], at: new Date(NOW).toISOString(), ...o }))
const spec = { video: 'renders/final.mp4', title: 'タイトル', description: 'd', tags: ['a'], youtube: { privacy: 'unlisted' } }

function deps(over: Partial<Record<PublishTargetId, (c: UploadContext) => Promise<UploadOutcome>>> = {}) {
  const calls: { target: string; ctx: UploadContext }[] = []
  const records: unknown[][] = []
  const changes: string[] = []
  const d: HandoffDeps = {
    upload: {
      youtube: over.youtube ?? (async (c) => (calls.push({ target: 'youtube', ctx: c }), c.onProgress('upload', 0.5), { url: 'https://youtu.be/abc', status: 'published', warnings: [] })),
      tiktok: over.tiktok ?? (async (c) => (calls.push({ target: 'tiktok', ctx: c }), { status: 'inbox', warnings: ['inbox'] }))
    },
    record: async (...a) => void records.push(a),
    now: () => NOW,
    onChange: (x) => void changes.push(x)
  }
  return { d, calls, records, changes }
}

describe('受け渡し: 頼み → アップロード → 結果', () => {
  it('頼みが無ければ何もしない。壊れた頼みは invalid（結果は書かない）', async () => {
    const { d } = deps()
    expect(await new PublishHandoff(d).check(dir)).toBe('none')
    writeFileSync(join(dir, '.ferret-video', 'publish-request.json'), '{not json')
    expect(await new PublishHandoff(d).check(dir)).toBe('invalid')
    writeFileSync(join(dir, '.ferret-video', 'publish-request.json'), JSON.stringify({ id: 'x', targets: [], at: 'now' }))
    expect(await new PublishHandoff(d).check(dir)).toBe('invalid')
    writeFileSync(join(dir, '.ferret-video', 'publish-request.json'), '')
    expect(await new PublishHandoff(d).check(dir)).toBe('invalid')
    expect(existsSync(join(dir, '.ferret-video', 'publish-result.json'))).toBe(false)
  })

  it('publish.json でオンのものを上げ、同じ id で結果を書く', async () => {
    writeSpec(spec)
    writeReq()
    const { d, calls, records, changes } = deps()
    expect(await new PublishHandoff(d).check(dir)).toBe('processed')
    expect(calls.map((c) => c.target)).toEqual(['youtube'])
    expect(calls[0]!.ctx.videoPath).toBe(join(dir, 'renders', 'final.mp4'))
    expect(calls[0]!.ctx.thumbnailPath).toBeUndefined()
    const r = readResult(dir)!
    expect(r).toMatchObject({ id: ID, state: 'done', results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/abc', status: 'published' }] })
    expect(records).toEqual([[dir, 'youtube', 'published', 'https://youtu.be/abc']])
    expect(readLog(dir)).toEqual([expect.objectContaining({ target: 'youtube', video: 'renders/final.mp4', size: 1000, url: 'https://youtu.be/abc', requestId: ID })])
    // running（開始）・進み具合・done で3回以上
    expect(changes.length).toBeGreaterThanOrEqual(3)
  })

  it('結果ファイルは所有者だけが読める（0600）', async () => {
    writeSpec(spec)
    writeReq()
    await new PublishHandoff(deps().d).check(dir)
    if (process.platform !== 'win32') expect(statSync(join(dir, '.ferret-video', 'publish-result.json')).mode & 0o777).toBe(0o600)
  })

  it('同じ id は二度と実行しない（アプリを再起動しても）', async () => {
    writeSpec(spec)
    writeReq()
    const { d, calls } = deps()
    const h = new PublishHandoff(d)
    await h.check(dir)
    expect(await h.check(dir)).toBe('handled')
    expect(await new PublishHandoff(d).check(dir)).toBe('handled')
    expect(calls).toHaveLength(1)
  })

  it('同じファイル（パスと大きさ）への新しい頼みは記録から答え、上げ直さない', async () => {
    writeSpec(spec)
    writeReq()
    const { d, calls } = deps()
    await new PublishHandoff(d).check(dir)
    writeReq({ id: 'req-00000002' })
    await new PublishHandoff(d).check(dir)
    expect(calls).toHaveLength(1)
    expect(readResult(dir)).toMatchObject({ id: 'req-00000002', results: [{ target: 'youtube', ok: true, alreadyPublished: true, url: 'https://youtu.be/abc', status: 'published' }] })
    expect(readLog(dir)).toHaveLength(1)
  })

  it('--force は上げ直す。書き出し直したファイル（大きさが違う）も上げる。別のパスも上げる', async () => {
    writeSpec(spec)
    writeReq()
    const { d, calls } = deps()
    await new PublishHandoff(d).check(dir)
    writeReq({ id: 'req-00000002', force: true })
    await new PublishHandoff(d).check(dir)
    expect(calls).toHaveLength(2)
    writeFileSync(join(dir, 'renders', 'final.mp4'), Buffer.alloc(2000, 1))
    writeReq({ id: 'req-00000003' })
    await new PublishHandoff(d).check(dir)
    expect(calls).toHaveLength(3)
    writeFileSync(join(dir, 'renders', 'v2.mp4'), Buffer.alloc(2000, 1))
    writeSpec({ ...spec, video: 'renders/v2.mp4' })
    writeReq({ id: 'req-00000004' })
    await new PublishHandoff(d).check(dir)
    expect(calls).toHaveLength(4)
    expect(readLog(dir)).toHaveLength(4)
  })

  it('同じ投稿先の記録は投稿先ごと: YouTube 済みでも TikTok は上げる', async () => {
    writeSpec(spec)
    writeReq()
    const { d, calls } = deps()
    await new PublishHandoff(d).check(dir)
    writeSpec({ ...spec, tiktok: { enabled: true, caption: 'c' } })
    writeReq({ id: 'req-00000002' })
    await new PublishHandoff(d).check(dir)
    expect(calls.map((c) => c.target)).toEqual(['youtube', 'tiktok'])
    expect(readResult(dir)?.results).toEqual([
      expect.objectContaining({ target: 'youtube', alreadyPublished: true }),
      expect.objectContaining({ target: 'tiktok', ok: true, status: 'inbox' })
    ])
  })

  it('同じ動画で同時に2つは走らない（2つ目は busy）', async () => {
    writeSpec(spec)
    writeReq()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { d, calls } = deps({ youtube: async () => (await gate, { url: 'https://youtu.be/x', status: 'published', warnings: [] }) })
    const h = new PublishHandoff(d)
    const first = h.check(dir)
    await Promise.resolve()
    expect(await h.check(dir)).toBe('busy')
    expect(h.isBusy(dir)).toBe(true)
    // 走っている間、結果はそう言う（CLI はアプリが受け取ったと分かる）
    expect(readResult(dir)).toMatchObject({ id: ID, state: 'running' })
    release()
    expect(await first).toBe('processed')
    expect(h.isBusy(dir)).toBe(false)
    expect(calls).toHaveLength(0) // 渡した偽物は calls に積まない
  })

  it('別の動画は同時に走れる', async () => {
    const other = join(channel, 'other')
    mkdirSync(join(other, 'renders'), { recursive: true })
    writeFileSync(join(other, 'renders', 'final.mp4'), Buffer.alloc(10, 1))
    writeFileSync(join(other, 'publish.json'), JSON.stringify(spec))
    mkdirSync(join(other, '.ferret-video'))
    writeFileSync(join(other, '.ferret-video', 'publish-request.json'), JSON.stringify({ id: 'req-other-01', targets: [], at: new Date(NOW).toISOString() }))
    writeSpec(spec)
    writeReq()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let n = 0
    const { d } = deps({ youtube: async () => (n++, await gate, { url: 'https://youtu.be/x', status: 'published', warnings: [] }) })
    const h = new PublishHandoff(d)
    const a = h.check(dir)
    const b = h.check(other)
    await vi.waitFor(() => expect(n).toBe(2))
    release()
    expect(await Promise.all([a, b])).toEqual(['processed', 'processed'])
  })

  it('アップロード中に来た頼みは、終わってから処理する', async () => {
    writeSpec({ ...spec, tiktok: { enabled: false } })
    writeReq()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let n = 0
    const { d } = deps({ youtube: async () => (n++ === 0 && (await gate), { url: `https://youtu.be/${n}`, status: 'published', warnings: [] }) })
    const h = new PublishHandoff(d)
    const first = h.check(dir)
    await Promise.resolve()
    writeReq({ id: 'req-00000002', force: true })
    release()
    await first
    expect(n).toBe(2)
    expect(readResult(dir)?.id).toBe('req-00000002')
  })

  it('アプリが途中で終わって running のまま残った結果は「中断されました」で閉じ、上げ直さない', async () => {
    writeSpec(spec)
    writeReq()
    writeFileSync(join(dir, '.ferret-video', 'publish-result.json'), JSON.stringify({ id: ID, state: 'running', at: '', results: [{ target: 'youtube', ok: true, url: 'u' }] }))
    const { d, calls } = deps()
    expect(await new PublishHandoff(d).check(dir)).toBe('handled')
    expect(calls).toHaveLength(0)
    expect(readResult(dir)).toMatchObject({ id: ID, state: 'done', error: expect.stringContaining('interrupted'), results: [{ target: 'youtube', ok: true }] })
    // もう一度見ても書き直さない
    const before = readFileSync(join(dir, '.ferret-video', 'publish-result.json'), 'utf8')
    expect(await new PublishHandoff(d).check(dir)).toBe('handled')
    expect(readFileSync(join(dir, '.ferret-video', 'publish-result.json'), 'utf8')).toBe(before)
  })

  it('10 分を過ぎた頼みは無視する。ちょうど 10 分は処理する', async () => {
    writeSpec(spec)
    writeReq({ at: new Date(NOW - REQUEST_TTL_MS - 1).toISOString() })
    const { d, calls } = deps()
    expect(await new PublishHandoff(d).check(dir)).toBe('stale')
    expect(calls).toHaveLength(0)
    expect(readResult(dir)).toBeNull()
    writeReq({ id: 'req-00000002', at: new Date(NOW - REQUEST_TTL_MS).toISOString() })
    expect(await new PublishHandoff(d).check(dir)).toBe('processed')
  })

  it('別の id の古い結果があっても、新しい頼みは処理する', async () => {
    writeSpec(spec)
    writeFileSync(join(dir, '.ferret-video', 'publish-result.json'), JSON.stringify({ id: 'req-older-01', state: 'running', at: '', results: [] }))
    writeReq()
    expect(await new PublishHandoff(deps().d).check(dir)).toBe('processed')
    expect(readResult(dir)?.id).toBe(ID)
  })

  it('publish.json が無い・壊れている → error 付きの done', async () => {
    writeReq()
    const { d } = deps()
    await new PublishHandoff(d).check(dir)
    expect(readResult(dir)).toMatchObject({ id: ID, state: 'done', results: [], error: expect.stringContaining('publish.json') })
    writeSpec('{broken')
    writeReq({ id: 'req-00000002' })
    await new PublishHandoff(d).check(dir)
    expect(readResult(dir)).toMatchObject({ id: 'req-00000002', results: [], error: expect.stringContaining('JSON') })
  })

  it('投稿先がオフ・頼まれた投稿先がオフ → error', async () => {
    writeSpec({ ...spec, youtube: { enabled: false } })
    writeReq()
    const { d, calls } = deps()
    await new PublishHandoff(d).check(dir)
    expect(readResult(dir)?.error).toMatch(/No destination/)
    writeSpec(spec)
    writeReq({ id: 'req-00000002', targets: ['tiktok'] })
    await new PublishHandoff(d).check(dir)
    expect(readResult(dir)?.error).toMatch(/No destination/)
    expect(calls).toHaveLength(0)
  })

  it('止める問題はその投稿先だけを失敗にする', async () => {
    writeSpec({ ...spec, title: 'a'.repeat(101), tiktok: { enabled: true, caption: 'ok' } })
    writeReq()
    const { d, calls, records } = deps()
    await new PublishHandoff(d).check(dir)
    const r = readResult(dir)!
    expect(r.results).toEqual([
      { target: 'youtube', ok: false, error: expect.stringContaining('title') },
      { target: 'tiktok', ok: true, status: 'inbox', warnings: ['inbox'] }
    ])
    expect(calls.map((c) => c.target)).toEqual(['tiktok'])
    expect(records).toEqual([[dir, 'tiktok', 'draft', undefined]])
  })

  it('予約日時が過ぎていれば YouTube は上げない', async () => {
    writeSpec({ ...spec, youtube: { publishAt: '2026-10-10T00:00:00Z' } })
    writeReq()
    const { d, calls } = deps()
    await new PublishHandoff(d).check(dir)
    expect(calls).toHaveLength(0)
    expect(readResult(dir)?.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('youtube.publishAt') })
  })

  it('動画が無ければ、上げる口を呼ばずにすべて失敗', async () => {
    writeSpec({ ...spec, video: 'renders/nope.mp4', tiktok: { enabled: true, caption: 'c' } })
    writeReq()
    const { d, calls } = deps()
    await new PublishHandoff(d).check(dir)
    expect(readResult(dir)?.results).toEqual([
      { target: 'youtube', ok: false, error: expect.stringContaining('renders/nope.mp4') },
      { target: 'tiktok', ok: false, error: expect.stringContaining('renders/nope.mp4') }
    ])
    expect(calls).toHaveLength(0)
  })

  it('空の動画（0 バイト）は上げない', async () => {
    writeFileSync(join(dir, 'renders', 'final.mp4'), '')
    writeSpec(spec)
    writeReq()
    const { d, calls } = deps()
    await new PublishHandoff(d).check(dir)
    expect(calls).toHaveLength(0)
    expect(readResult(dir)?.results[0]?.ok).toBe(false)
  })

  it('プロジェクトの外を指すパスは上げない（../ も、途中のリンクも）', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'ferret-video-outside-'))
    try {
      writeFileSync(join(outside, 'secret.mp4'), Buffer.alloc(50, 1))
      writeSpec({ ...spec, video: '../../secret.mp4' })
      writeReq()
      const a = deps()
      await new PublishHandoff(a.d).check(dir)
      expect(a.calls).toHaveLength(0)
      expect(readResult(dir)?.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('video') })

      symlinkSync(outside, join(dir, 'linked'))
      writeSpec({ ...spec, video: 'linked/secret.mp4' })
      writeReq({ id: 'req-00000002' })
      const b = deps()
      await new PublishHandoff(b.d).check(dir)
      expect(b.calls).toHaveLength(0)
      expect(readResult(dir)?.results[0]).toMatchObject({ ok: false, error: expect.stringContaining('linked/secret.mp4') })
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('上げる口の失敗 → ok:false、failed として記録、投稿の記録には残さない', async () => {
    writeSpec(spec)
    writeReq()
    const { d, records } = deps({ youtube: async () => Promise.reject(new Error('YouTube 403 quotaExceeded')) })
    await new PublishHandoff(d).check(dir)
    expect(readResult(dir)?.results).toEqual([{ target: 'youtube', ok: false, error: 'YouTube 403 quotaExceeded' }])
    expect(records).toEqual([[dir, 'youtube', 'failed']])
    expect(readLog(dir)).toEqual([])
  })

  it('YouTube の失敗のあとも TikTok は続ける', async () => {
    writeSpec({ ...spec, tiktok: { enabled: true, caption: 'c' } })
    writeReq()
    const { d, calls } = deps({ youtube: async () => Promise.reject(new Error('boom')) })
    await new PublishHandoff(d).check(dir)
    expect(calls.map((c) => c.target)).toEqual(['tiktok'])
    expect(readResult(dir)?.results.map((r) => r.ok)).toEqual([false, true])
  })

  it('記録（publish record）の失敗は結果を壊さない', async () => {
    writeSpec(spec)
    writeReq()
    const { d } = deps()
    d.record = async () => Promise.reject(new Error('cli missing'))
    await new PublishHandoff(d).check(dir)
    expect(readResult(dir)?.results[0]?.ok).toBe(true)
  })

  it('設定の読み込みが投げても安全な既定で続ける', async () => {
    writeSpec({ ...spec, youtube: {} })
    writeReq()
    const { d, calls } = deps()
    d.defaults = () => { throw new Error('broken settings') }
    await new PublishHandoff(d).check(dir)
    expect(calls[0]!.ctx.spec.youtube.privacy).toBe('private')
  })

  it('サムネイルはあれば渡す。無ければお知らせ', async () => {
    mkdirSync(join(dir, 'thumbnails'))
    writeFileSync(join(dir, 'thumbnails', 't.png'), 'png')
    writeSpec({ ...spec, thumbnail: 'thumbnails/t.png' })
    writeReq()
    const a = deps()
    await new PublishHandoff(a.d).check(dir)
    expect(a.calls[0]!.ctx.thumbnailPath).toBe(join(dir, 'thumbnails', 't.png'))
    writeSpec({ ...spec, thumbnail: 'thumbnails/gone.png' })
    writeReq({ id: 'req-00000002', force: true })
    const b = deps()
    await new PublishHandoff(b.d).check(dir)
    expect(b.calls[0]!.ctx.thumbnailPath).toBeUndefined()
    expect(readResult(dir)?.results[0]?.warnings).toEqual(['Thumbnail not found: thumbnails/gone.png'])
  })

  it('予約は scheduled、URL の無い published は draft として記録', async () => {
    writeSpec({ ...spec, tiktok: { enabled: true, caption: 'c' } })
    writeReq()
    const { d, records } = deps({
      youtube: async () => ({ url: 'https://youtu.be/s', status: 'scheduled', warnings: [] }),
      tiktok: async () => ({ status: 'published', warnings: [] })
    })
    await new PublishHandoff(d).check(dir)
    expect(records).toEqual([
      [dir, 'youtube', 'scheduled', 'https://youtu.be/s'],
      [dir, 'tiktok', 'draft', undefined]
    ])
  })

  it('進み具合はおよそ 2 % ごとにまとめる', async () => {
    writeSpec(spec)
    writeReq()
    const { d, changes } = deps({
      youtube: async (c) => {
        for (let i = 0; i <= 1000; i++) c.onProgress('upload', i / 1000)
        return { url: 'https://youtu.be/p', status: 'published', warnings: [] }
      }
    })
    await new PublishHandoff(d).check(dir)
    expect(changes.length).toBeLessThan(60)
    expect(changes.length).toBeGreaterThan(40)
  })
})

describe('CLI（ferret-video publish upload）との受け渡しの形', () => {
  it('アプリが書いた結果を CLI が同じ id で読める', async () => {
    writeSpec(spec)
    writeReq()
    await new PublishHandoff(deps().d).check(dir)
    expect(readHandoffResult(dir, ID)).toMatchObject({ id: ID, state: 'done', results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/abc' }] })
    expect(readHandoffResult(dir, 'req-other-99')).toBeNull()
  })

  it('アプリが居なければ CLI は 30 秒で app-not-running にする', async () => {
    writeReq()
    let clock = 0
    const out = await waitForResult(dir, ID, { pickupMs: PICKUP_MS, timeoutMs: 3600_000, pollMs: 1000, now: () => clock, sleep: async (ms) => void (clock += ms) })
    expect(out).toEqual({ kind: 'no-app' })
    expect(clock).toBe(PICKUP_MS)
  })

  it('アプリが受け取れば（running）CLI は 30 秒を過ぎても待ち、done を受け取る', async () => {
    writeSpec(spec)
    writeReq()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { d } = deps({ youtube: async () => (await gate, { url: 'https://youtu.be/late', status: 'published', warnings: [] }) })
    const run = new PublishHandoff(d).check(dir)
    await vi.waitFor(() => expect(readResult(dir)?.state).toBe('running'))
    let clock = 0
    const waiting = waitForResult(dir, ID, {
      pickupMs: PICKUP_MS, timeoutMs: 3600_000, pollMs: 10_000, now: () => clock,
      sleep: async (ms) => { clock += ms; if (clock >= 60_000) release(); await new Promise((r) => setTimeout(r, 5)) }
    })
    await run
    const out = await waiting
    expect(out.kind).toBe('done')
    expect(clock).toBeGreaterThanOrEqual(60_000)
  })
})

describe('見張り（今開いているチャンネルの直下の動画のフォルダ）', () => {
  it('変わったファイルの種類を見分ける', () => {
    expect(classifyChange('v1/publish.json')).toEqual({ video: 'v1', what: 'spec' })
    expect(classifyChange('v1/.ferret-video/publish-request.json')).toEqual({ video: 'v1', what: 'request' })
    expect(classifyChange('v1\\.ferret-video\\publish-result.json')).toEqual({ video: 'v1', what: 'result' })
    expect(classifyChange('v1/thumbnails/a.png')).toEqual({ video: 'v1', what: 'thumbnails' })
    expect(classifyChange('v1/renders/final.mp4')).toBeNull()
    expect(classifyChange('publish.json')).toBeNull() // チャンネルの直下は動画ではない
    expect(classifyChange('.git/publish.json')).toBeNull()
    expect(classifyChange('v1/sub/publish.json')).toBeNull()
  })

  it('直下の動画のフォルダ（隠しフォルダ・node_modules・ファイルは除く）', () => {
    mkdirSync(join(channel, '.hidden'))
    mkdirSync(join(channel, 'node_modules'))
    writeFileSync(join(channel, 'file.txt'), 'x')
    expect(videoDirs(channel)).toEqual([dir])
    expect(videoDirs(join(channel, 'none'))).toEqual([])
  })

  it('見張りを始めたとき、閉じている間に来た頼みを拾い、2 秒ごとの確認で新しい頼みも拾う', async () => {
    writeReq()
    const seen: string[] = []
    const w = new PublishWatcher((d, what) => void seen.push(`${d === dir ? 'dir' : d}:${what}`), 20)
    w.watch(channel)
    expect(seen).toEqual(['dir:request'])
    writeReq({ id: 'req-00000002' })
    const at = new Date(Date.now() + 5000)
    utimesSync(join(dir, '.ferret-video', 'publish-request.json'), at, at)
    await vi.waitFor(() => expect(seen.filter((x) => x === 'dir:request').length).toBeGreaterThanOrEqual(2), { timeout: 2000 })
    w.close()
  })

  it('あとから作られた動画のフォルダの頼みも拾う', async () => {
    const seen: string[] = []
    const w = new PublishWatcher((d, what) => void seen.push(`${d}:${what}`), 20)
    w.watch(channel)
    const later = join(channel, 'later')
    mkdirSync(join(later, '.ferret-video'), { recursive: true })
    writeFileSync(join(later, '.ferret-video', 'publish-request.json'), '{}')
    await vi.waitFor(() => expect(seen).toContain(`${later}:request`), { timeout: 2000 })
    w.close()
  })

  it('同じチャンネルは何もしない。切り替えると見張り直す。null で止める', () => {
    const seen: string[] = []
    const w = new PublishWatcher((d) => void seen.push(d), 20)
    w.watch(channel)
    w.watch(channel)
    expect(w.current()).toBe(channel)
    const other = mkdtempSync(join(tmpdir(), 'ferret-video-other-'))
    try {
      w.watch(other)
      expect(w.current()).toBe(other)
      w.watch(null)
      expect(w.current()).toBeNull()
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
    w.close()
    expect(seen).toEqual([])
  })

  it('確認のたびに beforePoll を呼ぶ（チャンネルの切り替えをここで拾う）', async () => {
    let n = 0
    const w = new PublishWatcher(() => undefined, 10, () => void n++)
    w.watch(channel)
    await vi.waitFor(() => expect(n).toBeGreaterThanOrEqual(2), { timeout: 2000 })
    w.close()
  })
})

describe('画面のデータ', () => {
  it('loadState: publish.json が無い', () => {
    expect(loadState(channel, dir)).toMatchObject({ exists: false, spec: null, issues: [], request: null, result: null, log: [], published: {} })
  })
  it('loadState: ファイル・無いサムネイルのお知らせ・上げ済みの投稿先・チャンネルからの相対パス', async () => {
    writeSpec({ ...spec, thumbnail: 'thumbnails/x.png', youtube: { privacy: 'unlisted', chapters: false } })
    writeReq()
    await new PublishHandoff(deps().d).check(dir)
    const v = loadState(channel, dir, new Date(NOW))
    expect(v.videoMedia).toBe('2026-10-11-video/renders/final.mp4')
    expect(v.videoSize).toBe(1000)
    expect(v.thumbnailMedia).toBeUndefined()
    expect(v.issues).toEqual([{ level: 'warning', field: 'thumbnail', code: 'missing', detail: 'thumbnails/x.png' }])
    expect(v.published.youtube?.url).toBe('https://youtu.be/abc')
    expect(v.request?.id).toBe(ID)
    expect(v.result?.state).toBe('done')
  })
  it('loadState: 動画が無いのは問題。外を指すパスは bad-path だけ（missing を重ねない）', () => {
    writeSpec({ ...spec, video: 'renders/none.mp4' })
    expect(loadState(channel, dir).issues).toContainEqual({ level: 'error', field: 'video', code: 'missing', detail: 'renders/none.mp4' })
    writeSpec({ ...spec, video: '../x.mp4' })
    expect(loadState(channel, dir).issues.filter((i) => i.field === 'video').map((i) => i.code)).toEqual(['bad-path'])
  })
  it('loadState: チャプターが YouTube の条件を満たさなければお知らせ', () => {
    writeSpec({ ...spec, description: '0:00 a\n0:30 b' })
    expect(loadState(channel, dir).issues).toContainEqual({ level: 'warning', field: 'youtube.chapters', code: 'chapters' })
    writeSpec({ ...spec, description: '0:00 a\n0:30 b\n1:00 c' })
    expect(loadState(channel, dir).issues.some((i) => i.code === 'chapters')).toBe(false)
  })
  it('resolveVideoDir: チャンネルの直下のフォルダだけ', () => {
    expect(resolveVideoDir(channel, dir)).toBe(dir)
    expect(resolveVideoDir(channel, '2026-10-11-video')).toBe(dir)
    expect(() => resolveVideoDir(channel, channel)).toThrow(/not in the open channel/)
    expect(() => resolveVideoDir(channel, join(dir, 'renders'))).toThrow()
    expect(() => resolveVideoDir(channel, join(channel, '..'))).toThrow()
    expect(() => resolveVideoDir(channel, '../x')).toThrow()
    expect(() => resolveVideoDir(channel, join(channel, 'missing'))).toThrow()
    expect(() => resolveVideoDir(null, dir)).toThrow()
    expect(() => resolveVideoDir(channel, 5)).toThrow()
    expect(() => resolveVideoDir(channel, '')).toThrow()
    mkdirSync(join(channel, '.ferret-video'))
    expect(() => resolveVideoDir(channel, '.ferret-video')).toThrow()
    writeFileSync(join(channel, 'file'), 'x')
    expect(() => resolveVideoDir(channel, 'file')).toThrow()
  })
  it('resolveVideoDir: 外を指すリンクは断る', () => {
    const outside = mkdtempSync(join(tmpdir(), 'ferret-video-outside-'))
    try {
      symlinkSync(outside, join(channel, 'link'))
      expect(() => resolveVideoDir(channel, 'link')).toThrow()
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it('containedFile と videoRel', () => {
    expect(containedFile(dir, 'renders/final.mp4')).toBe(join(dir, 'renders', 'final.mp4'))
    expect(containedFile(dir, 'renders')).toBeNull() // フォルダ
    expect(containedFile(dir, '../x')).toBeNull()
    expect(videoRel(dir, join(dir, 'thumbnails', 'a.png'))).toBe('thumbnails/a.png')
    expect(videoRel(dir, 'thumbnails/a.png')).toBe('thumbnails/a.png')
    expect(videoRel(dir, join(dir, '..', 'x.png'))).toBeNull()
    expect(videoRel(dir, dir)).toBeNull()
  })
  it('setThumbnail は publish.json を書き、ほかの項目を残す', () => {
    mkdirSync(join(dir, 'thumbnails'))
    writeFileSync(join(dir, 'thumbnails', 'a.png'), 'x')
    writeSpec({ ...spec, custom: { keep: true } })
    setThumbnail(dir, 'thumbnails/a.png')
    const j = JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'))
    expect(j).toMatchObject({ title: 'タイトル', custom: { keep: true }, thumbnail: 'thumbnails/a.png' })
    expect(parsePublishJson(JSON.stringify(j)).spec?.thumbnail).toBe('thumbnails/a.png')
    setThumbnail(dir, null)
    expect(JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8')).thumbnail).toBeUndefined()
  })
  it('setThumbnail は publish.json が無ければ作る', () => {
    mkdirSync(join(dir, 'thumbnails'))
    writeFileSync(join(dir, 'thumbnails', 'a.jpg'), 'x')
    setThumbnail(dir, join(dir, 'thumbnails', 'a.jpg'))
    expect(JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'))).toEqual({ thumbnail: 'thumbnails/a.jpg' })
  })
  it('setThumbnail は外・画像でない・無いファイル・壊れた JSON を断る（ファイルはそのまま）', () => {
    writeFileSync(join(dir, 'a.webp'), 'x')
    expect(() => setThumbnail(dir, '/etc/hosts')).toThrow()
    expect(() => setThumbnail(dir, '../x.png')).toThrow()
    expect(() => setThumbnail(dir, 'a.webp')).toThrow(/PNG or JPEG/)
    expect(() => setThumbnail(dir, 'thumbnails/none.png')).toThrow(/not found/)
    mkdirSync(join(dir, 'thumbnails'))
    writeFileSync(join(dir, 'thumbnails', 'a.png'), 'x')
    writeSpec('{broken')
    expect(() => setThumbnail(dir, 'thumbnails/a.png')).toThrow(/JSON/)
    expect(readFileSync(join(dir, 'publish.json'), 'utf8')).toBe('{broken')
  })
  it('listThumbnails: thumbnails/ の png/jpg（1 階層下まで）、新しい順、チャンネルからの相対パス', () => {
    expect(listThumbnails(channel, dir)).toEqual([])
    mkdirSync(join(dir, 'thumbnails', 'v2', 'deep'), { recursive: true })
    const f = (rel: string, t: number) => {
      writeFileSync(join(dir, rel), 'x')
      utimesSync(join(dir, rel), t, t)
    }
    f('thumbnails/old.png', 1000)
    f('thumbnails/new.JPG', 3000)
    f('thumbnails/v2/b.jpeg', 2000)
    f('thumbnails/v2/deep/c.png', 4000)
    f('thumbnails/skip.webp', 5000)
    f('thumbnails/.hidden.png', 5000)
    f('thumbnails/notes.txt', 5000)
    const list = listThumbnails(channel, dir)
    expect(list.map((x) => x.rel)).toEqual(['thumbnails/new.JPG', 'thumbnails/v2/b.jpeg', 'thumbnails/old.png'])
    expect(list[0]!.media).toBe('2026-10-11-video/thumbnails/new.JPG')
    expect(listThumbnails(channel, dir, 1)).toHaveLength(1)
  })
  it('videoProjectInfo: ferret-video.json → 旧 solocut.json → フォルダ名', () => {
    expect(videoProjectInfo(dir)).toEqual({ title: '2026-10-11-video', template: '' })
    writeFileSync(join(dir, 'solocut.json'), JSON.stringify({ title: '旧', template: 'talk' }))
    expect(videoProjectInfo(dir)).toEqual({ title: '旧', template: 'talk' })
    writeFileSync(join(dir, 'ferret-video.json'), JSON.stringify({ title: '新', template: 'tech' }))
    expect(videoProjectInfo(dir)).toEqual({ title: '新', template: 'tech' })
    writeFileSync(join(dir, 'ferret-video.json'), '{broken')
    expect(videoProjectInfo(dir).title).toBe('旧')
  })
})

describe('既定の公開範囲（受け渡しと画面）', () => {
  it('publish.json に無ければ、アップロードは設定の既定を使う', async () => {
    writeSpec({ ...spec, youtube: {}, tiktok: { enabled: true, caption: 'c' } })
    writeReq()
    const { d, calls } = deps()
    d.defaults = () => ({ youtubePrivacy: 'unlisted', tiktokPrivacy: 'MUTUAL_FOLLOW_FRIENDS' })
    await new PublishHandoff(d).check(dir)
    expect(calls.map((c) => [c.target, c.target === 'youtube' ? c.ctx.spec.youtube.privacy : c.ctx.spec.tiktok.privacy])).toEqual([
      ['youtube', 'unlisted'],
      ['tiktok', 'MUTUAL_FOLLOW_FRIENDS']
    ])
  })
  it('既定が渡されなければ安全な値（非公開）', async () => {
    writeSpec({ ...spec, youtube: {} })
    writeReq()
    const { d, calls } = deps()
    await new PublishHandoff(d).check(dir)
    expect(calls[0]!.ctx.spec.youtube.privacy).toBe('private')
  })
  it('loadState は使う値を見せ、setPrivacy はこの動画だけに書く', () => {
    writeSpec({ ...spec, youtube: {}, custom: true })
    const v = loadState(channel, dir, new Date(NOW), { youtubePrivacy: 'public', tiktokPrivacy: 'SELF_ONLY' })
    expect(v.spec?.youtube).toMatchObject({ privacy: 'public', privacyDefaulted: true })
    setPrivacy(dir, 'youtube', 'unlisted')
    setPrivacy(dir, 'tiktok', 'FOLLOWER_OF_CREATOR')
    const j = JSON.parse(readFileSync(join(dir, 'publish.json'), 'utf8'))
    expect(j).toMatchObject({ custom: true, youtube: { privacy: 'unlisted' }, tiktok: { privacy: 'FOLLOWER_OF_CREATOR' } })
    expect(loadState(channel, dir, new Date(NOW), { youtubePrivacy: 'public', tiktokPrivacy: 'SELF_ONLY' }).spec?.youtube).toMatchObject({ privacy: 'unlisted', privacyDefaulted: false })
  })
  it('setPrivacy はおかしな値・無いファイル・壊れた JSON・知らない投稿先を断る（ファイルはそのまま）', () => {
    expect(() => setPrivacy(dir, 'youtube', 'private')).toThrow() // まだ publish.json が無い
    writeSpec(spec)
    expect(() => setPrivacy(dir, 'youtube', 'PUBLIC_TO_EVERYONE')).toThrow()
    expect(() => setPrivacy(dir, 'tiktok', 'public')).toThrow()
    expect(() => setPrivacy(dir, 'instagram', 'public')).toThrow()
    expect(() => setPrivacy(dir, 'youtube', 5)).toThrow()
    writeSpec('{broken')
    expect(() => setPrivacy(dir, 'youtube', 'private')).toThrow(/JSON/)
    expect(readFileSync(join(dir, 'publish.json'), 'utf8')).toBe('{broken')
  })
})
