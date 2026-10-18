import { afterEach, describe, expect, it } from 'vitest'
import { setLocale } from '@shared/i18n'
import {
  BUILTIN_DEFAULTS,
  DEFAULT_VIDEO,
  PUBLISH_LOG_FILE,
  REQUEST_FILE,
  REQUEST_TTL_MS,
  RESULT_FILE,
  RUNNING_HOLD_MS,
  SENT_HOLD_MS,
  alreadyPublished,
  chaptersFromDescription,
  chaptersValid,
  charCount,
  fixInstruction,
  isRequestId,
  issueBlocks,
  issueText,
  nextOffsetFromRange,
  okState,
  parsePublishJson,
  parsePublishLog,
  parsePublishRequest,
  parsePublishResult,
  parseTags,
  publishDefaultsFrom,
  requestIsStale,
  resultOk,
  safeRelPath,
  tagsLength,
  targetsToUpload,
  utf8Bytes,
  withPrivacy,
  withThumbnail,
  youtubeVideoResource,
  type PublishSpec,
  type VideoPublishAccounts,
  type VideoPublishState
} from '../../../../src/video/app/shared/publish'
import { authUrl, base64url, challengeS256, channelTitle, newVerifier, refreshRequestBody, tokenRequestBody } from '../../../../src/video/app/main/publish/oauth'

const NOW = new Date('2026-10-11T00:00:00Z')
const parse = (o: unknown) => parsePublishJson(typeof o === 'string' ? o : JSON.stringify(o), NOW)
const codes = (o: unknown, level?: 'error' | 'warning') =>
  parse(o)
    .issues.filter((i) => !level || i.level === level)
    .map((i) => `${i.field}:${i.code}`)
const good = { video: 'renders/final.mp4', title: 'Claude Code の設定 3つのコツ', description: '説明', tags: ['claude', 'AI'], youtube: { privacy: 'unlisted' } }

afterEach(() => setLocale('en'))

describe('受け渡しのファイルの場所', () => {
  it('作業用フォルダは .ferret-video（docs/14 の形のまま、名前だけ Ferret）', () => {
    expect(REQUEST_FILE).toBe('.ferret-video/publish-request.json')
    expect(RESULT_FILE).toBe('.ferret-video/publish-result.json')
    expect(PUBLISH_LOG_FILE).toBe('.ferret-video/publish-log.json')
  })
})

describe('publish.json: 例外を投げない・形の問題', () => {
  it.each([
    ['', 'empty'],
    ['   \n', 'empty'],
    ['{', 'invalid-json'],
    ['{"a":1,}', 'invalid-json'],
    ['null', 'not-object'],
    ['[]', 'not-object'],
    ['"text"', 'not-object'],
    ['42', 'not-object']
  ])('%j → %s', (text, code) => {
    const r = parsePublishJson(text, NOW)
    expect(r.spec).toBeNull()
    expect(r.issues).toEqual([expect.objectContaining({ level: 'error', field: '$', code })])
  })
  it('BOM と読み込み済みの値も受ける', () => {
    expect(parsePublishJson('\uFEFF' + JSON.stringify(good), NOW).spec?.title).toBe(good.title)
    expect(parsePublishJson(good, NOW).spec?.title).toBe(good.title)
  })
  it('揃ったファイルは問題もお知らせも無い', () => {
    expect(parse(good).issues).toEqual([])
  })
  it('最小のファイルは安全な既定で埋め、お知らせを出す', () => {
    const r = parse({ title: 't' })
    expect(r.spec).toMatchObject({
      video: DEFAULT_VIDEO,
      description: '',
      tags: [],
      youtube: { enabled: true, categoryId: '28', privacy: 'private', madeForKids: false, containsSyntheticMedia: false, chapters: true, language: 'ja' },
      tiktok: { enabled: false, privacy: 'SELF_ONLY', allowComment: false, allowDuet: false, allowStitch: false, isAigc: false }
    })
    expect(codes({ title: 't' }, 'error')).toEqual([])
    expect(codes({ title: 't' }, 'warning')).toEqual(['video:default', 'youtube.privacy:default'])
  })
  it('知らない項目はどの階層でもお知らせにして続ける', () => {
    expect(codes({ ...good, extra: 1, youtube: { privacy: 'public', foo: 1 }, tiktok: { bar: 2 } }, 'warning')).toEqual([
      'extra:unknown-field',
      'youtube.foo:unknown-field',
      'tiktok.bar:unknown-field'
    ])
  })
  it('型が違う値は変換するか無視する（投げない）', () => {
    const r = parse({ ...good, title: 123, description: ['x'], tags: 'a, #b, a', youtube: { privacy: 'PUBLIC', madeForKids: 'true', chapters: 3 }, tiktok: 'yes' })
    expect(r.spec).toMatchObject({ title: '123', description: '', tags: ['a', 'b'], youtube: { privacy: 'public', madeForKids: true, chapters: true }, tiktok: { enabled: false } })
    expect(r.issues.map((i) => `${i.field}:${i.code}`)).toEqual(
      expect.arrayContaining(['title:coerced', 'description:wrong-type', 'tags:coerced', 'youtube.madeForKids:coerced', 'youtube.chapters:wrong-type', 'tiktok:wrong-type'])
    )
  })
  it('null の節は無いものとして扱う', () => {
    expect(parse({ ...good, youtube: null, tiktok: null, thumbnail: null }).spec?.youtube.enabled).toBe(true)
  })
  it('巨大な・深い入れ子でも投げない', () => {
    const deep: Record<string, unknown> = {}
    let cur = deep
    for (let i = 0; i < 200; i++) cur = (cur.x = {}) as Record<string, unknown>
    expect(() => parse({ ...good, notes: deep, youtube: { privacy: 'private', extra: deep } })).not.toThrow()
  })
})

