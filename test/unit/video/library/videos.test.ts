import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync, chmodSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  channelRelative, isStrictlyInside, isVideoChannel, latestRender, listVideos, readVideo, resolveVideoDir, uniqueChild, videoProjectKind, videoStatus
} from '@video/app/main/library/videos'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-video-lib-')))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function file(rel: string, text = '', mtimeSec?: number): string {
  const p = join(root, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
  if (mtimeSec !== undefined) utimesSync(p, mtimeSec, mtimeSec)
  return p
}

function video(name: string, json: object = { title: name }, legacy = false): string {
  file(`${name}/${legacy ? 'solocut.json' : 'ferret-video.json'}`, JSON.stringify(json))
  return join(root, name)
}

describe('uniqueChild', () => {
  it('returns the name when free, then -2, -3', () => {
    expect(uniqueChild(root, 'a')).toBe(join(root, 'a'))
    mkdirSync(join(root, 'a'))
    expect(uniqueChild(root, 'a')).toBe(join(root, 'a-2'))
    mkdirSync(join(root, 'a-2'))
    expect(uniqueChild(root, 'a')).toBe(join(root, 'a-3'))
  })
  it('gives up after too many', () => {
    expect(() => uniqueChild(root, 'a', () => true)).toThrow(/too many/)
  })
})

describe('videoStatus', () => {
  it('is new for an empty project', () => {
    expect(videoStatus(video('v'))).toBe('new')
  })
  it('is editing with a take folder, a take file or an import', () => {
    const v = video('v')
    mkdirSync(join(v, 'media', 'takes', 'take_1'), { recursive: true })
    expect(videoStatus(v)).toBe('editing')
    const w = video('w')
    file('w/media/imports/clip.mov')
    expect(videoStatus(w)).toBe('editing')
  })
  it('ignores hidden files in takes', () => {
    const v = video('v')
    file('v/media/takes/.DS_Store')
    expect(videoStatus(v)).toBe('new')
  })
  it('is done with a final render, any render video, but not a partial one', () => {
    const v = video('v')
    file('v/renders/youtube/final.mp4')
    expect(videoStatus(v)).toBe('done')
    const w = video('w')
    file('w/renders/out.webm')
    expect(videoStatus(w)).toBe('done')
    const x = video('x')
    file('x/renders/out.mp4.part')
    expect(videoStatus(x)).toBe('new')
  })
  it('is posted from a publish result, a done publish step or a published output', () => {
    const a = video('a')
    file('a/.ferret-video/publish-result.json', JSON.stringify({ results: [{ ok: false }, { ok: true }] }))
    expect(videoStatus(a)).toBe('posted')
    const b = video('b')
    file('b/.ferret-video/status.json', JSON.stringify({ steps: [{ step: 'publish', state: 'done' }] }))
    expect(videoStatus(b)).toBe('posted')
    const c = video('c')
    file('c/timeline.json', JSON.stringify({ outputs: [{ publish: { status: 'scheduled' } }] }))
    expect(videoStatus(c)).toBe('posted')
    const d = video('d', {}, true)
    file('d/.solocut/publish-result.json', JSON.stringify({ results: [{ ok: true }] }))
    expect(videoStatus(d)).toBe('posted')
  })
  it('is not posted from a failed result or broken files', () => {
    const a = video('a')
    file('a/.ferret-video/publish-result.json', JSON.stringify({ results: [{ ok: false }] }))
    file('a/.ferret-video/status.json', '{broken')
    file('a/timeline.json', 'null')
    expect(videoStatus(a)).toBe('new')
  })
  it('posted wins over done', () => {
    const a = video('a')
    file('a/renders/final.mp4')
    file('a/.ferret-video/status.json', JSON.stringify([{ step: 'publish', state: 'done' }]))
    expect(videoStatus(a)).toBe('posted')
  })
})

