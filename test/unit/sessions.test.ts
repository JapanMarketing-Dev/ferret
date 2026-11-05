import { beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendEvents,
  applyEdits,
  clearWork,
  createSession,
  ensureGitExclude,
  findIncompleteSessions,
  frameCandidates,
  isSessionId,
  listSessions,
  loadSession,
  pruneRecordings,
  readEvents,
  saveSession,
  sessionId,
  sessionPaths,
  writeFeedbackMarkdown
} from '../../src/main/sessions/index'
import type { SessionRecord } from '../../src/main/sessions/store'
import type { ItemEdit } from '../../src/main/sessions/edits'
import { assembleFromOrganized } from '../../src/main/pipeline/assemble'
import { renderFeedbackMarkdown } from '../../src/main/pipeline/feedback'
import { buildDraft } from '../../src/main/pipeline/draft'
import { material } from './fixtures'

// 期待値は日本語の文言。画面の言語を日本語に固定する（既定は英語）
import { setLocale } from '@shared/i18n'
setLocale('ja')

let project: string

beforeEach(async () => {
  project = await mkdtemp(join(tmpdir(), 'ade-session-'))
})

const organized = {
  items: [
    {
      title: '見出しが小さい',
      request: '大きくする',
      status: 'decided' as const,
      quotes: [{ speaker: 'self' as const, t: 2_000, text: 'この見出しが小さいですね' }, { speaker: 'self' as const, t: 5_500, text: 'もう少し大きくしてください' }],
      frame_times: [3_000],
      annotation_ids: []
    },
    {
      title: 'ボタンの色が薄い',
      request: '濃くする',
      status: 'decided' as const,
      quotes: [{ speaker: 'self' as const, t: 18_000, text: 'このボタンの色が薄いです' }],
      frame_times: [19_750],
      annotation_ids: ['p3']
    },
    {
      title: '表記をどうするか',
      request: '決める',
      status: 'needs_check' as const,
      quotes: [{ speaker: 'self' as const, t: 24_800, text: '表記がばらばらです' }],
      frame_times: [25_400],
      annotation_ids: ['x1']
    }
  ],
  dropped: []
}

describe('セッションID とフォルダ構成（設計8章）', () => {
  it('日時から YYYYMMDD-HHMMSS を作る', () => {
    expect(sessionId(new Date(2026, 9, 2, 10, 40, 12))).toBe('20261002-104012')
    expect(isSessionId('20261002-104012')).toBe(true)
    expect(isSessionId('work')).toBe(false)
  })

  it('設計どおりのパスを組み立てる', () => {
    const p = sessionPaths('/proj', '20261002-104012')
    // 実際のパスは OS の区切り（Windows は \\）。Agent へ渡す相対パス（relativeDir）だけは常に /
    const dir = join('/proj', '.ferret', 'reviews', '20261002-104012')
    expect(p.dir).toBe(dir)
    expect(p.relativeDir).toBe('.ferret/reviews/20261002-104012')
    expect(p.feedbackMd).toBe(join(dir, 'feedback.md'))
    expect(p.sessionJson).toBe(join(dir, 'session.json'))
    expect(p.eventsJsonl).toBe(join(dir, 'events.jsonl'))
    expect(p.recording).toBe(join(dir, 'recording.webm'))
    expect(p.audioDir).toBe(join(dir, 'work', 'audio'))
    expect(p.framesDir).toBe(join(dir, 'work', 'frames'))
  })

  it('録画開始でフォルダを作る', async () => {
    const p = await createSession(project, new Date(2026, 9, 2, 10, 40, 12))
    expect(existsSync(p.audioDir)).toBe(true)
    expect(existsSync(p.framesDir)).toBe(true)
  })
})

