/**
 * メモリが足りないときの知らせ（src/shared/memoryAlert.ts と src/main/memoryWatch.ts）。
 * 勝手には止めない。出す・消す（ヒステリシス）・「あとで」の間隔・分からない値・止められるものの並びを確かめる
 */
import { describe, expect, it } from 'vitest'
import {
  CONSUMER_LIMIT,
  CONSUMER_MIN_BYTES,
  DISMISS_COOLDOWN_MS,
  INITIAL_MEMORY_ALERT,
  assessMemory,
  dismissMemoryAlert,
  memoryConsumers,
  stepMemoryAlert,
  stillLow,
  type MemoryAlertState,
  type MemorySample,
  type PaneInfo
} from '../../src/shared/memoryAlert'
import { MemoryWatch, parseDarwinSysctl, parseMemAvailable } from '../../src/main/memoryWatch'
import type { ResourceProject, ResourceSnapshot, ResourceTerminal } from '../../src/shared/resources'
import type { MemoryAlertNotice } from '../../src/shared/memoryAlert'

const GB = 1024 ** 3
const MB = 1024 ** 2
const TOTAL = 16 * GB

function sample(over: Partial<MemorySample> = {}): MemorySample {
  return { total: TOTAL, available: 8 * GB, pressure: 'normal', ferret: 2 * GB, ...over }
}

describe('assessMemory（入る側の閾値）', () => {
  it('余裕があれば ok', () => {
    expect(assessMemory(sample())).toBe('ok')
  })

  it('境界: 空きが全体の 10% ちょうどは ok、1 バイト下回れば warn', () => {
    expect(assessMemory(sample({ available: TOTAL * 0.10 }))).toBe('ok')
    expect(assessMemory(sample({ available: TOTAL * 0.10 - 1 }))).toBe('warn')
  })

  it('境界: 小さい PC では 1.5GB を下回れば warn（割合では足りていても）', () => {
    const total = 8 * GB
    expect(assessMemory(sample({ total, available: 1.5 * GB }))).toBe('ok')
    expect(assessMemory(sample({ total, available: 1.5 * GB - 1 }))).toBe('warn')
  })

  it('境界: 空きが 5% 未満・0.75GB 未満は critical', () => {
    expect(assessMemory(sample({ available: TOTAL * 0.05 }))).toBe('warn')
    expect(assessMemory(sample({ available: TOTAL * 0.05 - 1 }))).toBe('critical')
    expect(assessMemory(sample({ total: 4 * GB, available: 0.75 * GB - 1 }))).toBe('critical')
  })

  it('境界: Ferret が全体の 60% を超えれば warn、75% を超えれば critical', () => {
    expect(assessMemory(sample({ ferret: TOTAL * 0.60 }))).toBe('ok')
    expect(assessMemory(sample({ ferret: TOTAL * 0.60 + 1 }))).toBe('warn')
    expect(assessMemory(sample({ ferret: TOTAL * 0.75 }))).toBe('warn')
    expect(assessMemory(sample({ ferret: TOTAL * 0.75 + 1 }))).toBe('critical')
  })

  it('OS の逼迫（macOS）をそのまま使う', () => {
    expect(assessMemory(sample({ pressure: 'warn' }))).toBe('warn')
    expect(assessMemory(sample({ pressure: 'critical' }))).toBe('critical')
  })

  it('分からない値は無いものとして扱う（空きも Ferret も分からなければ ok）', () => {
    expect(assessMemory(sample({ available: null, ferret: null, pressure: null }))).toBe('ok')
    expect(assessMemory(sample({ available: null, ferret: TOTAL * 0.7 }))).toBe('warn')
    expect(assessMemory(sample({ available: Number.NaN, ferret: null }))).toBe('ok')
    expect(assessMemory(sample({ available: -1, ferret: null }))).toBe('ok')
  })

  it('合計が分からない（0・NaN）なら出さない', () => {
    expect(assessMemory(sample({ total: 0, available: 0 }))).toBe('ok')
    expect(assessMemory(sample({ total: Number.NaN, available: 0 }))).toBe('ok')
  })
})

