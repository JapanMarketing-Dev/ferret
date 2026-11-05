import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-live-transcript-unit' } }))

import {
  IDLE_LIVE_STATUS, LIVE_BATCH_MAX, LIVE_SEGMENT_MAX_TEXT, SpeechStallWatch, addLiveSegments, formatLiveTime,
  liveStatusLine, liveTranscriptProblem, sanitizeLiveBatch, sanitizeLiveSegment, sanitizeLiveStatus,
  type LiveTranscriptBatch, type LiveTranscriptStatus
} from '@shared/liveTranscript'
import { SETTINGS_SCHEMA } from '@shared/settingsSchema'
import { IncrementalTranscriber, type SttEngine, type TranscriberProgress } from '../../src/main/pipeline/stt/engine'
import { LiveTranscriptFeed } from '../../src/main/pipeline/stt/liveFeed'
import { sanitize } from '../../src/main/settings'

/**
 * 録画中の文字起こしの途中経過（右パネルの「文字起こし」タブ）。
 * 届いた値の確かめ・並べ方・止まったときの見張り・main の状態の作り方・逐次実行の進み具合を確かめる。
 */

const seg = (t0: number, text: string, source: 'mic' | 'system' = 'mic') => ({ t0, t1: t0 + 1000, text, source })

describe('届いた値を確かめる', () => {
  it('発話: 文字が無い・時刻が壊れたものは捨て、長い文は切り、系統は mic か system にする', () => {
    expect(sanitizeLiveSegment(null)).toBeNull()
    expect(sanitizeLiveSegment({ t0: 0, text: '   ' })).toBeNull()
    expect(sanitizeLiveSegment({ t0: -1, text: 'a' })).toBeNull()
    expect(sanitizeLiveSegment({ t0: Number.NaN, text: 'a' })).toBeNull()
    expect(sanitizeLiveSegment({ t0: 1200.4, t1: 900, text: ' ここ \n 直して ', source: 'bogus' })).toEqual({ t0: 1200, t1: 1200, text: 'ここ 直して', source: 'mic' })
    expect(sanitizeLiveSegment({ t0: 0, t1: 10, text: 'x'.repeat(LIVE_SEGMENT_MAX_TEXT + 50), source: 'system' })!.text).toHaveLength(LIVE_SEGMENT_MAX_TEXT)
  })

  it('状態: 知らない値は既定へ戻し、数は 0 以上の整数にする', () => {
    expect(sanitizeLiveStatus('x')).toEqual(IDLE_LIVE_STATUS)
    expect(sanitizeLiveStatus({ run: 3, active: true, state: 'nope', pending: -2, done: 1.7, failed: 'a', warning: 'zzz', message: '  ' }))
      .toEqual({ run: 3, active: true, state: 'off', pending: 0, done: 1, failed: 0, twoSpeakers: false })
    expect(sanitizeLiveStatus({ run: 1, active: true, state: 'error', pending: 0, done: 0, failed: 1, twoSpeakers: true, message: 'm'.repeat(900), warning: 'stalled' }))
      .toMatchObject({ state: 'error', twoSpeakers: true, warning: 'stalled' })
    expect(sanitizeLiveStatus({ state: 'error', message: 'm'.repeat(900) }).message!.length).toBeLessThanOrEqual(500)
  })

  it('束: 配列でなければ null、上限を超えた分と壊れた発話は捨てる', () => {
    expect(sanitizeLiveBatch({ run: 1, segments: 'x' })).toBeNull()
    const many = Array.from({ length: LIVE_BATCH_MAX + 10 }, (_, i) => seg(i, `t${i}`))
    expect(sanitizeLiveBatch({ run: 2, segments: [...many, { t0: 'x' }] })!.segments).toHaveLength(LIVE_BATCH_MAX)
    expect(sanitizeLiveBatch({ run: 2, segments: [{ t0: 'x' }, seg(5, 'ok')] })).toEqual({ run: 2, segments: [seg(5, 'ok')] })
  })
})

