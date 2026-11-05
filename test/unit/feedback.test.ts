import { describe, expect, it } from 'vitest'
import { assembleFromDraft, assembleFromOrganized, imagePlan } from '../../src/main/pipeline/assemble'
import { buildDraft } from '../../src/main/pipeline/draft'
import { renderFeedbackMarkdown, renderSendCommand } from '../../src/main/pipeline/feedback'
import type { OrganizeOutput } from '../../src/main/pipeline/types'
import { material } from './fixtures'
import { setLocale } from '@shared/i18n'

// 日本語の文言を確かめるテストなので、画面の言語を日本語に固定する（既定は英語）
setLocale('ja')

const organized: OrganizeOutput = {
  items: [
    {
      title: '申し込みボタンの色が薄い',
      request: '「申し込む」ボタンの色を濃くし、押せることが分かるようにする',
      status: 'decided',
      quotes: [{ speaker: 'self', t: 18_000, text: 'このボタンの色が薄いです' }],
      frame_times: [19_750],
      annotation_ids: ['p3'],
    },
    {
      title: '見出しが小さい',
      request: 'トップの見出しを大きくする',
      status: 'decided',
      quotes: [
        { speaker: 'self', t: 2_000, text: 'この見出しが小さいですね' },
        { speaker: 'self', t: 5_500, text: 'もう少し大きくしてください' },
      ],
      frame_times: [3_000],
      annotation_ids: [],
    },
    {
      title: '表記の統一をどうするか',
      request: '単位の表記をどちらに揃えるか決める',
      status: 'needs_check',
      quotes: [{ speaker: 'self', t: 24_800, text: '表記がばらばらです' }],
      frame_times: [25_400],
      annotation_ids: ['x1'],
    },
  ],
  dropped: [{ t: 2_000, text: 'この見出しが小さいですね', reason: 'テスト用' }],
}

