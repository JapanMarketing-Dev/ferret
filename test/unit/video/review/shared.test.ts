import { describe, expect, it } from 'vitest'
import {
  ATTACH_MS, boxPoints, buildReviewItems, contentRect, DEFAULT_FPS, feedbackMarkdown, fixFeedbackPrompt, fpsOf, frameAtSession, frameAtTime, frameToSeconds,
  imageName, isFeedbackId, MAX_ITEMS, MAX_TEXT, newFeedbackId, normalizePoint, sanitizeItems, simplifyStroke, splitRemarks, timecode,
  type ReviewItem, type ReviewStroke
} from '@video/app/shared/review'

const F30 = { num: 30, den: 1 }
const NTSC = { num: 30000, den: 1001 }

describe('timecode', () => {
  it('is 00:00:00:00 at frame 0 and for invalid frames', () => {
    expect(timecode(0, F30)).toBe('00:00:00:00')
    expect(timecode(-5, F30)).toBe('00:00:00:00')
    expect(timecode(Number.NaN, F30)).toBe('00:00:00:00')
    expect(timecode(Number.POSITIVE_INFINITY, F30)).toBe('00:00:00:00')
  })
  it('counts frames, seconds, minutes and hours', () => {
    expect(timecode(29, F30)).toBe('00:00:00:29')
    expect(timecode(30, F30)).toBe('00:00:01:00')
    expect(timecode(30 * 60 - 1, F30)).toBe('00:00:59:29')
    expect(timecode(30 * 60, F30)).toBe('00:01:00:00')
    expect(timecode(30 * 3600 + 30 * 61 + 7, F30)).toBe('01:01:01:07')
  })
  it('uses the nominal rate for 29.97 (non-drop)', () => {
    expect(timecode(30, NTSC)).toBe('00:00:01:00')
  })
  it('floors fractional frames', () => {
    expect(timecode(30.9, F30)).toBe('00:00:01:00')
  })
  it('does not break with a zero den or tiny fps', () => {
    expect(timecode(10, { num: 0, den: 0 })).toBe('00:00:10:00')
  })
})

describe('frameAtTime / frameToSeconds', () => {
  it('maps seconds to the nearest frame', () => {
    expect(frameAtTime(0, F30)).toBe(0)
    expect(frameAtTime(1, F30)).toBe(30)
    expect(frameAtTime(1.0166, F30)).toBe(30)
    expect(frameAtTime(1.02, F30)).toBe(31)
    expect(frameAtTime(1001 / 30000, NTSC)).toBe(1)
  })
  it('is 0 for negative or invalid times', () => {
    expect(frameAtTime(-1, F30)).toBe(0)
    expect(frameAtTime(Number.NaN, F30)).toBe(0)
  })
  it('round-trips with frameToSeconds', () => {
    for (const f of [0, 1, 29, 30, 12345]) expect(frameAtTime(frameToSeconds(f, NTSC), NTSC)).toBe(f)
  })
})

describe('frameAtSession', () => {
  const pb = [
    { atMs: 0, state: 'paused' as const, frame: 0 },
    { atMs: 1000, state: 'playing' as const, frame: 0 },
    { atMs: 3000, state: 'paused' as const, frame: 60 },
    { atMs: 5000, state: 'paused' as const, frame: 300 }
  ]
  it('is 0 without events', () => {
    expect(frameAtSession([], 1000, F30)).toBe(0)
  })
  it('stays on a paused frame', () => {
    expect(frameAtSession(pb, 500, F30)).toBe(0)
    expect(frameAtSession(pb, 4000, F30)).toBe(60)
  })
  it('advances while playing', () => {
    expect(frameAtSession(pb, 2000, F30)).toBe(30)
    expect(frameAtSession(pb, 2999, F30)).toBe(59)
  })
  it('uses the seeked frame', () => {
    expect(frameAtSession(pb, 9000, F30)).toBe(300)
  })
  it('accepts unsorted events and times before the first event', () => {
    expect(frameAtSession([...pb].reverse(), 2000, F30)).toBe(30)
    expect(frameAtSession([{ atMs: 1000, state: 'playing', frame: 10 }], 0, F30)).toBe(10)
  })
})