describe('publish.json: パス（プロジェクトの外を指すもの）', () => {
  it.each([
    ['renders/final.mp4', 'renders/final.mp4'],
    ['./renders//final.mp4', 'renders/final.mp4'],
    ['renders\\final.mp4', 'renders/final.mp4'],
    ['a/../renders/final.mp4', 'renders/final.mp4'],
    ['../outside.mp4', null],
    ['a/../../x.mp4', null],
    ['..\\..\\x.mp4', null],
    ['/abs/final.mp4', null],
    ['\\\\server\\share\\x.mp4', null],
    ['C:/x.mp4', null],
    ['c:\\x.mp4', null],
    ['', null],
    ['   ', null],
    ['.', null],
    ['./', null],
    ['a\0b', null]
  ])('safeRelPath(%j) = %j', (p, want) => {
    expect(safeRelPath(p)).toBe(want)
  })
  it('外を指す動画は、すべての投稿先を止める問題', () => {
    const r = parse({ ...good, video: '../../etc/passwd' })
    const issue = r.issues.find((i) => i.field === 'video')!
    expect(issue).toMatchObject({ level: 'error', code: 'bad-path' })
    expect(issueBlocks(issue, 'youtube')).toBe(true)
    expect(issueBlocks(issue, 'tiktok')).toBe(true)
  })
  it('動画の拡張子でないものはお知らせ', () => {
    expect(codes({ ...good, video: 'renders/final.gif' }, 'warning')).toEqual(['video:not-video'])
    expect(codes({ ...good, video: 'renders/final.MOV' }, 'warning')).toEqual([])
  })
  it('数値の video はパスの問題', () => {
    expect(codes({ ...good, video: 5 }, 'error')).toEqual(['video:bad-path'])
  })
  it('サムネイル: 任意、png/jpg だけ、中だけ', () => {
    expect(parse({ ...good, thumbnail: 'thumbnails/thumb-1.png' }).spec?.thumbnail).toBe('thumbnails/thumb-1.png')
    expect(parse({ ...good, thumbnail: 'thumbnails/a.JPEG' }).spec?.thumbnail).toBe('thumbnails/a.JPEG')
    expect(parse({ ...good, thumbnail: '' }).spec?.thumbnail).toBeUndefined()
    expect(codes({ ...good, thumbnail: 'thumbnails/a.webp' }, 'warning')).toEqual(['thumbnail:not-image'])
    expect(codes({ ...good, thumbnail: '/tmp/a.png' }, 'warning')).toEqual(['thumbnail:bad-path'])
    expect(codes({ ...good, thumbnail: 5 }, 'warning')).toEqual(['thumbnail:bad-path'])
    expect(parse({ ...good, thumbnail: '../a.png' }).spec?.thumbnail).toBeUndefined()
  })
})