describe('feedback.md の生成', () => {
  it('要件6章の形式で書き出す', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc)

    expect(md).toContain('# UIフィードバック（2件）'); // needs_check は既定で外れる
    // 2件はトップと料金の別のページの指摘なので、対象ごとの節に分かれる
    expect(md).toContain('- 対象: 2件（指摘は、どのファイル・URLへのものかで下の節に分けた）')
    expect(md).toContain('- 収録: 2026-10-02 10:40 / 1分0秒')
    expect(md).toContain('- 画像内の赤い線はレビュアーのペン書き込み、赤いリングはカーソル位置。')
    expect(md).toContain('- 発話は音声認識によるため、誤変換の可能性がある。')
    // 文字起こしのファイルの形（エージェントが項目名を推し量って NaN:NaN にしないように）
    expect(md).toContain('transcript.jsonl')
    expect(md).toContain('t0・t1 は録画開始からのミリ秒')
    expect(md).toContain('speaker は self（自分＝レビューした人）か other（相手）')

    expect(md).toContain('## 対象 1: localhost:3000\n- URL: http://localhost:3000/')
    expect(md).toContain('### 1. [00:02] 見出しが小さい')
    expect(md).toContain('## 対象 2: localhost:3000/pricing\n- URL: http://localhost:3000/pricing')
    expect(md).toContain('### 2. [00:18] 申し込みボタンの色が薄い')
    expect(md).toContain('- 要望: 「申し込む」ボタンの色を濃くし、押せることが分かるようにする')
    expect(md).toContain('- 発話（原文）: 「このボタンの色が薄いです」')
    expect(md).toContain('- URL: http://localhost:3000/pricing （表示幅 1280px）')
    expect(md).toContain('- 要素: `button.plan-cta`（テキスト「申し込む」）')
    expect(md).toContain('- 直前の操作: トップ →「料金」をクリック → 料金')
  })

  it('対象が1つなら節に分けず、冒頭に対象を書く', () => {
    const doc = assembleFromOrganized(material, organized)
    const single = { ...doc, items: doc.items.map((it) => ({ ...it, context: { ...it.context, url: 'http://localhost:3000/pricing' } })) }
    const md = renderFeedbackMarkdown(single)
    expect(md).toContain('- 対象: http://localhost:3000/')
    expect(md).toContain('## 1. [00:02] 見出しが小さい')
    expect(md).not.toContain('## 対象 1')
  })

  it('対象の節には、ファイルなら相対パス、URLなら環境のラベルを書く', () => {
    const doc = assembleFromOrganized(material, organized)
    const urls = ['ade-preview://project/docs/a.md', 'https://dev.example.com/pricing?token=a8F3kQ9zX2vB'] // gitleaks:allow（伏せ字の確認用の偽の値）
    const mixed = {
      ...doc,
      meta: { ...doc.meta, urlPresets: [{ id: 'd', label: 'dev', url: 'https://dev.example.com/' }] },
      items: doc.items.map((it, i) => ({ ...it, context: { ...it.context, url: urls[i % 2] } }))
    }
    const md = renderFeedbackMarkdown(mixed)
    expect(md).toContain('## 対象 1: docs/a.md\n- ファイル: docs/a.md（プロジェクト内のこのファイルを直す）')
    expect(md).toContain('## 対象 2: dev · dev.example.com/pricing')
    expect(md).toContain('- 環境: dev')
    expect(md).not.toContain('a8F3kQ9zX2vB')
    expect(renderFeedbackMarkdown(mixed, { locale: 'en' })).toContain('## Target 1: docs/a.md\n- File: docs/a.md')
  })

  it('各指摘に「完了の条件」（受け入れ条件）を要望から付け、冒頭で受け入れ条件として扱うよう書く', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc)
    expect(md).toContain('- 各指摘の「完了の条件」が受け入れ条件。')
    expect(md).toContain('- 要望: 「申し込む」ボタンの色を濃くし、押せることが分かるようにする\n- 完了の条件: 「「申し込む」ボタンの色を濃くし、押せることが分かるようにする」が実装され、変更後の画面や動作で確かめられていること。')
    // 要望の数だけ付く（送信対象の2件）
    expect(md.match(/^- 完了の条件: /gm)).toHaveLength(2)
  })

  it('「要確認」の指摘には完了の条件を付けない。要望が無ければ見出しから作る', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { includeNeedsCheck: true })
    expect(md.match(/^- 完了の条件: /gm)).toHaveLength(2)
    const noRequest = { ...doc, items: doc.items.map((it) => ({ ...it, request: '' })) }
    expect(renderFeedbackMarkdown(noRequest)).toContain('- 完了の条件: 「見出しが小さい」の指摘が直り、変更後の画面や動作で確かめられていること。')
    expect(renderFeedbackMarkdown(doc, { locale: 'en' })).toMatch(/^- Done when: ".+" is implemented and confirmed on the changed screen or behavior\.$/m)
  })

  it('時刻の順に番号を振り直す', () => {
    const doc = assembleFromOrganized(material, organized)
    expect(doc.items.map((i) => i.title)).toEqual([
      '見出しが小さい',
      '申し込みボタンの色が薄い',
      '表記の統一をどうするか',
    ])
    expect(doc.items.map((i) => i.index)).toEqual([1, 2, 3])
  })

  it('「要確認」は既定で送信対象から外し、件数を末尾に書く', () => {
    const doc = assembleFromOrganized(material, organized)
    const needsCheck = doc.items.find((i) => i.status === 'needs_check')!
    expect(needsCheck.include).toBe(false)

    const md = renderFeedbackMarkdown(doc)
    expect(md).not.toContain('表記の統一をどうするか')
    expect(md).toContain('結論が出ていない話題 1 件は「要確認」として送信対象から外した')
  })

  it('「要確認」を含める指定にすると【要確認】を付けて書き出す', () => {
    const doc = assembleFromOrganized(material, organized)
    const md = renderFeedbackMarkdown(doc, { includeNeedsCheck: true })
    expect(md).toContain('# UIフィードバック（3件）')
    expect(md).toContain('【要確認】表記の統一をどうするか')
  })

  it('MTGでは話者名を付ける', () => {
    const mtg = { ...material, meta: { ...material.meta, twoSpeakers: true } }
    const doc = assembleFromOrganized(mtg, {
      items: [
        {
          title: 'ボタンの色',
          request: '濃くする',
          status: 'decided' as const,
          quotes: [{ speaker: 'other' as const, t: 18_000, text: 'このボタンの色が薄いです' }],
          frame_times: [19_750],
          annotation_ids: [],
        },
      ],
      dropped: [],
    })
    const md = renderFeedbackMarkdown(doc)
    expect(md).toContain('- 発話（原文）: 相手「このボタンの色が薄いです」')
  })

  it('画像は feedback.md に出る順（時刻順）に 01.png から振り、同じ時刻は同じファイルにする', () => {
    const doc = assembleFromOrganized(material, organized)
    const byTitle = new Map(doc.items.map((i) => [i.title, i]))
    // 1件目（00:02 見出し）が 01.png、2件目（00:18 ボタン）が 02.png
    expect(byTitle.get('見出しが小さい')!.images).toEqual(['./01.png'])
    expect(byTitle.get('申し込みボタンの色が薄い')!.images).toEqual(['./02.png'])
  })

  it('同じ静止画を参照する指摘は同じファイル名を共有する', () => {
    const shared = {
      items: [
        {
          title: '1件目',
          request: 'a',
          status: 'decided' as const,
          quotes: [{ speaker: 'self' as const, t: 18_000, text: 'このボタンの色が薄いです' }],
          frame_times: [19_750],
          annotation_ids: []
        },
        {
          title: '2件目',
          request: 'b',
          status: 'decided' as const,
          quotes: [{ speaker: 'self' as const, t: 24_800, text: '表記がばらばらです' }],
          frame_times: [19_750],
          annotation_ids: []
        }
      ],
      dropped: []
    }
    // 出力が引いている発話だけの素材にする（出力に無い発話は、話したそのままの指摘として足される）
    const spoken = { ...material, transcript: material.transcript.filter((s) => s.t0 === 18_000 || s.t0 === 24_800) }
    const doc = assembleFromOrganized(spoken, shared)
    expect(doc.items.map((i) => i.images)).toEqual([['./01.png'], ['./01.png']])
  })

  it('保存すべき画像の一覧を出せる（送信対象だけ）', () => {
    const doc = assembleFromOrganized(material, organized)
    const plan = imagePlan(doc, material.frames)
    expect(plan.map((p) => p.name).sort()).toEqual(['./01.png', './02.png']);
    // ペンもテキストも無い指摘の画像にはカーソルのリングを合成する
    const headingImage = plan.find((p) => p.frame.t === 3_000)!
    expect(headingImage.needsCursorRing).toBe(true)
    const buttonImage = plan.find((p) => p.frame.t === 19_750)!
    expect(buttonImage.needsCursorRing).toBe(false)
  })

  it('URL・要素は画像と同じ瞬間から引く（遷移直前に話し始めた指摘でも遷移後のURLになる）', () => {
    // 遷移(13000)の直前(12800)に話し始め、画像は遷移後(13200)の指摘
    const m = {
      ...material,
      transcript: [
        { t0: 12_800, t1: 16_000, speaker: 'self' as const, text: 'この料金表が読みにくい', source: 'mic' as const },
      ],
    }
    const doc = assembleFromOrganized(m, {
      items: [
        {
          title: '料金表が読みにくい',
          request: '読みやすくする',
          status: 'decided' as const,
          quotes: [{ speaker: 'self' as const, t: 12_800, text: 'この料金表が読みにくい' }],
          frame_times: [13_200],
          annotation_ids: [],
        },
      ],
      dropped: [],
    })
    const item = doc.items[0]!;
    // 見出しの時刻は発話の開始（動画のシーク先）
    expect(item.t).toBe(12_800);
    // 文脈は画像の時刻（遷移後）
    expect(item.contextTime).toBe(13_200)
    expect(item.context.url).toBe('http://localhost:3000/pricing')
  })

  it('送信時の指示文を作れる', () => {
    expect(renderSendCommand('.ade-movie/reviews/20261002-104012')).toBe(
      '".ade-movie/reviews/20261002-104012/feedback.md" と、同じフォルダにある各指摘の画像を読み、送信対象の指摘をすべて実装してください。受け入れ条件は、すべての指摘が実装され、指摘ごとに完了したことを確かめたことです。確かめるときは、変更した画面や動作を実際に確認してください。テストやビルドが通るだけでは完了としません。最後に、指摘ごとに「完了／未完了（理由）」と確かめた方法を一覧で報告してください。未完了の指摘が残っている間は、完了と報告しないでください。 作業しながら、feedback.md の「進み具合」の節に従って ".ade-movie/reviews/20261002-104012/progress.json" に指摘ごとの進み具合を書いてください。指摘ごとに「直す → feedback.md の「AFTER のスクリーンショット」の節のとおり AFTER を撮る → human_review にする」を1つの単位とし、使えるならサブエージェントで並列に進めてください。done にするのはレビューした人だけです。レビューした人に質問して止まらないでください。前提が合わない指摘（録画が古いなど）も、意図に最も沿う形で実装して AFTER を撮り、human_review にして、何を仮定したかを note に1行で書いてください。',
    )
  })
})

describe('下書きのままの feedback.md（LLM未使用）', () => {
  it('発話の原文を見出しにして、要約されていない旨を書く', () => {
    const draft = buildDraft(material)
    const doc = assembleFromDraft(material, draft.items)
    const md = renderFeedbackMarkdown(doc)

    expect(doc.organizedByLlm).toBe(false)
    expect(md).toContain('- この一覧はルールによる自動分割のみで、要約されていない')
    expect(md).toContain('この見出しが小さいですね もう少し大きくしてください')
    // 書き込み単独の指摘も残る
    expect(md).toContain('ペンで囲んだ箇所')
  })

  it('書き込みだけの指摘は、ペンの見出しを付ける', () => {
    const material2 = { ...material, transcript: [] }
    const draft = buildDraft(material2)
    const doc = assembleFromDraft(material2, draft.items)
    expect(doc.items.length).toBeGreaterThan(0)
    // 囲んだ要素（表示テキスト、無ければセレクタ）を見出しに添える
    expect(doc.items.map((i) => i.title)).toEqual(['ペンで囲んだ箇所: “申し込む”', 'ペンで囲んだ箇所: div.footer'])
  })
})
