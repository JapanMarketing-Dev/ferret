import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_SENTRY_DSN,
  MAX_EVENTS_PER_RUN,
  createEventLimiter,
  crashReportsEnabled,
  resolveSentryDsn,
  sampleEvent,
  scrubBreadcrumb,
  scrubEvent,
  scrubString,
  sentryRelease,
  shouldSendCrashReports,
  telemetryProfile,
  parseSentryTestKinds,
  shouldReportLoadFailure,
  shouldReportProcessGone,
  isGpuContextLostExit,
  createGpuContextLostGate,
  GPU_CONTEXT_LOST_WINDOW_MS,
  renderErrorCapture,
  wrapIpcHandler
} from '../../src/shared/telemetry'
import { UserFacingError, isUserFacingError, toUserFacingFileError } from '../../src/shared/errors'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-unit' } }))

/**
 * クラッシュレポート（Sentry）の送る条件と、送る前の個人情報の除去。
 * 実際の送信はしない（beforeSend に渡る前後のイベントの形だけを見る）。
 */

describe('DSN', () => {
  it('環境変数が無ければ既定の DSN', () => {
    expect(resolveSentryDsn({})).toBe(DEFAULT_SENTRY_DSN)
  })
  it('環境変数で上書きできる（フォークした人の Sentry）', () => {
    expect(resolveSentryDsn({ FERRET_SENTRY_DSN: ' https://abc@example.ingest.sentry.io/1 ' })).toBe('https://abc@example.ingest.sentry.io/1')
  })
  it('空にすれば送らない', () => {
    expect(resolveSentryDsn({ FERRET_SENTRY_DSN: '' })).toBeNull()
    expect(resolveSentryDsn({ MOVIE_ADE_SENTRY_DSN: '   ' })).toBeNull()
  })
  it('release は ferret@<version>', () => {
    expect(sentryRelease('0.2.0')).toBe('ferret@0.2.0')
  })
})

describe('送る条件', () => {
  const base = { e2e: false, unitTest: false, enabled: true, dsn: DEFAULT_SENTRY_DSN }
  it('設定 ON なら送る（配布版も dev 起動も）', () => {
    expect(shouldSendCrashReports(base)).toBe(true)
  })
  it('E2E では送らない', () => {
    expect(shouldSendCrashReports({ ...base, e2e: true })).toBe(false)
  })
  it('確認用の FERRET_SENTRY_FORCE なら E2E の起動でも送る（単体テスト・設定 OFF には勝たない）', () => {
    expect(shouldSendCrashReports({ ...base, e2e: true, forced: true })).toBe(true)
    expect(shouldSendCrashReports({ ...base, unitTest: true, forced: true })).toBe(false)
    expect(shouldSendCrashReports({ ...base, enabled: false, e2e: true, forced: true })).toBe(false)
  })
  it('単体テストでは送らない', () => {
    expect(shouldSendCrashReports({ ...base, unitTest: true })).toBe(false)
  })
  it('設定 OFF なら送らない', () => {
    expect(shouldSendCrashReports({ ...base, enabled: false })).toBe(false)
  })
  it('DSN が空なら送らない', () => {
    expect(shouldSendCrashReports({ ...base, dsn: null })).toBe(false)
  })
  it('設定は未設定なら ON、明示の false だけ OFF', () => {
    expect(crashReportsEnabled({})).toBe(true)
    expect(crashReportsEnabled({ crashReports: true })).toBe(true)
    expect(crashReportsEnabled({ crashReports: false })).toBe(false)
  })
})

