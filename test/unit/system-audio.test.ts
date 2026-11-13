import { describe, expect, it } from 'vitest'
import { classifySystemAudioError, systemAudioFeatures, systemAudioUnsupported } from '../../src/shared/systemAudio'

describe('相手の声（PC の音声）の OS ごとの条件', () => {
  it('macOS は 14.2 から。それより前は試さずに案内する', () => {
    expect(systemAudioUnsupported('darwin', '14.2')).toBeNull()
    expect(systemAudioUnsupported('darwin', '14.2.1')).toBeNull()
    expect(systemAudioUnsupported('darwin', '15.0')).toBeNull()
    expect(systemAudioUnsupported('darwin', '26.1')).toBeNull()
    expect(systemAudioUnsupported('darwin', '14.1.2')).toBe('macosTooOld')
    expect(systemAudioUnsupported('darwin', '14')).toBe('macosTooOld')
    expect(systemAudioUnsupported('darwin', '13.6')).toBe('macosTooOld')
  })

  it('版が読めない・macOS 以外は止めない', () => {
    expect(systemAudioUnsupported('darwin', '')).toBeNull()
    expect(systemAudioUnsupported('win32', '10.0.19045')).toBeNull()
    expect(systemAudioUnsupported('linux', '6.8.0')).toBeNull()
  })

  it('Chromium のループバックの機能は macOS と Linux だけで足す', () => {
    expect(systemAudioFeatures('darwin')).toEqual(['MacCatapLoopbackAudioForScreenShare'])
    expect(systemAudioFeatures('linux')).toEqual(['PulseaudioLoopbackForScreenShare'])
    expect(systemAudioFeatures('win32')).toEqual([])
  })

  it('失敗を「許可が無い」「出力先が無い」「その他」に言い分ける', () => {
    expect(classifySystemAudioError('NotAllowedError')).toBe('denied')
    expect(classifySystemAudioError('SecurityError')).toBe('denied')
    expect(classifySystemAudioError('PermissionDeniedError')).toBe('denied')
    expect(classifySystemAudioError('NotFoundError')).toBe('noDevice')
    expect(classifySystemAudioError('DevicesNotFoundError')).toBe('noDevice')
    expect(classifySystemAudioError('OverconstrainedError')).toBe('noDevice')
    expect(classifySystemAudioError('NotReadableError')).toBe('failed')
    expect(classifySystemAudioError('AbortError')).toBe('failed')
    expect(classifySystemAudioError(undefined)).toBe('failed')
    // macOS は許可が無いと取り込みを始められない（Electron が断る・音声を開けない）。許可を案内する
    expect(classifySystemAudioError('AbortError', 'darwin')).toBe('denied')
    expect(classifySystemAudioError('NotReadableError', 'darwin')).toBe('denied')
    expect(classifySystemAudioError('AbortError', 'win32')).toBe('failed')
    expect(classifySystemAudioError('NotFoundError', 'darwin')).toBe('noDevice')
  })
})
