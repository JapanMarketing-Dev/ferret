import { afterEach, describe, expect, it, vi } from 'vitest'
import { boundedStep, safeStep } from '../../../src/main/recording/stopStep'

afterEach(() => { vi.useRealTimers() })

describe('停止の1段（boundedStep）', () => {
  it('終われば値を返す（同期の値・Promise・undefined）', async () => {
    await expect(boundedStep(() => 42, 100)).resolves.toEqual({ ok: true, value: 42 })
    await expect(boundedStep(async () => 'done', 100)).resolves.toEqual({ ok: true, value: 'done' })
    await expect(boundedStep(() => undefined, 100)).resolves.toEqual({ ok: true, value: undefined })
  })

  it('同期で投げても・失敗しても投げ返さず、理由を返す', async () => {
    const sync = await boundedStep(() => { throw new Error('同期で投げた') }, 100)
    expect(sync).toMatchObject({ ok: false, reason: 'error' })
    expect(String((sync as { error: unknown }).error)).toContain('同期で投げた')
    const rejected = await boundedStep(() => Promise.reject(new Error('失敗した')), 100)
    expect(rejected).toMatchObject({ ok: false, reason: 'error' })
    // Error でない値で失敗しても同じ
    await expect(boundedStep(() => Promise.reject('文字列'), 100)).resolves.toEqual({ ok: false, reason: 'error', error: '文字列' })
  })

  it('返ってこない段は上限であきらめる（停止が終わらないことを防ぐ）', async () => {
    vi.useFakeTimers()
    const result = boundedStep(() => new Promise<never>(() => {}), 5_000)
    let settled = false
    void result.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' })
  })

  it('上限が 0・負の値でも待ち続けない', async () => {
    await expect(boundedStep(() => new Promise<never>(() => {}), 0)).resolves.toEqual({ ok: false, reason: 'timeout' })
    await expect(boundedStep(() => new Promise<never>(() => {}), -10)).resolves.toEqual({ ok: false, reason: 'timeout' })
  })

  it('上限の後で失敗しても、未処理の失敗にしない', async () => {
    vi.useFakeTimers()
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const result = boundedStep(() => new Promise((_, reject) => setTimeout(() => reject(new Error('遅れて失敗')), 200)), 100)
      await vi.advanceTimersByTimeAsync(100)
      await expect(result).resolves.toEqual({ ok: false, reason: 'timeout' })
      await vi.advanceTimersByTimeAsync(200)
      await Promise.resolve()
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('終わった段のタイマーを残さない', async () => {
    vi.useFakeTimers()
    await boundedStep(() => 1, 60_000)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('同期の後片付け（safeStep）', () => {
  it('投げても次へ進み、理由を知らせる', () => {
    const onError = vi.fn()
    const after = vi.fn()
    safeStep(() => { throw new Error('壊れたウインドウ') }, onError)
    after()
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: '壊れたウインドウ' }))
    expect(after).toHaveBeenCalled()
  })

  it('投げなければ知らせない', () => {
    const onError = vi.fn()
    const run = vi.fn()
    safeStep(run, onError)
    expect(run).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
  })
})