describe('readVideo / videoProjectKind', () => {
  it('uses the title and template from ferret-video.json', () => {
    const v = video('2026-a', { title: '  タイトル ', template: { id: 'tech' } })
    expect(readVideo(v, '2026-a')).toMatchObject({ name: '2026-a', title: 'タイトル', template: 'tech', status: 'new' })
    expect(videoProjectKind(v)).toBe('current')
  })
  it('falls back to the folder name for a blank, missing or broken title', () => {
    expect(readVideo(video('a', { title: '   ' }), 'a').title).toBe('a')
    expect(readVideo(video('b', {}), 'b').title).toBe('b')
    file('c/ferret-video.json', '{oops')
    expect(readVideo(join(root, 'c'), 'c').title).toBe('c')
  })
  it('marks legacy Solocut projects', () => {
    const v = video('old', { title: 'Old' }, true)
    expect(videoProjectKind(v)).toBe('legacy')
    expect(readVideo(v, 'old')).toMatchObject({ title: 'Old', legacy: true })
  })
  it('prefers ferret-video.json when both exist', () => {
    const v = video('both', { title: 'new' })
    file('both/solocut.json', JSON.stringify({ title: 'old' }))
    expect(videoProjectKind(v)).toBe('current')
    expect(readVideo(v, 'both').legacy).toBeUndefined()
  })
  it('is null for a plain folder', () => {
    mkdirSync(join(root, 'plain'))
    expect(videoProjectKind(join(root, 'plain'))).toBeNull()
  })
})

