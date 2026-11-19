/**
 * 指摘に付ける画像（どの状態に何の指摘か）。録画のレビューの feedback.md と、ビジュアルレビュー・価値ユースケースの返事から取り出し、
 * main（src/main/feedbackImages.ts）がフォルダの中の普通の画像だけに絞る。feedback.md には画像の行を書く
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractPlanFeedback, extractRecordingFeedback, renderFeedbackList, renderFeedbackSkill, type FeedbackEntry } from '../../src/shared/feedbackSkill'
import { checkLocalImage, imageSize, resolveEntryImages, toPixelBox } from '../../src/main/feedbackImages'
import { projectFeedback, syncFeedbackSkill } from '../../src/main/feedbackSkill'
import { CLOUD_LIMITS } from '../../src/shared/feedbackCloud'

/** IHDR に幅と高さを持つ PNG の頭（大きさを読むだけなので CRC は見ない） */
function png(width: number, height: number, salt = 0): Buffer {
  const b = Buffer.alloc(40)
  b.writeUInt32BE(0x89504e47, 0)
  b.writeUInt32BE(0x0d0a1a0a, 4)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  b.writeUInt32BE(salt, 30)
  return b
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-fbimg-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

const recordingMd = (images: string) => [
  '# Feedback', '',
  '## 1. [00:03] ボタン', '- ID: `a`', '- 要望: ボタンを大きく', `- 画像: ${images}`, '',
  '## 2. [00:09] 文字', '- 要望: 文字を減らす', '',
  '### 3. [00:12] 英語', '- Request: remove banner', '- Images: ./03.png'
].join('\n')

describe('録画のレビューの画像', () => {
  it('同じ節の「- 画像:」を要望に付ける。画像の無い節には付けない。英語の見出しも読む', () => {
    const out = extractRecordingFeedback(recordingMd('./01.png / ./02.png'), 'A', '/p/.ferret/reviews/r1/feedback.md')
    expect(out.map((e) => e.text)).toEqual(['ボタンを大きく', '文字を減らす', 'remove banner'])
    expect(out[0]!.images).toEqual([{ path: '/p/.ferret/reviews/r1/01.png' }, { path: '/p/.ferret/reviews/r1/02.png' }])
    expect(out[1]!.images).toBeUndefined()
    expect(out[2]!.images).toEqual([{ path: '/p/.ferret/reviews/r1/03.png' }])
  })

  it('./NN.png の形だけ（.. や絶対パス・ほかの拡張子は捨てる）、4枚まで', () => {
    const out = extractRecordingFeedback(recordingMd('../x.png / /etc/a.png / ./a/../01.png / ./01.jpg / ./1.png / ./2.png / ./3.png / ./4.png / ./5.png'), 'A', '/p/r/feedback.md')
    expect(out[0]!.images!.map((i) => i.path)).toEqual(['/p/r/1.png', '/p/r/2.png', '/p/r/3.png', '/p/r/4.png'])
  })

  it('Windows のパスでも同じフォルダに付ける', () => {
    const out = extractRecordingFeedback(recordingMd('./01.png'), 'A', 'C:\\p\\.ferret\\reviews\\r\\feedback.md')
    expect(out[0]!.images).toEqual([{ path: 'C:\\p\\.ferret\\reviews\\r\\01.png' }])
  })
})

describe('ビジュアルレビュー・価値ユースケースの画像', () => {
  const visual = JSON.stringify({
    title: 'S', screens: [{ image: '.ferret/visual-review/p1/a.png' }, { image: '../../etc/passwd.png' }],
    responses: [
      { action: 'feedback', at: '2026-11-01T00:00:00Z', text: '余白', boxes: [{ screen: 0, x: 0.1, y: 0.2, w: 0.5, h: 0.25, note: 'ここ' }, { screen: 1, x: 0, y: 0, w: 1, h: 1 }, { screen: 9, x: 0, y: 0, w: 1, h: 1 }],
        kind: 'recording', review: { id: 'r1', dir: '.ferret/reviews/r1', findings: [], screenshots: ['.ferret/reviews/r1/01.png', '/abs/x.png'] } },
      { action: 'feedback', text: '画像なし' },
      { action: 'approve', text: 'OK' }
    ]
  })

  it('囲んだ画面の画像に割合の囲み、録画のレビューの画像は囲みなしで付ける。外へ出るパスは捨てる', () => {
    const out = extractPlanFeedback(visual, 'A', 'visual-review', '/p/.ferret/visual-review/p1.json', '/p')
    expect(out).toHaveLength(2)
    expect(out[0]!.images).toEqual([
      { path: '/p/.ferret/visual-review/p1/a.png', frac: { x: 0.1, y: 0.2, w: 0.5, h: 0.25 } },
      { path: '/p/.ferret/reviews/r1/01.png' }
    ])
    expect(out[1]!.images).toBeUndefined()
  })

  it('projectDir が無ければ画像を付けない（前と同じ）', () => {
    expect(extractPlanFeedback(visual, 'A', 'visual-review', '/f.json')[0]!.images).toBeUndefined()
  })

  it('価値ユースケースは values[value].flow[step].image', () => {
    const doc = JSON.stringify({
      title: 'V', values: [{ flow: [{ image: '.ferret/value-usecases/v/1.png' }, { image: '.ferret/value-usecases/v/2.svg' }] }],
      responses: [{ action: 'feedback', text: '手順2', boxes: [{ value: 0, step: 1, x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, { value: 3, step: 0, x: 0, y: 0, w: 1, h: 1 }] }]
    })
    const out = extractPlanFeedback(doc, 'A', 'value-usecases', '/p/x.json', '/p')
    expect(out[0]!.images).toEqual([{ path: '/p/.ferret/value-usecases/v/2.svg', frac: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }])
  })
})

describe('画像の大きさ', () => {
  it('PNG・JPEG・WebP・SVG の頭から読む。壊れていれば null', () => {
    expect(imageSize(png(800, 600), 'png')).toEqual({ width: 800, height: 600 })
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0x03, 0, 0, 0, 0, 0, 0])
    expect(imageSize(jpeg, 'jpeg')).toEqual({ width: 600, height: 300 })
    const webp = Buffer.alloc(32)
    webp.write('RIFF', 0, 'ascii'); webp.write('WEBP', 8, 'ascii'); webp.write('VP8X', 12, 'ascii')
    webp.writeUIntLE(1279, 24, 3); webp.writeUIntLE(719, 27, 3)
    expect(imageSize(webp, 'webp')).toEqual({ width: 1280, height: 720 })
    expect(imageSize(Buffer.from('<svg xmlns="x" width="390px" height="844">'), 'svg')).toEqual({ width: 390, height: 844 })
    expect(imageSize(Buffer.from('<svg viewBox="0 0 1440 900">'), 'svg')).toEqual({ width: 1440, height: 900 })
    expect(imageSize(Buffer.from('not an image'), 'png')).toBeNull()
    expect(imageSize(Buffer.from('<svg>'), 'svg')).toBeNull()
  })

  it('割合の囲みをピクセルにする（幅・高さは 1 以上）', () => {
    expect(toPixelBox({ x: 0.1, y: 0.2, w: 0.5, h: 0.25 }, { width: 1000, height: 800 })).toEqual({ x: 100, y: 160, w: 500, h: 200, width: 1000, height: 800 })
    expect(toPixelBox({ x: 0, y: 0, w: 0.0001, h: 0.0001 }, { width: 10, height: 10 }).w).toBe(1)
  })
})

