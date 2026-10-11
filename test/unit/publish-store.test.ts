import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PUBLISH_LIMITS } from '../../src/shared/publish'
import { PublishStore, sanitizeProjectData, titleFromText, type NewDraft } from '../../src/main/publish/store'

/**
 * 「発信」の下書きの置き場（src/main/publish/store.ts）。一時フォルダに書き、時計は差し替える。
 */

let dir: string
let clock: number
const P = 'project-a'
const MB = 1024 * 1024

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ferret-publish-store-'))
  clock = Date.parse('2026-10-01T00:00:00.000Z')
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeStore(): PublishStore {
  return new PublishStore(dir, () => clock)
}

function draft(text: string, extra: Partial<NewDraft> = {}): NewDraft {
  return { source: 'manual', title: '', text, ...extra }
}

describe('PublishStore の保存と読み込み', () => {
  it('プロジェクトごとに sha256 の名前のファイルへ、所有者だけが読める形で書く', async () => {
    const store = makeStore()
    await store.add(P, [draft('こんにちは')])
    const path = store.pathOf(P)
    expect(path).toMatch(/[/\\]publish[/\\][0-9a-f]{32}\.json$/)
    expect(path).not.toContain(P)
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o600)
    const reread = await makeStore().snapshot(P)
    expect(reread.drafts.map((d) => d.text)).toEqual(['こんにちは'])
    expect(reread.background).toEqual({ enabled: true, running: false })
    // 別のプロジェクトは別のファイル
    expect((await makeStore().snapshot('project-b')).drafts).toEqual([])
  })

  it('壊れたファイル・JSON でないファイルは空として扱う', async () => {
    const store = makeStore()
    const path = store.pathOf(P)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, '{not json')
    expect((await store.snapshot(P)).drafts).toEqual([])
    await writeFile(path, 'null')
    expect((await makeStore().snapshot(P)).drafts).toEqual([])
    // 壊れていても足せば正しく書き直す
    await store.add(P, [draft('x')])
    expect(JSON.parse(await readFile(path, 'utf8')).drafts).toHaveLength(1)
  })

  it('別のプロジェクトの id が入ったファイルは使わない', async () => {
    expect(sanitizeProjectData({ projectId: 'other', drafts: [{ id: 'aaaaaaaa' }] }, P).drafts).toEqual([])
  })

  it('形の合わない下書き・メディアを捨て、新しい順に並べる', () => {
    const good = { id: 'a1b2c3d4', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', source: 'manual', status: 'new', title: 't', text: 'x' }
    const data = sanitizeProjectData({
      projectId: P,
      drafts: [
        good,
        { ...good, id: 'a1b2c3d4' }, // 重複
        { ...good, id: 'NOT-HEX!' },
        { ...good, id: 'b1b2c3d4', status: 'weird' },
        { ...good, id: 'c1b2c3d4', source: 'robot' },
        { ...good, id: 'd1b2c3d4', createdAt: 'yesterday' },
        { ...good, id: 'e1b2c3d4', text: 42 },
        null,
        'junk',
        {
          ...good, id: 'f1b2c3d4', createdAt: '2026-02-01T00:00:00Z', title: '  ',
          text: '一行目\n二行目',
          media: [
            { id: '11111111', kind: 'image', name: 'a.png', bytes: 10, path: '/abs/a.png' },
            { id: '22222222', kind: 'video', name: 'a.png', bytes: 10, path: '/abs/b.png' }, // 拡張子と種類が合わない
            { id: '33333333', kind: 'image', name: 'c.png', bytes: 10, path: 'rel/c.png' }, // 相対パス
            { id: '44444444', kind: 'image', name: 'd.txt', bytes: 10, path: '/abs/d.txt' }, // 知らない形式
            { id: '55555555', kind: 'image', name: 'e.png', bytes: -1, path: '/abs/e.png' },
            { id: '11111111', kind: 'image', name: 'dup.png', bytes: 1, path: '/abs/dup.png' }
          ]
        }
      ],
      background: { enabled: false, lastRunAt: 'nope', lastError: 'boom', lastHead: 'zzz' }
    }, P)
    expect(data.drafts.map((d) => d.id)).toEqual(['f1b2c3d4', 'a1b2c3d4'])
    expect(data.drafts[0].title).toBe('一行目')
    expect(data.drafts[0].media.map((m) => m.id)).toEqual(['11111111'])
    expect(data.background).toEqual({ enabled: false, lastError: 'boom' })
  })

  it('X の決まりから外れたメディアの組み合わせは、収まる分だけ残す', () => {
    const media = Array.from({ length: 6 }, (_, i) => ({ id: `${i}0000000`, kind: 'image', name: `${i}.png`, bytes: 1, path: `/abs/${i}.png` }))
    const data = sanitizeProjectData({ projectId: P, drafts: [{ id: 'a1b2c3d4', createdAt: '2026-01-01T00:00:00Z', source: 'manual', status: 'new', title: 't', text: 'x', media }] }, P)
    expect(data.drafts[0].media).toHaveLength(4)
  })
})

