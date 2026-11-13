import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SCREENS_LATEST,
  SCREEN_MAX_WIDTH,
  ScreenCaptureScheduler,
  addScreen,
  emptyScreenIndex,
  isCapturableUrl,
  parseScreenIndex,
  scaledSize,
  screenFileName,
  shortHash,
  type ScreenEntry
} from '../../src/shared/screenCache'

describe('撮ってよいページ', () => {
  it('手元のホスト・社内のホストは撮る', () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1:5173/a', 'http://192.168.1.10/', 'http://10.0.0.2:8080', 'https://app.test/', 'http://[::1]:3000/']) {
      expect(isCapturableUrl(url), url).toBe(true)
    }
  })

  it('プロジェクトのページ（ade-page://project/）は撮る', () => {
    expect(isCapturableUrl('ade-page://project/docs/index.html')).toBe(true)
  })

  it('登録した URL と同じホストは撮る（www. は同じとみなす）。ほかのサイトは撮らない', () => {
    const registered = ['https://www.example.com/app', 'not a url', 'mailto:x@y']
    expect(isCapturableUrl('https://example.com/settings', registered)).toBe(true)
    expect(isCapturableUrl('https://www.example.com/', registered)).toBe(true)
    expect(isCapturableUrl('https://mail.google.com/', registered)).toBe(false)
    expect(isCapturableUrl('https://evil-example.com/', registered)).toBe(false)
    expect(isCapturableUrl('https://example.com:8443/', registered)).toBe(false)
  })

  it('http(s) 以外・壊れた URL・空のページは撮らない', () => {
    for (const url of ['about:blank', 'file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', '', 'not a url', 'ade-preview://x/a.md']) {
      expect(isCapturableUrl(url, ['https://example.com']), url).toBe(false)
    }
  })
})