describe('発話を並べる', () => {
  it('時刻順に入れ、同じ発話は二度足さず、上限を超えたら古いものから捨てる', () => {
    let list = addLiveSegments([], [seg(5000, 'b')])
    list = addLiveSegments(list, [seg(1000, 'a', 'system'), seg(9000, 'c')])
    list = addLiveSegments(list, [seg(5000, 'b')])
    expect(list.map((s) => s.text)).toEqual(['a', 'b', 'c'])
    // 同じ時刻なら届いた順
    list = addLiveSegments(list, [seg(5000, 'b2', 'system')])
    expect(list.map((s) => s.text)).toEqual(['a', 'b', 'b2', 'c'])
    expect(addLiveSegments(list, [seg(10_000, 'd')], 2).map((s) => s.text)).toEqual(['c', 'd'])
  })

  it('何も足さなければ同じ配列を返す（再描画しない）', () => {
    const list = [seg(0, 'a')]
    expect(addLiveSegments(list, [])).toBe(list)
  })

  it('時刻は mm:ss、1時間を超えたら h:mm:ss', () => {
    expect(formatLiveTime(0)).toBe('00:00')
    expect(formatLiveTime(65_900)).toBe('01:05')
    expect(formatLiveTime(3_725_000)).toBe('1:02:05')
    expect(formatLiveTime(-5)).toBe('00:00')
  })
})

describe('状態の見せ方と知らせ', () => {
  const base: LiveTranscriptStatus = { ...IDLE_LIVE_STATUS, run: 1, active: true, state: 'idle' }
  it('問題は録画中だけ。動いていない・失敗・推測の警告の順に返す', () => {
    expect(liveTranscriptProblem(base)).toBeNull()
    expect(liveTranscriptProblem({ ...base, state: 'unavailable' })).toBe('unavailable')
    expect(liveTranscriptProblem({ ...base, state: 'error', warning: 'stalled' })).toBe('error')
    expect(liveTranscriptProblem({ ...base, warning: 'micSilent' })).toBe('micSilent')
    expect(liveTranscriptProblem({ ...base, active: false, state: 'error' })).toBeNull()
  })

  it('上の1行', () => {
    expect(liveStatusLine(IDLE_LIVE_STATUS)).toEqual({ line: 'off', tone: 'muted' })
    expect(liveStatusLine({ ...base, active: false })).toEqual({ line: 'done', tone: 'muted' })
    expect(liveStatusLine({ ...base, state: 'off' }).line).toBe('noAudio')
    expect(liveStatusLine({ ...base, state: 'working' })).toEqual({ line: 'working', tone: 'busy' })
    expect(liveStatusLine({ ...base, state: 'error' }).tone).toBe('danger')
    expect(liveStatusLine({ ...base, state: 'unavailable' }).tone).toBe('danger')
    expect(liveStatusLine(base)).toEqual({ line: 'idle', tone: 'ok' })
  })
})

describe('声が文字にならない・マイクに音が来ないの見張り', () => {
  const speak = (watch: SpeechStallWatch, seconds: number, rms = 0.1) => { for (let i = 0; i < seconds * 10; i++) watch.level(rms, rms * 2) }

  it('声が 2 分続いても、待っている区切りがあれば警告しない。追いついて文字が無ければ警告し、文字が出たら消える', () => {
    const watch = new SpeechStallWatch()
    speak(watch, 130)
    expect(watch.check(1)).toBe(false)
    expect(watch.warning()).toBeUndefined()
    expect(watch.check(0)).toBe(true)
    expect(watch.warning()).toBe('stalled')
    expect(watch.text()).toBe(true)
    expect(watch.warning()).toBeUndefined()
  })

  it('静かな部屋の雑音は声に数えない', () => {
    const watch = new SpeechStallWatch()
    speak(watch, 300, 0.01)
    watch.check(0)
    expect(watch.warning()).toBeUndefined()
  })

  it('マイクの音が 20 秒まったく 0 ならマイクの無音、少しでも音が来れば消える', () => {
    const watch = new SpeechStallWatch()
    speak(watch, 19, 0)
    expect(watch.warning()).toBeUndefined()
    speak(watch, 2, 0)
    expect(watch.warning()).toBe('micSilent')
    expect(watch.level(0.005, 0.01)).toBe(true)
    expect(watch.warning()).toBeUndefined()
  })
})