describe('操作ログ（events.jsonl）', () => {
  it('追記で書き、時刻順に読み戻す', async () => {
    const p = await createSession(project)
    await appendEvents(p, [{ t: 100, type: 'nav', url: 'http://x/', title: 'トップ' }])
    await appendEvents(p, [
      { t: 50, type: 'click', x: 1, y: 2, el: { selector: 'a' } },
      { t: 300, type: 'scroll', y: 10 }
    ])
    const events = await readEvents(p)
    expect(events.map((e) => e.t)).toEqual([50, 100, 300])
  })

  it('異常終了で書きかけになった行は捨てる（NF-12）', async () => {
    const p = await createSession(project)
    await appendEvents(p, [{ t: 100, type: 'nav', url: 'http://x/', title: 'トップ' }])
    await writeFile(p.eventsJsonl, `${await readFile(p.eventsJsonl, 'utf8')}{"t":200,"type":"na`, 'utf8')
    const events = await readEvents(p)
    expect(events).toHaveLength(1)
  })

  it('空の配列では何も書かない', async () => {
    const p = await createSession(project)
    await appendEvents(p, [])
    expect(existsSync(p.eventsJsonl)).toBe(false)
  })
})

describe('session.json', () => {
  const record = (): SessionRecord => ({
    version: 1,
    meta: material.meta,
    transcript: material.transcript,
    removedDuplicates: [],
    frames: material.frames,
    draft: [],
    document: assembleFromOrganized(material, organized),
    edits: []
  })

  it('書いて読み戻せる', async () => {
    const p = await createSession(project)
    await saveAndCheck(p, record())
  })

  it('壊れていたら null を返す（復元へ回す）', async () => {
    const p = await createSession(project)
    await writeFile(p.sessionJson, '{壊れている', 'utf8')
    expect(await loadSession(p)).toBeNull()
  })

  it('版が違えば null を返す', async () => {
    const p = await createSession(project)
    await writeFile(p.sessionJson, JSON.stringify({ version: 99 }), 'utf8')
    expect(await loadSession(p)).toBeNull()
  })

  it('廃止した「置いたテキスト」を含む古いレビューも、落ちずに読み込んで書き込みとして表示する', async () => {
    const p = await createSession(project)
    // 旧版が書いた events.jsonl（text の行）と session.json（source: 'text' の引用）をそのまま置く
    const legacyText = { t: 25_100, type: 'text', id: 'x1', x: 300, y: 520, body: 'ここは「月額」表記に統一' }
    await writeFile(p.eventsJsonl, `${JSON.stringify({ t: 0, type: 'nav', url: 'http://x/', title: 'トップ' })}\n${JSON.stringify(legacyText)}\n`, 'utf8')
    const legacy = record()
    const item = legacy.document.items[1]!
    // 共有の organized を書き換えないよう、引用は新しい配列にする
    legacy.document.items[1] = { ...item, quotes: [{ source: 'text', speaker: 'self', t: 25_100, text: 'ここは「月額」表記に統一' }, ...item.quotes] }
    await writeFile(p.sessionJson, JSON.stringify(legacy), 'utf8')

    const back = await loadSession(p)
    expect(back?.document.items).toHaveLength(3)
    expect(renderFeedbackMarkdown(back!.document)).toContain('書き込み「ここは「月額」表記に統一」')
    // 操作ログの text 行は読めるが、下書きでは書き込みとして扱わない
    const events = await readEvents(p)
    expect(events).toHaveLength(2)
    const draft = buildDraft({ ...material, events })
    expect(draft.items.some((i) => i.annotationIds.includes('x1'))).toBe(false)
  })

  it('分解後に中間ファイルを片付ける', async () => {
    const p = await createSession(project)
    await writeFile(join(p.audioDir, 'c0.wav'), 'x', 'utf8')
    await clearWork(p)
    expect(existsSync(p.workDir)).toBe(false)
  })

  async function saveAndCheck(p: ReturnType<typeof sessionPaths>, r: SessionRecord): Promise<void> {
    const { saveSession } = await import('../../src/main/sessions/store')
    await saveSession(p, r)
    const back = await loadSession(p)
    expect(back?.document.items).toHaveLength(3)
    expect(back?.meta.id).toBe(material.meta.id)
  }
})