describe('ページごとの画像の名前', () => {
  it('<host><path>.jpg。根は host だけ', () => {
    expect(screenFileName('http://localhost:3000/')).toBe('localhost_3000.jpg')
    expect(screenFileName('http://localhost:3000/settings/profile')).toBe('localhost_3000_settings_profile.jpg')
    expect(screenFileName('https://example.com/a/b.html')).toBe('example.com_a_b.html.jpg')
  })

  it('クエリは見ない。#/ で始まるハッシュ（SPA の画面）は含める', () => {
    expect(screenFileName('http://localhost:3000/list?page=2')).toBe(screenFileName('http://localhost:3000/list'))
    expect(screenFileName('http://localhost:3000/#/settings')).toBe('localhost_3000_settings.jpg')
    expect(screenFileName('http://localhost:3000/page#section')).toBe('localhost_3000_page.jpg')
  })

  it('使えない文字は _ にまとめ、外へ出る形にしない', () => {
    const name = screenFileName('http://localhost:3000/../../%2e%2e/日本語/a b')
    expect(name).toMatch(/^[A-Za-z0-9._-]+\.jpg$/)
    expect(name).not.toContain('..')
    expect(name).not.toContain('/')
  })

  it('プロジェクトのページは project_<パス>', () => {
    expect(screenFileName('ade-page://project/docs/index.html')).toBe('project_docs_index.html.jpg')
  })

  it('長い URL は切って指紋を付ける（違う URL は違う名前）', () => {
    const a = screenFileName(`http://localhost:3000/${'a'.repeat(300)}/x`)
    const b = screenFileName(`http://localhost:3000/${'a'.repeat(300)}/y`)
    expect(a.length).toBeLessThanOrEqual(104)
    expect(a).not.toBe(b)
    expect(a).toMatch(/-[0-9a-f]{8}\.jpg$/)
  })

  it('壊れた URL でも名前は作る', () => {
    expect(screenFileName('')).toBe('page.jpg')
    expect(screenFileName('???')).toMatch(/\.jpg$/)
  })

  it('指紋は決まった値（8 桁の 16 進）', () => {
    expect(shortHash('abc')).toBe(shortHash('abc'))
    expect(shortHash('abc')).not.toBe(shortHash('abd'))
    expect(shortHash('')).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('画像の大きさ', () => {
  it('上限以下はそのまま、超えたら幅を上限にして比を保つ', () => {
    expect(scaledSize(1280, 800)).toEqual({ width: 1280, height: 800 })
    expect(scaledSize(SCREEN_MAX_WIDTH, 900)).toEqual({ width: SCREEN_MAX_WIDTH, height: 900 })
    expect(scaledSize(2880, 1800)).toEqual({ width: SCREEN_MAX_WIDTH, height: 900 })
    expect(scaledSize(3000, 1)).toEqual({ width: SCREEN_MAX_WIDTH, height: 1 })
  })

  it('空の画像は 0', () => {
    expect(scaledSize(0, 100)).toEqual({ width: 0, height: 0 })
    expect(scaledSize(100, -1)).toEqual({ width: 0, height: 0 })
  })
})

describe('index.json', () => {
  const entry = (file: string, url = `http://localhost/${file}`): ScreenEntry => ({ file, url, title: file, capturedAt: '2026-11-13T00:00:00Z', width: 100, height: 50 })

  it('撮ったものを先頭に入れ、latest は latest.jpg を指す', () => {
    const { index, evicted } = addScreen(emptyScreenIndex(), entry('pages/a.jpg'))
    expect(index.pages.map((p) => p.file)).toEqual(['pages/a.jpg'])
    expect(index.latest).toMatchObject({ file: SCREENS_LATEST, url: 'http://localhost/pages/a.jpg' })
    expect(evicted).toEqual([])
  })

  it('同じページは置き換えて先頭へ', () => {
    let index = addScreen(emptyScreenIndex(), entry('pages/a.jpg')).index
    index = addScreen(index, entry('pages/b.jpg')).index
    index = addScreen(index, { ...entry('pages/a.jpg'), title: 'new' }).index
    expect(index.pages.map((p) => p.file)).toEqual(['pages/a.jpg', 'pages/b.jpg'])
    expect(index.pages[0]!.title).toBe('new')
  })

  it('上限を超えた古いページは外して、消すファイルとして返す', () => {
    let index = emptyScreenIndex()
    for (const name of ['a', 'b', 'c']) index = addScreen(index, entry(`pages/${name}.jpg`), 3).index
    const result = addScreen(index, entry('pages/d.jpg'), 3)
    expect(result.index.pages.map((p) => p.file)).toEqual(['pages/d.jpg', 'pages/c.jpg', 'pages/b.jpg'])
    expect(result.evicted).toEqual(['pages/a.jpg'])
  })

  it('壊れた index は空から。おかしな項目は外す', () => {
    expect(parseScreenIndex(null)).toEqual(emptyScreenIndex())
    expect(parseScreenIndex('x')).toEqual(emptyScreenIndex())
    const parsed = parseScreenIndex({ latest: { file: 'latest.jpg', url: 'u' }, pages: [entry('pages/a.jpg'), { file: '../x.jpg', url: 'u' }, { file: 'pages/b.jpg' }, null, { file: '/abs.jpg', url: 'u' }] })
    expect(parsed.latest).toMatchObject({ file: 'latest.jpg', title: '', width: 0 })
    expect(parsed.pages.map((p) => p.file)).toEqual(['pages/a.jpg'])
  })
})

describe('いつ撮るか（ScreenCaptureScheduler）', () => {
  const timing = { settleMs: 1000, inPageSettleMs: 1500, refreshMs: 30_000, minGapMs: 3000 }
  let now = 0
  let capture: ReturnType<typeof vi.fn<() => Promise<void>>>
  let scheduler: ScreenCaptureScheduler

  beforeEach(() => {
    vi.useFakeTimers()
    now = 100_000
    capture = vi.fn(async () => {})
    scheduler = new ScreenCaptureScheduler(capture, () => now, { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }, timing)
  })
  afterEach(() => vi.useRealTimers())

  const advance = async (ms: number): Promise<void> => {
    now += ms
    await vi.advanceTimersByTimeAsync(ms)
  }

  it('読み込みが終わってから落ち着くのを待って1回撮る', async () => {
    scheduler.onState({ url: 'http://localhost/', loading: true })
    await advance(5000)
    expect(capture).not.toHaveBeenCalled()
    scheduler.onState({ url: 'http://localhost/', loading: false })
    await advance(999)
    expect(capture).not.toHaveBeenCalled()
    await advance(1)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('待っている間に次の読み込みが始まったら撮らずに待ち直す', async () => {
    scheduler.onState({ url: 'http://localhost/a', loading: true })
    scheduler.onState({ url: 'http://localhost/a', loading: false })
    await advance(500)
    scheduler.onState({ url: 'http://localhost/b', loading: true })
    await advance(5000)
    expect(capture).not.toHaveBeenCalled()
    scheduler.onState({ url: 'http://localhost/b', loading: false })
    await advance(1000)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('ページの中の移動（読み込みなしで URL が変わる）は少し長く待つ', async () => {
    scheduler.onState({ url: 'http://localhost/#/a', loading: false })
    await advance(1499)
    expect(capture).not.toHaveBeenCalled()
    await advance(1)
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('題名だけの変化（URL も読み込みも同じ）では撮らない', async () => {
    scheduler.onState({ url: 'http://localhost/', loading: false })
    await advance(2000)
    capture.mockClear()
    scheduler.onState({ url: 'http://localhost/', loading: false })
    await advance(10_000)
    expect(capture).not.toHaveBeenCalled()
  })

  it('続けて撮るときは最小の間を空ける', async () => {
    scheduler.onState({ url: 'http://localhost/a', loading: false })
    await advance(1500)
    expect(capture).toHaveBeenCalledTimes(1)
    await advance(500)
    scheduler.onState({ url: 'http://localhost/b', loading: true })
    scheduler.onState({ url: 'http://localhost/b', loading: false })
    await advance(1000) // 落ち着く時間（1000ms）は過ぎたが、前に撮ってから 1500ms
    expect(capture).toHaveBeenCalledTimes(1)
    await advance(1499)
    expect(capture).toHaveBeenCalledTimes(1)
    await advance(1) // 前に撮ってから 3000ms
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('ゆっくりした撮り直しは前に撮ってから間が空いたときだけ。読み込み中は撮らない', async () => {
    scheduler.onState({ url: 'http://localhost/', loading: false })
    await advance(1500)
    expect(capture).toHaveBeenCalledTimes(1)
    scheduler.refresh()
    await advance(0)
    expect(capture).toHaveBeenCalledTimes(1)
    await advance(30_000)
    scheduler.refresh()
    await advance(0)
    expect(capture).toHaveBeenCalledTimes(2)
    scheduler.onState({ url: 'http://localhost/', loading: true })
    await advance(30_000)
    scheduler.refresh()
    await advance(0)
    expect(capture).toHaveBeenCalledTimes(2)
  })

  it('撮る処理が失敗しても止まらない。撮っている間に重ねて撮らない', async () => {
    let release: () => void = () => {}
    capture.mockImplementationOnce(() => new Promise<void>((resolve) => { release = resolve }))
    capture.mockImplementationOnce(async () => { throw new Error('hidden') })
    scheduler.onState({ url: 'http://localhost/a', loading: false })
    await advance(1500)
    expect(capture).toHaveBeenCalledTimes(1)
    // 1回目が終わらないうちに撮り直しの時間が来ても、重ねない
    await advance(30_000)
    scheduler.refresh()
    await advance(0)
    expect(capture).toHaveBeenCalledTimes(1)
    release()
    await advance(0)
    await advance(30_000)
    scheduler.refresh()
    await advance(0)
    expect(capture).toHaveBeenCalledTimes(2) // 失敗（hidden）しても投げない
    await advance(30_000)
    scheduler.refresh()
    await advance(0)
    expect(capture).toHaveBeenCalledTimes(3)
  })

  it('cancel で待っているものを捨てる', async () => {
    scheduler.onState({ url: 'http://localhost/a', loading: false })
    expect(scheduler.pending).toBe(true)
    scheduler.cancel()
    expect(scheduler.pending).toBe(false)
    await advance(10_000)
    expect(capture).not.toHaveBeenCalled()
  })
})
