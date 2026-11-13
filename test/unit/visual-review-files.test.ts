/**
 * ビジュアルレビューの main 側（src/main/visualReview.ts・screenCache.ts・visualReviewSkill.ts）を、一時フォルダで確かめる結合テスト。
 * Electron・ネットワークは使わない（NativeImage は形だけの偽物）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NativeImage } from 'electron'
import { listVisualPlans, readPlanImage, readVisualPlan, writeVisualPlanResponse } from '../../src/main/visualReview'
import { ScreenCache, type ScreenCacheTarget } from '../../src/main/screenCache'
import { syncVisualReviewSkill } from '../../src/main/visualReviewSkill'
import { shouldWatchDir } from '../../src/main/linuxTreeWatch'
import { LIMITS } from '../../src/shared/visualReview'
import { VISUAL_REVIEW_SKILL_MARKER, VISUAL_REVIEW_SKILL_NAME, isVisualReviewSkill, renderVisualReviewSkill } from '../../src/shared/visualReviewSkill'

let root: string
let outside: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ferret-vr-'))
  outside = await mkdtemp(join(tmpdir(), 'ferret-vr-out-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

const planJson = (id: string, over: Record<string, unknown> = {}): string => JSON.stringify({
  id, title: `plan ${id}`, request: 'r', revision: 1, createdAt: '2026-11-13T10:00:00Z', status: 'proposed',
  screens: [{ image: `.ferret/visual-review/${id}/s.png`, caption: 'c', annotations: [{ x: 0, y: 0, w: 0.5, h: 0.5, after: 'x' }] }],
  extra: 'keep', ...over
})

async function writePlan(id: string, text: string): Promise<void> {
  await mkdir(join(root, '.ferret', 'visual-review'), { recursive: true })
  await writeFile(join(root, '.ferret', 'visual-review', `${id}.json`), text)
}

describe('計画の一覧', () => {
  it('無ければ空', async () => {
    expect(await listVisualPlans(root)).toEqual({ plans: [], invalid: [] })
  })

  it('新しい順に読み、読めないものは理由付きで別に返す', async () => {
    await writePlan('a', planJson('a', { createdAt: '2026-11-13T09:00:00Z' }))
    await writePlan('b', planJson('b', { createdAt: '2026-11-13T11:00:00Z' }))
    await writePlan('broken', '{ not json')
    await writePlan('notitle', planJson('notitle', { title: '' }))
    await writeFile(join(root, '.ferret', 'visual-review', 'bad name!.json'), planJson('x'))
    await writeFile(join(root, '.ferret', 'visual-review', 'notes.txt'), 'ignored')
    await mkdir(join(root, '.ferret', 'visual-review', 'a'), { recursive: true })
    const listing = await listVisualPlans(root)
    expect(listing.plans.map((p) => p.id)).toEqual(['b', 'a'])
    expect(listing.invalid.map((i) => i.file)).toEqual(['bad name!.json', 'broken.json', 'notitle.json'])
    expect(listing.invalid.find((i) => i.file === 'broken.json')!.reason).toMatch(/JSON/)
  })

  it('リンクの計画・大きすぎる計画は読まない', async () => {
    await writeFile(join(outside, 'secret.json'), planJson('secret'))
    await mkdir(join(root, '.ferret', 'visual-review'), { recursive: true })
    await symlink(join(outside, 'secret.json'), join(root, '.ferret', 'visual-review', 'link.json'))
    await writePlan('big', planJson('big', { request: 'x'.repeat(LIMITS.planBytes) }))
    const listing = await listVisualPlans(root)
    expect(listing.plans).toEqual([])
    expect(listing.invalid.map((i) => i.file).sort()).toEqual(['big.json'])
  })

  it('計画のフォルダがプロジェクトの外へのリンクなら何も読まない', async () => {
    await mkdir(join(outside, 'vr'), { recursive: true })
    await writeFile(join(outside, 'vr', 'a.json'), planJson('a'))
    await mkdir(join(root, '.ferret'), { recursive: true })
    await symlink(join(outside, 'vr'), join(root, '.ferret', 'visual-review'))
    expect(await listVisualPlans(root)).toEqual({ plans: [], invalid: [] })
  })
})

describe('計画の画像', () => {
  it('.ferret/ の下の画像を data URL で返す', async () => {
    await mkdir(join(root, '.ferret', 'visual-review', 'a'), { recursive: true })
    await writeFile(join(root, '.ferret', 'visual-review', 'a', 's.png'), Buffer.from([1, 2, 3]))
    expect(await readPlanImage(root, '.ferret/visual-review/a/s.png')).toBe('data:image/png;base64,AQID')
  })

  it('外・形の違うパス・リンク・無いものは null', async () => {
    await writeFile(join(outside, 'x.png'), Buffer.from([1]))
    await writeFile(join(root, 'top.png'), Buffer.from([1]))
    await mkdir(join(root, '.ferret', 'screens'), { recursive: true })
    await symlink(join(outside, 'x.png'), join(root, '.ferret', 'screens', 'link.png'))
    expect(await readPlanImage(root, '.ferret/screens/link.png')).toBeNull()
    expect(await readPlanImage(root, 'top.png')).toBeNull()
    expect(await readPlanImage(root, '../x.png')).toBeNull()
    expect(await readPlanImage(root, join(outside, 'x.png'))).toBeNull()
    expect(await readPlanImage(root, 'screens/missing.png')).toBeNull()
    expect(await readPlanImage(root, '.ferret/screens/missing.png')).toBeNull()
  })

  it('途中のフォルダが外へのリンクなら読まない', async () => {
    await mkdir(join(outside, 'shots'), { recursive: true })
    await writeFile(join(outside, 'shots', 'a.png'), Buffer.from([1]))
    await mkdir(join(root, '.ferret'), { recursive: true })
    await symlink(join(outside, 'shots'), join(root, '.ferret', 'shots'))
    expect(await readPlanImage(root, '.ferret/shots/a.png')).toBeNull()
  })
})

describe('返事を書き足す', () => {
  it('承認で approved にし、知らない項目は残す。2回目は書かない', async () => {
    await writePlan('a', planJson('a'))
    const plan = await writeVisualPlanResponse(root, 'a', { at: '2026-11-13T12:00:00Z', action: 'approve' })
    expect(plan?.status).toBe('approved')
    const raw = JSON.parse(await readFile(join(root, '.ferret', 'visual-review', 'a.json'), 'utf8')) as Record<string, unknown>
    expect(raw.status).toBe('approved')
    expect(raw.extra).toBe('keep')
    expect(raw.responses).toEqual([{ at: '2026-11-13T12:00:00Z', action: 'approve', revision: 1 }])
    // 承認したあとでもフィードバックは書ける（いつでも送れる）。2回目の承認は書かない
    expect((await writeVisualPlanResponse(root, 'a', { at: 'later', action: 'feedback', text: 'x' }))?.status).toBe('changes-requested')
    expect(await writeVisualPlanResponse(root, 'a', { at: 'later2', action: 'approve' })).toBeNull()
  })

  it('フィードバックで changes-requested にし、囲んだ場所も残す', async () => {
    await writePlan('b', planJson('b', { revision: 3 }))
    const plan = await writeVisualPlanResponse(root, 'b', { at: 'now', action: 'feedback', text: '違う', boxes: [{ x: 0.1, y: 0.1, w: 0.2, h: 0.2, screen: 0 }] })
    expect(plan?.status).toBe('changes-requested')
    expect(plan?.responses[0]).toMatchObject({ action: 'feedback', revision: 3, text: '違う' })
  })

  it('無い・読めない・おかしな id は null', async () => {
    expect(await readVisualPlan(root, 'missing')).toBeNull()
    expect(await readVisualPlan(root, '../etc')).toBeNull()
    await writePlan('broken', '{')
    expect(await writeVisualPlanResponse(root, 'broken', { at: 'x', action: 'approve' })).toBeNull()
  })

  it('計画のファイルがリンクなら、たどった先を書き換えない', async () => {
    await writeFile(join(outside, 'p.json'), planJson('p'))
    await mkdir(join(root, '.ferret', 'visual-review'), { recursive: true })
    await symlink(join(outside, 'p.json'), join(root, '.ferret', 'visual-review', 'p.json'))
    expect(await writeVisualPlanResponse(root, 'p', { at: 'x', action: 'approve' })).toBeNull()
    expect(JSON.parse(await readFile(join(outside, 'p.json'), 'utf8')).status).toBe('proposed')
  })
})

describe('最新の画面の控え（ScreenCache）', () => {
  /** NativeImage の形だけの偽物（中身の文字列が同じなら同じ画像） */
  const fakeImage = (content: string, width = 2000, height = 1000): NativeImage => {
    const image = {
      getSize: () => ({ width, height }),
      resize: ({ width: w, height: h }: { width: number; height: number }) => fakeImage(content, w, h),
      toJPEG: () => Buffer.from(`${content}:${width}x${height}`)
    }
    return image as unknown as NativeImage
  }

  const setup = (state: { folder: string; url: string; content: string; urls?: string[] }) => {
    let capturing: (() => void) | null = null
    const cache = new ScreenCache({
      target: (): ScreenCacheTarget => ({
        folder: state.folder,
        url: state.url,
        registeredUrls: state.urls ?? [],
        capture: async () => {
          capturing?.()
          return { image: fakeImage(state.content), url: state.url, title: `title ${state.content}` }
        }
      })
    })
    return { cache, onCapture: (fn: () => void) => { capturing = fn } }
  }

  it('latest.jpg・ページごとの画像・index.json を書き、大きい画像は縮める', async () => {
    const { cache } = setup({ folder: root, url: 'http://localhost:3000/settings', content: 'A' })
    expect(await cache.captureNow()).toBe(true)
    const dir = join(root, '.ferret', 'screens')
    expect((await readFile(join(dir, 'latest.jpg'))).toString()).toBe('A:1440x720')
    expect((await readFile(join(dir, 'pages', 'localhost_3000_settings.jpg'))).toString()).toBe('A:1440x720')
    const index = JSON.parse(await readFile(join(dir, 'index.json'), 'utf8'))
    expect(index.latest).toMatchObject({ file: 'latest.jpg', url: 'http://localhost:3000/settings', title: 'title A', width: 1440, height: 720 })
    expect(index.pages[0].file).toBe('pages/localhost_3000_settings.jpg')
  })

  it('前と同じ画像なら書かない。変われば書く', async () => {
    const state = { folder: root, url: 'http://localhost:3000/', content: 'A' }
    const { cache } = setup(state)
    expect(await cache.captureNow()).toBe(true)
    expect(await cache.captureNow()).toBe(false)
    state.content = 'B'
    expect(await cache.captureNow()).toBe(true)
  })

  it('撮ってよいページでなければ撮らない（登録した URL のサイトは撮る）', async () => {
    const state = { folder: root, url: 'https://mail.example.org/inbox', content: 'A', urls: ['https://shop.example.com'] }
    const { cache } = setup(state)
    expect(await cache.captureNow()).toBe(false)
    await expect(lstat(join(root, '.ferret', 'screens'))).rejects.toThrow()
    state.url = 'https://shop.example.com/cart'
    expect(await cache.captureNow()).toBe(true)
  })

  it('撮っている間にプロジェクト・ページが替わったら書かない', async () => {
    const state = { folder: root, url: 'http://localhost:3000/', content: 'A' }
    const { cache, onCapture } = setup(state)
    onCapture(() => { state.folder = outside })
    expect(await cache.captureNow()).toBe(false)
    expect(await readdir(outside)).toEqual([])
    await expect(lstat(join(root, '.ferret'))).rejects.toThrow()
  })

  it('.ferret/screens が外へのリンクなら書かない', async () => {
    await mkdir(join(root, '.ferret'), { recursive: true })
    await symlink(outside, join(root, '.ferret', 'screens'))
    const { cache } = setup({ folder: root, url: 'http://localhost:3000/', content: 'A' })
    await expect(cache.captureNow()).rejects.toThrow()
    expect(await readdir(outside)).toEqual([])
  })

  it('ページの数の上限を超えたら古い画像を消す', async () => {
    const state = { folder: root, url: '', content: 'A' }
    const { cache } = setup(state)
    for (let i = 0; i < 42; i++) {
      state.url = `http://localhost:3000/p${i}`
      state.content = `C${i}`
      await cache.captureNow()
    }
    const pages = await readdir(join(root, '.ferret', 'screens', 'pages'))
    expect(pages).toHaveLength(40)
    expect(pages).not.toContain('localhost_3000_p0.jpg')
    expect(pages).not.toContain('localhost_3000_p1.jpg')
    expect(pages).toContain('localhost_3000_p41.jpg')
  })
})

