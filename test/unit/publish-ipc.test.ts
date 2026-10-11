import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectFile, publishHandlers, readDraftPatch, readGenerateRequest, readParts, type PublishIpcDeps } from '../../src/main/publish/ipc'
import { PublishStore } from '../../src/main/publish/store'
import type { PublishBackground } from '../../src/main/publish/background'
import type { ComposerContents } from '../../src/main/publish/xComposer'

/** 発信の IPC（src/main/publish/ipc.ts）。下書きは一時フォルダ、ブラウザと AI は偽物。外へは送らない */

let dir = ''
let project = ''
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ferret-publish-ipc-'))
  project = join(dir, 'project')
  await mkdir(join(project, 'shots'), { recursive: true })
  await writeFile(join(project, 'shots', 'a.png'), 'png')
  await writeFile(join(project, 'notes.txt'), 'x')
  await writeFile(join(dir, 'outside.png'), 'png')
})
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

function fakeContents(): ComposerContents & { loaded: string[] } {
  const loaded: string[] = []
  return {
    loaded,
    loadURL: async (url: string) => { loaded.push(url) },
    getURL: () => loaded.at(-1) ?? '',
    isDestroyed: () => false,
    debugger: { attach: () => {}, detach: () => {}, isAttached: () => false, sendCommand: async () => ({}) }
  }
}

function setup(over: Partial<PublishIpcDeps> = {}) {
  const store = new PublishStore(join(dir, 'userData'))
  const background = { isRunning: () => false, runNow: vi.fn(async () => 2) } as unknown as PublishBackground
  const contents = fakeContents()
  const notifyChanged = vi.fn()
  const deps: PublishIpcDeps = {
    projectId: () => 'p1',
    projectDir: () => project,
    store,
    background,
    thumbnail: async () => undefined,
    pickFiles: async () => [],
    openComposerTab: async () => contents,
    fillComposer: async () => ({ status: 'filled', parts: 1, media: 0 }),
    fallbackUrl: (parts) => `https://x.com/intent/post?text=${encodeURIComponent(parts[0] ?? '')}`,
    notifyChanged,
    ...over
  }
  return { handlers: publishHandlers(deps), store, background, contents, notifyChanged }
}

describe('画面から来た値を確かめる', () => {
  it('生成の指示：空白だけは落とし、文章の無い出どころは付けない', () => {
    expect(readGenerateRequest(undefined)).toEqual({})
    expect(readGenerateRequest({ text: '  ', textLabel: 'a.md', hint: ' ' })).toEqual({})
    expect(readGenerateRequest({ text: ' 本文 ', textLabel: 'a.md', hint: '告知で' })).toEqual({ text: '本文', textLabel: 'a.md', hint: '告知で' })
    expect(readGenerateRequest({ text: 1, hint: ['x'] })).toEqual({})
    expect(readGenerateRequest({ hint: 'h'.repeat(9999) }).hint).toHaveLength(500)
  })

  it('下書きの変更：知らない状態・型の違う値は落とす', () => {
    expect(readDraftPatch({ title: 't', text: 'b', status: 'posted', mediaOrder: ['a', 1, 'b'] })).toEqual({ title: 't', text: 'b', status: 'posted', mediaOrder: ['a', 'b'] })
    expect(readDraftPatch({ status: 'deleted', text: 3 })).toEqual({})
    expect(readDraftPatch(null)).toEqual({})
  })

  it('投稿の本文：文字列でない・空白だけの件を落とし、25件まで', () => {
    expect(readParts('x')).toEqual([])
    expect(readParts(['a', ' ', 2, 'b'])).toEqual(['a', 'b'])
    expect(readParts(Array.from({ length: 30 }, () => 'a'))).toHaveLength(25)
  })
})

describe('プロジェクトの中のファイル（projectFile）', () => {
  it('中の普通のファイルは実パスと大きさ', async () => {
    const file = await projectFile(project, 'shots/a.png')
    expect(file?.bytes).toBe(3)
    expect(file?.path.endsWith(join('shots', 'a.png'))).toBe(true)
  })

  it('外へ出るパス・絶対パス・フォルダ・無いファイル・外へ向くリンクは null', async () => {
    await symlink(join(dir, 'outside.png'), join(project, 'link.png'))
    for (const rel of ['../outside.png', join(dir, 'outside.png'), 'shots', 'none.png', 'link.png', '', 'shots/../../outside.png']) {
      expect(await projectFile(project, rel)).toBeNull()
    }
  })
})