describe('PublishStore.add', () => {
  it('渡した順で先頭に足し、AI の空の本文は捨て、題が無ければ本文から作る', async () => {
    const store = makeStore()
    await store.add(P, [draft('古い')])
    clock += 1000
    const added = await store.add(P, [draft('  一つ目\n続き  ', { title: '' }), draft('   ', { source: 'ai-text' }), draft('二つ目', { title: '題\n  です', basis: '  コミット abc ' })])
    expect(added).toHaveLength(2)
    expect(added[1]).toMatchObject({ title: '題 です', basis: 'コミット abc', status: 'new', source: 'manual' })
    expect(added[0].id).toMatch(/^[0-9a-f]{16}$/)
    const snap = await store.snapshot(P)
    expect(snap.drafts.map((d) => d.text)).toEqual(['一つ目\n続き', '二つ目', '古い'])
    expect(snap.drafts[0].title).toBe('一つ目')
    expect(snap.drafts[0].createdAt).toBe(new Date(clock).toISOString())
  })

  it('手書きの下書きは白紙（空の本文）でも作れる', async () => {
    const store = makeStore()
    const [blank] = await store.add(P, [draft('')])
    expect(blank).toMatchObject({ text: '', title: '', source: 'manual' })
    expect((await store.snapshot(P)).drafts.map((d) => d.id)).toEqual([blank!.id])
    expect(await store.add(P, [draft('', { source: 'ai-background' })])).toEqual([])
  })

  it('上限を超えたら、使い終わったものの古い順、次に未使用の古い順に忘れる', async () => {
    const store = makeStore()
    const max = PUBLISH_LIMITS.draftsPerProject
    const ids: string[] = []
    for (let i = 0; i < max; i++) {
      clock += 1
      ids.push((await store.add(P, [draft(`d${i}`)]))[0].id)
    }
    // いちばん新しいもののうち2つを使い終わりにする
    await store.update(P, ids[max - 1], { status: 'posted' })
    await store.update(P, ids[max - 2], { status: 'dismissed' })
    clock += 1
    await store.add(P, [draft('n1'), draft('n2'), draft('n3')])
    const texts = (await store.snapshot(P)).drafts.map((d) => d.text)
    expect(texts).toHaveLength(max)
    expect(texts).not.toContain(`d${max - 1}`)
    expect(texts).not.toContain(`d${max - 2}`)
    // 使い終わったものが尽きたら未使用の古いもの
    expect(texts).not.toContain('d0')
    expect(texts).toContain('d1')
    expect(texts.slice(0, 3)).toEqual(['n1', 'n2', 'n3'])
  })

  it('一度に上限より多く渡されたら、先頭から上限まで', async () => {
    const store = makeStore()
    const many = Array.from({ length: PUBLISH_LIMITS.draftsPerProject + 5 }, (_, i) => draft(`m${i}`))
    expect(await store.add(P, many)).toHaveLength(PUBLISH_LIMITS.draftsPerProject)
  })

  it('メディアは知っている形式・絶対パスで、X の決まりに収まる分だけ付ける', async () => {
    const store = makeStore()
    const [d] = await store.add(P, [draft('x', {
      media: [
        { path: '/abs/a.png', bytes: 10 }, { path: 'rel/b.png', bytes: 1 }, { path: '/abs/c.txt', bytes: 1 },
        { path: '/abs/v.mp4', bytes: 1 }, { path: '/abs/a.png', bytes: 10 }, { path: '/abs/huge.jpg', bytes: 6 * MB }
      ]
    })])
    expect(d.media.map((m) => m.name)).toEqual(['a.png'])
    expect(JSON.stringify(d)).not.toContain('/abs/')
  })

  it('本文は上限で切る', async () => {
    const [d] = await makeStore().add(P, [draft('あ'.repeat(PUBLISH_LIMITS.textChars + 10))])
    expect(d.text.length).toBe(PUBLISH_LIMITS.textChars)
  })
})