describe('環境ごとの送り方', () => {
  it('配布版は production・JS の例外は半分・1回の起動で10件まで', () => {
    expect(telemetryProfile(true)).toEqual({ environment: 'production', sampleRate: 0.5, maxEventsPerRun: 10, maxWarningsPerRun: 5 })
  })
  it('dev は development・全部・50件まで', () => {
    expect(telemetryProfile(false)).toEqual({ environment: 'development', sampleRate: 1, maxEventsPerRun: 50, maxWarningsPerRun: 30 })
  })
  it('dev の上限は50件で、重複の抑止は同じ', () => {
    const allow = createEventLimiter(telemetryProfile(false).maxEventsPerRun)
    const ev = (v: string) => ({ exception: { values: [{ type: 'Error', value: v }] } })
    expect(allow(ev('x'))).toBe(true)
    expect(allow(ev('x'))).toBe(false)
    const rest = Array.from({ length: 60 }, (_, i) => allow(ev(`e${i}`)))
    expect(rest.filter(Boolean)).toHaveLength(49)
  })
  it('dev の release は git の短いハッシュ付き。取れなければ +dev', () => {
    expect(sentryRelease('0.1.0', { gitHash: 'fd78b14' })).toBe('ferret@0.1.0+fd78b14')
    expect(sentryRelease('0.1.0', { gitHash: null })).toBe('ferret@0.1.0+dev')
    expect(sentryRelease('0.1.0', { gitHash: 'fatal: not a git repository' })).toBe('ferret@0.1.0+dev')
    expect(sentryRelease('0.1.0')).toBe('ferret@0.1.0')
  })
  it('確認用の FERRET_SENTRY_TEST を読む', () => {
    expect(parseSentryTestKinds(undefined)).toEqual([])
    expect(parseSentryTestKinds('0')).toEqual([])
    expect(parseSentryTestKinds('1')).toEqual(['main', 'renderer', 'boundary', 'ipc', 'handled'])
    expect(parseSentryTestKinds('all')).toHaveLength(5)
    expect(parseSentryTestKinds('ipc, main x')).toEqual(['main', 'ipc'])
  })
})