describe('skill「ferret-visual-review」', () => {
  it('前書き・印・画面の控えと計画の置き場・止まって待つ手順がある', () => {
    const text = renderVisualReviewSkill('9.9.9')
    expect(text.startsWith(`---\nname: ${VISUAL_REVIEW_SKILL_NAME}\ndescription: `)).toBe(true)
    expect(isVisualReviewSkill(text)).toBe(true)
    expect(text).toContain(VISUAL_REVIEW_SKILL_MARKER)
    expect(text).toContain('<!-- Ferret 9.9.9 -->')
    for (const word of ['.ferret/screens/latest.jpg', '.ferret/screens/index.json', '.ferret/visual-review/<id>.json', '$FERRET_TERMINAL_ID', 'end your turn', '"status": "proposed"', '"status": "drafting"', 'after-1.jpg', 'ビジュアルレビュー']) {
      expect(text).toContain(word)
    }
    const description = text.split('\n')[2]!
    for (const word of ['UI', '画面を変えて', 'Skip only']) expect(description).toContain(word)
  })

  it('設定のフォルダがある Agent にだけ入れ、同じ中身なら書き直さない', async () => {
    const home = root
    await mkdir(join(home, '.claude'), { recursive: true })
    expect(await syncVisualReviewSkill('1.0.0', home, {})).toBe(1)
    const path = join(home, '.claude', 'skills', VISUAL_REVIEW_SKILL_NAME, 'SKILL.md')
    expect(isVisualReviewSkill(await readFile(path, 'utf8'))).toBe(true)
    await expect(lstat(join(home, '.codex'))).rejects.toThrow()
    expect(await syncVisualReviewSkill('1.0.0', home, {})).toBe(0)
    expect(await syncVisualReviewSkill('1.0.1', home, {})).toBe(1)
    expect(await readFile(path, 'utf8')).toContain('<!-- Ferret 1.0.1 -->')
  })

  it('同じ名前の Ferret のものでない skill・リンクは触らない', async () => {
    const home = root
    const dir = join(home, '.claude', 'skills', VISUAL_REVIEW_SKILL_NAME)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: ferret-visual-review\n---\nmine')
    expect(await syncVisualReviewSkill('1.0.0', home, {})).toBe(0)
    expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('mine')

    await mkdir(join(home, '.codex', 'skills'), { recursive: true })
    await mkdir(join(outside, 'target'), { recursive: true })
    await symlink(join(outside, 'target'), join(home, '.codex', 'skills', VISUAL_REVIEW_SKILL_NAME))
    expect(await syncVisualReviewSkill('1.0.0', home, {})).toBe(0)
    expect(await readdir(join(outside, 'target'))).toEqual([])
  })
})

describe('Linux の見張り', () => {
  it('計画のフォルダとその下の画像のフォルダまでは降りる', () => {
    expect(shouldWatchDir('.ferret/visual-review')).toBe(true)
    expect(shouldWatchDir('.ferret/visual-review/p1')).toBe(true)
    expect(shouldWatchDir('.ferret/visual-review/p1/deep')).toBe(false)
    expect(shouldWatchDir('.ferret/screens')).toBe(false)
  })
})
