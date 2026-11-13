import { describe, expect, it } from 'vitest'
import { defaultMicKey, micRecoveryAction, silencePadSamples, type MicDeviceLike } from '../../src/shared/micRecovery'

const builtIn: MicDeviceLike[] = [
  { deviceId: 'default', label: 'Default - MacBook Pro Microphone', groupId: 'g-mac' },
  { deviceId: 'mac', label: 'MacBook Pro Microphone', groupId: 'g-mac' }
]
const withAirPods: MicDeviceLike[] = [
  { deviceId: 'default', label: 'Default - AirPods Pro', groupId: 'g-pods' },
  { deviceId: 'mac', label: 'MacBook Pro Microphone', groupId: 'g-mac' },
  { deviceId: 'pods', label: 'AirPods Pro', groupId: 'g-pods' }
]
const live = (requested: string, devices: MicDeviceLike[]) => ({ requested, defaultKey: requested === '' ? defaultMicKey(devices) : null, live: true })

describe('既定のマイクの印', () => {
  it("'default' の項目のグループと名前", () => {
    expect(defaultMicKey(builtIn)).toBe('g-mac|Default - MacBook Pro Microphone')
  })
  it("'default' が無ければ最初のマイク（communications は除く）", () => {
    expect(defaultMicKey([{ deviceId: 'communications', label: 'Comm' }, { deviceId: 'a', label: 'A' }])).toBe('|A')
  })
  it('マイクが無ければ null', () => {
    expect(defaultMicKey([])).toBeNull()
  })
})

describe('録画中のマイクの付け替え', () => {
  it('何も変わらなければそのまま', () => {
    expect(micRecoveryAction('', live('', builtIn), builtIn)).toEqual({ kind: 'keep' })
    expect(micRecoveryAction('mac', live('mac', builtIn), builtIn)).toEqual({ kind: 'keep' })
  })

  it('OS の既定が別のマイクに変わったら（AirPods をつないだ）、既定を開き直す', () => {
    expect(micRecoveryAction('', live('', builtIn), withAirPods)).toEqual({ kind: 'open', deviceId: '' })
  })

  it('選んだマイクを使っている間は、既定が変わっても切り替えない', () => {
    expect(micRecoveryAction('mac', live('mac', builtIn), withAirPods)).toEqual({ kind: 'keep' })
  })

  it('取り込みが終わった（ended）ら開き直す', () => {
    expect(micRecoveryAction('', { ...live('', builtIn), live: false }, builtIn)).toEqual({ kind: 'open', deviceId: '' })
  })

  it('選んだマイクが抜かれたら既定へ切り替え、戻ってきたら選んだものへ戻す', () => {
    const gone = builtIn
    expect(micRecoveryAction('pods', { requested: 'pods', defaultKey: null, live: false }, gone)).toEqual({ kind: 'open', deviceId: '' })
    expect(micRecoveryAction('pods', live('', gone), withAirPods)).toEqual({ kind: 'open', deviceId: 'pods' })
  })

  it("選んだ値が 'default' なら OS の既定と同じに扱う", () => {
    expect(micRecoveryAction('default', live('', builtIn), builtIn)).toEqual({ kind: 'keep' })
    expect(micRecoveryAction('default', null, builtIn)).toEqual({ kind: 'open', deviceId: '' })
  })

  it('開けていなければ開く（録画開始時にマイクが無く、あとからつながった）', () => {
    expect(micRecoveryAction('', null, builtIn)).toEqual({ kind: 'open', deviceId: '' })
  })

  it('マイクが1つも無い間は待つ（映像だけ録り続ける）。開いていて生きていればそのまま', () => {
    expect(micRecoveryAction('', null, [])).toEqual({ kind: 'wait' })
    expect(micRecoveryAction('', { ...live('', builtIn), live: false }, [])).toEqual({ kind: 'wait' })
    expect(micRecoveryAction('', live('', builtIn), [])).toEqual({ kind: 'keep' })
  })

  it('ID が空の項目（許可の前の一覧）は数えない', () => {
    expect(micRecoveryAction('', null, [{ deviceId: '', label: '' }])).toEqual({ kind: 'wait' })
  })
})

describe('付け替えの途切れを埋める無音', () => {
  it('途切れた分だけ埋める', () => {
    // 10秒たって、送ったのは 8 秒分 → 2 秒分
    expect(silencePadSamples(10_000, 0, 8 * 16_000, 16_000)).toBe(2 * 16_000)
  })
  it('この系統が録り始めた時刻を差し引く', () => {
    expect(silencePadSamples(10_000, 4_000, 5 * 16_000, 16_000)).toBe(16_000)
  })
  it('送った分が多ければ埋めない（負にしない）', () => {
    expect(silencePadSamples(1_000, 0, 32_000, 16_000)).toBe(0)
  })
  it('壊れた値・0 の標本化周波数なら埋めない', () => {
    expect(silencePadSamples(Number.NaN, 0, 0, 16_000)).toBe(0)
    expect(silencePadSamples(1_000, 0, 0, 0)).toBe(0)
  })
  it('1時間を超える埋めは上限で切る', () => {
    expect(silencePadSamples(10 * 3600_000, 0, 0, 16_000)).toBe(16_000 * 3600)
  })
})