describe('publish.json: YouTube の制限', () => {
  it('タイトル: 必須・100 文字（コードポイント）ちょうどは通り、101 は止まる', () => {
    expect(codes({ ...good, title: '  ' }, 'error')).toEqual(['title:required'])
    expect(codes({ ...good, title: 'a'.repeat(100) }, 'error')).toEqual([])
    expect(codes({ ...good, title: 'あ'.repeat(100) }, 'error')).toEqual([])
    expect(codes({ ...good, title: '😀'.repeat(100) }, 'error')).toEqual([]) // UTF-16 では 200 単位でも 100 文字
    expect(codes({ ...good, title: 'a'.repeat(101) }, 'error')).toEqual(['title:too-long'])
    expect(codes({ ...good, title: 'あ'.repeat(101) }, 'error')).toEqual(['title:too-long'])
    expect(codes({ ...good, title: '😀'.repeat(101) }, 'error')).toEqual(['title:too-long'])
    expect(parse({ ...good, title: 'a'.repeat(101) }).issues[0]?.detail).toBe('101/100')
  })
  it('タイトルの < > は止まる（片方だけでも）', () => {
    expect(codes({ ...good, title: 'a <b>' }, 'error')).toEqual(['title:angle-brackets'])
    expect(codes({ ...good, title: 'a > b' }, 'error')).toEqual(['title:angle-brackets'])
    expect(codes({ ...good, title: 'a < b' }, 'error')).toEqual(['title:angle-brackets'])
    expect(codes({ ...good, title: 'a ＜b＞' }, 'error')).toEqual([]) // 全角は使える
  })
  it('タイトルは前後の空白を外してから数える', () => {
    expect(codes({ ...good, title: `  ${'a'.repeat(100)}  ` }, 'error')).toEqual([])
  })
  it('説明: 5000 バイト（UTF-8）。多バイト文字の境界', () => {
    expect(codes({ ...good, description: 'a'.repeat(5000) }, 'error')).toEqual([])
    expect(codes({ ...good, description: 'a'.repeat(5001) }, 'error')).toEqual(['description:too-long'])
    expect(codes({ ...good, description: 'あ'.repeat(1666) + 'aa' }, 'error')).toEqual([]) // 4998 + 2 = 5000
    expect(codes({ ...good, description: 'あ'.repeat(1666) + 'aaa' }, 'error')).toEqual(['description:too-long']) // 5001
    expect(codes({ ...good, description: 'あ'.repeat(1667) }, 'error')).toEqual(['description:too-long']) // 5001
    expect(codes({ ...good, description: '😀'.repeat(1250) }, 'error')).toEqual([]) // 4 × 1250 = 5000
    expect(codes({ ...good, description: '😀'.repeat(1250) + 'a' }, 'error')).toEqual(['description:too-long'])
    expect(codes({ ...good, description: 'é'.repeat(2500) }, 'error')).toEqual([]) // 2 バイト × 2500
  })
  it('説明の < > は止まる', () => {
    expect(codes({ ...good, description: '<script>' }, 'error')).toEqual(['description:angle-brackets'])
    expect(codes({ ...good, description: '1 > 0' }, 'error')).toEqual(['description:angle-brackets'])
  })
  it('説明の CRLF は LF にする（送る中身のバイトで数える）', () => {
    expect(parse({ ...good, description: 'a\r\nb' }).spec?.description).toBe('a\nb')
    expect(codes({ ...good, description: 'a'.repeat(2499) + '\r\n'.repeat(2501) }, 'error')).toEqual([]) // 2499 + 2501 = 5000
  })
  it('タグ: 合計 500 文字。区切りと、空白を含むタグの引用符も数える', () => {
    expect(tagsLength([])).toBe(0)
    expect(tagsLength(['ab'])).toBe(2)
    expect(tagsLength(['ab', 'c d'])).toBe(2 + 1 + 3 + 2)
    expect(tagsLength(['a\tb'])).toBe(3 + 2) // タブも空白
    expect(tagsLength(['😀'])).toBe(1)
    const fits = Array.from({ length: 50 }, (_, i) => `t${String(i).padStart(7, '0')}`) // 50*8 + 49 = 449
    expect(codes({ ...good, tags: fits }, 'error')).toEqual([])
    expect(codes({ ...good, tags: ['a'.repeat(500)] }, 'error')).toEqual([])
    expect(codes({ ...good, tags: ['a'.repeat(501)] }, 'error')).toEqual(['tags:too-long'])
    expect(codes({ ...good, tags: ['a'.repeat(496) + ' b'] }, 'error')).toEqual([]) // 498 + 2 = 500
    expect(codes({ ...good, tags: ['a'.repeat(497) + ' b'] }, 'error')).toEqual(['tags:too-long']) // 499 + 2
    expect(codes({ ...good, tags: ['a'.repeat(249), 'b'.repeat(250)] }, 'error')).toEqual([]) // 249 + 1 + 250
    expect(codes({ ...good, tags: ['a'.repeat(250), 'b'.repeat(250)] }, 'error')).toEqual(['tags:too-long'])
    expect(codes({ ...good, tags: ['<x>'] }, 'error')).toEqual(['tags:angle-brackets'])
  })
  it('タグ: 前後の空白・# を外し、大文字小文字を区別せず重複を除き、文字列以外は捨てる', () => {
    const r = parse({ ...good, tags: [' AI ', 'ai', '#動画', '##x', '# y', '', '#', 3, null] })
    expect(r.spec?.tags).toEqual(['AI', '動画', 'x', 'y'])
    expect(codes({ ...good, tags: ['a', 3] }, 'warning')).toEqual(['tags:wrong-type'])
    expect(parseTags('#AI, claude、AI\n  動画 編集 ,')).toEqual(['AI', 'claude', '動画 編集'])
    expect(parseTags('')).toEqual([])
    expect(parseTags(',,、\n')).toEqual([])
  })
  it('重複を除いたあとの長さで数える', () => {
    expect(codes({ ...good, tags: ['a'.repeat(300), 'A'.repeat(300)] }, 'error')).toEqual([])
  })
  it('YouTube がオフなら YouTube の制限は見ない', () => {
    expect(codes({ ...good, title: '', youtube: { enabled: false }, tiktok: { enabled: true, caption: 'c' } }, 'error')).toEqual([])
    expect(codes({ ...good, title: 'a'.repeat(200), description: '<>', youtube: { enabled: false }, tiktok: { enabled: true, caption: 'c' } }, 'error')).toEqual([])
  })
  it('公開範囲: 知らない値は既定（非公開）にしてお知らせ。大文字は受ける', () => {
    const r = parse({ ...good, youtube: { privacy: 'friends' } })
    expect(r.spec?.youtube).toMatchObject({ privacy: 'private', privacyDefaulted: true })
    expect(r.issues.map((i) => i.code)).toEqual(['invalid'])
    expect(parse({ ...good, youtube: { privacy: 'Unlisted' } }).spec?.youtube.privacy).toBe('unlisted')
    expect(parse({ ...good, youtube: { privacy: 1 } }).spec?.youtube.privacy).toBe('private')
    expect(parse({ ...good, youtube: { privacy: '' } }).spec?.youtube.privacy).toBe('private')
  })
  it('YouTube がオフなら、公開範囲が無くてもお知らせを出さない', () => {
    expect(codes({ ...good, youtube: { enabled: false }, tiktok: { enabled: true, caption: 'c', privacy: 'SELF_ONLY' } }, 'warning')).toEqual([])
  })
  it('categoryId: 数字だけ（数値も可）、ほかは 28', () => {
    expect(parse({ ...good, youtube: { privacy: 'public', categoryId: 27 } }).spec?.youtube.categoryId).toBe('27')
    expect(parse({ ...good, youtube: { privacy: 'public', categoryId: 'Education' } }).spec?.youtube.categoryId).toBe('28')
    expect(parse({ ...good, youtube: { privacy: 'public', categoryId: '1234' } }).spec?.youtube.categoryId).toBe('28')
  })
  it('予約: 未来の ISO は非公開に。過去・ちょうど今・不正は止まる', () => {
    const r = parse({ ...good, youtube: { privacy: 'public', publishAt: '2026-10-12T09:00:00+09:00' } })
    expect(r.spec?.youtube).toMatchObject({ privacy: 'private', publishAt: '2026-10-12T00:00:00.000Z' })
    expect(r.issues.map((i) => `${i.field}:${i.code}`)).toEqual(['youtube.privacy:scheduled-private'])
    expect(codes({ ...good, youtube: { privacy: 'private', publishAt: '2026-10-10T00:00:00Z' } }, 'error')).toEqual(['youtube.publishAt:past'])
    expect(codes({ ...good, youtube: { privacy: 'private', publishAt: NOW.toISOString() } }, 'error')).toEqual(['youtube.publishAt:past'])
    expect(codes({ ...good, youtube: { privacy: 'private', publishAt: new Date(NOW.getTime() + 1000).toISOString() } }, 'error')).toEqual([])
    expect(codes({ ...good, youtube: { privacy: 'private', publishAt: 'tomorrow' } }, 'error')).toEqual(['youtube.publishAt:invalid'])
    expect(codes({ ...good, youtube: { privacy: 'private', publishAt: 12 } }, 'error')).toEqual(['youtube.publishAt:invalid'])
    expect(parse({ ...good, youtube: { privacy: 'private', publishAt: '' } }).spec?.youtube.publishAt).toBeUndefined()
  })
  it('過去の予約は YouTube だけを止める', () => {
    const r = parse({ ...good, youtube: { publishAt: '2020-01-01T00:00:00Z' }, tiktok: { enabled: true, caption: 'c' } })
    const issue = r.issues.find((i) => i.code === 'past')!
    expect([issueBlocks(issue, 'youtube'), issueBlocks(issue, 'tiktok')]).toEqual([true, false])
  })
  it('videos.insert の本文', () => {
    const spec = parse({ ...good, youtube: { privacy: 'unlisted', containsSyntheticMedia: true, language: 'en' } }).spec!
    expect(youtubeVideoResource(spec)).toEqual({
      snippet: { title: good.title, description: '説明', tags: ['claude', 'AI'], categoryId: '28', defaultLanguage: 'en', defaultAudioLanguage: 'en' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: false, containsSyntheticMedia: true }
    })
    const sched = parse({ ...good, youtube: { publishAt: '2026-11-01T00:00:00Z' } }).spec!
    expect(youtubeVideoResource(sched).status).toEqual({ privacyStatus: 'private', selfDeclaredMadeForKids: false, containsSyntheticMedia: false, publishAt: '2026-11-01T00:00:00.000Z' })
  })
})