describe('PublishStore.update', () => {
  it('題・本文を変え、updatedAt を進める', async () => {
    const store = makeStore()
    const [d] = await store.add(P, [draft('本文')])
    clock += 5000
    const next = await store.update(P, d.id, { title: '  新しい題 ', text: '新しい本文' })
    expect(next).toMatchObject({ title: '新しい題', text: '新しい本文', updatedAt: new Date(clock).toISOString() })
    // 題を空にしたら本文から
    expect((await store.update(P, d.id, { title: '' })).title).toBe('新しい本文')
  })

  it('長すぎる題・本文は断る（ちょうど上限は通す）', async () => {
    const store = makeStore()
    const [d] = await store.add(P, [draft('本文')])
    await expect(store.update(P, d.id, { title: 'a'.repeat(PUBLISH_LIMITS.titleChars + 1) })).rejects.toMatchObject({ userFacing: true })
    await expect(store.update(P, d.id, { text: 'a'.repeat(PUBLISH_LIMITS.textChars + 1) })).rejects.toMatchObject({ userFacing: true })
    await expect(store.update(P, d.id, { title: '題'.repeat(PUBLISH_LIMITS.titleChars), text: 'a'.repeat(PUBLISH_LIMITS.textChars) })).resolves.toBeTruthy()
    // 空の本文は書いている途中として受け付ける
    await expect(store.update(P, d.id, { text: '' })).resolves.toMatchObject({ text: '' })
  })

  it('無い下書きは利用者向けのエラー', async () => {
    await expect(makeStore().update(P, 'deadbeef', { text: 'x' })).rejects.toMatchObject({ userFacing: true })
  })

  it('状態の移り方を確かめ、投稿したら postedAt を付ける', async () => {
    const store = makeStore()
    const [d] = await store.add(P, [draft('本文')])
    clock += 1000
    const posted = await store.update(P, d.id, { status: 'posted' })
    expect(posted.postedAt).toBe(new Date(clock).toISOString())
    await expect(store.update(P, d.id, { status: 'new' })).rejects.toThrow(/posted -> new/)
    const dismissed = await store.update(P, d.id, { status: 'dismissed' })
    expect(dismissed.postedAt).toBe(posted.postedAt)
    const back = await store.update(P, d.id, { status: 'new' })
    expect(back.postedAt).toBeUndefined()
    await expect(store.update(P, d.id, { status: 'bogus' as never })).rejects.toThrow()
    // 同じ状態への変更は何もしない
    await expect(store.update(P, d.id, { status: 'new' })).resolves.toMatchObject({ status: 'new' })
    // 失敗した変更は保存されていない
    expect((await makeStore().get(P, d.id))?.status).toBe('new')
  })

  it('mediaOrder は今ある id だけを渡した順に残す（重複・知らない id は捨てる）', async () => {
    const store = makeStore()
    const [d] = await store.add(P, [draft('x')])
    const withMedia = await store.addMedia(P, d.id, [{ path: '/abs/1.png', bytes: 1 }, { path: '/abs/2.png', bytes: 1 }, { path: '/abs/3.png', bytes: 1 }])
    const [a, b, c] = withMedia.media.map((m) => m.id)
    const next = await store.update(P, d.id, { mediaOrder: [c, 'ffffffff', a, c] })
    expect(next.media.map((m) => m.id)).toEqual([c, a])
    expect((await store.stored(P, d.id)).media.map((x) => x.path)).toEqual(['/abs/3.png', '/abs/1.png'])
    expect(b).toBeTruthy()
    expect((await store.update(P, d.id, { mediaOrder: [] })).media).toEqual([])
  })
})