describe('splitRemarks', () => {
  it('is empty without pieces or with blank text', () => {
    expect(splitRemarks([], 0, 'ja')).toEqual([])
    expect(splitRemarks([{ t0: 0, t1: 500, text: '   ' }, { t0: 600, t1: 700, text: '' }], 0, 'ja')).toEqual([])
  })
  it('joins close pieces (ja without spaces) and offsets by audioStartMs', () => {
    expect(splitRemarks([{ t0: 0, t1: 500, text: 'ここの' }, { t0: 700, t1: 1200, text: '字幕を大きく' }], 250, 'ja')).toEqual([{ startMs: 250, endMs: 1450, text: 'ここの字幕を大きく' }])
  })
  it('splits on a long pause', () => {
    const r = splitRemarks([{ t0: 0, t1: 500, text: 'a' }, { t0: 1301, t1: 1500, text: 'b' }], 0, 'en')
    expect(r.map((x) => x.text)).toEqual(['a', 'b'])
  })
  it('keeps a pause of exactly the gap together', () => {
    expect(splitRemarks([{ t0: 0, t1: 500, text: 'a' }, { t0: 1300, t1: 1500, text: 'b' }], 0, 'en')).toHaveLength(1)
  })
  it('splits after a sentence end with a short pause', () => {
    const r = splitRemarks([{ t0: 0, t1: 500, text: '暗い。' }, { t0: 900, t1: 1500, text: '次に' }], 0, 'ja')
    expect(r.map((x) => x.text)).toEqual(['暗い。', '次に'])
    expect(splitRemarks([{ t0: 0, t1: 500, text: '暗い。' }, { t0: 700, t1: 1500, text: '次に' }], 0, 'ja')).toHaveLength(1)
  })
  it('joins English with spaces but not before punctuation', () => {
    expect(splitRemarks([{ t0: 0, t1: 100, text: 'make it' }, { t0: 150, t1: 200, text: 'bigger' }, { t0: 210, t1: 220, text: '!' }], 0, 'en')[0]!.text).toBe('make it bigger!')
  })
  it('sorts pieces and drops non-finite times', () => {
    const r = splitRemarks([{ t0: 600, t1: 900, text: 'b' }, { t0: Number.NaN, t1: 1, text: 'x' }, { t0: 0, t1: 500, text: 'a' }], 0, 'en')
    expect(r).toEqual([{ startMs: 0, endMs: 900, text: 'a b' }])
  })
  it('keeps a long remark whole', () => {
    const long = 'あ'.repeat(5000)
    expect(splitRemarks([{ t0: 0, t1: 60_000, text: long }], 0, 'ja')[0]!.text).toHaveLength(5000)
  })
  it('handles t1 before t0', () => {
    expect(splitRemarks([{ t0: 500, t1: 100, text: 'x' }], 0, 'en')).toEqual([{ startMs: 500, endMs: 500, text: 'x' }])
  })
})

