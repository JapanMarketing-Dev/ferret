import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WAV_HEADER_BYTES, wavHeader, wavSizePatches } from '../../../../src/video/app/main/record/wav'
import { TakeWriter } from '../../../../src/video/app/main/record/takeWriter'
import { createTakeMeta } from '../../../../src/video/app/shared/record/take'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ferret-video-take-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** WAV の見出しを読む */
function readWav(path: string) {
  const b = readFileSync(path)
  return {
    riff: b.toString('ascii', 0, 4),
    riffSize: b.readUInt32LE(4),
    wave: b.toString('ascii', 8, 12),
    fmt: b.toString('ascii', 12, 16),
    format: b.readUInt16LE(20),
    channels: b.readUInt16LE(22),
    sampleRate: b.readUInt32LE(24),
    byteRate: b.readUInt32LE(28),
    blockAlign: b.readUInt16LE(32),
    bits: b.readUInt16LE(34),
    data: b.toString('ascii', 36, 40),
    dataSize: b.readUInt32LE(40),
    length: b.length
  }
}

describe('wavHeader', () => {
  it('writes a 44-byte PCM header', () => {
    const h = wavHeader({ sampleRate: 48000, channels: 2, bitsPerSample: 16, dataBytes: 1000 })
    expect(h.length).toBe(WAV_HEADER_BYTES)
    expect(h.toString('ascii', 0, 4)).toBe('RIFF')
    expect(h.readUInt32LE(4)).toBe(1036)
    expect(h.toString('ascii', 8, 16)).toBe('WAVEfmt ')
    expect(h.readUInt32LE(16)).toBe(16)
    expect(h.readUInt16LE(20)).toBe(1)
    expect(h.readUInt16LE(22)).toBe(2)
    expect(h.readUInt32LE(24)).toBe(48000)
    expect(h.readUInt32LE(28)).toBe(192000)
    expect(h.readUInt16LE(32)).toBe(4)
    expect(h.readUInt16LE(34)).toBe(16)
    expect(h.toString('ascii', 36, 40)).toBe('data')
    expect(h.readUInt32LE(40)).toBe(1000)
  })
  it('float format is 3', () => {
    expect(wavHeader({ sampleRate: 48000, channels: 1, bitsPerSample: 32, float: true, dataBytes: 0 }).readUInt16LE(20)).toBe(3)
  })
  it('clamps sizes past 4 GiB instead of overflowing', () => {
    const h = wavHeader({ sampleRate: 48000, channels: 1, bitsPerSample: 16, dataBytes: 2 ** 33 })
    expect(h.readUInt32LE(4)).toBe(0xffffffff)
    expect(h.readUInt32LE(40)).toBe(0xffffffff)
    expect(wavSizePatches(2 ** 33)).toEqual([[4, 0xffffffff], [40, 0xffffffff]])
  })
  it('patches are RIFF = 36 + data and data', () => {
    expect(wavSizePatches(0)).toEqual([[4, 36], [40, 0]])
    expect(wavSizePatches(10)).toEqual([[4, 46], [40, 10]])
  })
})