describe('ハンドラ', () => {
  it('プロジェクトを開いていなければ断る', async () => {
    const { handlers } = setup({ projectId: () => null })
    await expect(handlers['publish:list']()).rejects.toThrow()
    await expect(handlers['publish:create']('a')).rejects.toThrow()
  })

  it('手書きの下書きを作ると一覧に出て、変わったことを知らせる', async () => {
    const { handlers, notifyChanged } = setup()
    const id = await handlers['publish:create']('こんにちは') as string
    const list = await handlers['publish:list']() as { drafts: Array<{ id: string; text: string; source: string }> }
    expect(list.drafts).toEqual([expect.objectContaining({ id, text: 'こんにちは', source: 'manual' })])
    expect(notifyChanged).toHaveBeenCalledTimes(1)
  })

  it('生成は background.runNow を通す（同時に1つだけ）', async () => {
    const { handlers, background } = setup()
    expect(await handlers['publish:generate']({ text: '本文', hint: '告知' })).toBe(2)
    expect(background.runNow).toHaveBeenCalledWith('p1', { text: '本文', hint: '告知' })
  })

  it('プロジェクトのメディア：中のファイルは付き、外は断る。画面へ実パスを返さない', async () => {
    const { handlers } = setup()
    const id = await handlers['publish:create']('a') as string
    expect(await handlers['publish:addProjectMedia'](id, ['shots/a.png'])).toBe(1)
    await expect(handlers['publish:addProjectMedia'](id, ['../outside.png'])).rejects.toThrow()
    const list = await handlers['publish:list']() as { drafts: Array<{ media: Array<Record<string, unknown>> }> }
    expect(list.drafts[0]!.media).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(project)
  })

  it('選んだファイル：画像・動画でなければ断り、選ばなければ0', async () => {
    const id = await setup().handlers['publish:create']('a') as string
    expect(await setup({ pickFiles: async () => [] }).handlers['publish:pickMedia'](id)).toBe(0)
    await expect(setup({ pickFiles: async () => [join(project, 'notes.txt')] }).handlers['publish:pickMedia'](id)).rejects.toThrow()
    expect(await setup({ pickFiles: async () => [join(dir, 'outside.png')] }).handlers['publish:pickMedia'](id)).toBe(1)
  })

  it('X へ：メディアの実パスと本文を渡し、入れられたらそのまま返す', async () => {
    const fill = vi.fn(async () => ({ status: 'filled' as const, parts: 2, media: 1 }))
    const { handlers, contents } = setup({ fillComposer: fill })
    const id = await handlers['publish:create']('a') as string
    await handlers['publish:addProjectMedia'](id, ['shots/a.png'])
    expect(await handlers['publish:composeX'](id, ['一', '二'])).toEqual({ status: 'filled', parts: 2, media: 1 })
    expect(fill).toHaveBeenCalledWith(contents, { parts: ['一', '二'], mediaPaths: [expect.stringMatching(/a\.png$/)] })
    expect(contents.loaded).toEqual([])
  })

  it('X へ：入れられなければ、同じタブで本文だけの投稿画面を開く', async () => {
    const { handlers, contents } = setup({ fillComposer: async () => ({ status: 'fallback', reason: 'composer did not appear' }) })
    const id = await handlers['publish:create']('a') as string
    expect((await handlers['publish:composeX'](id, ['一件目', '二件目']) as { status: string }).status).toBe('fallback')
    expect(contents.loaded).toEqual([`https://x.com/intent/post?text=${encodeURIComponent('一件目')}`])
  })

  it('X へ：本文が空・ブラウザが無いときは断る（ブラウザは開かない）', async () => {
    const open = vi.fn(async () => null)
    const { handlers } = setup({ openComposerTab: open })
    const id = await handlers['publish:create']('a') as string
    await expect(handlers['publish:composeX'](id, [' '])).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
    await expect(handlers['publish:composeX'](id, ['a'])).rejects.toThrow()
  })

  it('バックグラウンドの切り替えは下書きの控えに残る', async () => {
    const { handlers, store } = setup()
    await handlers['publish:setBackground'](false)
    expect((await store.background('p1')).enabled).toBe(false)
    await handlers['publish:setBackground'](true)
    expect((await store.background('p1')).enabled).toBe(true)
  })
})
