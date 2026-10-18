import { encodeWav, toPcm16, WAV_RATE } from '../../shared/wav'

/**
 * 確認の声をマイクから録る（文字起こし用の 16kHz モノラル）。
 * 画面の CSP（script-src 'self'）では AudioWorklet を blob から読めないので、ScriptProcessorNode で受ける。
 * 声は画面の中だけに貯め、終えたときに WAV にして main へ1回で渡す。
 */
export interface MicCapture {
  /** マイクの最初の音が来た時刻（performance.now()）。まだなら undefined */
  firstSampleAt(): number | undefined
  /** 止めて WAV を返す（音が無ければ null） */
  stop(): Promise<Uint8Array | null>
}

export async function startMicCapture(deviceId?: string): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    video: false
  })
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const node = ctx.createScriptProcessor(4096, 1, 1)
  // 鳴らさずにグラフにつなぐ（つながないと onaudioprocess が来ない）
  const mute = ctx.createGain()
  mute.gain.value = 0
  const chunks: Int16Array[] = []
  let first: number | undefined
  node.onaudioprocess = (ev) => {
    if (first === undefined) first = performance.now() - (ev.inputBuffer.duration * 1000)
    chunks.push(toPcm16(ev.inputBuffer.getChannelData(0), ctx.sampleRate, WAV_RATE))
  }
  source.connect(node)
  node.connect(mute).connect(ctx.destination)
  return {
    firstSampleAt: () => first,
    stop: async () => {
      node.onaudioprocess = null
      source.disconnect()
      node.disconnect()
      mute.disconnect()
      stream.getTracks().forEach((tr) => tr.stop())
      await ctx.close().catch(() => undefined)
      return chunks.length ? encodeWav(chunks, WAV_RATE) : null
    }
  }
}