describe('publish.json: TikTok', () => {
  const on = (caption: string) => ({ ...good, tiktok: { enabled: true, caption } })
  it('キャプションは 2200（UTF-16 の単位）', () => {
    expect(codes(on('a'.repeat(2200)), 'error')).toEqual([])
    expect(codes(on('a'.repeat(2201)), 'error')).toEqual(['tiktok.caption:too-long'])
    expect(codes(on('あ'.repeat(2200)), 'error')).toEqual([])
    expect(codes(on('😀'.repeat(1100)), 'error')).toEqual([]) // 2200 単位
    expect(codes(on('😀'.repeat(1100) + 'a'), 'error')).toEqual(['tiktok.caption:too-long'])
    expect(codes(on('😀'.repeat(1101)), 'error')).toEqual(['tiktok.caption:too-long'])
    expect(charCount('😀'.repeat(1101))).toBe(1101) // コードポイントでは 1101 でも止まる
  })
  it('TikTok がオフなら長いキャプションは気にしない', () => {
    expect(codes({ ...good, tiktok: { enabled: false, caption: 'a'.repeat(3000) } }, 'error')).toEqual([])
  })
  it('キャプションが無ければタイトル＋ハッシュタグ（空白は詰める）にしてお知らせ', () => {
    const r = parse({ ...good, tags: ['AI', '動画 編集'], tiktok: { enabled: true } })
    expect(r.spec?.tiktok.caption).toBe(`${good.title}\n#AI #動画編集`)
    expect(r.issues.map((i) => `${i.field}:${i.code}`)).toEqual(['tiktok.caption:default'])
    expect(parse({ ...good, tags: [], tiktok: { enabled: true, caption: '   ' } }).spec?.tiktok.caption).toBe(good.title)
  })
  it('作ったキャプションが長すぎても止める', () => {
    expect(codes({ ...good, youtube: { enabled: false }, title: 'a'.repeat(2201), tiktok: { enabled: true } }, 'error')).toEqual(['tiktok.caption:too-long'])
  })
  it('公開範囲: 大文字小文字を問わない。知らない値・型違いは既定（自分のみ）', () => {
    expect(parse({ ...good, tiktok: { privacy: 'public_to_everyone' } }).spec?.tiktok.privacy).toBe('PUBLIC_TO_EVERYONE')
    expect(parse({ ...good, tiktok: { privacy: 'everyone' } }).spec?.tiktok).toMatchObject({ privacy: 'SELF_ONLY', privacyDefaulted: true })
    expect(parse({ ...good, tiktok: { privacy: ['PUBLIC_TO_EVERYONE'] } }).spec?.tiktok.privacy).toBe('SELF_ONLY')
    expect(codes({ ...good, tiktok: { privacy: 'everyone' } }, 'warning')).toEqual(['tiktok.privacy:invalid'])
  })
  it('TikTok の問題は TikTok だけ、YouTube の問題は YouTube だけを止める', () => {
    const r = parse({ ...good, title: '', tiktok: { enabled: true, caption: 'a'.repeat(2201) } })
    const tt = r.issues.find((i) => i.field === 'tiktok.caption')!
    const yt = r.issues.find((i) => i.field === 'title')!
    expect([issueBlocks(tt, 'tiktok'), issueBlocks(tt, 'youtube')]).toEqual([true, false])
    expect([issueBlocks(yt, 'tiktok'), issueBlocks(yt, 'youtube')]).toEqual([false, true])
    expect(issueBlocks({ level: 'warning', field: 'video', code: 'x' }, 'youtube')).toBe(false)
    expect(issueBlocks({ level: 'error', field: '$', code: 'x' }, 'tiktok')).toBe(true)
  })
  it('両方オフはお知らせ', () => {
    expect(codes({ ...good, youtube: { enabled: false } }, 'warning')).toEqual(['$:no-target'])
  })
})

