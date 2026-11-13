import { describe, expect, it } from 'vitest'
import {
  createLogRing,
  isCrashEvent,
  isInstallId,
  LOG_LINE_MAX,
  parseSentryTestKinds,
  resolveInstallId,
  scrubEvent,
  sentryRelease,
  uiTabTag
} from '../../src/shared/telemetry'
// scripts は型検査の外（.mjs）なので、実行時だけ読む
const { parseGitLog } = (await import(/* @vite-ignore */ '../../scripts/sentry-release.mjs' as string)) as {
  parseGitLog: (text: string, repo: string) => Array<{ id: string; message: string; patch_set: Array<{ path: string; type: string }> }>
}

/**
 * クラッシュを特定するための文脈：リリース名、インストール ID、クラッシュに添付するログ、タグ、確認用の指定。
 */

describe('リリース名（SDK と上げたソースマップで同じ）', () => {
  it('配布版は ferret@<version>。sentry-sourcemaps.mjs / sentry-release.mjs と同じ形', () => {
    expect(sentryRelease('0.2.0')).toBe('ferret@0.2.0')
  })
  it('dev 起動は +<短いハッシュ> を付けて分ける', () => {
    expect(sentryRelease('0.2.0', { gitHash: 'd956abb' })).toBe('ferret@0.2.0+d956abb')
  })
})

describe('インストール ID', () => {
  const uuid = '3f2b6a1c-9d4e-4f7a-8b2c-1d0e9f8a7b6c'
  it('保存した UUID があればそれを使い、無い・壊れていれば作る', () => {
    expect(resolveInstallId(`${uuid}\n`, () => 'new')).toEqual({ id: uuid, created: false })
    expect(resolveInstallId(null, () => uuid)).toEqual({ id: uuid, created: true })
    expect(resolveInstallId('taro@example.com', () => uuid)).toEqual({ id: uuid, created: true })
  })
  it('UUID v4 の形だけを ID とみなす', () => {
    expect(isInstallId(uuid)).toBe(true)
    expect(isInstallId('taro')).toBe(false)
    expect(isInstallId(undefined)).toBe(false)
  })
  it('送る前の除去で、user は ID だけを残す（名前・メール・IP は落とす）', () => {
    const out = scrubEvent({ user: { id: uuid, email: 'taro@example.com', ip_address: '1.2.3.4', username: 'taro' } }) as { user?: unknown }
    expect(out.user).toEqual({ id: uuid, geo: {} })
    expect((scrubEvent({ user: { id: 'taro' } }) as { user?: unknown }).user).toEqual({ geo: {} })
  })
  it('空の geo を必ず置き、Sentry に接続元の IP から市区町村を推定させない（user が無いイベントも）', () => {
    expect((scrubEvent({ user: { id: uuid, geo: { city: 'Adachi City', country_code: 'JP' } } }) as { user?: unknown }).user).toEqual({ id: uuid, geo: {} })
    expect((scrubEvent({ message: 'x' }) as { user?: unknown }).user).toEqual({ geo: {} })
  })
})

describe('クラッシュに添付する main のログ', () => {
  const ctx = () => ({ homeDir: '/Users/taro', projectPaths: ['/Users/taro/work/app'] })
  it('アプリの見出し付きの行だけを残し、パス・URL・メール・キーを伏せる', () => {
    const ring = createLogRing(50, ctx)
    ring.push('warn', ['[recording] 停止に失敗しました', new Error("EACCES: open '/Users/taro/work/app/x.webm'")])
    ring.push('log', ['ターミナルの出力: npm run secret'])
    ring.push('log', ['[browser] 読み込み失敗 https://intra.example.com/admin taro@example.com sk-live-abcdefghijklmnop'])
    const text = ring.snapshot()
    expect(text.split('\n')).toHaveLength(2)
    expect(text).toContain("<project>/x.webm")
    expect(text).not.toMatch(/\/Users\/taro|https?:\/\/|@example\.com|sk-live|ターミナルの出力/)
  })
  it('直近の行だけを残し、1行は短く切る', () => {
    const ring = createLogRing(3, ctx)
    for (let i = 0; i < 10; i++) ring.push('log', [`[startup] line ${i}`])
    ring.push('log', [`[startup] ${'x'.repeat(1000)}`])
    const lines = ring.snapshot().split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('line 8')
    expect(lines[2]!.length).toBeLessThan(LOG_LINE_MAX + 60)
  })
  it('添付するのはクラッシュ（minidump・fatal・捕まえていない例外）だけ', () => {
    expect(isCrashEvent({}, true)).toBe(true)
    expect(isCrashEvent({ level: 'fatal' }, false)).toBe(true)
    expect(isCrashEvent({ exception: { values: [{ mechanism: { handled: false } }] } }, false)).toBe(true)
    expect(isCrashEvent({ level: 'warning', exception: { values: [{ mechanism: { handled: true } }] } }, false)).toBe(false)
  })
})

