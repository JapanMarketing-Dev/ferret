/**
 * 動画の撮影の AudioWorklet。マイク・PC の音声の生の PCM（48kHz・圧縮もブラウザの補正もしない）を録画ウインドウへ渡す。
 * 最初に { first: true, t: currentTime } を1回、そのあと約 2048 フレームごとに { data: Float32Array[] }（チャンネルごと）と
 * { peak }（メーター用）を送る。旧 Solocut の lib/pcm-worklet.js から移した。
 */
const BATCH = 2048

class FerretVideoPcmTap extends AudioWorkletProcessor {
  constructor() {
    super()
    this.buf = null
    this.n = 0
    this.started = false
    this.peak = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || input.length === 0) return true
    const ch = input.length
    const len = input[0].length
    if (!this.buf) {
      this.buf = Array.from({ length: ch }, () => new Float32Array(BATCH + 128))
      this.n = 0
    }
    for (let c = 0; c < ch && c < this.buf.length; c++) {
      const src = input[c]
      this.buf[c].set(src, this.n)
      for (let i = 0; i < src.length; i++) {
        const v = src[i] < 0 ? -src[i] : src[i]
        if (v > this.peak) this.peak = v
      }
    }
    this.n += len
    if (!this.started) {
      this.started = true
      this.port.postMessage({ first: true, t: currentTime })
    }
    if (this.n >= BATCH) {
      const out = this.buf.map((b) => b.slice(0, this.n))
      this.port.postMessage({ data: out, peak: this.peak }, out.map((b) => b.buffer))
      this.buf = null
      this.peak = 0
    }
    return true
  }
}

registerProcessor('ferret-video-pcm', FerretVideoPcmTap)
