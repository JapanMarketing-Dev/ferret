/**
 * 落ちても再生できるように少しずつ書く WAV の見出し。最初に今までの長さで見出しを書き、追記のたびに長さの2か所を書き直す。
 * 旧 Solocut の main/services/wav.ts から移した。
 */

export const WAV_HEADER_BYTES = 44

export function wavHeader(o: { sampleRate: number; channels: number; bitsPerSample: 16 | 32; float?: boolean; dataBytes: number }): Buffer {
  const b = Buffer.alloc(WAV_HEADER_BYTES)
  const blockAlign = (o.channels * o.bitsPerSample) / 8
  b.write('RIFF', 0, 'ascii')
  b.writeUInt32LE(Math.min(0xffffffff, 36 + o.dataBytes), 4)
  b.write('WAVE', 8, 'ascii')
  b.write('fmt ', 12, 'ascii')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(o.float ? 3 : 1, 20)
  b.writeUInt16LE(o.channels, 22)
  b.writeUInt32LE(o.sampleRate, 24)
  b.writeUInt32LE(o.sampleRate * blockAlign, 28)
  b.writeUInt16LE(blockAlign, 32)
  b.writeUInt16LE(o.bitsPerSample, 34)
  b.write('data', 36, 'ascii')
  b.writeUInt32LE(Math.min(0xffffffff, o.dataBytes), 40)
  return b
}

/** 追記のあとに書き直す2つの長さ: [位置, 値][] */
export function wavSizePatches(dataBytes: number): [number, number][] {
  return [
    [4, Math.min(0xffffffff, 36 + dataBytes)],
    [40, Math.min(0xffffffff, dataBytes)]
  ]
}
