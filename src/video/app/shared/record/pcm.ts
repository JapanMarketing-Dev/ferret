/**
 * 録画ウインドウの純粋な部品（Node の単体テストで確かめるためここに置く）。旧 Solocut の shared/pcm.ts から移した。
 */

/** MediaRecorder の形式。断片化 MP4（H.264）が使えればそれ、無ければ WebM（VP9） */
export function pickVideoMime(isSupported: (m: string) => boolean): { mime: string; ext: 'mp4' | 'webm' } {
  for (const m of ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.640028', 'video/mp4']) if (isSupported(m)) return { mime: m, ext: 'mp4' }
  for (const m of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']) if (isSupported(m)) return { mime: m, ext: 'webm' }
  return { mime: '', ext: 'webm' }
}

/** Float32 のチャンネルごとの並び → 交互に並べたリトルエンディアンの Int16 PCM。[-1, 1] に収める */
export function toInt16Interleaved(chs: Float32Array[]): Uint8Array {
  const n = chs[0]?.length ?? 0
  const c = chs.length
  const out = new DataView(new ArrayBuffer(n * c * 2))
  let o = 0
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < c; k++) {
      const v = Math.max(-1, Math.min(1, chs[k]![i] ?? 0))
      out.setInt16(o, v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff), true)
      o += 2
    }
  }
  return new Uint8Array(out.buffer)
}

/** 音割れとみなすピーク（0〜1） */
export const CLIP_PEAK = 0.99
/** 音割れの警告を出し続ける時間 */
export const CLIP_HOLD_MS = 1500

/** ピーク（0〜1）→ メーターの値（-60〜0 dB を 0〜1 に） */
export function levelFromPeak(peak: number): number {
  if (!Number.isFinite(peak) || peak <= 0) return 0
  const db = 20 * Math.log10(Math.max(peak, 1e-5))
  return Math.max(0, Math.min(1, (db + 60) / 60))
}

/** サンプルの並びの絶対値の最大 */
export function peakOf(samples: ArrayLike<number>): number {
  let peak = 0
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i] ?? 0)
    if (v > peak) peak = v
  }
  return Number.isFinite(peak) ? Math.min(peak, 1) : 0
}

/** 音割れの警告を少しのあいだ出し続ける（一瞬のピークでも見落とさない） */
export class ClipHold {
  private until = Number.NEGATIVE_INFINITY

  constructor(private readonly holdMs = CLIP_HOLD_MS) {}

  /** 今のピークを入れて、警告を出すかを返す */
  push(peak: number, nowMs: number): boolean {
    if (peak >= CLIP_PEAK) this.until = nowMs + this.holdMs
    return nowMs < this.until
  }
}
