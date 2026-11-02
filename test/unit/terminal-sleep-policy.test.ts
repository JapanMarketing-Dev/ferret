/**
 * 使っていないターミナルを休ませる決まり（src/renderer/terminal/sleepPolicy.ts）
 */
import { describe, expect, it } from 'vitest'
import { SLEEP_AFTER_MS, panesToSleep, trackHidden, type SleepCandidate } from '../../src/renderer/terminal/sleepPolicy'

const MIN = 60_000

function pane(over: Partial<SleepCandidate> & { key: string }): SleepCandidate {
  return { projectId: 'B', launch: 'claude', cwd: '/b', accountId: null, state: 'idle', awake: true, restorable: true, ...over }
}

/** 全部のペインが long ms 前から裏にいる */
function hiddenFor(panes: readonly SleepCandidate[], ms: number, now: number): Map<string, number> {
  return new Map(panes.map((p) => [p.key, now - ms]))
}

describe('trackHidden（裏に回った時刻）', () => {
  it('裏のペインに初めて見た時刻を入れ、2回目以降は変えない', () => {
    const map = new Map<string, number>()
    trackHidden(map, [{ key: 'a', projectId: 'A' }, { key: 'b', projectId: 'B' }], 'A', 100)
    expect([...map]).toEqual([['b', 100]])
    trackHidden(map, [{ key: 'a', projectId: 'A' }, { key: 'b', projectId: 'B' }], 'A', 500)
    expect(map.get('b')).toBe(100)
  })

  it('表示したプロジェクトのペインは消え、もう一度裏に回ると時刻を入れ直す', () => {
    const map = new Map<string, number>([['b', 100]])
    trackHidden(map, [{ key: 'b', projectId: 'B' }], 'B', 200)
    expect(map.has('b')).toBe(false)
    trackHidden(map, [{ key: 'b', projectId: 'B' }], 'A', 300)
    expect(map.get('b')).toBe(300)
  })

  it('閉じたペインは消す', () => {
    const map = new Map<string, number>([['gone', 1], ['b', 2]])
    trackHidden(map, [{ key: 'b', projectId: 'B' }], 'A', 10)
    expect([...map.keys()]).toEqual(['b'])
  })

  it('プロジェクトの無いペインはホーム（空のキー）を表示中として扱う', () => {
    const map = new Map<string, number>()
    trackHidden(map, [{ key: 'h', projectId: null }, { key: 'b', projectId: 'B' }], '', 5)
    expect([...map.keys()]).toEqual(['b'])
    trackHidden(map, [{ key: 'h', projectId: null }], 'A', 6)
    expect(map.get('h')).toBe(6)
  })
})

describe('panesToSleep（休ませるペイン）', () => {
  const now = 10 * 60 * MIN

  it('裏で入力待ちのまま SLEEP_AFTER_MS 経った Claude Code・Codex を休ませる', () => {
    const panes = [pane({ key: 'c' }), pane({ key: 'x', launch: 'codex' })]
    expect(panesToSleep(panes, 'A', hiddenFor(panes, SLEEP_AFTER_MS, now), now)).toEqual(['c', 'x'])
  })

  it('境界: SLEEP_AFTER_MS ちょうどで休ませ、1ms 足りなければ休ませない', () => {
    const panes = [pane({ key: 'c' })]
    expect(panesToSleep(panes, 'A', hiddenFor(panes, SLEEP_AFTER_MS, now), now)).toEqual(['c'])
    expect(panesToSleep(panes, 'A', hiddenFor(panes, SLEEP_AFTER_MS - 1, now), now)).toEqual([])
  })

  it('裏に回った時刻が無いペインは休ませない', () => {
    expect(panesToSleep([pane({ key: 'c' })], 'A', new Map(), now)).toEqual([])
  })

  it('表示中のプロジェクトのペインは休ませない', () => {
    const panes = [pane({ key: 'a', projectId: 'A' })]
    expect(panesToSleep(panes, 'A', hiddenFor(panes, 2 * SLEEP_AFTER_MS, now), now)).toEqual([])
  })

  it('入力待ち（idle）以外は休ませない。作業中・確認待ち・終わったのにまだ見ていない・不明', () => {
    const panes = (['working', 'blocked', 'done', 'unknown'] as const).map((state) => pane({ key: state, state, cwd: `/${state}` }))
    expect(panesToSleep(panes, 'A', hiddenFor(panes, 2 * SLEEP_AFTER_MS, now), now)).toEqual([])
  })

  it('素のシェル・続きから起動し直せない Agent は休ませない', () => {
    const panes = [pane({ key: 'sh', launch: null }), pane({ key: 'g', launch: 'cursor', cwd: '/g' })]
    expect(panesToSleep(panes, 'A', hiddenFor(panes, 2 * SLEEP_AFTER_MS, now), now)).toEqual([])
  })

  it('もう止まっている・戻せない（ログイン・1回きりのコマンド）ペインは休ませない', () => {
    const panes = [pane({ key: 'dead', awake: false }), pane({ key: 'login', restorable: false, cwd: '/l' })]
    expect(panesToSleep(panes, 'A', hiddenFor(panes, 2 * SLEEP_AFTER_MS, now), now)).toEqual([])
  })

  it('同じ Agent・フォルダ・アカウントのペインが2つあれば、どちらも休ませない（--continue で取り違える）', () => {
    const panes = [pane({ key: 'c1' }), pane({ key: 'c2', projectId: 'A' })]
    expect(panesToSleep(panes, 'A', hiddenFor(panes, 2 * SLEEP_AFTER_MS, now), now)).toEqual([])
  })

  it('フォルダかアカウントが違えば、それぞれ休ませる', () => {
    const panes = [pane({ key: 'c1' }), pane({ key: 'c2', cwd: '/other' }), pane({ key: 'c3', accountId: 'work' })]
    expect(panesToSleep(panes, 'A', hiddenFor(panes, 2 * SLEEP_AFTER_MS, now), now)).toEqual(['c1', 'c2', 'c3'])
  })

  it('同じ Agent でも素のシェルは数に入れない', () => {
    const panes = [pane({ key: 'c' }), pane({ key: 'sh', launch: null })]
    expect(panesToSleep(panes, 'A', hiddenFor(panes, 2 * SLEEP_AFTER_MS, now), now)).toEqual(['c'])
  })

  it('ホームを表示中なら、プロジェクトの Agent は休ませ、プロジェクトの無いペインは休ませない', () => {
    const panes = [pane({ key: 'b' }), pane({ key: 'h', projectId: null, cwd: '/h' })]
    expect(panesToSleep(panes, null, hiddenFor(panes, 2 * SLEEP_AFTER_MS, now), now)).toEqual(['b'])
  })

  it('待つ時間を渡せる', () => {
    const panes = [pane({ key: 'c' })]
    expect(panesToSleep(panes, 'A', hiddenFor(panes, 5 * MIN, now), now, 5 * MIN)).toEqual(['c'])
  })
})