describe('確認画面の編集（REV-2 / REV-3 / REV-5）', () => {
  const base = () => assembleFromOrganized(material, organized)
  const apply = (edits: ItemEdit[]) =>
    applyEdits({ document: base(), edits, events: material.events, frames: material.frames })

  it('テキストを直せる', () => {
    const id = base().items[0]!.id
    const { document } = apply([{ kind: 'text', id, title: '新しい見出し', request: '新しい要望' }])
    expect(document.items[0]!.title).toBe('新しい見出し')
    expect(document.items[0]!.request).toBe('新しい要望')
  })

  it('指摘を削除すると、番号と画像名を振り直す', () => {
    const id = base().items[0]!.id
    const { document } = apply([{ kind: 'delete', id }])
    expect(document.items).toHaveLength(2)
    expect(document.items.map((i) => i.index)).toEqual([1, 2])
    expect(document.items[0]!.images).toEqual(['./01.png'])
  })

  it('隣り合う指摘を結合する（引用と画像を束ね、見出しは先頭を使う）', () => {
    const [a, b] = base().items
    const { document } = apply([{ kind: 'merge', ids: [a!.id, b!.id] }])
    expect(document.items).toHaveLength(2)
    const merged = document.items[0]!
    expect(merged.title).toBe('見出しが小さい')
    expect(merged.request).toBe('大きくする / 濃くする')
    expect(merged.quotes.map((q) => q.t)).toEqual([2_000, 5_500, 18_000])
    expect(merged.frameTimes).toEqual([3_000, 19_750])
  })

  it('要確認を含むものを結合したら、結果も要確認のままにする', () => {
    const items = base().items
    const decided = items.find((i) => i.status === 'decided')!
    const needsCheck = items.find((i) => i.status === 'needs_check')!
    const { document } = apply([{ kind: 'merge', ids: [decided.id, needsCheck.id] }])
    const merged = document.items.find((i) => i.id === decided.id)!
    expect(merged.status).toBe('needs_check')
    expect(merged.include).toBe(false)
  })

  it('要確認を確定させると送信対象に入る', () => {
    const id = base().items.find((i) => i.status === 'needs_check')!.id
    const { document } = apply([{ kind: 'status', id, status: 'decided' }])
    const item = document.items.find((i) => i.id === id)!
    expect(item.status).toBe('decided')
    expect(item.include).toBe(true)
    expect(renderFeedbackMarkdown(document)).toContain('表記をどうするか')
  })

  it('要確認を送信対象に含める／外すを切り替えられる', () => {
    const id = base().items.find((i) => i.status === 'needs_check')!.id
    expect(apply([{ kind: 'include', id, include: true }]).document.items.find((i) => i.id === id)!.include).toBe(true)
    expect(apply([{ kind: 'include', id, include: false }]).document.items.find((i) => i.id === id)!.include).toBe(false)
  })

  it('画像を差し替えると、URL・要素・直前の操作も引き直す（設計5章④）', () => {
    const target = base().items.find((i) => i.title === '見出しが小さい')!
    expect(target.context.url).toBe('http://localhost:3000/')
    // 遷移後（13200）の静止画へ差し替える
    const { document } = apply([{ kind: 'frames', id: target.id, frameTimes: [13_200] }])
    const after = document.items.find((i) => i.id === target.id)!
    expect(after.frameTimes).toEqual([13_200])
    expect(after.contextTime).toBe(13_200)
    expect(after.context.url).toBe('http://localhost:3000/pricing')
  })

  it('存在しない時刻の静止画は選べない', () => {
    const id = base().items[0]!.id
    const { document, skipped } = apply([{ kind: 'frames', id, frameTimes: [999_999] }])
    expect(skipped).toHaveLength(1)
    expect(document.items[0]!.frameTimes).toEqual([3_000])
  })

  it('全体への補足コメントを足せる（REV-5）', () => {
    const { document } = apply([{ kind: 'note', note: 'スマホ幅を優先してください' }])
    expect(document.note).toBe('スマホ幅を優先してください')
    expect(renderFeedbackMarkdown(document)).toContain('補足: スマホ幅を優先してください')
  })

  it('見つからないIDの編集は skipped に入れ、ほかの編集は適用する', () => {
    const id = base().items[0]!.id
    const { document, skipped } = apply([
      { kind: 'text', id: 'いない', title: 'x' },
      { kind: 'text', id, title: '適用される' }
    ])
    expect(skipped).toHaveLength(1)
    expect(document.items[0]!.title).toBe('適用される')
  })

  it('編集を並べた順に適用する（同じ指摘への連続した編集）', () => {
    const id = base().items[0]!.id
    const { document } = apply([
      { kind: 'text', id, title: '1回目' },
      { kind: 'text', id, title: '2回目' }
    ])
    expect(document.items[0]!.title).toBe('2回目')
  })

  it('画像の差し替え候補を、いまの時刻の前後から近い順に出す（REV-3）', () => {
    const candidates = frameCandidates(material.frames, 19_750, 3)
    expect(candidates.map((f) => f.t)).toEqual([13_200, 19_750, 25_400])
  })
})