describe('集める異常', () => {
  it('アプリ自身の画面の読み込み失敗は送る。止めただけ（-3）とサブフレームは送らない', () => {
    expect(shouldReportLoadFailure({ ownPage: true, errorCode: -6, isMainFrame: true })).toBe(true)
    expect(shouldReportLoadFailure({ ownPage: true, errorCode: -3, isMainFrame: true })).toBe(false)
    expect(shouldReportLoadFailure({ ownPage: true, errorCode: -6, isMainFrame: false })).toBe(false)
  })
  it('内蔵ブラウザのページ（別のセッション）の読み込み失敗は送らない', () => {
    expect(shouldReportLoadFailure({ ownPage: false, errorCode: -102, isMainFrame: true })).toBe(false) // CONNECTION_REFUSED
    expect(shouldReportLoadFailure({ ownPage: false, errorCode: -300, isMainFrame: true })).toBe(false) // INVALID_URL
  })
  it('プロセスの終了は、正常終了と利用者が止めたもの以外を送る', () => {
    expect(shouldReportProcessGone('crashed')).toBe(true)
    expect(shouldReportProcessGone('oom')).toBe(true)
    expect(shouldReportProcessGone('launch-failed')).toBe(true)
    expect(shouldReportProcessGone('clean-exit')).toBe(false)
    expect(shouldReportProcessGone('killed')).toBe(false)
  })
  it('GPU の文脈を失った終了（終了コード 34。macOS・Linux は 34 << 8 = 8704）を見分ける（FERRET-24）', () => {
    expect(isGpuContextLostExit({ type: 'GPU', reason: 'abnormal-exit', exitCode: 8704 })).toBe(true)
    expect(isGpuContextLostExit({ type: 'GPU', reason: 'abnormal-exit', exitCode: 34 })).toBe(true)
    // 本当に落ちたもの・他のプロセス・他の終了コードは今までどおり送る
    expect(isGpuContextLostExit({ type: 'GPU', reason: 'crashed', exitCode: 8704 })).toBe(false)
    expect(isGpuContextLostExit({ type: 'GPU', reason: 'abnormal-exit', exitCode: 1 })).toBe(false)
    expect(isGpuContextLostExit({ type: 'GPU', reason: 'abnormal-exit', exitCode: 33 << 8 })).toBe(false)
    expect(isGpuContextLostExit({ type: 'Utility', reason: 'abnormal-exit', exitCode: 8704 })).toBe(false)
  })
  it('GPU の文脈を失った終了は、短い間に3回続いたときに1度だけ送る', () => {
    let now = 0
    const gate = createGpuContextLostGate(() => now)
    expect(gate()).toBe(false)
    now += 60_000
    expect(gate()).toBe(false)
    now += 60_000
    expect(gate()).toBe(true)
    now += 60_000
    expect(gate()).toBe(false) // 続きの4回目は送らない
  })
  it('GPU の文脈を失った終了が間を空けて起きるなら送らない（1日に数回のスリープ明けなど）', () => {
    let now = 0
    const gate = createGpuContextLostGate(() => now)
    for (let i = 0; i < 10; i++) {
      expect(gate()).toBe(false)
      now += GPU_CONTEXT_LOST_WINDOW_MS / 2 + 1
    }
  })
  it('ErrorBoundary のエラーには境界の名前と componentStack を付ける', () => {
    expect(renderErrorCapture('terminal', '\n    at Bomb\n    at ErrorBoundary')).toEqual({
      tags: { kind: 'render-error', 'error.boundary': 'terminal' },
      contexts: { react: { componentStack: 'at Bomb\n    at ErrorBoundary' } }
    })
  })
  it('componentStack は長めに残し、パスは伏せる', () => {
    const stack = `at Foo (/Users/taro/app/src/a.tsx)\n${'    at Bar\n'.repeat(60)}`
    const out = scrubEvent({ contexts: renderErrorCapture('x', stack).contexts }, { homeDir: '/Users/taro' }) as { contexts: { react: { componentStack: string } } }
    expect(out.contexts.react.componentStack.length).toBeGreaterThan(300)
    expect(out.contexts.react.componentStack).toContain('~/app/src/a.tsx')
  })
  it('起動の失敗（startup）のパンくずは残す', () => {
    expect(scrubBreadcrumb({ category: 'startup', message: '[startup] failed at /Users/taro/x' }, { homeDir: '/Users/taro' }))
      .toEqual({ category: 'startup', message: '[startup] failed at ~/x' })
  })
})

describe('UserFacingError', () => {
  it('Error の一種で、renderer が本文を取り出せる形（name は Error）のまま', () => {
    const err = new UserFacingError('録画中は切り替えできません')
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('録画中は切り替えできません')
    expect(String(err)).toBe('Error: 録画中は切り替えできません')
  })
  it('印で見分ける。ふつうの Error・文字列・null は想定外として扱う', () => {
    expect(isUserFacingError(new UserFacingError('x'))).toBe(true)
    expect(isUserFacingError(Object.assign(new Error('x'), { userFacing: true }))).toBe(true)
    expect(isUserFacingError(new Error('x'))).toBe(false)
    expect(isUserFacingError('x')).toBe(false)
    expect(isUserFacingError(null)).toBe(false)
  })
  it('main の利用者向けの文は UserFacingError で投げる（throw new Error(t( が残っていない）', async () => {
    const { execFileSync } = await import('node:child_process')
    const hits = (() => {
      try { return execFileSync('grep', ['-rln', 'throw new Error(t(', 'src'], { encoding: 'utf8' }).trim() } catch { return '' }
    })()
    expect(hits).toBe('')
  })
})