describe('投稿先と小さな部品', () => {
  const spec = (yt: boolean, tt: boolean) => parse({ ...good, youtube: { privacy: 'public', enabled: yt }, tiktok: { enabled: tt, caption: 'c' } }).spec!
  it('targetsToUpload: publish.json が決め、頼みで絞る', () => {
    expect(targetsToUpload(spec(true, true))).toEqual(['youtube', 'tiktok'])
    expect(targetsToUpload(spec(true, false))).toEqual(['youtube'])
    expect(targetsToUpload(spec(true, true), ['tiktok'])).toEqual(['tiktok'])
    expect(targetsToUpload(spec(true, false), ['tiktok'])).toEqual([]) // 頼まれてもオフ
    expect(targetsToUpload(spec(false, false))).toEqual([])
  })
  it('withThumbnail は知らない項目を残す', () => {
    expect(withThumbnail({ title: 'x', custom: 1 }, 'thumbnails/a.png')).toEqual({ title: 'x', custom: 1, thumbnail: 'thumbnails/a.png' })
    expect(withThumbnail({ title: 'x', thumbnail: 'a.png' }, null)).toEqual({ title: 'x' })
    expect(withThumbnail(null, 'a.png')).toEqual({ thumbnail: 'a.png' })
    expect(withThumbnail([1], 'a.png')).toEqual({ thumbnail: 'a.png' })
  })
  it('issueText は今の言語で出す', () => {
    expect(issueText({ level: 'error', field: 'title', code: 'too-long', detail: '101/100' })).toBe('title: Too long (101/100)')
    expect(issueText({ level: 'error', field: '$', code: 'invalid-json' })).toBe('publish.json: Not valid JSON')
    expect(issueText({ level: 'error', field: 'x', code: 'weird' })).toBe('x: weird')
    setLocale('ja')
    expect(issueText({ level: 'error', field: 'title', code: 'too-long', detail: '101/100' })).toBe('title: 長すぎます (101/100)')
  })
  it('fixInstruction は空白を詰め、500 文字で切る', () => {
    expect(fixInstruction('タイトルを短く')).toBe('タイトルを短く')
    expect(fixInstruction('  a \n  b ')).toBe('a b')
    expect(fixInstruction('')).toBe('')
    expect(fixInstruction('x'.repeat(900)).length).toBe(500)
  })
  it('utf8 と再開位置', () => {
    expect(utf8Bytes('aあ😀')).toBe(1 + 3 + 4)
    expect(nextOffsetFromRange('bytes=0-8388607')).toBe(8388608)
    expect(nextOffsetFromRange(null)).toBe(0)
    expect(nextOffsetFromRange(undefined)).toBe(0)
    expect(nextOffsetFromRange('garbage')).toBe(0)
  })
  it('チャプター: 行頭の時刻だけ。YouTube の条件（0:00 から・3つ以上・10 秒以上）', () => {
    const desc = '紹介\n00:00 はじめに\n0:45 - 設定\n1:02:03 まとめ\n本文中の 1:00 は数えない\n99:99 だめ'
    const ch = chaptersFromDescription(desc)
    expect(ch.map((c) => [c.at, c.title])).toEqual([[0, 'はじめに'], [45, '設定'], [3723, 'まとめ']])
    expect(chaptersValid(ch)).toBe(true)
    expect(chaptersValid(ch.slice(0, 2))).toBe(false)
    expect(chaptersValid(chaptersFromDescription('0:05 a\n0:30 b\n1:00 c'))).toBe(false) // 0:00 からでない
    expect(chaptersValid(chaptersFromDescription('0:00 a\n0:09 b\n1:00 c'))).toBe(false) // 10 秒未満
    expect(chaptersValid(chaptersFromDescription('0:00 a\n0:10 b\n0:20 c'))).toBe(true)
    expect(chaptersFromDescription('')).toEqual([])
  })
})

