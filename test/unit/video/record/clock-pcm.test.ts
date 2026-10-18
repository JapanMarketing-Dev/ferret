import { describe, expect, it } from 'vitest'
import { contextTimeToPerfMs } from '../../../../src/video/app/shared/record/audioClock'
import { CLIP_HOLD_MS, ClipHold, levelFromPeak, peakOf, pickVideoMime, toInt16Interleaved } from '../../../../src/video/app/shared/record/pcm'

describe('contextTimeToPerfMs', () => {
  it('uses the output timestamp when the context is running', () => {
    expect(contextTimeToPerfMs(2, { contextTime: 2.5, performanceTime: 135_000 }, 135_100, 2.6)).toBe(134_500)
  })
  it('falls back to currentTime + performance.now() before the first output ({0, 0})', () => {
    expect(contextTimeToPerfMs(0.010667, { contextTime: 0, performanceTime: 0 }, 134_848, 0.021333)).toBeCloseTo(134_837.33, 1)
  })
  it('falls back when the timestamp is missing or partial', () => {
    for (const ts of [undefined, null, {}, { contextTime: 1 }, { performanceTime: 5 }, { contextTime: Number.NaN, performanceTime: 1 }]) {
      expect(contextTimeToPerfMs(1, ts, 10_000, 1.5)).toBe(9_500)
    }
  })
  it('ignores a mapping in the future or before zero', () => {
    expect(contextTimeToPerfMs(1, { contextTime: 0.5, performanceTime: 20_000 }, 10_000, 1.2)).toBe(9_800)
    expect(contextTimeToPerfMs(0, { contextTime: 5, performanceTime: 100 }, 10_000, 0.1)).toBe(9_900)
  })
  it('accepts a mapping exactly at now (+1 ms of jitter)', () => {
    expect(contextTimeToPerfMs(1, { contextTime: 1, performanceTime: 10_001 }, 10_000, 1)).toBe(10_001)
  })
  it('clamps clock jitter (currentTime slightly behind t)', () => {
    expect(contextTimeToPerfMs(1.003, null, 10_000, 1)).toBe(10_000)
  })
  it('undefined when nothing usable', () => {
    expect(contextTimeToPerfMs(Number.NaN, null, 10_000, 1)).toBeUndefined()
    expect(contextTimeToPerfMs(1, null, Number.NaN, 1)).toBeUndefined()
    expect(contextTimeToPerfMs(1, null, 10_000, Number.NaN)).toBeUndefined()
    expect(contextTimeToPerfMs(0, null, 100, 5)).toBeUndefined()
  })
  it('is on the same clock as video firstFrameMs (within a few ms)', () => {
    const video = 134_864.9
    const audio = contextTimeToPerfMs(0, { contextTime: 0, performanceTime: 0 }, 134_870, 0.008)!
    expect(Math.abs(audio - video)).toBeLessThan(50)
  })
})

describe('pickVideoMime', () => {
  it('prefers fragmented MP4 (H.264)', () => {
    expect(pickVideoMime(() => true)).toEqual({ mime: 'video/mp4;codecs=avc1', ext: 'mp4' })
  })
  it('takes a later MP4 variant', () => {
    expect(pickVideoMime((m) => m === 'video/mp4')).toEqual({ mime: 'video/mp4', ext: 'mp4' })
  })
  it('falls back to WebM VP9, then VP8', () => {
    expect(pickVideoMime((m) => m.startsWith('video/webm'))).toEqual({ mime: 'video/webm;codecs=vp9', ext: 'webm' })
    expect(pickVideoMime((m) => m === 'video/webm;codecs=vp8')).toEqual({ mime: 'video/webm;codecs=vp8', ext: 'webm' })
  })
  it('lets the browser choose when nothing is reported', () => {
    expect(pickVideoMime(() => false)).toEqual({ mime: '', ext: 'webm' })
  })
})

describe('toInt16Interleaved', () => {
  const read = (u: Uint8Array) => Array.from(new Int16Array(u.buffer, u.byteOffset, u.byteLength / 2))
  it('interleaves stereo little-endian', () => {
    const out = toInt16Interleaved([new Float32Array([0, 1]), new Float32Array([-1, 0.5])])
    expect(out.byteLength).toBe(8)
    expect(read(out)).toEqual([0, -32768, 32767, 16384])
  })
  it('clamps out-of-range samples', () => {
    expect(read(toInt16Interleaved([new Float32Array([2, -3])]))).toEqual([32767, -32768])
  })
  it('treats NaN as silence-ish (clamped, never throws) and empty input as empty', () => {
    expect(toInt16Interleaved([]).byteLength).toBe(0)
    expect(toInt16Interleaved([new Float32Array(0)]).byteLength).toBe(0)
  })
  it('a shorter second channel is padded with zero', () => {
    expect(read(toInt16Interleaved([new Float32Array([0.5, 0.5]), new Float32Array([0.5])]))).toEqual([16384, 16384, 16384, 0])
  })
})

describe('levels and clipping', () => {
  it('maps peak to -60..0 dB', () => {
    expect(levelFromPeak(1)).toBe(1)
    expect(levelFromPeak(0.001)).toBeCloseTo(0, 5)
    expect(levelFromPeak(0.1)).toBeCloseTo(2 / 3, 5)
    expect(levelFromPeak(0)).toBe(0)
    expect(levelFromPeak(-1)).toBe(0)
    expect(levelFromPeak(Number.NaN)).toBe(0)
    expect(levelFromPeak(5)).toBe(1)
  })
  it('peakOf takes the largest magnitude, capped at 1', () => {
    expect(peakOf([0.1, -0.7, 0.3])).toBeCloseTo(0.7)
    expect(peakOf([])).toBe(0)
    expect(peakOf([3])).toBe(1)
  })
  it('holds the clip warning for a while after a single peak', () => {
    const hold = new ClipHold()
    expect(hold.push(0.5, 0)).toBe(false)
    expect(hold.push(0.995, 100)).toBe(true)
    expect(hold.push(0.1, 100 + CLIP_HOLD_MS - 1)).toBe(true)
    expect(hold.push(0.1, 100 + CLIP_HOLD_MS)).toBe(false)
  })
  it('a new peak extends the warning', () => {
    const hold = new ClipHold(1000)
    hold.push(1, 0)
    hold.push(1, 900)
    expect(hold.push(0, 1500)).toBe(true)
    expect(hold.push(0, 1900)).toBe(false)
  })
})
