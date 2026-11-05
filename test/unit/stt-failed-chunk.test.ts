import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { IncrementalTranscriber, failedChunkSegment, type SttEngine, type TranscribeChunkInput } from '../../src/main/pipeline/stt/engine'
import { writeWavFile } from '../../src/main/pipeline/stt/wav'
import { buildDraftDocument } from '../../src/main/pipeline/decompose'
import type { Material, TranscriptSegment } from '../../src/main/pipeline/types'
import { setLocale } from '@shared/i18n'

// 文言を確かめるので日本語に固定する
setLocale('ja')

let dir = ''
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-stt-failed-')) })
afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

function engine(transcribe: SttEngine['transcribeChunk']): SttEngine {
  return { id: 'fake', sendsAudioOffDevice: false, available: async () => true, transcribeChunk: transcribe }
}
const chunk = (offsetMs: number, extra: Partial<TranscribeChunkInput> = {}): TranscribeChunkInput =>
  ({ wavPath: join(dir, 'missing.wav'), offsetMs, speaker: 'self', source: 'mic', ...extra })

describe('文字起こしに失敗した区切りを黙って捨てない', () => {
  it('失敗した区切りは「文字起こしできなかった発話」の区間として残り、失敗の理由も返る', async () => {
    const stt = new IncrementalTranscriber(engine(async () => { throw new Error('whisper がタイムアウトしました') }))
    stt.push(chunk(65_000, { durationMs: 12_000 }))
    const r = await stt.flush()
    expect(r.errors.map((e) => e.message)).toEqual(['whisper がタイムアウトしました'])
    expect(r.segments).toEqual([{ t0: 65_000, t1: 77_000, speaker: 'self', source: 'mic', sttFailed: true,
      text: '（01:05〜01:17 の発話は文字起こしできませんでした。動画のこの区間で確かめてください）' }])
  })

  it('長さを渡されなければ WAV の長さから区間を作る', async () => {
    const wavPath = join(dir, 'two-seconds.wav')
    await writeWavFile(wavPath, new Int16Array(32_000), 16_000)
    const seg = await failedChunkSegment(chunk(1_000, { wavPath }))
    expect([seg.t0, seg.t1]).toEqual([1_000, 3_000])
  })

  it('WAV が読めない・壊れていても、始まりの時刻だけの区間で残す', async () => {
    const broken = join(dir, 'broken.wav')
    await writeFile(broken, 'not a wav')
    expect(await failedChunkSegment(chunk(4_000, { wavPath: broken }))).toMatchObject({ t0: 4_000, t1: 4_000, sttFailed: true })
    expect(await failedChunkSegment(chunk(5_000))).toMatchObject({ t0: 5_000, t1: 5_000 })
  })

  it('長さが壊れた値（NaN・負）でも区間を逆さにしない', async () => {
    expect(await failedChunkSegment(chunk(2_000, { durationMs: Number.NaN }))).toMatchObject({ t0: 2_000, t1: 2_000 })
    expect(await failedChunkSegment(chunk(2_000, { durationMs: -500 }))).toMatchObject({ t0: 2_000, t1: 2_000 })
  })

  it('相手の声（PC音声）の失敗は相手の区間として残す', async () => {
    const seg = await failedChunkSegment(chunk(0, { speaker: 'other', source: 'system', durationMs: 1_000 }))
    expect(seg).toMatchObject({ speaker: 'other', source: 'system' })
  })

  it('成功した区切りと失敗した区切りが混ざっても、時刻順にすべて残る', async () => {
    let n = 0
    const stt = new IncrementalTranscriber(engine(async (input) => {
      n++
      if (n === 2) throw new Error('429 Too Many Requests')
      return { segments: [{ t0: input.offsetMs, t1: input.offsetMs + 1_000, speaker: 'self', text: `発話${n}`, source: 'mic' }], elapsedMs: 1, commandLine: '' }
    }))
    stt.push(chunk(0, { durationMs: 1_000 }))
    stt.push(chunk(10_000, { durationMs: 1_000 }))
    stt.push(chunk(20_000, { durationMs: 1_000 }))
    const r = await stt.flush()
    expect(r.segments.map((s) => [s.t0, s.sttFailed === true])).toEqual([[0, false], [10_000, true], [20_000, false]])
    expect(r.errors).toHaveLength(1)
  })

  it('復元用の書き残し（transcript.jsonl）にも残す。書き残しに失敗しても続ける', async () => {
    const written: TranscriptSegment[][] = []
    const stt = new IncrementalTranscriber(engine(async () => { throw new Error('落ちた') }), async (segments) => {
      written.push(segments)
      throw new Error('ディスクがいっぱい')
    })
    stt.push(chunk(3_000, { durationMs: 2_000 }))
    const r = await stt.flush()
    expect(written).toHaveLength(1)
    expect(written[0]![0]).toMatchObject({ t0: 3_000, sttFailed: true })
    expect(r.segments).toHaveLength(1)
  })

  it('文字起こしは済んで書き残しだけ失敗したときは、代わりの区間を重ねない', async () => {
    const stt = new IncrementalTranscriber(engine(async (input) => ({
      segments: [{ t0: input.offsetMs, t1: input.offsetMs + 500, speaker: 'self', text: 'ボタンを赤に', source: 'mic' }], elapsedMs: 1, commandLine: ''
    })), async () => { throw new Error('ディスクがいっぱい') })
    stt.push(chunk(0, { durationMs: 500 }))
    const r = await stt.flush()
    expect(r.segments.map((s) => s.text)).toEqual(['ボタンを赤に'])
    expect(r.errors).toHaveLength(1)
  })

  it('進み具合の表示が投げても、失敗の区間は残る', async () => {
    const onProgress = vi.fn(() => { throw new Error('表示の失敗') })
    const stt = new IncrementalTranscriber(engine(async () => { throw new Error('落ちた') }), undefined, onProgress)
    stt.push(chunk(0, { durationMs: 100 }))
    expect((await stt.flush()).segments).toHaveLength(1)
  })
})