describe('buildReviewItems', () => {
  const stroke = (startMs: number, frame: number): ReviewStroke => ({ startMs, endMs: startMs + 200, frame, points: [[0.1, 0.1], [0.2, 0.2]] })
  const pb = [{ atMs: 0, state: 'playing' as const, frame: 0 }]

  it('is empty for an empty session', () => {
    expect(buildReviewItems({ playback: [], strokes: [], notes: [] }, [], F30)).toEqual([])
  })
  it('makes one item per remark with the frame where it started', () => {
    const items = buildReviewItems({ playback: pb, strokes: [], notes: [] }, [{ startMs: 2000, endMs: 3000, text: '暗い' }], F30)
    expect(items).toEqual([{ index: 1, atMs: 2000, frame: 60, speech: '暗い', strokes: [], notes: [], targets: [] }])
  })
  it('attaches a stroke during or near a remark and uses its frame', () => {
    const items = buildReviewItems({ playback: pb, strokes: [stroke(3500, 42)], notes: [] }, [{ startMs: 1000, endMs: 3000, text: 'ここ' }], F30)
    expect(items).toHaveLength(1)
    expect(items[0]!.frame).toBe(42)
    expect(items[0]!.strokes).toHaveLength(1)
  })
  it('makes a pen-only item when the stroke is far from every remark', () => {
    const items = buildReviewItems({ playback: pb, strokes: [stroke(3000 + ATTACH_MS + 1, 99)], notes: [] }, [{ startMs: 1000, endMs: 3000, text: 'a' }], F30)
    expect(items.map((x) => [x.speech, x.frame])).toEqual([['a', 30], ['', 99]])
    expect(items.map((x) => x.index)).toEqual([1, 2])
  })
  it('attaches at exactly the limit', () => {
    const items = buildReviewItems({ playback: pb, strokes: [stroke(3000 + ATTACH_MS, 99)], notes: [] }, [{ startMs: 1000, endMs: 3000, text: 'a' }], F30)
    expect(items).toHaveLength(1)
  })
  it('picks the nearest remark', () => {
    const items = buildReviewItems({ playback: pb, strokes: [stroke(5800, 7)], notes: [] }, [{ startMs: 0, endMs: 1000, text: 'a' }, { startMs: 6000, endMs: 7000, text: 'b' }], F30)
    expect(items[1]!.strokes).toHaveLength(1)
    expect(items[0]!.strokes).toHaveLength(0)
  })
  it('drops strokes without points and blank notes, keeps notes', () => {
    const items = buildReviewItems({ playback: pb, strokes: [{ ...stroke(0, 0), points: [] }], notes: [{ atMs: 0, text: '  ' }, { atMs: 50_000, text: ' メモ ', frame: 5 }] }, [], F30)
    expect(items).toEqual([{ index: 1, atMs: 50_000, frame: 5, speech: '', strokes: [], notes: ['メモ'], targets: [] }])
  })
  it('clamps frames to the last frame of the video and never below 0', () => {
    const items = buildReviewItems({ playback: [{ atMs: 0, state: 'paused', frame: 1000 }], strokes: [{ ...stroke(0, -3) }], notes: [] }, [{ startMs: 10_000, endMs: 11_000, text: 'end' }], F30, 900)
    expect(items.map((x) => x.frame)).toEqual([0, 899])
  })
  it('sorts items by time', () => {
    const items = buildReviewItems({ playback: pb, strokes: [stroke(100, 1)], notes: [] }, [{ startMs: 20_000, endMs: 21_000, text: 'later' }], F30)
    expect(items.map((x) => x.speech)).toEqual(['', 'later'])
  })
})

describe('newFeedbackId / isFeedbackId', () => {
  it('builds fb_YYYYMMDD-HHMMSS in local time', () => {
    expect(newFeedbackId(new Date(2026, 9, 18, 7, 5, 9))).toBe('fb_20261018-070509')
    expect(isFeedbackId(newFeedbackId())).toBe(true)
  })
  it.each(['fb_a', 'fb_20261018-070509-2', 'fb_x.y'])('accepts %j', (id) => expect(isFeedbackId(id)).toBe(true))
  it.each(['', 'fb_', 'fb_..', 'fb_a/../b', 'fb_a/b', '../fb_a', 'x_fb', 'fb_-a', 'fb_a\\b', `fb_${'a'.repeat(100)}`, 12, null])('refuses %j', (id) => expect(isFeedbackId(id)).toBe(false))
})