describe('履歴（OUT-5）', () => {
  it('新しい順に並べ、件数と動画の有無を返す', async () => {
    const a = await createSession(project, new Date(2026, 9, 1, 9, 0, 0))
    const b = await createSession(project, new Date(2026, 9, 2, 10, 40, 12))
    const { saveSession } = await import('../../src/main/sessions/store')
    const doc = assembleFromOrganized(material, organized)
    for (const p of [a, b]) {
      await saveSession(p, {
        version: 1,
        meta: material.meta,
        transcript: [],
        removedDuplicates: [],
        frames: material.frames,
        draft: [],
        document: doc,
        edits: []
      })
      await writeFeedbackMarkdown(p, '# x\n')
    }
    await writeFile(b.recording, 'video', 'utf8')

    const list = await listSessions(project)
    expect(list.map((s) => s.id)).toEqual(['20261002-104012', '20261001-090000'])
    expect(list[0]!.hasRecording).toBe(true)
    expect(list[1]!.hasRecording).toBe(false)
    // 履歴は一覧と同じ全指摘数。要確認も含める。
    expect(list[0]!.itemCount).toBe(3)
    expect(list[0]!.needsCheckCount).toBe(1)
  })

  it('session.json が無いフォルダも incomplete として一覧に出す', async () => {
    await createSession(project, new Date(2026, 9, 2, 10, 40, 12))
    const list = await listSessions(project)
    expect(list).toHaveLength(1)
    expect(list[0]!.incomplete).toBe(true)
  })

  it('セッションID以外のフォルダは無視する', async () => {
    await mkdir(join(project, '.ade-movie', 'reviews', 'メモ'), { recursive: true })
    expect(await listSessions(project)).toHaveLength(0)
  })

  it('reviews フォルダが無くても落ちない', async () => {
    expect(await listSessions(join(project, 'ない'))).toEqual([])
  })
})

describe('動画の保持期間（NF-8）', () => {
  it('期間を過ぎた動画だけ消し、feedback.md と画像は残す', async () => {
    const p = await createSession(project, new Date(2026, 9, 2, 10, 40, 12))
    await writeFile(p.recording, 'video', 'utf8')
    await writeFeedbackMarkdown(p, '# x\n')
    await writeFile(join(p.dir, '01.png'), 'img', 'utf8')
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    await utimes(p.recording, old, old)
    await saveSession(p, { version: 1, meta: material.meta, transcript: [], removedDuplicates: [], frames: material.frames, draft: [], document: assembleFromOrganized(material, organized), edits: [] })

    const result = await pruneRecordings(project, { keepDays: 7 })
    expect(result.removedRecordings).toHaveLength(1)
    expect(existsSync(p.recording)).toBe(false)
    expect(existsSync(p.feedbackMd)).toBe(true)
    expect(existsSync(join(p.dir, '01.png'))).toBe(true)
  })

  it('期間内の動画は消さない', async () => {
    const p = await createSession(project)
    await writeFile(p.recording, 'video', 'utf8')
    const result = await pruneRecordings(project, { keepDays: 7 })
    expect(result.removedRecordings).toHaveLength(0)
    expect(existsSync(p.recording)).toBe(true)
  })

  it('keepDays が 0 以下なら削除しない（無期限保持）', async () => {
    const p = await createSession(project)
    await writeFile(p.recording, 'video', 'utf8')
    const old = new Date(Date.now() - 999 * 24 * 60 * 60 * 1000)
    await utimes(p.recording, old, old)
    expect((await pruneRecordings(project, { keepDays: 0 })).removedRecordings).toHaveLength(0)
    expect(existsSync(p.recording)).toBe(true)
  })

  it('dryRun では消さずに対象だけ返す', async () => {
    const p = await createSession(project)
    await writeFile(p.recording, 'video', 'utf8')
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000)
    await utimes(p.recording, old, old)
    await saveSession(p, { version: 1, meta: material.meta, transcript: [], removedDuplicates: [], frames: material.frames, draft: [], document: assembleFromOrganized(material, organized), edits: [] })
    const result = await pruneRecordings(project, { keepDays: 7, dryRun: true })
    expect(result.removedRecordings).toHaveLength(1)
    expect(existsSync(p.recording)).toBe(true)
  })
})