describe('受け渡しの頼み・結果の読み込み', () => {
  const id = 'a1b2c3d4-0000-4000-8000-000000000000'
  it('頼みの id', () => {
    expect(isRequestId(id)).toBe(true)
    expect(isRequestId('abcdefgh')).toBe(true) // 8 文字ちょうど
    expect(isRequestId('abcdefg')).toBe(false)
    expect(isRequestId('short')).toBe(false)
    expect(isRequestId('../../etc')).toBe(false)
    expect(isRequestId('-abcdefgh')).toBe(false)
    expect(isRequestId('x'.repeat(64))).toBe(true)
    expect(isRequestId('x'.repeat(65))).toBe(false)
    expect(isRequestId(5)).toBe(false)
  })
  it('頼みを読む・おかしなものは断る', () => {
    expect(parsePublishRequest({ id, targets: ['youtube', 'youtube', 'x'], at: NOW.toISOString() })).toEqual({ id, targets: ['youtube'], at: NOW.toISOString() })
    expect(parsePublishRequest(JSON.stringify({ id, targets: [], at: NOW.toISOString(), force: true }))).toEqual({ id, targets: [], at: NOW.toISOString(), force: true })
    expect(parsePublishRequest('\uFEFF' + JSON.stringify({ id, targets: [], at: NOW.toISOString() }))?.id).toBe(id)
    expect(parsePublishRequest({ id, at: NOW.toISOString(), force: 'yes' })).toEqual({ id, targets: [], at: NOW.toISOString() })
    expect(parsePublishRequest({ id, targets: 'youtube', at: NOW.toISOString() })).toEqual({ id, targets: [], at: NOW.toISOString() })
    expect(parsePublishRequest({ id, targets: ['instagram'], at: NOW.toISOString() })).toBeNull()
    expect(parsePublishRequest({ id, targets: [] })).toBeNull()
    expect(parsePublishRequest({ id, targets: [], at: 'never' })).toBeNull()
    expect(parsePublishRequest({ id: 'bad id', targets: [], at: NOW.toISOString() })).toBeNull()
    expect(parsePublishRequest('{broken')).toBeNull()
    expect(parsePublishRequest(null)).toBeNull()
    expect(parsePublishRequest([])).toBeNull()
  })
  it('10 分を過ぎた頼みは古い（ちょうど 10 分はまだ新しい）', () => {
    const req = { id, targets: [], at: NOW.toISOString() }
    expect(requestIsStale(req, NOW.getTime() + REQUEST_TTL_MS)).toBe(false)
    expect(requestIsStale(req, NOW.getTime() + REQUEST_TTL_MS + 1)).toBe(true)
    expect(requestIsStale({ ...req, at: 'x' }, NOW.getTime())).toBe(true)
    expect(REQUEST_TTL_MS).toBe(600_000)
  })
  it('結果を読む。state の無い最小の形は確定とみなす', () => {
    expect(parsePublishResult({ id, results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/x' }] })).toEqual({
      id,
      state: 'done',
      at: '',
      results: [{ target: 'youtube', ok: true, url: 'https://youtu.be/x' }]
    })
    const r = parsePublishResult({ id, state: 'running', at: 'a', progress: { target: 'tiktok', phase: 'upload', fraction: 1.7 }, results: [{ target: 'x', ok: true }, { target: 'youtube' }, 5] })
    expect(r).toEqual({ id, state: 'running', at: 'a', progress: { target: 'tiktok', phase: 'upload', fraction: 1 }, results: [] })
    expect(parsePublishResult({ id, state: 'running', at: 'a', progress: { target: 'youtube', phase: 'upload', fraction: -1 }, results: [] })?.progress?.fraction).toBe(0)
    expect(parsePublishResult({ id, state: 'running', at: 'a', progress: { target: 'youtube', phase: 1, fraction: Number.NaN }, results: [] })?.progress).toEqual({ target: 'youtube', phase: '' })
    expect(parsePublishResult({ id, results: 'no' })?.results).toEqual([])
    expect(parsePublishResult({ id: 'no', results: [] })).toBeNull()
    expect(parsePublishResult('}{')).toBeNull()
    expect(parsePublishResult({ id, error: 'x', results: [{ target: 'tiktok', ok: false, error: 'e', status: 'bogus', alreadyPublished: 'yes', warnings: ['w', 1] }] })).toEqual({
      id,
      state: 'done',
      at: '',
      error: 'x',
      results: [{ target: 'tiktok', ok: false, error: 'e', warnings: ['w'] }]
    })
  })
  it('resultOk: 全部 ok で、空でない確定の結果だけ', () => {
    const base = { id, at: '', results: [] }
    expect(resultOk({ ...base, state: 'done' })).toBe(false)
    expect(resultOk({ ...base, state: 'running', results: [{ target: 'youtube', ok: true }] })).toBe(false)
    expect(resultOk({ ...base, state: 'done', results: [{ target: 'youtube', ok: true }, { target: 'tiktok', ok: false }] })).toBe(false)
    expect(resultOk({ ...base, state: 'done', results: [{ target: 'youtube', ok: true }] })).toBe(true)
  })
  it('投稿の記録と二重投稿の照合（パスと大きさ）', () => {
    const log = parsePublishLog({
      entries: [
        { target: 'youtube', video: 'renders/final.mp4', size: 10, url: 'u1', requestId: 'r', at: '', status: 'published' },
        { target: 'youtube', video: 'renders/final.mp4', size: 10, url: 'u2', requestId: 'r', at: '', status: 'published' },
        { target: 'nope', video: 'x', size: 1, requestId: 'r' },
        { target: 'youtube', video: 'x', size: '1', requestId: 'r' },
        'junk'
      ]
    })
    expect(log).toHaveLength(2)
    expect(alreadyPublished(log, 'youtube', 'renders/final.mp4', 10)?.url).toBe('u2') // 新しいもの
    expect(alreadyPublished(log, 'youtube', 'renders/final.mp4', 11)).toBeNull() // 書き出し直した
    expect(alreadyPublished(log, 'youtube', 'renders/other.mp4', 10)).toBeNull()
    expect(alreadyPublished(log, 'tiktok', 'renders/final.mp4', 10)).toBeNull()
    expect(parsePublishLog('{oops')).toEqual([])
    expect(parsePublishLog({ entries: 3 })).toEqual([])
  })
})

describe('「OK・投稿する」の状態', () => {
  const spec = (tt = false): PublishSpec => parse({ ...good, tiktok: { enabled: tt, caption: 'c' } }).spec!
  const view = (p: Partial<VideoPublishState> = {}): VideoPublishState => ({
    exists: true,
    spec: spec(),
    issues: [],
    videoMedia: 'v1/renders/final.mp4',
    request: null,
    result: null,
    log: [],
    published: {},
    ...p
  })
  const acc = (yt: boolean, tt: { configured: boolean; connected: boolean } = { configured: false, connected: false }): Omit<VideoPublishAccounts, 'persisted'> => ({
    youtube: { configured: true, connected: yt },
    tiktok: tt
  })
  const now = NOW.getTime()
  it('押せる', () => {
    expect(okState(view(), acc(true), null, now)).toEqual({ kind: 'ready', targets: ['youtube'] })
  })
  it('publish.json の問題では止めない（エージェントが先に直す）', () => {
    expect(okState(view({ issues: [{ level: 'error', field: 'title', code: 'too-long' }] }), acc(true), null, now).kind).toBe('ready')
  })
  it('ファイルが無い・読めない・動画が無い・投稿先が無い', () => {
    expect(okState(null, acc(true), null, now).kind).toBe('no-file')
    expect(okState(view({ exists: false, spec: null }), acc(true), null, now).kind).toBe('no-file')
    expect(okState(view({ spec: null }), acc(true), null, now).kind).toBe('no-file')
    const { videoMedia: _v, ...noVideo } = view()
    expect(okState(noVideo as VideoPublishState, acc(true), null, now).kind).toBe('no-video')
    expect(okState(view({ spec: { ...spec(), youtube: { ...spec().youtube, enabled: false } } }), acc(true), null, now).kind).toBe('no-target')
  })
  it('YouTube は接続が要る。TikTok は接続できる版のときだけ', () => {
    expect(okState(view(), acc(false), null, now)).toEqual({ kind: 'connect', target: 'youtube' })
    expect(okState(view({ spec: spec(true) }), acc(true, { configured: true, connected: false }), null, now)).toEqual({ kind: 'connect', target: 'tiktok' })
    // この版に TikTok が無い: 止めない（手で上げるボタンを出す）
    expect(okState(view({ spec: spec(true) }), acc(true), null, now)).toEqual({ kind: 'ready', targets: ['youtube', 'tiktok'] })
    // 接続の状態がまだ届いていない: 止めない
    expect(okState(view(), null, null, now).kind).toBe('ready')
  })
  it('送ったあとは 3 分押せない。ちょうど 3 分で戻る', () => {
    expect(okState(view(), acc(true), now - 1000, now).kind).toBe('sent')
    expect(okState(view(), acc(true), now - SENT_HOLD_MS + 1, now).kind).toBe('sent')
    expect(okState(view(), acc(true), now - SENT_HOLD_MS, now).kind).toBe('ready')
  })
  it('アップロード中（新しい running）は押せない。古い running・別の頼みの running は押せる', () => {
    const running = { id: 'abcdefgh1', state: 'running' as const, at: NOW.toISOString(), results: [] }
    expect(okState(view({ result: running }), acc(true), null, now).kind).toBe('running')
    expect(okState(view({ result: running }), acc(true), null, now + RUNNING_HOLD_MS - 1).kind).toBe('running')
    expect(okState(view({ result: running }), acc(true), null, now + RUNNING_HOLD_MS).kind).toBe('ready')
    expect(okState(view({ result: running, request: { id: 'zzzzzzzz9', targets: [], at: '' } }), acc(true), null, now).kind).toBe('ready')
    // アップロード中は「送った」より先
    expect(okState(view({ result: running }), acc(true), now, now).kind).toBe('running')
  })
  it('上げ済みの投稿先には二度と出さない', () => {
    const e = { target: 'youtube' as const, video: 'renders/final.mp4', size: 1, requestId: 'r', at: '', status: 'published' as const }
    expect(okState(view({ published: { youtube: e } }), acc(false), null, now).kind).toBe('published')
    expect(okState(view({ spec: spec(true), published: { youtube: e } }), acc(false), null, now)).toEqual({ kind: 'ready', targets: ['tiktok'] })
  })
})

describe('Google の OAuth（インストール型・PKCE S256）', () => {
  it('verifier は base64url の 43〜128 文字、challenge は SHA-256 の base64url（RFC 7636 付録 B）', () => {
    for (let i = 0; i < 20; i++) expect(newVerifier()).toMatch(/^[A-Za-z0-9_-]{43,128}$/)
    expect(challengeS256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
    expect(challengeS256(newVerifier())).toMatch(/^[A-Za-z0-9_-]{43}$/) // 32 バイト → 43 文字、= なし
    expect(base64url(Buffer.from([0xfb, 0xff, 0xfe]))).toBe('-__-')
  })
  it('認可 URL は PKCE・offline・ループバックのリダイレクトを持つ', () => {
    const u = new URL(authUrl({ clientId: 'cid', redirectUri: 'http://127.0.0.1:5555', challenge: 'ch', state: 'st' }))
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'cid', redirect_uri: 'http://127.0.0.1:5555', response_type: 'code', code_challenge: 'ch', code_challenge_method: 'S256', state: 'st', access_type: 'offline', prompt: 'consent'
    })
    expect(u.searchParams.get('scope')).toContain('youtube.upload')
    expect(u.searchParams.get('scope')).toContain('youtube.force-ssl')
  })
  it('トークンの要求の本文', () => {
    const b = tokenRequestBody({ clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'http://127.0.0.1:1' })
    expect(b.get('grant_type')).toBe('authorization_code')
    expect(b.has('client_secret')).toBe(false)
    expect(tokenRequestBody({ clientId: 'c', clientSecret: 's', code: 'x', verifier: 'v', redirectUri: 'r' }).get('client_secret')).toBe('s')
    expect(refreshRequestBody({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }).toString()).toBe('client_id=c&refresh_token=r&grant_type=refresh_token&client_secret=s')
  })
  it('channels.list からチャンネル名', () => {
    expect(channelTitle({ items: [{ snippet: { title: 'My Channel' } }] })).toBe('My Channel')
    expect(channelTitle({ items: [] })).toBeNull()
    expect(channelTitle({ items: [{ snippet: { title: '' } }] })).toBeNull()
    expect(channelTitle(null)).toBeNull()
    expect(channelTitle({ items: 'x' })).toBeNull()
  })
})