describe('main の途中経過（LiveTranscriptFeed）', () => {
  const sinkOf = () => {
    const statuses: LiveTranscriptStatus[] = []
    const batches: LiveTranscriptBatch[] = []
    return { statuses, batches, sink: { status: (s: LiveTranscriptStatus) => statuses.push(s), segments: (b: LiveTranscriptBatch) => batches.push(b) } }
  }
  const start = { transcribing: true, audio: true, mic: true, twoSpeakers: false }
  const tseg = (t0: number, text: string) => ({ t0, t1: t0 + 500, speaker: 'self' as const, text, source: 'mic' as const })

  it('録画ごとに run を増やし、待ち・済み・失敗を数え、発話を送る', () => {
    const { statuses, batches, sink } = sinkOf()
    const feed = new LiveTranscriptFeed(sink)
    feed.start(start)
    expect(feed.current()).toMatchObject({ run: 1, active: true, state: 'idle', pending: 0 })
    feed.progress({ pending: 1 })
    expect(feed.current().state).toBe('working')
    feed.progress({ pending: 0, segments: [tseg(100, 'ボタンが小さい'), { ...tseg(900, '相手'), speaker: 'other', source: 'system' }] })
    expect(feed.current()).toMatchObject({ state: 'idle', done: 1, pending: 0 })
    expect(batches).toEqual([{ run: 1, segments: [{ t0: 100, t1: 600, text: 'ボタンが小さい', source: 'mic' }, { t0: 900, t1: 1400, text: '相手', source: 'system' }] }])
    feed.progress({ pending: 1 })
    feed.progress({ pending: 0, error: new Error('401 Unauthorized') })
    expect(feed.current()).toMatchObject({ state: 'error', failed: 1, message: '401 Unauthorized' })
    // 次の区切りが通れば戻る（失敗した数は残す）
    feed.progress({ pending: 0, segments: [] })
    expect(feed.current()).toMatchObject({ state: 'idle', failed: 1, done: 2 })
    expect(feed.current().message).toBeUndefined()
    feed.stop()
    expect(feed.current()).toMatchObject({ active: false, pending: 0 })
    feed.start(start)
    expect(feed.current()).toMatchObject({ run: 2, done: 0, failed: 0 })
    expect(statuses.length).toBeGreaterThan(5)
  })

  it('文字起こしが動かない録画は unavailable と理由。音を録らない・検証の録画は off', () => {
    const { sink } = sinkOf()
    const feed = new LiveTranscriptFeed(sink)
    feed.start({ ...start, transcribing: false, message: 'No model' })
    expect(feed.current()).toMatchObject({ state: 'unavailable', message: 'No model' })
    feed.start({ ...start, transcribing: false })
    expect(feed.current().state).toBe('off')
    feed.start({ ...start, audio: false, transcribing: false, message: 'x' })
    expect(feed.current().state).toBe('off')
  })

  it('マイクのレベルから警告を出し、変わったときだけ送る。相手の音・止めたあとは見ない', () => {
    const { statuses, sink } = sinkOf()
    const feed = new LiveTranscriptFeed(sink, () => new SpeechStallWatch({ stallSpeechMs: 1000, silentMs: 60_000 }))
    feed.start(start)
    const before = statuses.length
    for (let i = 0; i < 30; i++) feed.level('system', 0.2, 0.4)
    expect(statuses.length).toBe(before)
    for (let i = 0; i < 30; i++) feed.level('mic', 0.2, 0.4)
    expect(feed.current().warning).toBe('stalled')
    expect(statuses.length).toBe(before + 1)
    feed.progress({ pending: 0, segments: [tseg(0, '出た')] })
    expect(feed.current().warning).toBeUndefined()
    feed.stop()
    const stopped = statuses.length
    feed.level('mic', 0.2, 0.4)
    feed.progress({ pending: 0, segments: [tseg(0, 'late')] })
    expect(statuses.length).toBe(stopped)
  })
})