describe('.git/info/exclude への追記（NF-9）', () => {
  it('追記し、.gitignore は触らない', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await writeFile(join(project, '.gitignore'), 'node_modules/\n', 'utf8')

    expect(await ensureGitExclude(project)).toBe('added')
    const exclude = await readFile(join(project, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude).toContain('.ade-movie/')
    expect(await readFile(join(project, '.gitignore'), 'utf8')).toBe('node_modules/\n')
  })

  it('2回呼んでも二重に書かない', async () => {
    await mkdir(join(project, '.git'), { recursive: true })
    await ensureGitExclude(project)
    expect(await ensureGitExclude(project)).toBe('already')
    const exclude = await readFile(join(project, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.split('.ade-movie/').length - 1).toBe(1)
  })

  it('既存の内容を壊さず、改行が無くても足す', async () => {
    await mkdir(join(project, '.git', 'info'), { recursive: true })
    await writeFile(join(project, '.git', 'info', 'exclude'), '*.log', 'utf8')
    await ensureGitExclude(project)
    const exclude = await readFile(join(project, '.git', 'info', 'exclude'), 'utf8')
    expect(exclude.startsWith('*.log\n')).toBe(true)
    expect(exclude).toContain('.ade-movie/')
  })

  it('gitリポジトリでなければ no-git（エラーにしない）', async () => {
    expect(await ensureGitExclude(project)).toBe('no-git')
  })

  it('worktree（.git がファイル）でも、git が確かめた元のリポジトリの除外ファイルへ書く', async () => {
    const { execFileSync } = await import('node:child_process')
    const main = join(project, 'main')
    const wt = join(project, 'wt')
    execFileSync('git', ['init', '-q', main])
    execFileSync('git', ['-C', main, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'])
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', wt])
    expect(await ensureGitExclude(wt)).toBe('added')
    // worktree の除外は元のリポジトリの info/exclude が効く
    expect(await readFile(join(main, '.git', 'info', 'exclude'), 'utf8')).toContain('.ferret/')
  })

  it('偽の gitdir:（任意のフォルダを指す）には書かない', async () => {
    const real = join(project, 'realgit')
    await mkdir(real, { recursive: true })
    await writeFile(join(project, '.git'), `gitdir: ${real}\n`, 'utf8')
    expect(await ensureGitExclude(project)).toBe('no-git')
    expect(existsSync(join(real, 'info', 'exclude'))).toBe(false)
  })
})

describe('異常終了後の復元（NF-12）', () => {
  it('session.json が無く素材が残っているセッションを見つける', async () => {
    const p = await createSession(project, new Date(2026, 9, 2, 10, 40, 12))
    await appendEvents(p, [{ t: 100, type: 'nav', url: 'http://x/', title: 'トップ' }])
    await writeFile(join(p.audioDir, 'chunk-0000-0.wav'), 'a', 'utf8')
    await writeFile(join(p.framesDir, '0000000.png'), 'f', 'utf8')

    const found = await findIncompleteSessions(project)
    expect(found).toHaveLength(1)
    expect(found[0]!.eventCount).toBe(1)
    expect(found[0]!.audioChunks).toHaveLength(1)
    expect(found[0]!.frameCount).toBe(1)
    expect(found[0]!.worthRecovering).toBe(true)
  })

  it('分解が終わっているセッションは対象にしない', async () => {
    const p = await createSession(project, new Date(2026, 9, 2, 10, 40, 12))
    await appendEvents(p, [{ t: 100, type: 'nav', url: 'http://x/', title: 'トップ' }])
    const { saveSession } = await import('../../src/main/sessions/store')
    await saveSession(p, {
      version: 1,
      meta: material.meta,
      transcript: [],
      removedDuplicates: [],
      frames: [],
      draft: [],
      document: assembleFromOrganized(material, organized),
      edits: []
    })
    expect(await findIncompleteSessions(project)).toHaveLength(0)
  })

  it('素材が何も残っていないセッションは対象にしない', async () => {
    await createSession(project, new Date(2026, 9, 2, 10, 40, 12))
    expect(await findIncompleteSessions(project)).toHaveLength(0)
  })
})