describe('IPC の包み方', () => {
  it('例外を kind: ipc とチャネル名のタグ付きで報告し、そのまま投げ直す', async () => {
    const report = vi.fn()
    const err = new Error('boom')
    const wrapped = wrapIpcHandler('project:switch', () => { throw err }, report)
    await expect(wrapped()).rejects.toBe(err)
    expect(report).toHaveBeenCalledWith(err, { kind: 'ipc', 'ipc.channel': 'project:switch' })
  })
  it('利用者に見せる想定内のエラー（UserFacingError）は送らずに投げ直す', async () => {
    const report = vi.fn()
    const err = new UserFacingError('Project not found.')
    const wrapped = wrapIpcHandler('project:switch', () => { throw err }, report)
    await expect(wrapped()).rejects.toBe(err)
    expect(report).not.toHaveBeenCalled()
  })
  it('ファイル操作の想定内の OS エラーは利用者向けの文にして送らない。想定外のコードは送る', async () => {
    const osError = (code: string) => Object.assign(new Error(`${code}: open '/Users/taro/x'`), { code })
    const report = vi.fn()
    // main と同じ順：ハンドラの中で包み直してから wrapIpcHandler が見る
    const handlerFailing = (err: Error) => wrapIpcHandler('fs:write', async () => {
      try { throw err } catch (e) { throw toUserFacingFileError(e) }
    }, report)
    for (const code of ['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT', 'ENOTDIR']) {
      const original = osError(code)
      const thrown = await handlerFailing(original)().catch((e: unknown) => e) as Error & { cause?: unknown }
      expect(isUserFacingError(thrown)).toBe(true)
      expect(thrown.cause).toBe(original)
      expect(thrown.message).not.toContain('/Users/taro')
    }
    expect(report).not.toHaveBeenCalled()
    const eio = osError('EIO')
    await expect(handlerFailing(eio)()).rejects.toBe(eio)
    expect(report).toHaveBeenCalledWith(eio, { kind: 'ipc', 'ipc.channel': 'fs:write' })
  })
  it('コードの無い例外・文字列はそのまま返す（包み直さない）', () => {
    const err = new Error('boom')
    expect(toUserFacingFileError(err)).toBe(err)
    expect(toUserFacingFileError('x')).toBe('x')
    expect(toUserFacingFileError(null)).toBe(null)
  })
  it('成功したときは報告せず、引数と戻り値をそのまま通す', async () => {
    const report = vi.fn()
    const wrapped = wrapIpcHandler('x', async (a: number, b: number) => a + b, report)
    await expect(wrapped(1, 2)).resolves.toBe(3)
    expect(report).not.toHaveBeenCalled()
  })
})

describe('文字列の除去', () => {
  const ctx = { homeDir: '/Users/taro', projectPaths: ['/Users/taro/work/secret-app'] }
  it('ホームのパスを ~ にする（macOS・Linux・Windows）', () => {
    expect(scrubString('ENOENT: /Users/hanako/Library/x.json')).toBe('ENOENT: ~/Library/x.json')
    expect(scrubString('open /home/hanako/.config/a')).toBe('open ~/.config/a')
    expect(scrubString('C:\\Users\\Hanako\\AppData\\Roaming\\ade-movie')).toBe('~\\AppData\\Roaming\\ade-movie')
    expect(scrubString('file:///Users/hanako/x.js')).toBe('file://~/x.js')
  })
  it('プロジェクトのフォルダは <project> にする', () => {
    expect(scrubString("can't read /Users/taro/work/secret-app/src/a.ts", ctx)).toBe("can't read <project>/src/a.ts")
  })
  it('内蔵ブラウザの URL を送らない', () => {
    expect(scrubString('failed to load https://intra.example.com/admin?id=42 (net::ERR)')).toBe('failed to load <url> (net::ERR)')
    expect(scrubString('ws://localhost:3000/socket closed')).toBe('<url> closed')
  })
  it('app:// のスタックのファイル名は残す（ソースマップの照合に要る）', () => {
    expect(scrubString('app:///out/main/index.js')).toBe('app:///out/main/index.js')
  })
  it('メールアドレスを送らない', () => {
    expect(scrubString('user hanako.yamada+test@example.co.jp not found')).toBe('user <email> not found')
  })
  it('API キー・トークンを送らない', () => {
    expect(scrubString('401 for sk-proj-abcdefghijklmnop1234')).toBe('401 for <secret>')
    expect(scrubString('token ghp_ABCDEFGHIJ1234567890abcd')).toBe('token <secret>')
    expect(scrubString('Authorization: Bearer abc.def-123456789')).toBe('Authorization: <secret>')
    expect(scrubString('AIzaSyA1234567890abcdefghijklmnop')).toBe('<secret>')
    expect(scrubString('jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.abcdefghijk')).toBe('jwt <secret>')
  })
  it('長い文は切り詰める（ターミナルの出力や文字起こしが混ざっても全部は出ない）', () => {
    const out = scrubString('x'.repeat(2000))
    expect(out.length).toBeLessThanOrEqual(301)
  })
})