describe('タグと確認用の指定', () => {
  it('中央のタブはパスを含めない値にする', () => {
    expect(uiTabTag('browser')).toBe('browser')
    expect(uiTabTag('findings')).toBe('findings')
    expect(uiTabTag('file:/Users/taro/work/app/a.ts')).toBe('file')
    expect(uiTabTag('something-else')).toBe('other')
  })
  it('アプリを落とす確認は 1 / all に含めず、名前を書いたときだけ', () => {
    expect(parseSentryTestKinds('all')).not.toContain('crash-main')
    expect(parseSentryTestKinds('crash-main,crash-renderer,uncaught,hang,preload')).toEqual(['crash-main', 'crash-renderer', 'uncaught', 'hang', 'preload'])
  })
})

describe('リリースに付けるコミット（scripts/sentry-release.mjs）', () => {
  it('git log の --name-status から、変更したファイル付きのコミットを作る', () => {
    const text = '\u001eabc123\u001fTaro\u001ftaro@example.com\u001f2026-10-03T10:00:00+09:00\u001ffix: crash on stop\n\nM\tsrc/main/index.ts\nA\tsrc/shared/report.ts\nD\told.ts\nR100\tsrc/a.ts\tsrc/b.ts\n' +
      '\u001edef456\u001fHanako\u001fh@example.com\u001f2026-10-02T10:00:00+09:00\u001fdocs: x\n\nM\tREADME.md\n'
    const commits = parseGitLog(text, 'JapanMarketing-Dev/ferret')
    expect(commits.map((c) => c.id)).toEqual(['abc123', 'def456'])
    expect(commits[0]!.message).toBe('fix: crash on stop')
    expect(commits[0]!.patch_set).toEqual([
      { path: 'src/main/index.ts', type: 'M' }, { path: 'src/shared/report.ts', type: 'A' }, { path: 'old.ts', type: 'D' }, { path: 'src/b.ts', type: 'M' }
    ])
  })
})

describe('environment（確認用の起動を production にしない）', () => {
  const base = { packaged: true, version: '0.1.1', forced: false, e2e: false }
  it('配布版は production、dev は development', async () => {
    const { resolveEnvironment } = await import('../../src/shared/telemetry')
    expect(resolveEnvironment(base)).toBe('production')
    expect(resolveEnvironment({ ...base, packaged: false })).toBe('development')
  })
  it('FERRET_SENTRY_FORCE・-verify の版は、配布版でも verification', async () => {
    const { resolveEnvironment } = await import('../../src/shared/telemetry')
    expect(resolveEnvironment({ ...base, forced: true })).toBe('verification')
    expect(resolveEnvironment({ ...base, version: '0.1.1-verify.1' })).toBe('verification')
  })
})

describe('性能の異常のイベントの形', () => {
  it('題名は種類と長さ、まとめ方は種類ごと、スタックは付けない', async () => {
    const { perfAnomalyEvent } = await import('../../src/shared/telemetry')
    expect(perfAnomalyEvent('slow-startup', 7368)).toEqual({
      message: 'Slow startup (7.4s)', level: 'warning', fingerprint: ['anomaly', 'slow-startup'],
      tags: { kind: 'perf', perf: 'slow-startup', duration: '5-10s' }
    })
    const e = perfAnomalyEvent('event-loop-block', 1234)
    expect(e.message).toBe('Main event loop blocked (1.2s)')
    expect(e.fingerprint).toEqual(['anomaly', 'event-loop-block'])
    expect(e).not.toHaveProperty('exception')
  })
  it('reportPerf は送り先へ題名・タグ・fingerprint を渡す', async () => {
    const { reportPerf, setReporter } = await import('../../src/shared/report')
    const calls: unknown[][] = []
    setReporter({ handled: () => {}, breadcrumb: () => {}, message: (...a) => { calls.push(a) } })
    reportPerf('slow-startup', 6000)
    setReporter(null)
    expect(calls).toEqual([['Slow startup (6.0s)', { kind: 'perf', perf: 'slow-startup', duration: '5-10s' }, 'warning', ['anomaly', 'slow-startup'], undefined]])
  })
  it('起動のパンくずは操作名と数だけ（console の文は入れない）', async () => {
    const { startupBreadcrumb } = await import('../../src/shared/telemetry')
    expect(startupBreadcrumb('warning', ['[startup] 操作可能まで 7368ms (目標 2000ms) | main:loaded=1564ms ← 目標未達']))
      .toEqual({ category: 'startup', level: 'warning', message: 'startup slow', data: { ms: 7368 } })
    expect(startupBreadcrumb('error', ['[startup] 起動に失敗しました', new Error('x')])).toEqual({ category: 'startup', level: 'error', message: 'startup failed' })
  })
})

