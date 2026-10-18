import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  discardInbox, inboxDir, isPng, listSavedFeedback, MAX_IMAGE_BYTES, reviewRegisterOps, saveFeedback, writeSnapshot, writeVoice
} from '@video/app/main/review/feedback'
import { encodeWav } from '@video/app/shared/wav'
import type { ReviewSession } from '@video/app/shared/review'

const F30 = { num: 30, den: 1 }
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
const session: ReviewSession = { schema: 1, createdAt: '2026-10-18T00:00:00.000Z', audioStartMs: 120, playback: [{ atMs: 0, state: 'paused', frame: 0 }], strokes: [], notes: [] }

let dir: string
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-video-fb-')))
  writeFileSync(join(dir, 'ferret-video.json'), '{}')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('isPng', () => {
  it('checks the signature', () => {
    expect(isPng(PNG)).toBe(true)
    expect(isPng(PNG.subarray(0, 8))).toBe(false)
    expect(isPng(new Uint8Array(20))).toBe(false)
  })
})

describe('writeVoice / writeSnapshot', () => {
  it('stores a WAV and PNGs in the inbox', () => {
    const path = writeVoice(dir, 'fb_1', encodeWav([new Int16Array(160)]))
    expect(path).toBe(join(dir, 'feedback', '.inbox', 'fb_1', 'voice.wav'))
    writeSnapshot(dir, 'fb_1', 1, PNG)
    writeSnapshot(dir, 'fb_1', 12, PNG)
    expect(readdirSync(inboxDir(dir, 'fb_1')).sort()).toEqual(['01.png', '12.png', 'voice.wav'])
  })
  it('refuses data that is not a WAV or a PNG', () => {
    expect(() => writeVoice(dir, 'fb_1', new Uint8Array(100))).toThrow(/WAV/)
    expect(() => writeSnapshot(dir, 'fb_1', 1, new Uint8Array(100))).toThrow(/PNG/)
    const huge = new Uint8Array(MAX_IMAGE_BYTES + 1)
    huge.set(PNG)
    expect(() => writeSnapshot(dir, 'fb_1', 1, huge)).toThrow(/PNG/)
  })
  it.each([0, -1, 1.5, 201, Number.NaN])('refuses the item index %s', (i) => {
    expect(() => writeSnapshot(dir, 'fb_1', i, PNG)).toThrow(/index/)
  })
  it.each(['../x', 'fb_..', 'fb_a/b', 'nope', ''])('refuses the id %j', (id) => {
    expect(() => writeVoice(dir, id, encodeWav([new Int16Array(1)]))).toThrow(/invalid feedback id/)
    expect(() => writeSnapshot(dir, id, 1, PNG)).toThrow(/invalid feedback id/)
  })
  it('does not write through a feedback folder that is a link', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-video-out-')))
    try {
      symlinkSync(outside, join(dir, 'feedback'))
      expect(() => writeSnapshot(dir, 'fb_1', 1, PNG)).toThrow(/not a folder/)
      expect(readdirSync(outside)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it('does not write through an inbox entry that is a link', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-video-out-')))
    try {
      mkdirSync(join(dir, 'feedback', '.inbox'), { recursive: true })
      symlinkSync(outside, join(dir, 'feedback', '.inbox', 'fb_1'))
      expect(() => writeSnapshot(dir, 'fb_1', 1, PNG)).toThrow(/not a folder/)
      expect(readdirSync(outside)).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it('discardInbox removes the inbox and ignores a missing one', () => {
    writeSnapshot(dir, 'fb_1', 1, PNG)
    discardInbox(dir, 'fb_1')
    expect(existsSync(inboxDir(dir, 'fb_1'))).toBe(false)
    expect(() => discardInbox(dir, 'fb_2')).not.toThrow()
    expect(() => discardInbox(dir, '../x')).toThrow()
  })
})

describe('saveFeedback', () => {
  const items = [
    { index: 5, atMs: 1000, frame: 30, speech: 'ここの字幕を大きく', strokes: [{ startMs: 1, endMs: 2, frame: 30, points: [[0.1, 0.2]] }], notes: [], targets: [] },
    { index: 6, atMs: 9000, frame: 270, speech: '', strokes: [], notes: ['BGM を下げる'], targets: [], request: '音量を下げる' }
  ]

  it('writes items.json, feedback.md, images, session and voice, and clears the inbox', () => {
    writeVoice(dir, 'fb_1', encodeWav([new Int16Array(16)]))
    writeSnapshot(dir, 'fb_1', 1, PNG)
    const r = saveFeedback(dir, { id: 'fb_1', session, items, fps: F30, lang: 'ja', now: new Date('2026-10-18T01:02:03Z') })
    expect(r).toMatchObject({ id: 'fb_1', dir: 'feedback/fb_1', path: 'feedback/fb_1/feedback.md', count: 2 })
    const out = join(dir, 'feedback', 'fb_1')
    expect(readdirSync(out).sort()).toEqual(['01.png', 'feedback.md', 'items.json', 'session.json', 'voice.wav'])
    const json = JSON.parse(readFileSync(join(out, 'items.json'), 'utf8'))
    expect(json).toMatchObject({ id: 'fb_1', createdAt: '2026-10-18T01:02:03.000Z', organizedBy: null, variant: 'main' })
    expect(json.items.map((x: { index: number }) => x.index)).toEqual([1, 2])
    const md = readFileSync(join(out, 'feedback.md'), 'utf8')
    expect(md).toContain('## 1. [00:00:01:00] ここの字幕を大きく')
    expect(md).toContain('- 画像: ./01.png（ペンの囲み入り）')
    expect(md).toContain('## 2. [00:00:09:00] BGM を下げる')
    expect(md).toContain('- 要望: 音量を下げる')
    expect(md).toContain('- 画像: （なし）')
    const s = JSON.parse(readFileSync(join(out, 'session.json'), 'utf8'))
    expect(s).toMatchObject({ schema: 1, audio: 'voice.wav', audioStartMs: 120 })
    expect(existsSync(inboxDir(dir, 'fb_1'))).toBe(false)
    expect(readdirSync(join(dir, 'feedback'))).toEqual(['fb_1'].concat(existsSync(join(dir, 'feedback', '.inbox')) ? ['.inbox'] : []).sort())
  })
  it('works without voice or images', () => {
    const r = saveFeedback(dir, { id: 'fb_2', session, items: [items[1]], fps: F30, lang: 'en' })
    expect(r.count).toBe(1)
    const s = JSON.parse(readFileSync(join(dir, 'feedback', 'fb_2', 'session.json'), 'utf8'))
    expect(s.audio).toBeUndefined()
    expect(readFileSync(join(dir, 'feedback', 'fb_2', 'feedback.md'), 'utf8')).toContain('- Image: (none)')
  })
  it('refuses when nothing is left after cleaning', () => {
    expect(() => saveFeedback(dir, { id: 'fb_3', session, items: [{ speech: ' ' }], fps: F30, lang: 'ja' })).toThrow(/no feedback items/)
    expect(() => saveFeedback(dir, { id: 'fb_3', session, items: 'x', fps: F30, lang: 'ja' })).toThrow(/no feedback items/)
  })
  it('refuses an existing feedback and bad ids', () => {
    saveFeedback(dir, { id: 'fb_4', session, items, fps: F30, lang: 'ja' })
    expect(() => saveFeedback(dir, { id: 'fb_4', session, items, fps: F30, lang: 'ja' })).toThrow(/already exists/)
    expect(() => saveFeedback(dir, { id: '../../evil', session, items, fps: F30, lang: 'ja' })).toThrow(/invalid feedback id/)
  })
  it('replaces a leftover folder without feedback.md', () => {
    mkdirSync(join(dir, 'feedback', 'fb_5'), { recursive: true })
    writeFileSync(join(dir, 'feedback', 'fb_5', 'junk'), '')
    saveFeedback(dir, { id: 'fb_5', session, items, fps: F30, lang: 'ja' })
    expect(existsSync(join(dir, 'feedback', 'fb_5', 'junk'))).toBe(false)
  })
  it('accepts a broken session and writes a clean one', () => {
    saveFeedback(dir, { id: 'fb_6', session: { schema: 1, audioStartMs: -5, playback: 'x' } as unknown as ReviewSession, items, fps: F30, lang: 'ja' })
    const s = JSON.parse(readFileSync(join(dir, 'feedback', 'fb_6', 'session.json'), 'utf8'))
    expect(s).toMatchObject({ schema: 1, audioStartMs: 0, playback: [], strokes: [], notes: [] })
  })
  it('leaves no work folder behind', () => {
    saveFeedback(dir, { id: 'fb_7', session, items, fps: F30, lang: 'ja' })
    expect(readdirSync(join(dir, 'feedback')).filter((n) => n.startsWith('.tmp-'))).toEqual([])
  })
})

describe('listSavedFeedback', () => {
  it('is [] without a feedback folder', () => {
    expect(listSavedFeedback(dir)).toEqual([])
  })
  it('lists folders with feedback.md, newest first, with the timeline status', () => {
    saveFeedback(dir, { id: 'fb_20261001-000000', session, items: [{ speech: 'a' }], fps: F30, lang: 'ja', now: new Date('2026-10-01T00:00:00Z') })
    saveFeedback(dir, { id: 'fb_20261002-000000', session, items: [{ speech: 'a' }, { speech: 'b' }], fps: F30, lang: 'ja' })
    mkdirSync(join(dir, 'feedback', 'fb_nomd'))
    mkdirSync(join(dir, 'feedback', 'notfb'))
    writeFileSync(join(dir, 'feedback', 'notfb', 'feedback.md'), '')
    mkdirSync(join(dir, 'feedback', 'fb_mdonly'))
    writeFileSync(join(dir, 'feedback', 'fb_mdonly', 'feedback.md'), '# x')
    const list = listSavedFeedback(dir, { review: { feedback: [{ id: 'fb_20261001-000000', status: 'done' }] } })
    expect(list.map((f) => [f.id, f.count, f.status])).toEqual([
      ['fb_mdonly', 0, 'open'],
      ['fb_20261002-000000', 2, 'open'],
      ['fb_20261001-000000', 1, 'done']
    ])
    expect(list[2]!.createdAt).toBe('2026-10-01T00:00:00.000Z')
    expect(list[1]!.path).toBe('feedback/fb_20261002-000000/feedback.md')
  })
})

describe('reviewRegisterOps', () => {
  it('adds the feedback and an open item, replacing an old record of the same id', () => {
    const ops = reviewRegisterOps({ review: { feedback: [{ id: 'fb_1', status: 'done', items: 9 }, { id: 'fb_0', status: 'open', items: 1 }], openItems: [{ ref: 'fb_1' }, { ref: 'x' }] } }, 'fb_1', 3, 'ja')
    expect(ops).toEqual([{ op: 'setReview', patch: {
      feedback: [{ id: 'fb_0', status: 'open', items: 1 }, { id: 'fb_1', status: 'open', items: 3 }],
      openItems: [{ ref: 'x' }, { ref: 'fb_1', kind: 'feedback', summary: 'フィードバック 3 件（feedback/fb_1/feedback.md）' }]
    } }])
  })
  it('works with a timeline without review', () => {
    const ops = reviewRegisterOps(undefined, 'fb_1', 1, 'en') as { patch: { feedback: unknown[]; openItems: { summary: string }[] } }[]
    expect(ops[0]!.patch.feedback).toHaveLength(1)
    expect(ops[0]!.patch.openItems[0]!.summary).toBe('1 feedback item(s) (feedback/fb_1/feedback.md)')
  })
})