describe('イベントの除去', () => {
  const ctx = { homeDir: '/Users/taro', projectPaths: ['/Users/taro/work/app'] }
  const event = {
    event_id: 'e1',
    message: 'boom at /Users/taro/work/app/feedback.md',
    user: { ip_address: '203.0.113.5', email: 'taro@example.com' },
    server_name: 'taros-macbook.local',
    request: { url: 'https://example.com/page' },
    extra: { transcript: '今日は社外秘の話をします' },
    contexts: {
      os: { name: 'macOS', version: '15.1' },
      device: { arch: 'arm64', name: "Taro's MacBook", model_id: 'Mac15,3', boot_time: '2026-10-02T14:40:18.347Z' },
      app: { app_name: 'MOVIE-ADE' },
      runtime: { name: 'Electron', version: '44.5.1' },
      terminal: { output: 'ls ~/secret' }
    },
    exception: {
      values: [{
        type: 'Error',
        value: 'ENOENT: no such file, open \'/Users/taro/Documents/a.txt\' (taro@example.com)',
        stacktrace: { frames: [{ filename: 'app:///out/main/index.js', abs_path: `/Users/taro/Applications/MOVIE-ADE.app/${'deep/'.repeat(80)}x.js`, function: 'run', lineno: 10 }] }
      }]
    },
    breadcrumbs: [
      { category: 'console', message: 'terminal output: npm run secret' },
      { category: 'ui.click', message: 'button[aria-label="Delete /Users/taro/x"]' },
      { category: 'navigation', data: { from: 'https://a.example', to: 'https://b.example' } },
      { category: 'electron', message: 'app.ready', data: { url: 'https://example.com', title: 'Inbox (3) – taro@example.com' } },
      { category: 'child-process', message: 'whisper exited', data: { type: 'Utility', exitCode: 1, name: 'whisper', cwd: '/Users/taro/work/app' } }
    ]
  }

  it('user は空の geo だけ・request・extra・server_name を持たない', () => {
    const out = scrubEvent(event, ctx) as Record<string, unknown>
    expect(out.user).toEqual({ geo: {} })
    expect(out.request).toBeUndefined()
    expect(out.extra).toBeUndefined()
    expect(out.server_name).toBeUndefined()
  })
  it('OS・CPU・実行環境の版は残し、端末名と知らない contexts は落とす', () => {
    const out = scrubEvent(event, ctx) as { contexts: Record<string, Record<string, unknown>> }
    expect(out.contexts.os).toEqual({ name: 'macOS', version: '15.1' })
    expect(out.contexts.device).toEqual({ arch: 'arm64' })
    expect(out.contexts.runtime?.version).toBe('44.5.1')
    expect(out.contexts.terminal).toBeUndefined()
  })
  it('例外のメッセージからパスとメールを落とす。スタックのファイル名は長くても切らない', () => {
    const out = scrubEvent(event, ctx) as typeof event
    const v = out.exception.values[0]!
    expect(v.value).toBe("ENOENT: no such file, open '~/Documents/a.txt' (<email>)")
    expect(out.message).toBe('boom at <project>/feedback.md')
    expect(v.stacktrace.frames[0]!.filename).toBe('app:///out/main/index.js')
    expect(v.stacktrace.frames[0]!.abs_path.startsWith('~/Applications/MOVIE-ADE.app/')).toBe(true)
    expect(v.stacktrace.frames[0]!.abs_path.endsWith('x.js')).toBe(true)
  })
  it('breadcrumb は electron と子プロセスだけ。URL・タイトル・作業フォルダは落とす', () => {
    const out = scrubEvent(event, ctx) as typeof event
    expect(out.breadcrumbs.map((b) => b.category)).toEqual(['electron', 'child-process'])
    expect(out.breadcrumbs[0]).toEqual({ category: 'electron', message: 'app.ready' })
    expect(out.breadcrumbs[1]!.data).toEqual({ type: 'Utility', exitCode: 1, name: 'whisper' })
  })
  it('Sentry の ID（event_id・trace_id）は秘密の形でも残す', () => {
    const ids = { event_id: 'a'.repeat(32), contexts: { trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16) } } }
    expect(scrubEvent(ids)).toEqual({ ...ids, user: { geo: {} } })
  })
  it('元のイベントは書き換えない', () => {
    scrubEvent(event, ctx)
    expect(event.user.email).toBe('taro@example.com')
  })
  it('送ったイベントのどこにもホーム・URL・メールが残らない', () => {
    const json = JSON.stringify(scrubEvent(event, ctx))
    expect(json).not.toMatch(/\/Users\/taro|https?:\/\/|@example\.com|社外秘|taros-macbook/)
  })
  it('beforeBreadcrumb でも同じ規則で落とす', () => {
    expect(scrubBreadcrumb({ category: 'console', message: 'x' })).toBeNull()
    expect(scrubBreadcrumb({ category: 'fetch', data: { url: 'https://a' } })).toBeNull()
    expect(scrubBreadcrumb({ category: 'electron', message: 'browser-window.closed /Users/taro/a' }, ctx)).toEqual({ category: 'electron', message: 'browser-window.closed ~/a' })
  })
})

