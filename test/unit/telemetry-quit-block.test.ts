import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * FERRET-M（0.6.12 の Windows）：ウィンドウを閉じた終了では、PTY の後始末が終わって app.quit() するまで
 * before-quit が来ない。その間（quit begin の後）の片付けの止まり 3.8s が「Main event loop blocked」で届いていた。
 * beginShutdown が noteQuitRequested() を呼んだ後の止まりは送らないことを、本物の watchEventLoop で確かめる。
 */

const clock = vi.hoisted(() => ({ now: 0 }))
const app = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter: E } = require('node:events') as typeof import('node:events')
  return Object.assign(new E(), {
    isReady: () => true,
    whenReady: () => new Promise<void>(() => undefined),
    getPath: () => '/tmp/ferret-unit',
    getAppPath: () => '/tmp/ferret-unit',
    isPackaged: false,
    accessibilitySupportEnabled: false
  })
})

vi.mock('electron', () => ({
  app,
  BrowserWindow: { getFocusedWindow: () => ({}) },
  powerMonitor: new EventEmitter(),
  crashReporter: { start: vi.fn() },
  dialog: {},
  session: {}
}))
vi.mock('@sentry/electron/main', () => ({}))
// マシンの実際の負荷で結果が変わらないよう、負荷は無いものにする（ビルド中の高負荷で isMachineOverloaded が効いてしまう）
vi.mock('node:os', async (importOriginal) => ({ ...(await importOriginal<typeof import('node:os')>()), loadavg: () => [0, 0, 0] }))
vi.mock('node:perf_hooks', () => ({
  performance: { now: () => clock.now },
  PerformanceObserver: class { observe(): void { throw new Error('no gc in tests') } }
}))
vi.mock('../../src/main/settings', () => ({ configDir: () => '/tmp/ferret-unit', currentSettings: () => ({}), onSettingsChanged: () => () => undefined }))
vi.mock('../../src/main/telemetrySourceMaps', () => ({ attachDebugIds: vi.fn(), remapDevFrames: vi.fn() }))

import { setReporter, type Reporter } from '../../src/shared/report'
import { EVENT_LOOP_WATCH_MS, noteQuitRequested, watchEventLoop } from '../../src/main/telemetry'
import { SLEEP_AFTER_BLOCK_MS } from '../../src/shared/telemetry'

describe('ウィンドウを閉じた終了の片付けの止まり（FERRET-M 0.6.12）', () => {
  const messages: string[] = []
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'setTimeout'] })
    messages.length = 0
    setReporter({ handled: vi.fn(), message: (m: string) => { messages.push(m) }, breadcrumb: vi.fn() } as unknown as Reporter)
  })
  afterEach(() => {
    setReporter(null)
    vi.useRealTimers()
  })

  /** 見張りのタイマーを1回進め、その間に main が blockMs 止まったことにする */
  const tick = (blockMs = 0): void => {
    clock.now += EVENT_LOOP_WATCH_MS + blockMs
    vi.advanceTimersByTime(EVENT_LOOP_WATCH_MS)
  }

  it('quit begin（noteQuitRequested）の後の 3.8s は送らない。before-quit が来ていなくても同じ。終了が取り消されて猶予を過ぎれば送る', () => {
    watchEventLoop(1000)
    tick()
    tick()
    noteQuitRequested()
    tick(3800)
    expect(messages).toEqual([])

    // 終了の猶予（30s）を過ぎた後の同じ止まりは送る（noteQuitRequested が無ければ上も送っていた）
    for (let i = 0; i < 40; i++) tick()
    expect(messages).toEqual([])
    tick(3800)
    // 送る前の待ち（手がかりを集め、スリープ・ロックの知らせが後から来ないかを見る。SLEEP_AFTER_BLOCK_MS）
    vi.advanceTimersByTime(SLEEP_AFTER_BLOCK_MS)
    expect(messages).toEqual(['Main event loop blocked (3.8s)'])
  })
})