describe('手元の画像の確かめ', () => {
  it('フォルダの中の普通の画像だけ。リンク・外・大きすぎる・形式違い・空・無いものは捨てる', async () => {
    const root = join(dir, 'p', '.ferret')
    await mkdir(join(root, 'r'), { recursive: true })
    await writeFile(join(root, 'r', 'ok.png'), png(10, 10))
    await writeFile(join(dir, 'outside.png'), png(10, 10))
    await symlink(join(dir, 'outside.png'), join(root, 'r', 'link.png'))
    await symlink(dir, join(root, 'up'))
    await writeFile(join(root, 'r', 'big.png'), Buffer.alloc(CLOUD_LIMITS.imageBytes + 1))
    await writeFile(join(root, 'r', 'a.gif'), png(1, 1))
    await writeFile(join(root, 'r', 'empty.png'), '')
    expect(await checkLocalImage(join(root, 'r', 'ok.png'), root)).toMatchObject({ type: 'png', size: 40 })
    for (const bad of [join(root, 'r', 'link.png'), join(root, 'up', 'outside.png'), join(root, 'r', '..', '..', '..', 'outside.png'), join(root, 'r', 'big.png'), join(root, 'r', 'a.gif'), join(root, 'r', 'empty.png'), join(root, 'r', 'none.png')]) {
      expect(await checkLocalImage(bad, root), bad).toBeNull()
    }
  })

  it('割合の囲みは画像の大きさで、読めなければ 1000×1000 で box にする', async () => {
    const root = join(dir, '.ferret')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'a.png'), png(200, 100))
    await writeFile(join(root, 'b.png'), 'xx')
    const out = await resolveEntryImages([
      { path: join(root, 'a.png'), frac: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 } },
      { path: join(root, 'b.png'), frac: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } },
      { path: join(root, 'missing.png') }
    ], root)
    expect(out).toEqual([
      { path: join(root, 'a.png'), box: { x: 100, y: 50, w: 100, h: 50, width: 200, height: 100 } },
      { path: join(root, 'b.png'), box: { x: 100, y: 100, w: 100, h: 100, width: 1000, height: 1000 } }
    ])
  })
})