describe('「クラッシュレポートを送る」を起動中に切り替える', () => {
  it('OFF にした瞬間から transport が何も送らず、ON に戻すとそこから送る', async () => {
    const { createSendGate, gateTransport } = await import('../../src/shared/telemetry')
    let enabled = true
    const sent: string[] = []
    const events: string[] = []
    const gate = createSendGate(() => enabled, { onDisable: () => events.push('end session'), onEnable: () => events.push('start session') })
    const envelope = (name: string, type = 'event') => [{ event_id: name }, [[{ type }, { name }]]]
    const transport = gateTransport({ send: async (e: never) => { sent.push((e as unknown as [{ event_id: string }])[0].event_id); return {} }, flush: async () => true }, gate.allow)
    await transport.send(envelope('error-1') as never)
    enabled = false // 設定の画面で OFF、または settings.json を外から書き換えた
    await transport.send(envelope('session-update', 'session') as never)
    await transport.send(envelope('error-2') as never)
    enabled = true
    await transport.send(envelope('error-3') as never)
    expect(sent).toEqual(['error-1', 'error-3'])
    expect(events).toEqual(['end session', 'start session'])
  })
  it('送るものが無いあいだも、見張り（sync）で切り替わりに気づく', async () => {
    const { createSendGate } = await import('../../src/shared/telemetry')
    let enabled = true
    const events: string[] = []
    const gate = createSendGate(() => enabled, { onDisable: () => events.push('off'), onEnable: () => events.push('on') })
    enabled = false
    gate.sync()
    gate.sync()
    expect(events).toEqual(['off'])
  })
})

describe('Ferret への改名', () => {
  it('Sentry の環境変数は FERRET_SENTRY_* を先に読み、以前の MOVIE_ADE_SENTRY_* も受け付ける', async () => {
    const { sentryEnv, resolveSentryDsn, DEFAULT_SENTRY_DSN } = await import('../../src/shared/telemetry')
    expect(sentryEnv({ FERRET_SENTRY_FORCE: '1' }, 'FORCE')).toBe('1')
    expect(sentryEnv({ MOVIE_ADE_SENTRY_TEST: 'main' }, 'TEST')).toBe('main')
    expect(sentryEnv({ FERRET_SENTRY_TEST: 'renderer', MOVIE_ADE_SENTRY_TEST: 'main' }, 'TEST')).toBe('renderer')
    // 新しい名前を空にしたら、古い名前があっても「送らない」
    expect(resolveSentryDsn({ FERRET_SENTRY_DSN: '', MOVIE_ADE_SENTRY_DSN: 'https://x@o1.ingest.sentry.io/1' })).toBeNull()
    expect(resolveSentryDsn({ MOVIE_ADE_SENTRY_DSN: '' })).toBeNull()
    expect(resolveSentryDsn({})).toBe(DEFAULT_SENTRY_DSN)
  })
  it('リリース名の前置きは ferret（スクリプトと同じ）', async () => {
    const { RELEASE_PREFIX } = await import('../../src/shared/telemetry')
    const { readFileSync } = await import('node:fs')
    expect(RELEASE_PREFIX).toBe('ferret')
    for (const f of ['scripts/sentry-sourcemaps.mjs', 'scripts/sentry-release.mjs']) {
      expect(readFileSync(f, 'utf8')).toContain('`ferret@${')
    }
  })
})