describe('PublishStore.addMedia', () => {
  async function fresh() {
    const store = makeStore()
    const [d] = await store.add(P, [draft('x')])
    return { store, id: d.id }
  }

  it('画像は4枚まで（5枚目で断り、それまでの分は残る）', async () => {
    const { store, id } = await fresh()
    await store.addMedia(P, id, [1, 2, 3, 4].map((i) => ({ path: `/abs/${i}.jpg`, bytes: MB })))
    await expect(store.addMedia(P, id, [{ path: '/abs/5.jpg', bytes: 1 }])).rejects.toMatchObject({ userFacing: true })
    expect((await store.stored(P, id)).media.map((x) => x.path)).toHaveLength(4)
  })

  it('一度に5枚渡すと全部断る', async () => {
    const { store, id } = await fresh()
    await expect(store.addMedia(P, id, [1, 2, 3, 4, 5].map((i) => ({ path: `/abs/${i}.png`, bytes: 1 })))).rejects.toMatchObject({ userFacing: true })
    expect((await store.stored(P, id)).media.map((x) => x.path)).toEqual([])
  })

  it('動画と画像は混ぜない・動画は1本', async () => {
    const { store, id } = await fresh()
    await store.addMedia(P, id, [{ path: '/abs/a.png', bytes: 1 }])
    await expect(store.addMedia(P, id, [{ path: '/abs/v.mp4', bytes: 1 }])).rejects.toMatchObject({ userFacing: true })
    const [other] = await store.add(P, [draft('y')])
    await store.addMedia(P, other.id, [{ path: '/abs/v.mov', bytes: 1 }])
    await expect(store.addMedia(P, other.id, [{ path: '/abs/w.mp4', bytes: 1 }])).rejects.toMatchObject({ userFacing: true })
  })

  it('大きすぎるファイルは断る（境界はちょうど上限まで通す・GIF は別の上限）', async () => {
    const { store, id } = await fresh()
    await expect(store.addMedia(P, id, [{ path: '/abs/big.png', bytes: PUBLISH_LIMITS.xImageBytes + 1 }])).rejects.toMatchObject({ userFacing: true })
    await expect(store.addMedia(P, id, [{ path: '/abs/ok.png', bytes: PUBLISH_LIMITS.xImageBytes }])).resolves.toBeTruthy()
    await expect(store.addMedia(P, id, [{ path: '/abs/anim.gif', bytes: PUBLISH_LIMITS.xImageBytes + 1 }])).resolves.toBeTruthy()
    const [v] = await store.add(P, [draft('v')])
    await expect(store.addMedia(P, v.id, [{ path: '/abs/v.mp4', bytes: PUBLISH_LIMITS.xVideoBytes + 1 }])).rejects.toMatchObject({ userFacing: true })
  })

  it('知らない形式は断り、相対パスは不具合として断る。同じファイルは2回付けない', async () => {
    const { store, id } = await fresh()
    await expect(store.addMedia(P, id, [{ path: '/abs/a.pdf', bytes: 1 }])).rejects.toMatchObject({ userFacing: true })
    await expect(store.addMedia(P, id, [{ path: 'a.png', bytes: 1 }])).rejects.toThrow(/absolute/)
    await store.addMedia(P, id, [{ path: '/abs/a.png', bytes: 1 }])
    const again = await store.addMedia(P, id, [{ path: '/abs/a.png', bytes: 1 }])
    expect(again.media).toHaveLength(1)
    expect(again.media[0]).toEqual({ id: again.media[0].id, kind: 'image', name: 'a.png', bytes: 1 })
  })

  it('無い下書きには付けられない', async () => {
    await expect(makeStore().addMedia(P, 'deadbeef', [{ path: '/abs/a.png', bytes: 1 }])).rejects.toMatchObject({ userFacing: true })
    await expect(makeStore().stored(P, 'deadbeef')).rejects.toMatchObject({ userFacing: true })
  })
})