describe('TakeWriter', () => {
  const at = new Date(2026, 9, 18, 10, 15, 0)

  it('creates media/takes/<take-id>/ and numbers takes in the same second', () => {
    const w = new TakeWriter(() => at)
    const a = w.beginTake(dir)
    const b = w.beginTake(dir)
    expect(a.takeId).toBe('take_20261018-101500')
    expect(b.takeId).toBe('take_20261018-101500-2')
    expect(a.takeDir).toBe(join(dir, 'media', 'takes', 'take_20261018-101500'))
    expect(existsSync(a.takeDir) && existsSync(b.takeDir)).toBe(true)
    expect(w.activeTakes).toBe(2)
  })

  it('skips a folder left by an earlier run', () => {
    mkdirSync(join(dir, 'media', 'takes', 'take_20261018-101500'), { recursive: true })
    expect(new TakeWriter(() => at).beginTake(dir).takeId).toBe('take_20261018-101500-2')
  })

  it('appends video chunks in order and returns the running size', () => {
    const w = new TakeWriter(() => at)
    const { takeId, takeDir } = w.beginTake(dir)
    w.openTrack(takeId, { file: 'screen.webm', kind: 'screen' })
    expect(w.isOpen(takeId, 'screen.webm')).toBe(true)
    expect(w.appendTrack(takeId, 'screen.webm', new Uint8Array([1, 2, 3]))).toBe(3)
    expect(w.appendTrack(takeId, 'screen.webm', new Uint8Array([4, 5]))).toBe(5)
    // 途中（閉じる前）でも書いた分は読める（落ちても残る）
    expect([...readFileSync(join(takeDir, 'screen.webm'))]).toEqual([1, 2, 3, 4, 5])
    expect(w.closeTrack(takeId, 'screen.webm')).toBe(5)
    expect(w.isOpen(takeId, 'screen.webm')).toBe(false)
  })

  it('appends a view into a larger buffer correctly', () => {
    const w = new TakeWriter(() => at)
    const { takeId, takeDir } = w.beginTake(dir)
    w.openTrack(takeId, { file: 'camera-1.mp4', kind: 'camera' })
    const big = new Uint8Array([9, 9, 7, 8, 9, 9])
    w.appendTrack(takeId, 'camera-1.mp4', big.subarray(2, 4))
    w.endTake(takeId)
    expect([...readFileSync(join(takeDir, 'camera-1.mp4'))]).toEqual([7, 8])
  })

  it('keeps the WAV header valid after every append (playable mid-take)', () => {
    const w = new TakeWriter(() => at)
    const { takeId, takeDir } = w.beginTake(dir)
    w.openTrack(takeId, { file: 'mic-1.wav', kind: 'mic', wav: { sampleRate: 48000, channels: 1 } })
    const path = join(takeDir, 'mic-1.wav')
    expect(readWav(path)).toMatchObject({ riff: 'RIFF', wave: 'WAVE', fmt: 'fmt ', data: 'data', dataSize: 0, riffSize: 36, length: 44, sampleRate: 48000, channels: 1, bits: 16 })
    w.appendTrack(takeId, 'mic-1.wav', new Uint8Array(960))
    expect(readWav(path)).toMatchObject({ dataSize: 960, riffSize: 996, length: 44 + 960 })
    w.appendTrack(takeId, 'mic-1.wav', new Uint8Array(40))
    expect(readWav(path)).toMatchObject({ dataSize: 1000, riffSize: 1036, length: 1044 })
    w.endTake(takeId)
  })

  it('stereo system audio header', () => {
    const w = new TakeWriter(() => at)
    const { takeId, takeDir } = w.beginTake(dir)
    w.openTrack(takeId, { file: 'system.wav', kind: 'system', wav: { sampleRate: 44100, channels: 2 } })
    w.endTake(takeId)
    expect(readWav(join(takeDir, 'system.wav'))).toMatchObject({ sampleRate: 44100, channels: 2, blockAlign: 4, byteRate: 176400 })
  })

  it('falls back to 48 kHz mono for bad WAV parameters', () => {
    const w = new TakeWriter(() => at)
    const { takeId, takeDir } = w.beginTake(dir)
    w.openTrack(takeId, { file: 'mic-1.wav', kind: 'mic', wav: { sampleRate: 7, channels: 6 } })
    w.openTrack(takeId, { file: 'mic-2.wav', kind: 'mic' })
    w.endTake(takeId)
    expect(readWav(join(takeDir, 'mic-1.wav'))).toMatchObject({ sampleRate: 48000, channels: 1 })
    expect(readWav(join(takeDir, 'mic-2.wav'))).toMatchObject({ sampleRate: 48000, channels: 1 })
  })

  it.each(['../evil.wav', 'take.json', 'screen.mov', 'mic.wav', '/abs/screen.mp4', 'a\\screen.mp4'])('refuses the file name %s', (file) => {
    const w = new TakeWriter(() => at)
    const { takeId } = w.beginTake(dir)
    expect(() => w.openTrack(takeId, { file, kind: 'mic' })).toThrow(/bad track file name/)
  })

  it('refuses to open the same track twice', () => {
    const w = new TakeWriter(() => at)
    const { takeId } = w.beginTake(dir)
    w.openTrack(takeId, { file: 'mic-1.wav', kind: 'mic' })
    expect(() => w.openTrack(takeId, { file: 'mic-1.wav', kind: 'mic' })).toThrow(/already open/)
  })

  it('never overwrites an existing file or follows a symlink', () => {
    const w = new TakeWriter(() => at)
    const { takeId, takeDir } = w.beginTake(dir)
    writeFileSync(join(takeDir, 'screen.mp4'), 'keep me')
    expect(() => w.openTrack(takeId, { file: 'screen.mp4', kind: 'screen' })).toThrow()
    expect(readFileSync(join(takeDir, 'screen.mp4'), 'utf8')).toBe('keep me')
    const outside = join(dir, 'outside.txt')
    writeFileSync(outside, 'secret')
    symlinkSync(outside, join(takeDir, 'mic-1.wav'))
    expect(() => w.openTrack(takeId, { file: 'mic-1.wav', kind: 'mic' })).toThrow()
    expect(readFileSync(outside, 'utf8')).toBe('secret')
  })

  it('errors for unknown takes and tracks that are not open', () => {
    const w = new TakeWriter(() => at)
    expect(() => w.openTrack('take_nope', { file: 'mic-1.wav', kind: 'mic' })).toThrow(/unknown take/)
    const { takeId } = w.beginTake(dir)
    expect(() => w.appendTrack(takeId, 'mic-1.wav', new Uint8Array(2))).toThrow(/not open/)
    expect(w.closeTrack(takeId, 'mic-1.wav')).toBe(0)
    expect(w.closeTrack('take_nope', 'mic-1.wav')).toBe(0)
  })

  it('writes take.json atomically (no .tmp left) and overwrites it', () => {
    const w = new TakeWriter(() => at)
    const { takeId, takeDir } = w.beginTake(dir)
    const meta = createTakeMeta({ id: takeId, createdAt: at.toISOString(), timeOrigin: 1, startedAtMs: 2, app: { version: 'x', os: 'darwin' } })
    w.writeMeta(takeId, meta)
    w.writeMeta(takeId, { ...meta, complete: true })
    expect(JSON.parse(readFileSync(join(takeDir, 'take.json'), 'utf8'))).toMatchObject({ id: takeId, complete: true })
    expect(readdirSync(takeDir)).toEqual(['take.json'])
  })

  it('writing take.json fails loudly when the folder was removed', () => {
    const w = new TakeWriter(() => at)
    const { takeId, takeDir } = w.beginTake(dir)
    rmSync(takeDir, { recursive: true })
    expect(() => w.writeMeta(takeId, createTakeMeta({ id: takeId, createdAt: '', timeOrigin: 0, startedAtMs: 0, app: { version: '', os: '' } }))).toThrow()
  })

  it('endTake closes every track and forgets the take; a second end is harmless', () => {
    const w = new TakeWriter(() => at)
    const { takeId } = w.beginTake(dir)
    w.openTrack(takeId, { file: 'mic-1.wav', kind: 'mic' })
    w.openTrack(takeId, { file: 'camera-1.webm', kind: 'camera' })
    w.endTake(takeId)
    expect(w.activeTakes).toBe(0)
    expect(() => w.endTake(takeId)).not.toThrow()
    expect(() => w.appendTrack(takeId, 'mic-1.wav', new Uint8Array(2))).toThrow(/unknown take/)
  })

  it('endAll closes everything (app quit)', () => {
    const w = new TakeWriter(() => at)
    w.beginTake(dir)
    w.beginTake(dir)
    w.endAll()
    expect(w.activeTakes).toBe(0)
  })
})
