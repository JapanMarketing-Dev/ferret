import { describe, expect, it } from 'vitest'
import {
  cliFailure, cliLang, compareVideos, withUiLang, folderSlug, inVideoFolder, isSafeVideoName, listChanged, parseCliJson, parseNext, parseSteps, parseTemplates,
  progressOf, SLUG_MAX, videoFolderName, type VideoEntry
} from '@video/app/shared/library'

describe('folderSlug', () => {
  it('keeps Japanese and turns spaces into dashes', () => {
    expect(folderSlug('Claude Code の 小技')).toBe('Claude-Code-の-小技')
  })
  it('drops characters no file system accepts', () => {
    expect(folderSlug('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })
  it('drops control characters and trims dashes and dots', () => {
    expect(folderSlug('\u0000..-hello-..\u001f')).toBe('hello')
  })
  it('collapses repeated dashes', () => {
    expect(folderSlug('a  -- b')).toBe('a-b')
  })
  it('returns empty for a title with nothing usable', () => {
    expect(folderSlug('   ')).toBe('')
    expect(folderSlug('///')).toBe('')
    expect(folderSlug('...')).toBe('')
  })
  it('normalizes full-width characters (NFKC)', () => {
    expect(folderSlug('ＡＢＣ　１２３')).toBe('ABC-123')
  })
  it('cuts at the max length by code points and never splits an emoji', () => {
    const long = '😀'.repeat(SLUG_MAX + 5)
    const s = folderSlug(long)
    expect(Array.from(s)).toHaveLength(SLUG_MAX)
    expect(s).toBe('😀'.repeat(SLUG_MAX))
  })
  it('does not end with a dash after cutting', () => {
    const s = folderSlug(`${'a'.repeat(SLUG_MAX - 1)} b`)
    expect(s.endsWith('-')).toBe(false)
  })
  it('never produces .. or a path separator', () => {
    for (const t of ['../../etc', '..\\..\\x', '/abs/path', '..']) {
      const s = folderSlug(t)
      expect(s).not.toContain('/')
      expect(s).not.toContain('\\')
      expect(s.startsWith('.')).toBe(false)
    }
  })
})

describe('videoFolderName', () => {
  const now = new Date(2026, 0, 5, 9, 7)
  it('is date + slug', () => {
    expect(videoFolderName('ネタ', now)).toBe('2026-01-05-ネタ')
  })
  it('falls back to HHMM without a usable title', () => {
    expect(videoFolderName('', now)).toBe('2026-01-05-0907')
    expect(videoFolderName('***', now)).toBe('2026-01-05-0907')
  })
  it('pads month, day, hour and minute', () => {
    expect(videoFolderName('', new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31-2359')
    expect(videoFolderName('', new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01-0000')
  })
})

describe('isSafeVideoName', () => {
  it('accepts a plain folder name', () => {
    expect(isSafeVideoName('2026-10-18-ネタ')).toBe(true)
  })
  it.each(['', '.', '..', '.hidden', '../x', 'a/b', 'a\\b', 'x\u0000', 'tab\tname', 'a'.repeat(256)])('refuses %j', (name) => {
    expect(isSafeVideoName(name)).toBe(false)
  })
  it('refuses non-strings', () => {
    expect(isSafeVideoName(undefined)).toBe(false)
    expect(isSafeVideoName(1)).toBe(false)
    expect(isSafeVideoName(['a'])).toBe(false)
  })
  it('accepts the longest allowed name', () => {
    expect(isSafeVideoName('a'.repeat(255))).toBe(true)
  })
})

describe('parseSteps', () => {
  it('reads an array, { steps }, { status } and { pipeline }', () => {
    const steps = [{ step: 'ingest', state: 'done' }]
    for (const input of [steps, { steps }, { status: steps }, { pipeline: steps }]) {
      expect(parseSteps(input)).toEqual([{ step: 'ingest', state: 'done' }])
    }
  })
  it('uses id when step is missing and todo for unknown states', () => {
    expect(parseSteps([{ id: 'captions', state: 'weird' }])).toEqual([{ step: 'captions', state: 'todo' }])
  })
  it('keeps note and at', () => {
    expect(parseSteps([{ step: 'check', state: 'needs-human', note: 'n', at: '2026' }])).toEqual([{ step: 'check', state: 'needs-human', note: 'n', at: '2026' }])
  })
  it('skips broken entries and returns [] for garbage', () => {
    expect(parseSteps([null, 1, 'x', [], { state: 'done' }, { step: 'ok' }])).toEqual([{ step: 'ok', state: 'todo' }])
    expect(parseSteps(undefined)).toEqual([])
    expect(parseSteps('steps')).toEqual([])
    expect(parseSteps({ steps: 'no' })).toEqual([])
  })
})

describe('parseNext', () => {
  it('reads { next } or the object itself', () => {
    const next = { step: 'captions', state: 'ready', why: 'w', do: 'd', commands: ['a', 1, 'b'] }
    expect(parseNext({ next })).toEqual({ step: 'captions', state: 'ready', why: 'w', do: 'd', commands: ['a', 'b'] })
    expect(parseNext(next)?.step).toBe('captions')
  })
  it('maps unknown states to ready and keeps prompt and blocking', () => {
    expect(parseNext({ step: 's', state: 'odd', prompt: 'p', blocking: ['x', 2] })).toEqual({ step: 's', state: 'ready', why: '', do: '', commands: [], prompt: 'p', blocking: ['x'] })
  })
  it('keeps needs-human and done', () => {
    expect(parseNext({ step: 's', state: 'needs-human' })?.state).toBe('needs-human')
    expect(parseNext({ step: 'done', state: 'done' })?.state).toBe('done')
  })
  it('is undefined without a step', () => {
    expect(parseNext({})).toBeUndefined()
    expect(parseNext(null)).toBeUndefined()
    expect(parseNext({ next: { state: 'ready' } })).toBeUndefined()
  })
})

describe('progressOf', () => {
  it('is 0 for no steps', () => {
    expect(progressOf([])).toBe(0)
  })
  it('counts done and skipped', () => {
    expect(progressOf([{ step: 'a', state: 'done' }, { step: 'b', state: 'skipped' }, { step: 'c', state: 'todo' }, { step: 'd', state: 'running' }])).toBe(0.5)
  })
  it('is 1 when everything is done', () => {
    expect(progressOf([{ step: 'a', state: 'done' }])).toBe(1)
  })
})

describe('parseCliJson', () => {
  it('parses the whole output', () => {
    expect(parseCliJson('{"ok":true}')).toEqual({ ok: true })
  })
  it('takes the last JSON line after progress lines', () => {
    expect(parseCliJson('{"progress":1}\nnot json\n{"ok":true,"steps":[]}\n')).toEqual({ ok: true, steps: [] })
  })
  it('skips a broken last line and uses the one before', () => {
    expect(parseCliJson('[1,2]\n{broken')).toEqual([1, 2])
  })
  it('is undefined for empty or non-JSON output', () => {
    expect(parseCliJson('')).toBeUndefined()
    expect(parseCliJson('   \n ')).toBeUndefined()
    expect(parseCliJson('hello\nworld')).toBeUndefined()
  })
})

describe('parseTemplates', () => {
  it('reads { templates } and fills missing names', () => {
    expect(parseTemplates({ templates: [{ id: 'tech', name: { ja: '技術', en: 'Tech' }, kind: 'talk' }, { id: 'x' }, { name: 'no id' }, null] })).toEqual([
      { id: 'tech', name: { ja: '技術', en: 'Tech' }, kind: 'talk' },
      { id: 'x', name: { ja: 'x', en: 'x' } }
    ])
  })
  it('keeps a string or bilingual description', () => {
    expect(parseTemplates([{ id: 'a', description: 'plain' }])[0]!.description).toBe('plain')
    expect(parseTemplates([{ id: 'a', description: { ja: 'に' } }])[0]!.description).toEqual({ ja: 'に', en: 'に' })
  })
  it('is [] for garbage', () => {
    expect(parseTemplates(undefined)).toEqual([])
    expect(parseTemplates({ templates: 'x' })).toEqual([])
  })
})

describe('cliFailure', () => {
  it('prefers the JSON error message on stdout, then stderr', () => {
    expect(cliFailure({ code: 1, stdout: '{"ok":false,"error":{"code":"exists","message":"already"}}', stderr: 'x' })).toBe('already')
    expect(cliFailure({ code: 1, stdout: '', stderr: '{"ok":false,"error":{"message":"from stderr"}}' })).toBe('from stderr')
    expect(cliFailure({ code: 1, stdout: '{"error":"plain"}', stderr: '' })).toBe('plain')
  })
  it('falls back to the last stderr line and then the exit code', () => {
    expect(cliFailure({ code: 2, stdout: '', stderr: 'first\nlast line\n\n' })).toBe('last line')
    expect(cliFailure({ code: 3, stdout: '', stderr: '' })).toBe('ferret-video exited with 3')
  })
})

describe('inVideoFolder', () => {
  it('puts the folder and a cd first (ja / en)', () => {
    const ja = inVideoFolder('/ch/2026-a', '  本文  ', 'ja')
    expect(ja.startsWith('対象の動画のフォルダ: /ch/2026-a\n')).toBe(true)
    expect(ja).toContain('cd "/ch/2026-a"')
    expect(ja.endsWith('\n\n本文')).toBe(true)
    expect(inVideoFolder('/ch/x', 'body', 'en')).toBe('Video folder: /ch/x\nWork in that folder (cd "/ch/x") and do the following.\n\nbody')
  })
})

describe('listChanged', () => {
  it('reacts to top-level folders and project files', () => {
    expect(listChanged(['2026-10-18-a'])).toBe(true)
    expect(listChanged(['2026-10-18-a/ferret-video.json'])).toBe(true)
    expect(listChanged(['old/solocut.json'])).toBe(true)
    expect(listChanged(['v/timeline.json'])).toBe(true)
    expect(listChanged(['v/.ferret-video/status.json'])).toBe(true)
    expect(listChanged(['v/.solocut/publish-result.json'])).toBe(true)
    expect(listChanged(['v/renders/youtube/final.mp4'])).toBe(true)
    expect(listChanged(['v\\renders\\final.MOV'])).toBe(true)
  })
  it('ignores media being written, hidden folders and other files', () => {
    expect(listChanged([])).toBe(false)
    expect(listChanged(['.git/index'])).toBe(false)
    expect(listChanged(['.ferret'])).toBe(false)
    expect(listChanged(['v/media/takes/t1/cam.mp4'])).toBe(false)
    expect(listChanged(['v/renders/youtube/final.mp4.part'])).toBe(false)
    expect(listChanged(['v/.ferret-video/cache/x.json'])).toBe(false)
    expect(listChanged(['v/notes.md'])).toBe(false)
  })
})

describe('compareVideos', () => {
  const e = (name: string, updatedAt: number): VideoEntry => ({ dir: `/c/${name}`, name, title: name, status: 'new', updatedAt })
  it('sorts newest first, then by folder name descending', () => {
    const list = [e('2026-01-01-a', 1), e('2026-01-03-c', 5), e('2026-01-02-b', 1)].sort(compareVideos)
    expect(list.map((v) => v.name)).toEqual(['2026-01-03-c', '2026-01-02-b', '2026-01-01-a'])
  })
})

describe('cliLang / withUiLang', () => {
  it('maps the locale to ja or en', () => {
    expect(cliLang('ja')).toBe('ja')
    expect(cliLang('ja-JP')).toBe('ja')
    expect(cliLang('JA')).toBe('ja')
    expect(cliLang('en')).toBe('en')
    expect(cliLang('fr')).toBe('en')
    expect(cliLang(undefined)).toBe('en')
  })
  it('appends --lang except for init or when already given', () => {
    expect(withUiLang(['status', '--json'], 'en')).toEqual(['status', '--json', '--lang', 'en'])
    expect(withUiLang(['init', '--template', 'tech'], 'en')).toEqual(['init', '--template', 'tech'])
    expect(withUiLang(['next', '--lang', 'ja'], 'en')).toEqual(['next', '--lang', 'ja'])
    expect(withUiLang(['next', '--lang=ja'], 'en')).toEqual(['next', '--lang=ja'])
  })
  it('does not change the input array', () => {
    const argv = ['status']
    withUiLang(argv, 'ja')
    expect(argv).toEqual(['status'])
  })
})
