/**
 * SSH のタブ（tmux の中）への利用者の入力の関所（src/main/tmuxInput.ts の TmuxInputGate）。
 * ホイールで上へ戻したあとの最初の入力の前に一度だけ tmux のコピーモードを抜け、それまでの入力を順番どおりに貯めて流す。
 * 時計と待ちは差し替える（実時間に依存しない）
 */
import { describe, expect, it } from 'vitest'
import { TmuxInputGate, dropRightButtonReports, hasMouseReport, splitTmuxInput } from '../../src/main/tmuxInput'

const WHEEL_UP = '\x1b[<64;10;10M'
const WHEEL_DOWN = '\x1b[<65;10;10M'
const CLICK = '\x1b[<0;10;10M\x1b[<0;10;10m'
/** X10 の報告（ESC [ M のあと b・x・y に 32 を足した文字） */
const x10 = (button: number, x = 10, y = 10) => `\x1b[M${String.fromCharCode(32 + button, 32 + x, 32 + y)}`

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, ng) => {
    resolve = ok
    reject = ng
  })
  return { promise, resolve, reject }
}

/** 抜ける処理の Promise のつながりを進める */
const settle = () => new Promise<void>((done) => setTimeout(done, 0))

function harness(leave: () => Promise<boolean | null>, options: { failLimit?: number; pauseMs?: number } = {}) {
  const writes: Array<{ data: string; mouse: boolean }> = []
  const timers: Array<{ fn: () => void; ms: number; done: boolean }> = []
  let now = 0
  let leaves = 0
  const gate = new TmuxInputGate({
    write: (data, mouse) => writes.push({ data, mouse }),
    leave: () => {
      leaves += 1
      return leave()
    },
    holdMs: 1500,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, done: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      ;(timer as { done: boolean }).done = true
    },
    now: () => now,
    ...options
  })
  return {
    gate,
    writes,
    written: () => writes.map((w) => w.data).join(''),
    leaves: () => leaves,
    /** 上限の待ちが来た */
    timeout: () => {
      for (const timer of timers) {
        if (timer.done) continue
        timer.done = true
        timer.fn()
      }
    },
    pendingTimers: () => timers.filter((t) => !t.done),
    advance: (ms: number) => {
      now += ms
    }
  }
}

describe('入力のかたまり（splitTmuxInput）', () => {
  it('上向きのホイール・ほかのマウスの報告・端末の答え・打鍵を順番どおりに分ける', () => {
    expect(splitTmuxInput('abc')).toEqual([{ kind: 'input', data: 'abc' }])
    expect(splitTmuxInput('')).toEqual([])
    expect(splitTmuxInput(`ab${WHEEL_UP}cd${CLICK}\x1b[I\x1b[?1;2c\x1b[12;5R\x1b]11;rgb:0000/0000/0000\x1b\\\x1bP>|xterm.js\x1b\\e`)).toEqual([
      { kind: 'input', data: 'ab' },
      { kind: 'wheel-up', data: WHEEL_UP },
      { kind: 'input', data: 'cd' },
      { kind: 'mouse', data: '\x1b[<0;10;10M' },
      { kind: 'mouse', data: '\x1b[<0;10;10m' },
      { kind: 'report', data: '\x1b[I' },
      { kind: 'report', data: '\x1b[?1;2c' },
      { kind: 'report', data: '\x1b[12;5R' },
      { kind: 'report', data: '\x1b]11;rgb:0000/0000/0000\x1b\\' },
      { kind: 'report', data: '\x1bP>|xterm.js\x1b\\' },
      { kind: 'input', data: 'e' }
    ])
  })

  it('修飾キー付きのホイールも上向きなら wheel-up。下向き・横向きは mouse。X10 も同じ', () => {
    for (const up of ['\x1b[<64;1;1M', '\x1b[<68;1;1M', '\x1b[<72;1;1M', '\x1b[<80;1;1M', x10(64), x10(64 + 16)]) expect(splitTmuxInput(up)[0]!.kind, JSON.stringify(up)).toBe('wheel-up')
    for (const other of [WHEEL_DOWN, '\x1b[<66;1;1M', '\x1b[<67;1;1M', '\x1b[<32;1;1M', '\x1b[<0;1;1M', x10(65), x10(0), x10(3)]) expect(splitTmuxInput(other)[0]!.kind, JSON.stringify(other)).toBe('mouse')
    // Shift+Enter（ESC CR）・↑・Ctrl+C・ブラケットペーストは打鍵
    for (const key of ['\x1b\r', '\x1b[A', '\x1bOA', '\x03', '\x1b[200~text\x1b[201~']) expect(splitTmuxInput(key).every((s) => s.kind === 'input'), JSON.stringify(key)).toBe(true)
  })

  it('X10 のマウスの報告も見て、右ボタンは落とす', () => {
    expect(hasMouseReport(x10(64))).toBe(true)
    expect(dropRightButtonReports(`a${x10(2)}b${x10(0)}c${x10(2 + 32)}`)).toBe(`ab${x10(0)}c`)
  })
})