describe('listVideos', () => {
  it('reports a missing root', () => {
    expect(listVideos(join(root, 'nope'))).toEqual({ root: join(root, 'nope'), exists: false, videos: [] })
  })
  it('reports a root that is a file', () => {
    const f = file('afile')
    expect(listVideos(f)).toMatchObject({ exists: true, videos: [], error: 'notDir' })
  })
  it('is empty for an empty channel', () => {
    expect(listVideos(root)).toEqual({ root, exists: true, videos: [] })
  })
  it('lists only video projects, newest first, including legacy ones', () => {
    video('2026-01-01-a')
    video('2026-01-02-b')
    video('old', { title: 'Old' }, true)
    mkdirSync(join(root, 'not-a-video'))
    mkdirSync(join(root, '.hidden'))
    file('.hidden/ferret-video.json', '{}')
    file('loose.txt')
    utimesSync(join(root, '2026-01-01-a'), 100, 100)
    utimesSync(join(root, '2026-01-01-a', 'ferret-video.json'), 100, 100)
    utimesSync(join(root, '2026-01-02-b'), 200, 200)
    utimesSync(join(root, '2026-01-02-b', 'ferret-video.json'), 200, 200)
    utimesSync(join(root, 'old'), 300, 300)
    utimesSync(join(root, 'old', 'solocut.json'), 300, 300)
    const list = listVideos(root)
    expect(list.videos.map((v) => v.name)).toEqual(['old', '2026-01-02-b', '2026-01-01-a'])
    expect(list.videos[0]!.legacy).toBe(true)
  })
  it('uses the newest of the folder, the project file, timeline and status for updatedAt', () => {
    const v = video('v')
    utimesSync(v, 100, 100)
    utimesSync(join(v, 'ferret-video.json'), 100, 100)
    file('v/.ferret-video/status.json', '[]', 500)
    utimesSync(v, 100, 100)
    expect(listVideos(root).videos[0]!.updatedAt).toBe(500_000)
  })
  it('does not follow links to folders outside the channel', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-video-out-')))
    try {
      writeFileSync(join(outside, 'ferret-video.json'), '{}')
      symlinkSync(outside, join(root, 'link'))
      expect(listVideos(root).videos).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('reports a folder it may not read', () => {
    const locked = join(root, 'locked')
    mkdirSync(locked)
    chmodSync(locked, 0o000)
    try {
      expect(listVideos(locked).error).toBe('permission')
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

describe('isVideoChannel', () => {
  it('is false for empty, missing or non-video folders', () => {
    expect(isVideoChannel('')).toBe(false)
    expect(isVideoChannel(root)).toBe(false)
    expect(isVideoChannel(join(root, 'missing'))).toBe(false)
    mkdirSync(join(root, 'src'))
    expect(isVideoChannel(root)).toBe(false)
  })
  it('is true with one current or legacy video folder', () => {
    video('v')
    expect(isVideoChannel(root)).toBe(true)
    rmSync(join(root, 'v'), { recursive: true })
    video('old', {}, true)
    expect(isVideoChannel(root)).toBe(true)
  })
  it('ignores hidden folders and node_modules', () => {
    file('.x/ferret-video.json', '{}')
    file('node_modules/ferret-video.json', '{}')
    expect(isVideoChannel(root)).toBe(false)
  })
  it('stops after the limit', () => {
    for (let i = 0; i < 5; i++) mkdirSync(join(root, `a${i}`))
    video('z')
    expect(isVideoChannel(root, 3)).toBe(false)
    expect(isVideoChannel(root, 100)).toBe(true)
  })
})

describe('isStrictlyInside', () => {
  it('is true only for children', () => {
    expect(isStrictlyInside('/a/b', '/a/b/c')).toBe(true)
    expect(isStrictlyInside('/a/b', '/a/b')).toBe(false)
    expect(isStrictlyInside('/a/b', '/a/bc')).toBe(false)
    expect(isStrictlyInside('/a/b', '/a')).toBe(false)
    expect(isStrictlyInside('/a/b', '/x/y')).toBe(false)
  })
  it('allows a child whose name starts with two dots', () => {
    expect(isStrictlyInside('/a', '/a/..x')).toBe(true)
  })
})

describe('resolveVideoDir', () => {
  it('returns the real path of a video folder', () => {
    video('v')
    expect(resolveVideoDir(root, 'v')).toBe(join(root, 'v'))
  })
  it('refuses without an open project', () => {
    expect(() => resolveVideoDir(null, 'v')).toThrow(/no project/)
  })
  it.each(['..', '../x', 'a/b', '.hidden', '', 'x\u0000'])('refuses the name %j', (name) => {
    expect(() => resolveVideoDir(root, name)).toThrow(/invalid/)
  })
  it('refuses a missing folder and a folder that is not a video', () => {
    expect(() => resolveVideoDir(root, 'missing')).toThrow(/not found/)
    mkdirSync(join(root, 'plain'))
    expect(() => resolveVideoDir(root, 'plain')).toThrow(/not a video/)
    file('afile.txt')
    expect(() => resolveVideoDir(root, 'afile.txt')).toThrow(/not a video/)
  })
  it('refuses a link that points outside the channel', () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'ferret-video-out-')))
    try {
      writeFileSync(join(outside, 'ferret-video.json'), '{}')
      symlinkSync(outside, join(root, 'link'))
      expect(() => resolveVideoDir(root, 'link')).toThrow(/outside/)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
  it('accepts a link to another video inside the channel', () => {
    video('real')
    symlinkSync(join(root, 'real'), join(root, 'alias'))
    expect(resolveVideoDir(root, 'alias')).toBe(join(root, 'real'))
  })
})

describe('latestRender', () => {
  it('is null without renders', () => {
    expect(latestRender(video('v'))).toBeNull()
  })
  it('prefers the newer of preview and final, final on a tie', () => {
    const v = video('v')
    file('v/renders/youtube/preview.mp4', '', 100)
    file('v/renders/youtube/final.mp4', '', 200)
    expect(latestRender(v)).toBe('renders/youtube/final.mp4')
    file('v/renders/youtube/preview.mp4', '', 300)
    expect(latestRender(v)).toBe('renders/youtube/preview.mp4')
    file('v/renders/youtube/preview.mp4', '', 200)
    expect(latestRender(v)).toBe('renders/youtube/final.mp4')
  })
  it('uses the older candidate places', () => {
    const v = video('v')
    file('v/renders/final.mp4', '', 100)
    expect(latestRender(v)).toBe('renders/final.mp4')
  })
  it('falls back to the newest video under renders, skipping vertical variants, thumbnails and partial files', () => {
    const v = video('v')
    file('v/renders/a/one.mp4', '', 100)
    file('v/renders/b/two.mov', '', 200)
    file('v/renders/tiktok/vertical.mp4', '', 900)
    file('v/renders/thumbnails/x.mp4', '', 900)
    file('v/renders/b/three.mp4.part', '', 900)
    file('v/renders/.cache/hidden.mp4', '', 900)
    expect(latestRender(v)).toBe('renders/b/two.mov')
  })
  it('does not go deeper than 3 levels', () => {
    const v = video('v')
    file('v/renders/a/b/c/d/deep.mp4', '', 100)
    expect(latestRender(v)).toBeNull()
  })
})

describe('channelRelative', () => {
  it('is the path from the channel with forward slashes', () => {
    const v = video('2026-a')
    expect(channelRelative(root, v, 'renders/youtube/final.mp4')).toBe('2026-a/renders/youtube/final.mp4')
  })
})
