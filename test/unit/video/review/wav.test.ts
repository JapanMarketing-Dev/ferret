import { describe, expect, it } from 'vitest'
import { encodeWav, toPcm16, wavSamples, WAV_RATE } from '@video/app/shared/wav'

describe('toPcm16', () => {
  it('is empty for no input or a bad rate', () => {
    expect(toPcm16(new Float32Array(0), 48000)).toHaveLength(0)
    expect(toPcm16(new Float32Array(10), 0)).toHaveLength(0)
    expect(toPcm16(new Float32Array(10), Number.NaN)).toHaveLength(0)
  })
  it('downsamples 48 kHz to 16 kHz by averaging', () => {
    const out = toPcm16(new Float32Array([0.5, 0.5, 0.5, -0.5, -0.5, -0.5, 1, 1]), 48000)
    expect(Array.from(out)).toEqual([Math.round(0.5 * 0x7fff), Math.round(-0.5 * 0x8000)])
  })
  it('keeps 16 kHz as is and clips beyond -1..1', () => {
    expect(Array.from(toPcm16(new Float32Array([2, -2, 0]), 16000))).toEqual([0x7fff, -0x8000, 0])
  })
  it('turns NaN into silence', () => {
    expect(Array.from(toPcm16(new Float32Array([Number.NaN]), 16000))).toEqual([0])
  })
  it('keeps every sample for a lower input rate', () => {
    expect(toPcm16(new Float32Array(8000), 8000)).toHaveLength(8000)
  })
})

describe('encodeWav / wavSamples', () => {
  it('writes a valid 16-bit mono WAV that reads back', () => {
    const wav = encodeWav([new Int16Array([1, -1]), new Int16Array([32767])])
    expect(wav.length).toBe(44 + 6)
    expect(wavSamples(wav)).toEqual({ rate: WAV_RATE, samples: 3 })
    const v = new DataView(wav.buffer)
    expect(v.getInt16(44, true)).toBe(1)
    expect(v.getInt16(46, true)).toBe(-1)
    expect(v.getInt16(48, true)).toBe(32767)
  })
  it('writes an empty WAV for no chunks', () => {
    expect(wavSamples(encodeWav([]))).toEqual({ rate: WAV_RATE, samples: 0 })
  })
  it('rejects short, foreign or stereo data and a size past the end', () => {
    expect(wavSamples(new Uint8Array(10))).toBeNull()
    const png = new Uint8Array(64)
    png.set([0x89, 0x50, 0x4e, 0x47])
    expect(wavSamples(png)).toBeNull()
    const stereo = encodeWav([new Int16Array(4)])
    new DataView(stereo.buffer).setUint16(22, 2, true)
    expect(wavSamples(stereo)).toBeNull()
    const lying = encodeWav([new Int16Array(2)])
    new DataView(lying.buffer).setUint32(40, 1000, true)
    expect(wavSamples(lying)).toBeNull()
  })
  it('reads a view into a larger buffer', () => {
    const wav = encodeWav([new Int16Array([5])])
    const big = new Uint8Array(wav.length + 10)
    big.set(wav, 10)
    expect(wavSamples(big.subarray(10))).toEqual({ rate: WAV_RATE, samples: 1 })
  })
})