describe('sanitizeItems', () => {
  it('is [] for non-arrays', () => {
    expect(sanitizeItems(undefined)).toEqual([])
    expect(sanitizeItems({ items: [] })).toEqual([])
  })
  it('renumbers and keeps valid fields', () => {
    const r = sanitizeItems([{ index: 9, atMs: 1.6, frame: 2.4, speech: 's', strokes: [{ startMs: 1, endMs: 2, frame: 3, color: '#ff0000', width: 0.005, points: [[0.5, 0.5]] }], notes: ['n'], request: ' r ', title: ' t ' }])
    expect(r).toEqual([{ index: 1, atMs: 2, frame: 2, speech: 's', strokes: [{ startMs: 1, endMs: 2, frame: 3, color: '#ff0000', width: 0.005, points: [[0.5, 0.5]] }], notes: ['n'], targets: [], title: 't', request: 'r' }])
  })
  it('clamps points into 0..1 and drops broken points, colors and widths', () => {
    const r = sanitizeItems([{ speech: 'x', strokes: [{ points: [[-1, 2], ['a', 1], [0.25, 0.75, 1], [Number.NaN, 0]], color: 'red', width: 5 }] }])
    expect(r[0]!.strokes).toEqual([{ startMs: 0, endMs: 0, frame: 0, points: [[0, 1]] }])
  })
  it('drops items with nothing in them and garbage entries', () => {
    expect(sanitizeItems([null, 1, 'x', { speech: '   ' }, { strokes: [{ points: [] }] }])).toEqual([])
  })
  it('keeps an item with only a request', () => {
    expect(sanitizeItems([{ request: '音を上げて' }])).toHaveLength(1)
  })
  it('caps the number of items and the text length', () => {
    const many = Array.from({ length: MAX_ITEMS + 10 }, () => ({ speech: 's' }))
    expect(sanitizeItems(many)).toHaveLength(MAX_ITEMS)
    expect(sanitizeItems([{ speech: 'a'.repeat(MAX_TEXT + 100) }])[0]!.speech).toHaveLength(MAX_TEXT)
  })
  it('never lets negative frames through', () => {
    expect(sanitizeItems([{ speech: 's', frame: -10, atMs: -5 }])[0]).toMatchObject({ frame: 0, atMs: 0 })
  })
})

describe('feedbackMarkdown', () => {
  const item = (o: Partial<ReviewItem>): ReviewItem => ({ index: 1, atMs: 0, frame: 0, speech: '', strokes: [], notes: [], targets: [], ...o })

  it('writes the Solocut format with timecodes (ja)', () => {
    const md = feedbackMarkdown('fb_1', [item({ frame: 95, speech: 'ここの字幕を大きく', strokes: [{ startMs: 0, endMs: 1, frame: 95, points: [[0, 0]] }] })], F30, 'ja')
    expect(md).toContain('# フィードバック fb_1')
    expect(md).toContain('## 1. [00:00:03:05] ここの字幕を大きく')
    expect(md).toContain('- 要望: （未整理）発話と画像をもとに対応してください')
    expect(md).toContain('- 発話（原文）: 「ここの字幕を大きく」')
    expect(md).toContain('- 画像: ./01.png（ペンの囲み入り）')
    expect(md).toContain('- 対象: （特定できませんでした）')
    expect(md).toContain('- フレーム: 95')
    expect(md).toContain('ferret-video feedback done fb_1')
    expect(md).not.toContain('solocut')
  })
  it('writes English', () => {
    const md = feedbackMarkdown('fb_1', [item({ request: 'Make it louder', title: 'Audio' })], F30, 'en')
    expect(md).toContain('# Feedback fb_1')
    expect(md).toContain('## 1. [00:00:00:00] Audio')
    expect(md).toContain('- Request: Make it louder')
    expect(md).toContain('- Image: ./01.png')
    expect(md).not.toContain('Speech (verbatim)')
  })
  it('uses the pen-only heading and notes', () => {
    expect(feedbackMarkdown('fb_1', [item({})], F30, 'ja')).toContain('（ペンの囲みのみ）')
    expect(feedbackMarkdown('fb_1', [item({})], F30, 'en')).toContain('(pen only)')
    const md = feedbackMarkdown('fb_1', [item({ notes: ['メモの内容'] })], F30, 'ja')
    expect(md).toContain('] メモの内容')
    expect(md).toContain('- メモ: メモの内容')
  })
  it('shortens a long heading but keeps the whole speech', () => {
    const long = 'あ'.repeat(100)
    const md = feedbackMarkdown('fb_1', [item({ speech: long })], F30, 'ja')
    expect(md).toContain(`## 1. [00:00:00:00] ${'あ'.repeat(28)}…`)
    expect(md).toContain(`「${long}」`)
  })
  it('keeps every item on its own lines even with newlines in the text', () => {
    const md = feedbackMarkdown('fb_1', [item({ speech: 'a\n## injected', request: 'x\ny', notes: ['n\nm'] })], F30, 'ja')
    expect(md).not.toContain('\n## injected')
    expect(md).toContain('「a ## injected」')
    expect(md).toContain('- 要望: x y')
    expect(md).toContain('- メモ: n m')
  })
  it('says (none) for items without an image', () => {
    const md = feedbackMarkdown('fb_1', [item({ index: 1 }), item({ index: 2 })], F30, 'ja', new Set([2]))
    expect(md).toContain('- 画像: （なし）')
    expect(md).toContain('- 画像: ./02.png')
  })
  it('handles the last frame of a long video', () => {
    expect(feedbackMarkdown('fb_1', [item({ frame: 30 * 3600 * 2 - 1 })], F30, 'ja')).toContain('[01:59:59:29]')
  })
  it('has just the header without items', () => {
    expect(feedbackMarkdown('fb_1', [], F30, 'ja').split('\n## ')).toHaveLength(1)
  })
})