describe('送る量を抑える', () => {
  const err = (value: string) => ({ exception: { values: [{ type: 'Error', value, stacktrace: { frames: [{ filename: 'app:///a.js', function: 'f', lineno: 1 }] } }] } })
  it('同じエラーは1回の起動で1度だけ', () => {
    const allow = createEventLimiter()
    expect(allow(err('a'))).toBe(true)
    expect(allow(err('a'))).toBe(false)
    expect(allow(err('b'))).toBe(true)
  })
  it('1回の起動で送る数に上限がある', () => {
    const allow = createEventLimiter()
    const results = Array.from({ length: MAX_EVENTS_PER_RUN + 5 }, (_, i) => allow(err(`e${i}`)))
    expect(results.filter(Boolean)).toHaveLength(MAX_EVENTS_PER_RUN)
  })
  it('JS の例外は間引き、ネイティブのクラッシュは全部送る', () => {
    expect(sampleEvent(true, () => 0.99)).toBe(true)
    expect(sampleEvent(false, () => 0.99)).toBe(false)
    expect(sampleEvent(false, () => 0.1)).toBe(true)
  })
})

describe('設定の保存', () => {
  it('crashReports は明示の false だけ残し、未設定は ON のまま', async () => {
    const { sanitize } = await import('../../src/main/settings')
    expect(sanitize({ crashReports: false }).crashReports).toBe(false)
    expect(sanitize({ crashReports: true }).crashReports).toBeUndefined()
    expect(sanitize({ crashReports: 'no' }).crashReports).toBeUndefined()
    expect(sanitize({ crashReportsNoticeShown: true }).crashReportsNoticeShown).toBe(true)
    expect(sanitize({}).crashReportsNoticeShown).toBeUndefined()
  })
})