describe('stillLow（消す側の閾値・ヒステリシス）', () => {
  it('入る側を下回っていれば当然まだ低い', () => {
    expect(stillLow(sample({ available: TOTAL * 0.05 }))).toBe(true)
  })

  it('境界: 空きが 15% と 2.5GB を両方満たすまでは消さない', () => {
    // 32GB では 15% が 2.5GB より大きいので割合で決まる
    expect(stillLow(sample({ total: 32 * GB, available: 32 * GB * 0.15 - 1 }))).toBe(true)
    expect(stillLow(sample({ total: 32 * GB, available: 32 * GB * 0.15 }))).toBe(false)
    expect(stillLow(sample({ total: 8 * GB, available: 2.5 * GB - 1 }))).toBe(true)
    expect(stillLow(sample({ total: 8 * GB, available: 2.5 * GB }))).toBe(false)
  })

  it('境界: Ferret が 50% 以下になるまでは消さない', () => {
    expect(stillLow(sample({ ferret: TOTAL * 0.50 + 1 }))).toBe(true)
    expect(stillLow(sample({ ferret: TOTAL * 0.50 }))).toBe(false)
  })

  it('分からない値だけなら消す', () => {
    expect(stillLow(sample({ available: null, ferret: null, pressure: null }))).toBe(false)
  })
})

describe('stepMemoryAlert（出す・出したまま・消す）', () => {
  it('余裕がある間は何もしない', () => {
    expect(stepMemoryAlert(INITIAL_MEMORY_ALERT, sample(), 0).action).toBeNull()
  })

  it('低くなったら出し、低いままなら中身だけ新しくする', () => {
    const first = stepMemoryAlert(INITIAL_MEMORY_ALERT, sample({ available: GB }), 0)
    expect(first.action).toBe('show')
    expect(first.state.shown).toBe(true)
    const again = stepMemoryAlert(first.state, sample({ available: GB }), 60_000)
    expect(again.action).toBe('update')
  })

  it('出したあと、入る側は越えても戻る側に届かない間（10〜15%）は消さない', () => {
    const shown = stepMemoryAlert(INITIAL_MEMORY_ALERT, sample({ available: GB }), 0).state
    const band = stepMemoryAlert(shown, sample({ available: TOTAL * 0.12 }), 1)
    expect(band.action).toBe('update')
    expect(band.state.level).toBe('warn')
    const recovered = stepMemoryAlert(band.state, sample({ available: TOTAL * 0.2 }), 2)
    expect(recovered.action).toBe('hide')
    expect(recovered.state.shown).toBe(false)
  })

  it('出している間に悪くなれば重さが上がる', () => {
    const shown = stepMemoryAlert(INITIAL_MEMORY_ALERT, sample({ available: GB }), 0).state
    expect(stepMemoryAlert(shown, sample({ available: 0.5 * GB }), 1).state.level).toBe('critical')
  })
})

describe('「あとで」の間隔', () => {
  function dismissedAt(level: MemorySample, now: number): MemoryAlertState {
    const shown = stepMemoryAlert(INITIAL_MEMORY_ALERT, level, now).state
    return dismissMemoryAlert(shown, level, now)
  }

  it('30 分は同じくらいの低さでは出し直さない。境界ちょうどで出し直す', () => {
    const low = sample({ available: 1.2 * GB })
    const state = dismissedAt(low, 0)
    expect(state.shown).toBe(false)
    expect(stepMemoryAlert(state, low, DISMISS_COOLDOWN_MS - 1).action).toBeNull()
    expect(stepMemoryAlert(state, low, DISMISS_COOLDOWN_MS).action).toBe('show')
  })

  it('30 分の間でも、warn から critical に上がれば出し直す', () => {
    const state = dismissedAt(sample({ available: 1.4 * GB }), 0)
    expect(stepMemoryAlert(state, sample({ available: 0.5 * GB }), 60_000).action).toBe('show')
  })

  it('30 分の間でも、空きが押したときの半分を切れば出し直す（半分ちょうどは出さない）', () => {
    const state = dismissedAt(sample({ available: TOTAL * 0.08 }), 0)
    expect(stepMemoryAlert(state, sample({ available: TOTAL * 0.04 }), 60_000).action).toBe('show') // critical でもある
    const critical = dismissedAt(sample({ available: 0.6 * GB }), 0)
    expect(stepMemoryAlert(critical, sample({ available: 0.3 * GB - 1 }), 60_000).action).toBe('show')
    expect(stepMemoryAlert(critical, sample({ available: 0.3 * GB }), 60_000).action).toBeNull()
  })

  it('critical で「あとで」を押したら、critical のままでは出し直さない', () => {
    const state = dismissedAt(sample({ pressure: 'critical' }), 0)
    expect(stepMemoryAlert(state, sample({ pressure: 'critical' }), 60_000).action).toBeNull()
  })

  it('空きが分からないまま押したら、空きの比較では出し直さない', () => {
    const state = dismissedAt(sample({ available: null, ferret: TOTAL * 0.65 }), 0)
    expect(state.dismissedAvailable).toBeNull()
    expect(stepMemoryAlert(state, sample({ available: null, ferret: TOTAL * 0.7 }), 60_000).action).toBeNull()
    expect(stepMemoryAlert(state, sample({ available: null, ferret: TOTAL * 0.8 }), 60_000).action).toBe('show')
  })

  it('間隔の後に出し直したら「あとで」の記録を消す', () => {
    const state = dismissedAt(sample({ available: GB }), 0)
    const next = stepMemoryAlert(state, sample({ available: GB }), DISMISS_COOLDOWN_MS + 1).state
    expect(next.dismissedAt).toBeNull()
  })
})

