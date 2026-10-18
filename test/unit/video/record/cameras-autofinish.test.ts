import { describe, expect, it, vi } from 'vitest'
import { autoStartEnabled, decideAutoFinish, runAutoFinish, type AutoFinishDeps } from '../../../../src/video/app/shared/record/autoFinish'
import { keepAvailable, mainCamera, recordingOrder, toggleCamera } from '../../../../src/video/app/shared/record/cameras'

describe('autoStartEnabled', () => {
  it.each([
    [null, true],
    [undefined, true],
    [{}, true],
    [{ autopilot: null }, true],
    [{ autopilot: [] }, true],
    [{ autopilot: {} }, true],
    [{ autopilot: { autoStart: 'no' } }, true],
    [{ autopilot: { autoStart: 0 } }, true],
    [{ autopilot: { autoStart: true } }, true],
    [{ autopilot: { autoStart: false } }, false]
  ])('%j → %s', (s, want) => {
    expect(autoStartEnabled(s as Record<string, unknown> | null)).toBe(want)
  })
})

describe('decideAutoFinish', () => {
  it('sends for a new take', () => {
    expect(decideAutoFinish({ autoStart: true, takeId: 't1', sent: new Set() })).toEqual({ send: true })
  })
  it('skips without a take', () => {
    expect(decideAutoFinish({ autoStart: true, takeId: null, sent: new Set() })).toEqual({ send: false, reason: 'no-take' })
    expect(decideAutoFinish({ autoStart: true, takeId: '', sent: new Set() })).toEqual({ send: false, reason: 'no-take' })
    expect(decideAutoFinish({ autoStart: true, takeId: undefined, sent: new Set() })).toEqual({ send: false, reason: 'no-take' })
  })
  it('skips when turned off', () => {
    expect(decideAutoFinish({ autoStart: false, takeId: 't1', sent: new Set() })).toEqual({ send: false, reason: 'disabled' })
  })
  it('skips a take that was already sent', () => {
    expect(decideAutoFinish({ autoStart: true, takeId: 't1', sent: new Set(['t1']) })).toEqual({ send: false, reason: 'already-sent' })
  })
})

function deps(over: Partial<AutoFinishDeps> = {}): AutoFinishDeps & { toasts: Array<[string, string]> } {
  const toasts: Array<[string, string]> = []
  return {
    toasts,
    autoStart: () => true,
    render: vi.fn(async (dir: string) => `動画を完成させて: ${dir}`),
    send: vi.fn(async () => ({ ok: true, message: 'sent' })),
    toast: (m, tone) => toasts.push([tone, m]),
    sent: new Set(),
    messages: { started: () => '編集を始めました', failed: (e) => `失敗: ${e}` },
    ...over
  }
}

describe('runAutoFinish', () => {
  it('renders finish with the folder, sends it and toasts', async () => {
    const d = deps()
    expect(await runAutoFinish('/ch/2026-10-18-a', 't1', d)).toBe('sent')
    expect(d.render).toHaveBeenCalledWith('/ch/2026-10-18-a')
    expect(d.send).toHaveBeenCalledWith('動画を完成させて: /ch/2026-10-18-a')
    expect(d.toasts).toEqual([['success', '編集を始めました']])
  })
  it('never sends twice for the same take, even concurrently', async () => {
    const d = deps()
    const [a, b] = await Promise.all([runAutoFinish('/p', 't1', d), runAutoFinish('/p', 't1', d)])
    expect([a, b].sort()).toEqual(['sent', 'skipped'])
    expect(await runAutoFinish('/p', 't1', d)).toBe('skipped')
    expect(d.send).toHaveBeenCalledTimes(1)
    expect(await runAutoFinish('/p', 't2', d)).toBe('sent')
    expect(d.send).toHaveBeenCalledTimes(2)
  })
  it('a failed send still counts as sent (no retry storm on the next stop)', async () => {
    const d = deps({ send: vi.fn(async () => ({ ok: false, message: 'no agent' })) })
    expect(await runAutoFinish('/p', 't1', d)).toBe('failed')
    expect(await runAutoFinish('/p', 't1', d)).toBe('skipped')
    expect(d.send).toHaveBeenCalledTimes(1)
  })
  it('does nothing when autoStart is off', async () => {
    const d = deps({ autoStart: () => false })
    expect(await runAutoFinish('/p', 't1', d)).toBe('skipped')
    expect(d.render).not.toHaveBeenCalled()
    expect(d.toasts).toEqual([])
    expect(d.sent.size).toBe(0)
  })
  it('a throwing autoStart reading counts as on (the default)', async () => {
    const d = deps({ autoStart: () => { throw new Error('broken settings') } })
    expect(await runAutoFinish('/p', 't1', d)).toBe('sent')
  })
  it('does nothing without a take id', async () => {
    const d = deps()
    expect(await runAutoFinish('/p', null, d)).toBe('skipped')
    expect(d.send).not.toHaveBeenCalled()
  })
  it('reports a failed send', async () => {
    const d = deps({ send: async () => ({ ok: false, message: 'no agent terminal' }) })
    expect(await runAutoFinish('/p', 't1', d)).toBe('failed')
    expect(d.toasts).toEqual([['danger', '失敗: no agent terminal']])
  })
  it('reports a render error without throwing', async () => {
    const d = deps({ render: async () => Promise.reject(new Error('unknown prompt')) })
    expect(await runAutoFinish('/p', 't1', d)).toBe('failed')
    expect(d.toasts).toEqual([['danger', '失敗: unknown prompt']])
    expect(d.send).not.toHaveBeenCalled()
  })
  it('an empty prompt is a failure, not an empty send', async () => {
    const d = deps({ render: async () => '   ' })
    expect(await runAutoFinish('/p', 't1', d)).toBe('failed')
    expect(d.send).not.toHaveBeenCalled()
  })
  it('a send that throws a non-Error is reported', async () => {
    const d = deps({ send: async () => Promise.reject('boom') })
    expect(await runAutoFinish('/p', 't1', d)).toBe('failed')
    expect(d.toasts).toEqual([['danger', '失敗: boom']])
  })
})

describe('cameras', () => {
  it('main camera is the chosen one while selected, else the first', () => {
    expect(mainCamera(['a', 'b'], 'b')).toBe('b')
    expect(mainCamera(['a', 'b'], 'c')).toBe('a')
    expect(mainCamera(['a', 'b'], null)).toBe('a')
    expect(mainCamera([], 'a')).toBeNull()
  })
  it('records the main camera first', () => {
    expect(recordingOrder(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
    expect(recordingOrder(['a', 'b'], undefined)).toEqual(['a', 'b'])
    expect(recordingOrder(['a', 'a', 'b'], 'b')).toEqual(['b', 'a'])
    expect(recordingOrder([], 'x')).toEqual([])
  })
  it('toggles and drops unplugged cameras', () => {
    expect(toggleCamera(['a'], 'b')).toEqual(['a', 'b'])
    expect(toggleCamera(['a', 'b'], 'a')).toEqual(['b'])
    expect(toggleCamera([], 'a')).toEqual(['a'])
    expect(keepAvailable(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c'])
    expect(keepAvailable(['a'], [])).toEqual([])
  })
})