describe('関所（TmuxInputGate）', () => {
  it('マウスを使わずに打った入力は、その場で書く（待たない・抜けない）。キーボードで入ったコピーモード（prefix [）はそのまま使える', () => {
    const h = harness(() => Promise.resolve(true))
    h.gate.push('hello')
    expect(h.written()).toBe('hello')
    h.gate.push('\x02[')
    h.gate.push('k')
    h.gate.push('\r')
    expect(h.written()).toBe('hello\x02[k\r')
    expect(h.leaves()).toBe(0)
    expect(h.pendingTimers()).toEqual([])
    expect(h.gate.holding).toBe(false)
  })

  it('マウスの報告だけでは抜けない（クリック・ホイールはその場で書く）', async () => {
    const h = harness(() => Promise.resolve(true))
    h.gate.push(WHEEL_UP)
    h.gate.push(CLICK)
    h.gate.push(WHEEL_DOWN)
    await settle()
    expect(h.writes).toEqual([{ data: WHEEL_UP, mouse: true }, { data: '\x1b[<0;10;10M', mouse: true }, { data: '\x1b[<0;10;10m', mouse: true }, { data: WHEEL_DOWN, mouse: true }])
    expect(h.leaves()).toBe(0)
  })

  it('ホイールのあとの最初の入力の前に一度だけ抜け、抜けるまでの打鍵・貼り付け・マウスを順番どおりに貯めて流す', async () => {
    const leave = deferred<boolean | null>()
    const h = harness(() => leave.promise)
    h.gate.push(WHEEL_UP)
    h.gate.push('f')
    h.gate.push('ix')
    h.gate.push('\x1b[200~the bug\x1b[201~')
    h.gate.push(CLICK)
    h.gate.push('\x1b\r')
    h.gate.push('\r')
    await settle()
    // 打ち続けても抜けるのは1回。抜け終わるまでは書かない
    expect(h.leaves()).toBe(1)
    expect(h.written()).toBe(WHEEL_UP)
    expect(h.gate.holding).toBe(true)
    leave.resolve(true)
    await settle()
    expect(h.written()).toBe(`${WHEEL_UP}fix\x1b[200~the bug\x1b[201~${CLICK}\x1b\r\r`)
    expect(h.gate.holding).toBe(false)
    expect(h.pendingTimers()).toEqual([])
    // 抜けたら元に戻る（次の入力は待たない）
    h.gate.push('more')
    expect(h.written().endsWith('more')).toBe(true)
    expect(h.leaves()).toBe(1)
  })

  it('抜けるのが遅ければ上限（holdMs）で流す。あとで抜け終わっても二重に送らない', async () => {
    const leave = deferred<boolean | null>()
    const h = harness(() => leave.promise)
    h.gate.push(WHEEL_UP)
    h.gate.push('abc')
    await settle()
    expect(h.pendingTimers().map((t) => t.ms)).toEqual([1500])
    h.timeout()
    expect(h.written()).toBe(`${WHEEL_UP}abc`)
    expect(h.gate.holding).toBe(false)
    leave.resolve(true)
    await settle()
    h.gate.push('d')
    expect(h.written()).toBe(`${WHEEL_UP}abcd`)
    expect(h.leaves()).toBe(1)
  })

  it('上限で流したあとに遅れて終わった前の抜ける処理で、次のホイールのあとの貯めを先に流さない', async () => {
    const leaves = [deferred<boolean | null>(), deferred<boolean | null>()]
    let n = 0
    const h = harness(() => leaves[n++]!.promise)
    h.gate.push(WHEEL_UP)
    h.gate.push('a')
    await settle()
    h.timeout()
    expect(h.written()).toBe(`${WHEEL_UP}a`)
    h.gate.push(WHEEL_UP)
    h.gate.push('b')
    await settle()
    expect(h.leaves()).toBe(2)
    // 1つ目が今ごろ終わっても、2つ目（b の前の抜ける処理）は終わっていないので b はまだ書かない
    leaves[0]!.resolve(true)
    await settle()
    expect(h.written()).toBe(`${WHEEL_UP}a${WHEEL_UP}`)
    expect(h.gate.holding).toBe(true)
    leaves[1]!.resolve(true)
    await settle()
    expect(h.written()).toBe(`${WHEEL_UP}a${WHEEL_UP}b`)
  })

  it('抜けられない（ssh の失敗・分からない）ときも捨てずに1回だけ流す', async () => {
    for (const fail of [() => Promise.reject(new Error('ssh down')), () => Promise.resolve(null)]) {
      const h = harness(fail)
      h.gate.push(WHEEL_UP)
      h.gate.push('a')
      h.gate.push('b')
      await settle()
      expect(h.written()).toBe(`${WHEEL_UP}ab`)
      h.timeout()
      expect(h.written()).toBe(`${WHEEL_UP}ab`)
    }
  })

  it('貯めている間のホイールのあとの入力は、流したあと、もう一度抜けてから書く（1回のホイールにつき1回）', async () => {
    const leaves = [deferred<boolean | null>(), deferred<boolean | null>()]
    let n = 0
    const h = harness(() => leaves[n++]!.promise)
    h.gate.push(WHEEL_UP)
    h.gate.push('a')
    h.gate.push(WHEEL_UP)
    h.gate.push('b')
    await settle()
    expect(h.leaves()).toBe(1)
    leaves[0]!.resolve(true)
    await settle()
    expect(h.written()).toBe(`${WHEEL_UP}a${WHEEL_UP}`)
    expect(h.leaves()).toBe(2)
    expect(h.gate.holding).toBe(true)
    leaves[1]!.resolve(false)
    await settle()
    expect(h.written()).toBe(`${WHEEL_UP}a${WHEEL_UP}b`)
  })

  it('まとめて届いたもの（renderer が打鍵とホイールを1回で送った）も、順番どおりに分けて扱う', async () => {
    const h = harness(() => Promise.resolve(true))
    h.gate.push(`ab${WHEEL_UP}cd`)
    expect(h.written()).toBe(`ab${WHEEL_UP}`)
    await settle()
    expect(h.written()).toBe(`ab${WHEEL_UP}cd`)
    expect(h.leaves()).toBe(1)
  })

  it('右ボタンの報告は書かず、抜けるきっかけにもしない', async () => {
    const h = harness(() => Promise.resolve(true))
    h.gate.push('\x1b[<2;5;5M')
    h.gate.push('\x1b[<34;6;6M')
    h.gate.push('\x1b[<2;6;6m')
    h.gate.push('x')
    await settle()
    expect(h.writes).toEqual([{ data: 'x', mouse: false }])
    expect(h.leaves()).toBe(0)
  })

  it('フォーカスの出入り・端末の答えは利用者の入力として扱わない（抜けるきっかけにしない）', async () => {
    const h = harness(() => Promise.resolve(true))
    h.gate.push(WHEEL_UP)
    h.gate.push('\x1b[I')
    h.gate.push('\x1b[O')
    h.gate.push('\x1b[?1;2c')
    h.gate.push('\x1b]11;rgb:0000/0000/0000\x07')
    await settle()
    expect(h.written()).toBe(`${WHEEL_UP}\x1b[I\x1b[O\x1b[?1;2c\x1b]11;rgb:0000/0000/0000\x07`)
    expect(h.leaves()).toBe(0)
    h.gate.push('k')
    expect(h.gate.holding).toBe(true)
    await settle()
    expect(h.leaves()).toBe(1)
    expect(h.written().endsWith('k')).toBe(true)
  })

  it('続けて抜けられなければ、しばらくはホイールのあとも待たせない（ssh が使えないホストで打鍵を遅らせ続けない）', async () => {
    const h = harness(() => Promise.resolve(null), { failLimit: 3, pauseMs: 60_000 })
    for (let i = 0; i < 3; i++) {
      h.gate.push(WHEEL_UP)
      h.gate.push(`${i}`)
      await settle()
    }
    expect(h.leaves()).toBe(3)
    h.gate.push(WHEEL_UP)
    h.gate.push('x')
    expect(h.written().endsWith('x')).toBe(true)
    expect(h.leaves()).toBe(3)
    h.advance(60_001)
    h.gate.push(WHEEL_UP)
    h.gate.push('y')
    expect(h.gate.holding).toBe(true)
    await settle()
    expect(h.leaves()).toBe(4)
    expect(h.written().endsWith('y')).toBe(true)
  })

  it('抜けられたら失敗の数え直し（間に成功があれば止めない）', async () => {
    const results: Array<boolean | null> = [null, null, true, null, null]
    const h = harness(() => Promise.resolve(results.shift() ?? null), { failLimit: 3 })
    for (let i = 0; i < 5; i++) {
      h.gate.push(WHEEL_UP)
      h.gate.push(`${i}`)
      await settle()
    }
    h.gate.push(WHEEL_UP)
    h.gate.push('z')
    expect(h.gate.holding).toBe(true)
    await settle()
    expect(h.leaves()).toBe(6)
  })

  it('書けなくなった（タブが終わった）ときも、待ちの後始末で投げない', async () => {
    let broken = false
    const leave = deferred<boolean | null>()
    const gate = new TmuxInputGate({
      write: () => {
        if (broken) throw new Error('pty closed')
      },
      leave: () => leave.promise,
      holdMs: 1500,
      setTimer: () => 0,
      clearTimer: () => {}
    })
    gate.push(WHEEL_UP)
    gate.push('a')
    broken = true
    leave.resolve(true)
    await settle()
    expect(gate.holding).toBe(false)
  })
})