// ───────────────────────── 止められるものの並び ─────────────────────────

function term(id: string, memory: number, over: Partial<ResourceTerminal> = {}): ResourceTerminal {
  return { id, pid: 1, title: id, running: true, orphan: false, cpu: 0, memory, ...over }
}

function project(id: string | null, terminals: ResourceTerminal[], page: ResourceProject['page'] = null): ResourceProject {
  return { id, name: id ?? 'その他', cpu: 0, memory: 0, cpuHistory: [], terminals, page }
}

function snapshot(projects: ResourceProject[]): ResourceSnapshot {
  return { app: { cpu: 0, memory: GB }, projects, totalCpu: 0, totalMemory: 0, terminalCount: 0, orphanCount: 0, cores: 8, collectedAt: 0 }
}

describe('memoryConsumers（止められるもの）', () => {
  const panes = new Map<string, PaneInfo>([
    ['a1', { ptyId: 'a1', launch: 'claude', state: 'idle', resumable: true }],
    ['a2', { ptyId: 'a2', launch: 'codex', state: 'working', resumable: true }],
    ['a3', { ptyId: 'a3', launch: 'cursor', state: 'blocked', resumable: false }],
    ['s1', { ptyId: 's1', launch: null, state: 'unknown', resumable: false }]
  ])

  it('大きい順に、Agent・シェル・内蔵ブラウザを並べ、アプリ本体は入れない', () => {
    const rows = memoryConsumers(snapshot([
      project('A', [term('a1', 600 * MB), term('s1', 200 * MB)], { title: 'Docs', url: 'https://x', cpu: 0, memory: 900 * MB }),
      project('B', [term('a2', 700 * MB), term('a3', 100 * MB)])
    ]), panes)
    expect(rows.map((row) => [row.id, row.kind, row.projectName])).toEqual([
      ['page', 'page', 'A'], ['a2', 'agent', 'B'], ['a1', 'agent', 'A'], ['s1', 'shell', 'A'], ['a3', 'agent', 'B']
    ])
  })

  it('Agent の動いているかは画面の印（作業中・確認待ち）、シェルはプロセスが走っているかで見る', () => {
    const rows = memoryConsumers(snapshot([project('A', [
      term('a1', GB), term('a2', GB), term('a3', GB), term('s1', GB, { running: false }), term('s2', GB, { running: true })
    ])]), panes)
    const busy = Object.fromEntries(rows.map((row) => [row.id, row.busy]))
    expect(busy).toEqual({ a1: false, a2: true, a3: true, s1: false, s2: true })
  })

  it('続きから戻せるのは Agent で、ペインがそう言うものだけ。ペインが分からなければシェル扱い', () => {
    const rows = memoryConsumers(snapshot([project('A', [term('a1', GB), term('a3', GB), term('unknown', GB)])]), panes)
    expect(rows.map((row) => [row.id, row.kind, row.resumable])).toEqual([['a1', 'agent', true], ['a3', 'agent', false], ['unknown', 'shell', false]])
  })

  it('境界: 50MB ちょうどは入れ、1 バイト足りなければ入れない', () => {
    const rows = memoryConsumers(snapshot([project('A', [term('big', CONSUMER_MIN_BYTES), term('small', CONSUMER_MIN_BYTES - 1)])]), panes)
    expect(rows.map((row) => row.id)).toEqual(['big'])
  })

  it(`多すぎれば上から ${CONSUMER_LIMIT} 件まで`, () => {
    const terms = Array.from({ length: 12 }, (_, i) => term(`t${i}`, (i + 1) * 100 * MB))
    const rows = memoryConsumers(snapshot([project('A', terms)]), panes)
    expect(rows).toHaveLength(CONSUMER_LIMIT)
    expect(rows[0]!.id).toBe('t11')
  })

  it('集計が無い・ターミナルが無いなら空', () => {
    expect(memoryConsumers(null, panes)).toEqual([])
    expect(memoryConsumers(snapshot([]), panes)).toEqual([])
  })

  it('メモリが NaN の行は入れない', () => {
    expect(memoryConsumers(snapshot([project('A', [term('bad', Number.NaN)])]), panes)).toEqual([])
  })
})