describe('プロジェクトから集める', () => {
  it('録画のレビューと計画の画像を、あるものだけ付ける（リンクで外を指すものは外す）', async () => {
    const proj = join(dir, 'proj')
    const review = join(proj, '.ferret', 'reviews', '20261101-101010')
    const vr = join(proj, '.ferret', 'visual-review')
    await mkdir(review, { recursive: true })
    await mkdir(join(vr, 'p1'), { recursive: true })
    await writeFile(join(review, 'feedback.md'), recordingMd('./01.png / ./02.png'))
    await writeFile(join(review, '01.png'), png(4, 4))
    await writeFile(join(dir, 'secret.png'), png(4, 4))
    await symlink(join(dir, 'secret.png'), join(review, '02.png'))
    await writeFile(join(vr, 'p1', 'a.png'), png(1000, 500))
    await writeFile(join(vr, 'p1.json'), JSON.stringify({ title: 'S', screens: [{ image: '.ferret/visual-review/p1/a.png' }], responses: [{ action: 'feedback', text: '余白', boxes: [{ screen: 0, x: 0.1, y: 0.1, w: 0.2, h: 0.2 }] }] }))
    const entries = await projectFeedback({ name: 'P', folderPath: proj })
    const rec = entries.find((e) => e.text === 'ボタンを大きく')!
    expect(rec.images).toEqual([{ path: join(review, '01.png') }])
    expect(entries.find((e) => e.text === '文字を減らす')!.images).toBeUndefined()
    expect(entries.find((e) => e.text === 'remove banner')!.images).toBeUndefined() // 03.png は無い
    expect(entries.find((e) => e.text === '余白')!.images).toEqual([{ path: join(vr, 'p1', 'a.png'), box: { x: 100, y: 50, w: 200, h: 100, width: 1000, height: 500 } }])

    const home = join(dir, 'home')
    await mkdir(join(home, '.claude'), { recursive: true })
    await syncFeedbackSkill('1.0.0', [{ id: 'p', name: 'P', folderPath: proj, urls: [] }], home, {})
    const md = await readFile(join(home, '.claude', 'skills', 'ferret-feedback', 'feedback.md'), 'utf8')
    expect(md).toContain(`  - image: ${join(review, '01.png')}\n`)
    expect(md).toContain(`  - image: ${join(vr, 'p1', 'a.png')} (box 100,50 200×100 on 1000×500)`)
    expect(md).not.toContain('secret.png')
  })
})

describe('feedback.md の画像の行', () => {
  const entry: FeedbackEntry = { project: 'A', source: 'visual-review', text: '余白を詰める', at: '2026-11-01', file: '/p/x.json',
    images: [{ path: '/p/.ferret/a.png', box: { x: 1, y: 2, w: 3, h: 4, width: 10, height: 20 } }, { path: '/p/.ferret/b.png' }, { path: '/p/c.png', frac: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } }] }

  it('指摘の行の下に字下げで書く（囲みがあれば位置と大きさ）', () => {
    const md = renderFeedbackList([entry])
    expect(md).toContain('— 余白を詰める (`/p/x.json`)\n  - image: /p/.ferret/a.png (box 1,2 3×4 on 10×20)\n  - image: /p/.ferret/b.png\n  - image: /p/c.png (box x 10% y 20% w 30% h 40% of the image)')
  })

  it('ほかの PC・チームの指摘も、控えた画像の行を書く', () => {
    const md = renderFeedbackList([], undefined, [], {
      otherDevices: [{ project: 'A', source: 'recording', text: 'ボタンが小さい', deviceName: 'Office', images: [{ path: '/cache/h.png' }] }],
      teams: [{ name: 'T', entries: [{ project: 'B', source: 'visual-review', text: 'バナーはいらない', deviceName: 'X', author: 'Bob', images: [{ path: '/cache/t.png', box: { x: 0, y: 0, w: 5, h: 5, width: 50, height: 50 } }] }] }]
    })
    expect(md).toContain('ボタンが小さい (other PC: Office)\n  - image: /cache/h.png')
    expect(md).toContain('バナーはいらない (T · Bob)\n  - image: /cache/t.png (box 0,0 5×5 on 50×50)')
  })

  it('skill に「画像を開いてどの状態かを見る」と書く', () => {
    const skill = renderFeedbackSkill('1', '/l.md', '/p.md')
    expect(skill).toContain('image:')
    expect(skill).toContain('Open the image to see which state')
  })
})
