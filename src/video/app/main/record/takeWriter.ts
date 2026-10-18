import { closeSync, constants, existsSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { isTrackFile, newTakeId, type TakeMeta } from '../../shared/record/take'
import type { RecorderOpenTrack } from '../../shared/record/types'
import { WAV_HEADER_BYTES, wavHeader, wavSizePatches } from './wav'

/**
 * テイクのフォルダ（<動画のフォルダ>/media/takes/<take-id>/）へ、届いた塊を順に書く（docs/03）。
 * 塊は1秒ごとに届き、すぐ追記する。WAV は追記のたびに見出しの長さを直すので、途中で落ちてもそこまで再生できる。
 * take.json は一時ファイルに書いてから置き換える。旧 Solocut の main/services/recorder.ts から移した。
 */

interface Track {
  fd: number
  /** 中身のバイト数（WAV の見出しを除く） */
  bytes: number
  wav: boolean
}

interface Take {
  dir: string
  tracks: Map<string, Track>
}

const nofollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0

export class TakeWriter {
  private readonly takes = new Map<string, Take>()

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** 新しいテイクのフォルダを作る。同じ秒に2つ目なら -2, -3 … を付ける */
  beginTake(videoDir: string): { takeId: string; takeDir: string } {
    const base = newTakeId(this.now())
    let takeId = base
    let dir = join(videoDir, 'media', 'takes', takeId)
    for (let i = 2; existsSync(dir) || this.takes.has(takeId); i++) {
      if (i > 999) throw new Error('too many takes in one second')
      takeId = `${base}-${i}`
      dir = join(videoDir, 'media', 'takes', takeId)
    }
    mkdirSync(dir, { recursive: true })
    this.takes.set(takeId, { dir, tracks: new Map() })
    return { takeId, takeDir: dir }
  }

  takeDir(takeId: string): string {
    return this.take(takeId).dir
  }

  isOpen(takeId: string, file: string): boolean {
    return this.takes.get(takeId)?.tracks.has(file) ?? false
  }

  private take(id: string): Take {
    const t = this.takes.get(id)
    if (!t) throw new Error(`unknown take ${id}`)
    return t
  }

  /** トラックのファイルを作る。名前は決まった形だけ。既にある名前・シンボリックリンクには書かない */
  openTrack(takeId: string, o: RecorderOpenTrack): void {
    const t = this.take(takeId)
    if (!isTrackFile(o.file)) throw new Error(`bad track file name: ${String(o.file)}`)
    if (t.tracks.has(o.file)) throw new Error(`track already open: ${o.file}`)
    const wav = o.file.endsWith('.wav')
    const fd = openSync(join(t.dir, o.file), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | nofollow, 0o644)
    try {
      if (wav) {
        const sampleRate = o.wav && Number.isInteger(o.wav.sampleRate) && o.wav.sampleRate >= 8000 && o.wav.sampleRate <= 192000 ? o.wav.sampleRate : 48000
        const channels = o.wav && (o.wav.channels === 1 || o.wav.channels === 2) ? o.wav.channels : 1
        writeSync(fd, wavHeader({ sampleRate, channels, bitsPerSample: 16, dataBytes: 0 }), 0, WAV_HEADER_BYTES, 0)
      }
    } catch (err) {
      closeSync(fd)
      throw err
    }
    t.tracks.set(o.file, { fd, bytes: 0, wav })
  }

  /** 追記して、そのトラックの今までのバイト数を返す */
  appendTrack(takeId: string, file: string, data: Uint8Array): number {
    const tr = this.take(takeId).tracks.get(file)
    if (!tr) throw new Error(`track not open: ${file}`)
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const pos = (tr.wav ? WAV_HEADER_BYTES : 0) + tr.bytes
    let off = 0
    while (off < buf.length) off += writeSync(tr.fd, buf, off, buf.length - off, pos + off)
    tr.bytes += buf.length
    if (tr.wav) {
      const b = Buffer.alloc(4)
      for (const [at, v] of wavSizePatches(tr.bytes)) {
        b.writeUInt32LE(v, 0)
        writeSync(tr.fd, b, 0, 4, at)
      }
    }
    return tr.bytes
  }

  closeTrack(takeId: string, file: string): number {
    const t = this.takes.get(takeId)
    const tr = t?.tracks.get(file)
    if (!t || !tr) return 0
    try {
      fsyncSync(tr.fd)
    } catch {
      // できるときだけ
    }
    try {
      closeSync(tr.fd)
    } finally {
      t.tracks.delete(file)
    }
    return tr.bytes
  }

  writeMeta(takeId: string, meta: TakeMeta): void {
    const p = join(this.take(takeId).dir, 'take.json')
    writeFileSync(`${p}.tmp`, JSON.stringify(meta, null, 2) + '\n')
    renameSync(`${p}.tmp`, p)
  }

  endTake(takeId: string): void {
    const t = this.takes.get(takeId)
    if (!t) return
    for (const file of [...t.tracks.keys()]) {
      try {
        this.closeTrack(takeId, file)
      } catch {
        // 閉じられないものがあっても残りは閉じる
      }
    }
    this.takes.delete(takeId)
  }

  get activeTakes(): number {
    return this.takes.size
  }

  endAll(): void {
    for (const id of [...this.takes.keys()]) this.endTake(id)
  }
}