// ───────────────────────── main の読み取りと見張り ─────────────────────────

describe('parseDarwinSysctl・parseMemAvailable', () => {
  it('kern.memorystatus_level（空きの%）と逼迫の段階を読む', () => {
    expect(parseDarwinSysctl('68\n1\n')).toEqual({ availableRatio: 0.68, pressure: 'normal' })
    expect(parseDarwinSysctl('9\n2\n')).toEqual({ availableRatio: 0.09, pressure: 'warn' })
    expect(parseDarwinSysctl('3\n4\n')).toEqual({ availableRatio: 0.03, pressure: 'critical' })
  })

  it('読めない・範囲外は null', () => {
    expect(parseDarwinSysctl('')).toEqual({ availableRatio: null, pressure: null })
    expect(parseDarwinSysctl('101\n3\n')).toEqual({ availableRatio: null, pressure: null })
    expect(parseDarwinSysctl('abc\n')).toEqual({ availableRatio: null, pressure: null })
  })

  it('/proc/meminfo の MemAvailable をバイトで', () => {
    expect(parseMemAvailable('MemTotal:       16000000 kB\nMemFree:  100 kB\nMemAvailable:    2048 kB\n')).toBe(2048 * 1024)
    expect(parseMemAvailable('MemTotal: 1 kB\n')).toBeNull()
  })
})

describe('MemoryWatch（60 秒ごとの見張り）', () => {
  function setup(system: { total: number; available: number | null }, opts: { fresh?: ResourceSnapshot | null } = {}) {
    const sent: Array<MemoryAlertNotice | null> = []
    const notified: MemoryAlertNotice[] = []
    let collected = 0
    let now = 0
    const snap = { ...snapshot([]), totalMemory: 2 * GB }
    const watch = new MemoryWatch({
      collect: async () => { collected++; return snap },
      latest: () => opts.fresh ?? null,
      readSystem: async () => ({ ...system, pressure: null }),
      send: (notice) => sent.push(notice),
      notify: (notice) => notified.push(notice),
      now: () => now
    })
    return { watch, sent, notified, system, collected: () => collected, tick: (ms: number) => { now += ms } }
  }

  it('余裕があれば何も送らない', async () => {
    const s = setup({ total: TOTAL, available: 8 * GB })
    await s.watch.check()
    expect(s.sent).toEqual([])
    expect(s.watch.current()).toBeNull()
  })

  it('低くなれば知らせを送り、OS の通知は出したときの1回だけ', async () => {
    const s = setup({ total: TOTAL, available: GB })
    await s.watch.check()
    s.tick(60_000)
    await s.watch.check()
    expect(s.sent).toHaveLength(2)
    expect(s.sent[0]!.level).toBe('warn')
    expect(s.sent[0]!.ferret).toBe(2 * GB)
    expect(s.notified).toHaveLength(1)
    expect(s.watch.current()).not.toBeNull()
  })

  it('戻れば消す（null を送る）', async () => {
    const s = setup({ total: TOTAL, available: GB })
    await s.watch.check()
    s.system.available = 8 * GB
    await s.watch.check()
    expect(s.sent.at(-1)).toBeNull()
    expect(s.watch.current()).toBeNull()
  })

  it('「あとで」で消し、30 分は出し直さない', async () => {
    const s = setup({ total: TOTAL, available: GB })
    await s.watch.check()
    s.watch.dismiss()
    expect(s.sent.at(-1)).toBeNull()
    s.tick(10 * 60_000)
    await s.watch.check()
    expect(s.sent).toHaveLength(2)
    s.tick(DISMISS_COOLDOWN_MS)
    await s.watch.check()
    expect(s.sent.at(-1)?.level).toBe('warn')
    expect(s.notified).toHaveLength(2)
  })

  it('フッターの新しい集計があれば ps を起動しない（collect を呼ばない）', async () => {
    const fresh = { ...snapshot([]), totalMemory: 3 * GB }
    const s = setup({ total: TOTAL, available: GB }, { fresh })
    await s.watch.check()
    expect(s.collected()).toBe(0)
    expect(s.sent[0]!.ferret).toBe(3 * GB)
    const t = setup({ total: TOTAL, available: GB })
    await t.watch.check()
    expect(t.collected()).toBe(1)
  })
})