describe('設定の既定の公開範囲', () => {
  const D = { youtubePrivacy: 'unlisted', tiktokPrivacy: 'FOLLOWER_OF_CREATOR' } as const
  it('publishDefaultsFrom は設定を疑って読む', () => {
    expect(publishDefaultsFrom({ publish: { youtube: { privacy: 'public' }, tiktok: { privacy: 'PUBLIC_TO_EVERYONE' } } })).toEqual({ youtubePrivacy: 'public', tiktokPrivacy: 'PUBLIC_TO_EVERYONE' })
    expect(publishDefaultsFrom({})).toEqual(BUILTIN_DEFAULTS)
    expect(publishDefaultsFrom(null)).toEqual({ youtubePrivacy: 'private', tiktokPrivacy: 'SELF_ONLY' })
    expect(publishDefaultsFrom({ publish: { youtube: { privacy: 'friends' }, tiktok: { privacy: 'self_only' } } })).toEqual(BUILTIN_DEFAULTS)
    expect(publishDefaultsFrom({ publish: 'x' })).toEqual(BUILTIN_DEFAULTS)
  })
  it('publish.json に無ければ設定の値（既定の印つき）', () => {
    const r = parsePublishJson({ title: 't', tiktok: { enabled: true, caption: 'c' } }, NOW, D)
    expect(r.spec?.youtube).toMatchObject({ privacy: 'unlisted', privacyDefaulted: true })
    expect(r.spec?.tiktok).toMatchObject({ privacy: 'FOLLOWER_OF_CREATOR', privacyDefaulted: true })
    expect(r.issues).toContainEqual({ level: 'warning', field: 'youtube.privacy', code: 'default', detail: 'unlisted' })
  })
  it('publish.json が設定より先', () => {
    const r = parsePublishJson({ title: 't', youtube: { privacy: 'public' }, tiktok: { privacy: 'SELF_ONLY' } }, NOW, D)
    expect(r.spec?.youtube).toMatchObject({ privacy: 'public', privacyDefaulted: false })
    expect(r.spec?.tiktok).toMatchObject({ privacy: 'SELF_ONLY', privacyDefaulted: false })
  })
  it('publish.json のおかしな値は設定の値へ（公開にはしない）', () => {
    const r = parsePublishJson({ title: 't', youtube: { privacy: 'everyone' }, tiktok: { privacy: 7 } }, NOW, D)
    expect(r.spec?.youtube).toMatchObject({ privacy: 'unlisted', privacyDefaulted: true })
    expect(r.spec?.tiktok).toMatchObject({ privacy: 'FOLLOWER_OF_CREATOR', privacyDefaulted: true })
  })
  it('予約は設定が公開でも非公開にする', () => {
    const r = parsePublishJson({ title: 't', youtube: { publishAt: '2026-11-01T00:00:00Z' } }, NOW, { ...D, youtubePrivacy: 'public' })
    expect(r.spec?.youtube.privacy).toBe('private')
  })
  it('withPrivacy は1つの投稿先だけを書き、ほかは残す', () => {
    expect(withPrivacy({ title: 'x', youtube: { categoryId: '27' }, extra: 1 }, 'youtube', 'public')).toEqual({ title: 'x', youtube: { categoryId: '27', privacy: 'public' }, extra: 1 })
    expect(withPrivacy({ tiktok: 'bad' }, 'tiktok', 'MUTUAL_FOLLOW_FRIENDS')).toEqual({ tiktok: { privacy: 'MUTUAL_FOLLOW_FRIENDS' } })
    expect(withPrivacy({}, 'youtube', 'SELF_ONLY')).toBeNull()
    expect(withPrivacy({}, 'tiktok', 'public')).toBeNull()
    expect(withPrivacy({}, 'youtube', 'Public')).toBeNull() // 書くときは正しい綴りだけ
    expect(withPrivacy(null, 'youtube', 'private')).toEqual({ youtube: { privacy: 'private' } })
  })
})