describe('文字起こしに失敗した区間の指摘', () => {
  const meta = { id: 's', startedAt: '2026-11-05T00:00:00.000Z', durationMs: 120_000, twoSpeakers: false }
  const failed = (t0: number, t1: number): TranscriptSegment => ({ t0, t1, speaker: 'self', source: 'mic', text: '（失敗の案内）', sttFailed: true })
  const spoken = (t0: number, text: string): TranscriptSegment => ({ t0, t1: t0 + 1_500, speaker: 'self', source: 'mic', text })

  it('失敗した区間だけの指摘は一覧に出し、要確認にして送る対象から外す', () => {
    const material: Material = { meta, transcript: [failed(10_000, 20_000)], events: [], frames: [] }
    const { document } = buildDraftDocument(material)
    expect(document.items).toHaveLength(1)
    expect(document.items[0]).toMatchObject({ status: 'needs_check', include: false })
    expect(document.items[0]!.quotes[0]!.t).toBe(10_000)
  })

  it('聞き取れた発話と同じまとまりなら、ふつうの指摘として送る', () => {
    const material: Material = { meta, transcript: [spoken(10_000, 'ここの余白を広げて'), failed(12_000, 15_000)], events: [], frames: [] }
    const { document } = buildDraftDocument(material)
    expect(document.items).toHaveLength(1)
    expect(document.items[0]).toMatchObject({ status: 'decided', include: true })
  })

  it('書き込み（ペン）があれば、その印の指摘として送る', () => {
    const pen = { type: 'pen' as const, t: 10_500, id: 'p1', shape: 'rect' as const, bbox: { x: 0, y: 0, w: 10, h: 10 } }
    const material: Material = { meta, transcript: [failed(10_000, 12_000)], events: [pen as unknown as Material['events'][number]], frames: [] }
    const { document } = buildDraftDocument(material)
    const item = document.items.find((it) => it.annotationIds.includes('p1'))!
    expect(item).toMatchObject({ status: 'decided', include: true })
  })
})