describe('fixFeedbackPrompt', () => {
  it('names the folder and feedback.md, and asks to mark it done', () => {
    const ja = fixFeedbackPrompt('/ch/v/', 'fb_1', 'ja')
    expect(ja).toContain('対象の動画のフォルダ: /ch/v\n')
    expect(ja).toContain('/ch/v/feedback/fb_1/feedback.md')
    expect(ja).toContain('ferret-video feedback done fb_1')
    const en = fixFeedbackPrompt('/ch/v', 'fb_1', 'en')
    expect(en).toContain('read /ch/v/feedback/fb_1/feedback.md')
  })
})

describe('fpsOf', () => {
  it('reads canvas.fps', () => {
    expect(fpsOf({ canvas: { fps: { num: 60, den: 1 } } })).toEqual({ num: 60, den: 1 })
  })
  it('falls back to 30 for missing or broken values', () => {
    for (const t of [undefined, null, {}, { canvas: { fps: { num: 0, den: 1 } } }, { canvas: { fps: { num: 30, den: -1 } } }, { canvas: { fps: { num: '30', den: 1 } } }]) {
      expect(fpsOf(t)).toEqual(DEFAULT_FPS)
    }
  })
})

describe('pen helpers', () => {
  it('contentRect letterboxes and pillarboxes', () => {
    expect(contentRect(1600, 1000, 1920, 1080)).toEqual({ x: 0, y: 50, w: 1600, h: 900 })
    expect(contentRect(1000, 1000, 1080, 1920)).toEqual({ x: 218.75, y: 0, w: 562.5, h: 1000 })
    expect(contentRect(1920, 1080, 1920, 1080)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 })
  })
  it('contentRect falls back to the element before the video loads', () => {
    expect(contentRect(800, 450, 0, 0)).toEqual({ x: 0, y: 0, w: 800, h: 450 })
    expect(contentRect(-1, 10, 1, 1)).toEqual({ x: 0, y: 0, w: 0, h: 10 })
  })
  it('normalizePoint clamps to the picture', () => {
    const r = { x: 0, y: 50, w: 1600, h: 900 }
    expect(normalizePoint(800, 500, r)).toEqual([0.5, 0.5])
    expect(normalizePoint(-10, 10, r)).toEqual([0, 0])
    expect(normalizePoint(5000, 5000, r)).toEqual([1, 1])
    expect(normalizePoint(1, 1, { x: 0, y: 0, w: 0, h: 0 })).toEqual([1, 1])
  })
  it('simplifyStroke drops close points and keeps the ends', () => {
    expect(simplifyStroke([])).toEqual([])
    expect(simplifyStroke([[0, 0], [1, 1]])).toEqual([[0, 0], [1, 1]])
    expect(simplifyStroke([[0, 0], [0.001, 0], [0.002, 0], [0.5, 0], [0.5001, 0]])).toEqual([[0, 0], [0.5, 0], [0.5001, 0]])
  })
  it('boxPoints closes the outline', () => {
    const p = boxPoints({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })
    expect(p).toHaveLength(5)
    expect(p[0]).toEqual(p[4])
  })
  it('imageName pads to two digits', () => {
    expect(imageName(1)).toBe('01.png')
    expect(imageName(12)).toBe('12.png')
    expect(imageName(123)).toBe('123.png')
  })
})