describe('PublishStore の見本・消去・バックグラウンドの状態', () => {
  it('snapshot は見本を付け（作れなければ無し）、実パスは返さない', async () => {
    const store = makeStore()
    const [d] = await store.add(P, [draft('x')])
    await store.addMedia(P, d.id, [{ path: '/abs/ok.png', bytes: 1 }, { path: '/abs/fail.png', bytes: 1 }])
    const snap = await store.snapshot(P, async (path, kind) => {
      if (path.includes('fail')) throw new Error('cannot read')
      return `data:image/png;base64,${kind}`
    }, true)
    expect(snap.background.running).toBe(true)
    expect(snap.drafts[0].media.map((m) => m.thumbnail)).toEqual(['data:image/png;base64,image', undefined])
    expect(JSON.stringify(snap)).not.toContain('/abs/')
  })

  it('remove は消し、無い id は何もしない', async () => {
    const store = makeStore()
    const [a, b] = await store.add(P, [draft('a'), draft('b')])
    await store.remove(P, a.id)
    await store.remove(P, 'deadbeef')
    expect((await makeStore().snapshot(P)).drafts.map((d) => d.id)).toEqual([b.id])
  })

  it('setBackground は項目を変え、null で消す。既定は有効', async () => {
    const store = makeStore()
    expect(await store.background(P)).toEqual({ enabled: true })
    await store.setBackground(P, { enabled: false, lastRunAt: '2026-10-01T00:00:00.000Z', lastError: 'e'.repeat(2000), lastHead: 'abcdef1' })
    const saved = await makeStore().background(P)
    expect(saved).toMatchObject({ enabled: false, lastRunAt: '2026-10-01T00:00:00.000Z', lastHead: 'abcdef1' })
    expect(saved.lastError?.length).toBe(500)
    await store.setBackground(P, { lastError: null, enabled: true })
    expect(await makeStore().background(P)).toEqual({ enabled: true, lastRunAt: '2026-10-01T00:00:00.000Z', lastHead: 'abcdef1' })
    const snap = await store.snapshot(P)
    expect(snap.background).toEqual({ enabled: true, running: false, lastRunAt: '2026-10-01T00:00:00.000Z' })
  })

  it('同時の変更を1つずつ行い、どれも失わない', async () => {
    const store = makeStore()
    await Promise.all(Array.from({ length: 20 }, (_, i) => store.add(P, [draft(`p${i}`)])))
    expect((await makeStore().snapshot(P)).drafts).toHaveLength(20)
  })

  it('pendingCount と recentTitles', async () => {
    const store = makeStore()
    const [a] = await store.add(P, [draft('a', { title: 'A' }), draft('b', { title: 'B' })])
    await store.update(P, a.id, { status: 'dismissed' })
    expect(await store.pendingCount(P)).toBe(1)
    expect(await store.recentTitles(P, 1)).toEqual(['A'])
  })

  it('titleFromText は最初の空でない行を上限まで', () => {
    expect(titleFromText('\n\n  見出し  \n本文')).toBe('見出し')
    expect(Array.from(titleFromText('😀'.repeat(200)))).toHaveLength(PUBLISH_LIMITS.titleChars)
  })
})

