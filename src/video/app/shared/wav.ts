/**
 * 確認のマイクの音声を、文字起こし（whisper）が読む 16kHz モノラル 16bit の WAV にする純粋な処理。
 * renderer がマイクの Float32 を受けて使い、main は受け取った WAV の頭を確かめる。
 */

export const WAV_RATE = 16000

/** Float32（-1..1）の音を、間引き（区間の平均）で 16kHz の Int16 にする */
export function toPcm16(input: Float32Array, inputRate: number, outRate = WAV_RATE): Int16Array {
  if (!(inputRate > 0) || input.length === 0) return new Int16Array(0)
  const ratio = inputRate / outRate
  const n = ratio <= 1 ? input.length : Math.floor(input.length / ratio)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) {
    let v: number
    if (ratio <= 1) v = input[i]!
    else {
      const a = Math.floor(i * ratio)
      const b = Math.min(input.length, Math.floor((i + 1) * ratio))
      let sum = 0
      for (let k = a; k < b; k++) sum += input[k]!
      v = b > a ? sum / (b - a) : 0
    }
    const c = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0
    out[i] = c < 0 ? Math.round(c * 0x8000) : Math.round(c * 0x7fff)
  }
  return out
}

/** Int16 のかたまりをつないで WAV（RIFF・PCM・モノラル）にする */
export function encodeWav(chunks: readonly Int16Array[], rate = WAV_RATE): Uint8Array {
  const samples = chunks.reduce((n, c) => n + c.length, 0)
  const buf = new ArrayBuffer(44 + samples * 2)
  const v = new DataView(buf)
  const ascii = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + samples * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true)
  v.setUint16(22, 1, true)
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, samples * 2, true)
  let off = 44
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++, off += 2) v.setInt16(off, c[i]!, true)
  }
  return new Uint8Array(buf)
}

/** WAV（PCM 16bit モノラル）の頭か。サンプル数を返す（違えば null） */
export function wavSamples(bytes: Uint8Array): { rate: number; samples: number } | null {
  if (bytes.length < 44) return null
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (off: number) => String.fromCharCode(bytes[off]!, bytes[off + 1]!, bytes[off + 2]!, bytes[off + 3]!)
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data') return null
  if (v.getUint16(20, true) !== 1 || v.getUint16(22, true) !== 1 || v.getUint16(34, true) !== 16) return null
  const rate = v.getUint32(24, true)
  const size = v.getUint32(40, true)
  if (rate <= 0 || size > bytes.length - 44) return null
  return { rate, samples: Math.floor(size / 2) }
}