describe('録画中の逐次の文字起こし（IncrementalTranscriber の進み具合）', () => {
  it('区切りは1つずつ順に処理し、待ちの数と結果・失敗を知らせる。止めたときは残りだけを待つ', async () => {
    let running = 0
    let maxRunning = 0
    const order: string[] = []
    const engine: SttEngine = {
      id: 'fake', sendsAudioOffDevice: false, available: async () => true,
      transcribeChunk: async (input) => {
        running++; maxRunning = Math.max(maxRunning, running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        order.push(input.wavPath)
        if (input.wavPath.endsWith('bad.wav')) throw new Error('provider down')
        return { segments: [{ t0: input.offsetMs, t1: input.offsetMs + 400, speaker: input.speaker, text: `text ${input.offsetMs}`, source: input.source }], elapsedMs: 5, commandLine: 'fake' }
      }
    }
    const progress: TranscriberProgress[] = []
    const written: string[] = []
    const transcriber = new IncrementalTranscriber(engine, async (segments) => { written.push(...segments.map((s) => s.text)) }, (p) => progress.push(p))
    const chunk = (name: string, offsetMs: number) => ({ wavPath: `/Users/taro/review/audio/${name}`, offsetMs, speaker: 'self' as const, source: 'mic' as const })
    transcriber.push(chunk('mic-1.wav', 0))
    transcriber.push(chunk('bad.wav', 1000))
    transcriber.push(chunk('mic-3.wav', 2000))
    expect(transcriber.pending).toBe(3)
    expect(progress.map((p) => p.pending)).toEqual([1, 2, 3])
    const result = await transcriber.flush()
    expect(maxRunning).toBe(1)
    expect(order.map((p) => p.split('/').pop())).toEqual(['mic-1.wav', 'bad.wav', 'mic-3.wav'])
    expect(transcriber.pending).toBe(0)
    const finished = progress.slice(3)
    expect(finished.map((p) => p.pending)).toEqual([2, 1, 0])
    expect(finished[0].segments?.[0].text).toBe('text 0')
    expect(finished[1].error?.message).toBe('provider down')
    // 失敗した区切りも黙って捨てず、「文字起こしできなかった発話」の区間として残す（stt/engine.ts の failedChunkSegment）
    expect(result.segments.map((s) => [s.t0, s.sttFailed === true])).toEqual([[0, false], [1000, true], [2000, false]])
    expect(result.segments.filter((s) => !s.sttFailed).map((s) => s.text)).toEqual(['text 0', 'text 2000'])
    expect(written.filter((text) => text.startsWith('text '))).toEqual(['text 0', 'text 2000'])
    expect(written).toHaveLength(3)
    expect(result.errors).toHaveLength(1)
  })

  it('表示の失敗で文字起こしを止めない', async () => {
    const engine: SttEngine = { id: 'fake', sendsAudioOffDevice: false, available: async () => true,
      transcribeChunk: async () => ({ segments: [{ t0: 0, t1: 1, speaker: 'self', text: 'ok' }], elapsedMs: 1, commandLine: 'fake' }) }
    const transcriber = new IncrementalTranscriber(engine, undefined, () => { throw new Error('ui gone') })
    transcriber.push({ wavPath: '/Users/taro/a.wav', offsetMs: 0, speaker: 'self', source: 'mic' })
    const result = await transcriber.flush()
    expect(result.segments).toHaveLength(1)
    expect(result.errors).toEqual([])
  })
})

describe('設定 capture.showLiveTranscript', () => {
  const capture = { captureMic: true, captureSystemAudio: false, transcription: 'local', language: 'auto', keepDays: 7, stayFeedbackOnStop: false }
  it('既定は出す（書かれていなければ書き足さない）。真偽値だけを残す', () => {
    expect(sanitize({ capture }).capture?.showLiveTranscript).toBeUndefined()
    expect(sanitize({ capture: { ...capture, showLiveTranscript: false } }).capture?.showLiveTranscript).toBe(false)
    expect(sanitize({ capture: { ...capture, showLiveTranscript: 'no' } }).capture?.showLiveTranscript).toBeUndefined()
  })

  it('スキーマに説明付きで、既定は true', () => {
    const prop = SETTINGS_SCHEMA.properties!.capture!.properties!.showLiveTranscript!
    expect(prop.type).toBe('boolean')
    expect(prop.default).toBe(true)
    expect(prop.description).toMatch(/live transcript/i)
  })
})