describe('記事・投稿の記録・メディアの相対パス', () => {
  it('記事は足すときに前後の空白を外して残し、無ければ空の記事', async () => {
    const store = makeStore()
    const [a, b] = await store.add(P, [draft('x', { article: { title: '  題 ', body: '\n本文\n' } }), draft('y')])
    expect(a.article).toEqual({ title: '題', body: '本文' })
    expect(b.article).toEqual({ title: '', body: '' })
    expect(a.results).toEqual([])
  })

  it('記事の題・本文を変え、上限を超えたら断る（境界: ちょうどは通す）', async () => {
    const store = makeStore()
    const [d] = await store.add(P, [draft('x')])
    expect((await store.update(P, d.id, { articleTitle: '新しい題' })).article).toEqual({ title: '新しい題', body: '' })
    expect((await store.update(P, d.id, { articleBody: '本文' })).article).toEqual({ title: '新しい題', body: '本文' })
    await expect(store.update(P, d.id, { articleTitle: 'あ'.repeat(PUBLISH_LIMITS.articleTitleChars) })).resolves.toBeTruthy()
    await expect(store.update(P, d.id, { articleTitle: 'あ'.repeat(PUBLISH_LIMITS.articleTitleChars + 1) })).rejects.toMatchObject({ userFacing: true })
    await expect(store.update(P, d.id, { articleBody: 'い'.repeat(PUBLISH_LIMITS.articleChars + 1) })).rejects.toMatchObject({ userFacing: true })
    await expect(store.update(P, d.id, { articleBody: 5 as unknown as string })).rejects.toThrow(/article body/)
    // 断った変更は残らない
    expect((await makeStore().get(P, d.id))?.article.body).toBe('本文')
  })

  it('投稿の記録を足すと投稿済みになり、記録は古い順で20件まで', async () => {
    const store = makeStore()
    const [d] = await store.add(P, [draft('x')])
    clock += 1000
    await store.recordResult(P, d.id, { kind: 'x', targetName: '@me', url: 'https://x.com/me/status/1' })
    let got = await store.get(P, d.id)
    expect(got?.status).toBe('posted')
    expect(got?.postedAt).toBe(new Date(clock).toISOString())
    expect(got?.results).toEqual([{ kind: 'x', targetName: '@me', url: 'https://x.com/me/status/1', at: new Date(clock).toISOString() }])
    for (let i = 0; i < 25; i++) await store.recordResult(P, d.id, { kind: 'wordpress', targetId: 'a'.repeat(16), targetName: `blog${i}`, draft: true })
    got = await makeStore().get(P, d.id)
    expect(got?.results).toHaveLength(20)
    expect(got?.results.at(-1)).toMatchObject({ targetName: 'blog24', draft: true, targetId: 'a'.repeat(16) })
    // 投稿した時刻は最初の投稿のまま
    expect(got?.postedAt).toBe(new Date(Date.parse('2026-10-01T00:00:00.000Z') + 1000).toISOString())
  })

  it('消えた下書きへの記録は何もしない', async () => {
    await expect(makeStore().recordResult(P, 'deadbeefdeadbeef', { kind: 'x', targetName: '@me' })).resolves.toBeUndefined()
  })

  it('メディアの相対パスを残し、危ないもの（絶対パス・..）は捨てる', async () => {
    const store = makeStore()
    const [d] = await store.add(P, [draft('x', { media: [{ path: '/abs/a.png', bytes: 1, ref: 'shots/a.png' }, { path: '/abs/b.png', bytes: 1, ref: '../b.png' }, { path: '/abs/c.png', bytes: 1, ref: '/etc/c.png' }] })])
    expect(d.media.map((m) => m.ref)).toEqual(['shots/a.png', undefined, undefined])
    const added = await store.addMedia(P, d.id, [{ path: '/abs/d.png', bytes: 1, ref: 'C:\\d.png' }])
    expect(added.media.at(-1)?.ref).toBeUndefined()
  })

  it('保存したファイルの記事・記録・相対パスの形を確かめる', () => {
    const at = '2026-10-01T00:00:00.000Z'
    const data = sanitizeProjectData({
      projectId: P,
      drafts: [{
        id: 'a1b2c3d4', createdAt: at, updatedAt: at, source: 'manual', status: 'posted', title: 't', text: 'x',
        media: [{ id: 'e5f6a7b8', kind: 'image', name: 'a.png', bytes: 1, path: '/abs/a.png', ref: 'x/../../a.png' }],
        article: { title: 5, body: 'b' },
        results: [
          { kind: 'x', targetName: '@me', at, url: 'javascript:alert(1)' },
          { kind: 'ghost', targetName: 'n', at },
          { kind: 'emdash', targetName: 'blog', at: 'nope' },
          { kind: 'emdash', targetName: 'blog', at, targetId: 'XYZ', draft: 'yes' }
        ]
      }]
    }, P)
    const d = data.drafts[0]
    expect(d.media[0].ref).toBeUndefined()
    expect(d.article).toEqual({ title: '', body: 'b' })
    expect(d.results).toEqual([{ kind: 'x', targetName: '@me', at }, { kind: 'emdash', targetName: 'blog', at }])
  })
})
