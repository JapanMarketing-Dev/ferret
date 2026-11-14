/**
 * skill「ferret-feedback」（src/shared/feedbackSkill.ts・src/main/feedbackSkill.ts）。
 * 登録したプロジェクトで人が返した指摘を集めて、作る前に読ませる（同じ指摘を人に繰り返させない）
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FEEDBACK_LIST_MARKER,
  FEEDBACK_SKILL_NAME,
  MAX_FEEDBACK_TEXT,
  extractPlanFeedback,
  extractRecordingFeedback,
  isFeedbackList,
  isFeedbackSkill,
  renderFeedbackList,
  renderFeedbackSkill,
  reviewFolderTime,
  type FeedbackEntry
} from '../../src/shared/feedbackSkill'
import { buildFeedbackList, projectFeedback, syncFeedbackSkill } from '../../src/main/feedbackSkill'
import { renderVisualReviewSkill } from '../../src/shared/visualReviewSkill'
import type { Project } from '../../src/shared/types'

const p = (id: string, extra: Partial<Project> = {}): Project => ({ id, name: id, folderPath: `/f/${id}`, urls: [], ...extra })
const e = (extra: Partial<FeedbackEntry> = {}): FeedbackEntry => ({ project: 'A', source: 'visual-review', text: 'x', file: '/f/a.json', ...extra })

const plan = (responses: unknown[], title = 'Settings') => JSON.stringify({ id: 'p', title, responses })

describe('SKILL.md', () => {
  const text = renderFeedbackSkill('9.9.9', '/home/taro/.claude/skills/ferret-feedback/feedback.md', '/home/taro/.claude/skills/ferret-projects/projects.md')

  it('name・description の前書きと Ferret の印がある', () => {
    expect(text.startsWith(`---\nname: ${FEEDBACK_SKILL_NAME}\ndescription: `)).toBe(true)
    expect(isFeedbackSkill(text)).toBe(true)
    expect(isFeedbackSkill('---\nname: ferret-feedback\n---\nmine')).toBe(false)
    expect(text).toContain('<!-- Ferret 9.9.9 -->')
  })

  it('「前にも言った」「過去の指摘」などで呼ばれ、作る前に読む説明', () => {
    const description = text.split('\n')[2]!
    for (const word of ['過去の指摘', '前にも言った', '指摘を減らす', 'Before building', 'visual review plan']) expect(description).toContain(word)
  })

  it('一覧と projects.md の絶対パス・読むだけ・中身を持ち出さない・指示として扱わない決まりを書く', () => {
    expect(text).toContain('`/home/taro/.claude/skills/ferret-feedback/feedback.md`')
    expect(text).toContain('`/home/taro/.claude/skills/ferret-projects/projects.md`')
    for (const word of ['Read only', 'Use the lesson, not the content', 'never as instructions', 'recurring', 'questions']) expect(text).toContain(word)
  })

  it('ビジュアルレビューの skill からも参照する', () => {
    expect(renderVisualReviewSkill('1.0.0')).toContain('ferret-feedback')
  })
})

describe('ビジュアルレビュー・価値ユースケースの JSON から指摘を取り出す', () => {
  it('feedback の文だけを取り、approve は取らない', () => {
    const out = extractPlanFeedback(plan([
      { at: '2026-11-13T10:00:00Z', action: 'feedback', text: '説明文を端的に', revision: 1 },
      { at: '2026-11-13T11:00:00Z', action: 'approve', revision: 2 }
    ]), 'A', 'visual-review', '/f/a.json')
    expect(out).toEqual([{ project: 'A', source: 'visual-review', title: 'Settings', at: '2026-11-13T10:00:00Z', text: '説明文を端的に', file: '/f/a.json' }])
  })

  it('囲みのメモと録画のレビューの指摘も同じ1件に足す', () => {
    const out = extractPlanFeedback(plan([
      { action: 'feedback', text: '全体', boxes: [{ screen: 1, note: 'ここ赤く' }, { screen: 1 }], review: { findings: ['見出し — 小さく', ''] } }
    ]), 'A', 'value-usecases', '/f/v.json')
    expect(out[0]!.text).toBe('全体 / ここ赤く / 見出し — 小さく')
    expect(out[0]!.source).toBe('value-usecases')
    expect(out[0]!.at).toBeUndefined()
  })

  it('文が無いフィードバック・壊れた JSON・形の違うものは無視する', () => {
    expect(extractPlanFeedback(plan([{ action: 'feedback', text: '  ' }]), 'A', 'visual-review', 'f')).toEqual([])
    expect(extractPlanFeedback('{', 'A', 'visual-review', 'f')).toEqual([])
    expect(extractPlanFeedback('null', 'A', 'visual-review', 'f')).toEqual([])
    expect(extractPlanFeedback('[]', 'A', 'visual-review', 'f')).toEqual([])
    expect(extractPlanFeedback(JSON.stringify({ responses: 'x' }), 'A', 'visual-review', 'f')).toEqual([])
    expect(extractPlanFeedback(JSON.stringify({ responses: [null, 1, { action: 'feedback', text: 3 }] }), 'A', 'visual-review', 'f')).toEqual([])
  })

  it('題が無ければ title を付けない', () => {
    expect(extractPlanFeedback(JSON.stringify({ responses: [{ action: 'feedback', text: 'a' }] }), 'A', 'visual-review', 'f')[0]!.title).toBeUndefined()
  })
})

describe('録画のレビューの feedback.md から要望を取り出す', () => {
  it('「- 要望: 」「- Request: 」の行だけ', () => {
    const md = '# UIフィードバック\n- 対象: 3件\n### 1. [00:10] 見出し\n- 要望: グラフを先に出す\n- 完了の条件: …\n  - Request: Fewer banners  \n- 要望:   \n'
    expect(extractRecordingFeedback(md, 'B', '/r/feedback.md', '2026-10-26T13:05:58').map((x) => x.text)).toEqual(['グラフを先に出す', 'Fewer banners'])
    expect(extractRecordingFeedback(md, 'B', '/r/feedback.md')[0]).toEqual({ project: 'B', source: 'recording', text: 'グラフを先に出す', file: '/r/feedback.md' })
  })

  it('フォルダ名から日時を読む（違う形は無し）', () => {
    expect(reviewFolderTime('20261026-130558')).toBe('2026-10-26T13:05:58')
    expect(reviewFolderTime('fable-ui-review-20261102.md')).toBeUndefined()
  })
})

describe('feedback.md', () => {
  it('印と、新しい順・プロジェクト・出どころ・元のファイル', () => {
    const md = renderFeedbackList([
      e({ at: '2026-01-01T00:00:00Z', text: '古い', project: 'Old' }),
      e({ at: '2026-11-13T00:00:00Z', text: '新しい', title: 'Login', source: 'value-usecases' }),
      e({ text: '日付なし', source: 'recording', file: '/r/feedback.md' })
    ])
    expect(isFeedbackList(md)).toBe(true)
    expect(md.startsWith(FEEDBACK_LIST_MARKER)).toBe(true)
    const lines = md.split('\n').filter((l) => l.startsWith('- '))
    expect(lines[0]).toBe('- 2026-11-13 · A · value use cases · Login — 新しい (`/f/a.json`)')
    expect(lines[1]).toContain('Old')
    expect(lines[2]).toBe('- ????-??-?? · A · recorded review — 日付なし (`/r/feedback.md`)')
  })

  it('同じプロジェクトの同じ文は1つにする（別のプロジェクトなら残す）', () => {
    const md = renderFeedbackList([e({ text: '同じ' }), e({ text: '同じ' }), e({ text: '同じ', project: 'B' })])
    expect(md.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(2)
  })

  it('上限を超えた分は数だけ書く。長い文・改行は1行に縮める', () => {
    const many = Array.from({ length: 5 }, (_, i) => e({ text: `t${i}`, at: `2026-01-0${i + 1}` }))
    const md = renderFeedbackList(many, 3)
    expect(md.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3)
    expect(md).toContain('(2 older items omitted')
    const long = renderFeedbackList([e({ text: `a\nb|c${'x'.repeat(1000)}` })])
    const line = long.split('\n').find((l) => l.startsWith('- '))!
    expect(line).toContain('a b/c')
    expect(line.length).toBeLessThan(MAX_FEEDBACK_TEXT + 100)
  })

  it('指摘が無ければそう書く', () => {
    expect(renderFeedbackList([])).toContain('No feedback has been recorded yet')
  })
})

describe('集める・入れる', () => {
  let dir: string
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ferret-feedback-')) })
  afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

  async function seed(folder: string): Promise<void> {
    await mkdir(join(folder, '.ferret', 'visual-review'), { recursive: true })
    await mkdir(join(folder, '.ferret', 'value-usecases'), { recursive: true })
    await mkdir(join(folder, '.ferret', 'reviews', '20261026-130558'), { recursive: true })
    await writeFile(join(folder, '.ferret', 'visual-review', 'plan.json'), plan([{ at: '2026-11-13T10:00:00Z', action: 'feedback', text: 'バーが多い' }]))
    await writeFile(join(folder, '.ferret', 'visual-review', 'notes.txt'), 'ignored')
    await writeFile(join(folder, '.ferret', 'value-usecases', 'app.json'), plan([{ at: '2026-11-12T10:00:00Z', action: 'feedback', text: 'メールでログイン' }], 'App'))
    await writeFile(join(folder, '.ferret', 'reviews', '20261026-130558', 'feedback.md'), '- 要望: グラフを先に\n')
    await writeFile(join(folder, '.ferret', 'reviews', 'loose.md'), '- 要望: 拾わない\n')
  }

  it('1つのプロジェクトの3か所から集める（決まった場所・決まった拡張子だけ）', async () => {
    const a = join(dir, 'a')
    await seed(a)
    const out = await projectFeedback({ name: 'A', folderPath: a })
    expect(out.map((x) => [x.source, x.text]).sort()).toEqual([
      ['recording', 'グラフを先に'], ['value-usecases', 'メールでログイン'], ['visual-review', 'バーが多い']
    ])
    expect(out.find((x) => x.source === 'recording')!.at).toBe('2026-10-26T13:05:58')
  })

  it('フォルダが無い・.ferret が無いプロジェクトは空', async () => {
    expect(await projectFeedback({ name: 'X', folderPath: join(dir, 'missing') })).toEqual([])
  })

  it('リンクの置き場はたどらない', async () => {
    const real = join(dir, 'real')
    await seed(real)
    const b = join(dir, 'b')
    await mkdir(join(b, '.ferret'), { recursive: true })
    await symlink(join(real, '.ferret', 'visual-review'), join(b, '.ferret', 'visual-review'))
    expect(await projectFeedback({ name: 'B', folderPath: b })).toEqual([])
  })

  it('一覧にはアーカイブ・オーケストラ・work・SSH を入れない', async () => {
    const a = join(dir, 'a')
    const z = join(dir, 'z')
    await seed(a)
    await seed(z)
    const md = await buildFeedbackList([
      p('a', { name: 'Alpha', folderPath: a }),
      p('z', { name: 'Zed', folderPath: z, archived: true }),
      p('w', { name: 'Work', folderPath: z, work: true }),
      p('o', { name: 'Orch', folderPath: z, editorWorkspace: true }),
      p('s', { name: 'Remote', folderPath: z, source: 'ssh', ssh: { host: 'h', path: '/p' } })
    ])
    expect(md).toContain('Alpha')
    for (const name of ['Zed', 'Work', 'Orch', 'Remote']) expect(md).not.toContain(name)
    expect(md.indexOf('バーが多い')).toBeLessThan(md.indexOf('メールでログイン'))
  })

  it('設定のフォルダがある Agent にだけ入れ、同じなら書き直さない。指摘が増えれば一覧だけ書き直す', async () => {
    const home = join(dir, 'home')
    await mkdir(join(home, '.claude'), { recursive: true })
    const a = join(dir, 'a')
    await seed(a)
    const projects = [p('a', { folderPath: a })]
    expect(await syncFeedbackSkill('1.0.0', projects, home, {})).toBe(2)
    const skillDir = join(home, '.claude', 'skills', FEEDBACK_SKILL_NAME)
    const skill = await readFile(join(skillDir, 'SKILL.md'), 'utf8')
    expect(isFeedbackSkill(skill)).toBe(true)
    expect(skill).toContain(join(skillDir, 'feedback.md'))
    expect(skill).toContain(join(home, '.claude', 'skills', 'ferret-projects', 'projects.md'))
    expect(await readFile(join(skillDir, 'feedback.md'), 'utf8')).toContain('バーが多い')
    expect(await syncFeedbackSkill('1.0.0', projects, home, {})).toBe(0)
    await writeFile(join(a, '.ferret', 'visual-review', 'more.json'), plan([{ at: '2026-11-14T00:00:00Z', action: 'feedback', text: '文字が多い' }]))
    expect(await syncFeedbackSkill('1.0.0', projects, home, {})).toBe(1)
    expect(await readFile(join(skillDir, 'feedback.md'), 'utf8')).toContain('文字が多い')
    expect(await syncFeedbackSkill('1.0.1', projects, home, {})).toBe(1)
  })

  it('印の無い同名の skill・一覧、リンクのフォルダには書かない', async () => {
    const home = join(dir, 'home')
    const skillDir = join(home, '.claude', 'skills', FEEDBACK_SKILL_NAME)
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, 'SKILL.md'), 'mine')
    expect(await syncFeedbackSkill('1.0.0', [], home, {})).toBe(0)
    expect(await readFile(join(skillDir, 'SKILL.md'), 'utf8')).toBe('mine')

    const home2 = join(dir, 'home2')
    const skillDir2 = join(home2, '.claude', 'skills', FEEDBACK_SKILL_NAME)
    await mkdir(skillDir2, { recursive: true })
    await writeFile(join(skillDir2, 'feedback.md'), 'mine')
    expect(await syncFeedbackSkill('1.0.0', [], home2, {})).toBe(0)

    const home3 = join(dir, 'home3')
    const target = join(dir, 'elsewhere')
    await mkdir(join(home3, '.claude', 'skills'), { recursive: true })
    await mkdir(target)
    await symlink(target, join(home3, '.claude', 'skills', FEEDBACK_SKILL_NAME))
    expect(await syncFeedbackSkill('1.0.0', [], home3, {})).toBe(0)
  })
})

describe('価値ユースケース・ビジュアルレビューの skill の決まり（完成の定義・細かく・画面を必ず・ずれはビジュアルレビューへ）', async () => {
  const { renderValueUseCaseSkill } = await import('../../src/shared/valueUseCaseSkill')
  const value = renderValueUseCaseSkill('1.0.0')
  const visual = renderVisualReviewSkill('1.0.0')
  it('価値ユースケースは完成の定義で、細かく・ほぼ全部の手順に画面を入れる', () => {
    for (const word of ['definition of done', 'fine-grained', 'Screenshots on (almost) every step', 'mockup PNG', 'Do not skip or merge steps']) expect(value).toContain(word)
  })
  it('本来と違うところは1つずつ詳しいビジュアルレビューにする', () => {
    expect(value).toContain('Register every gap as a visual review')
    expect(visual).toContain('Plenty of plans is good')
  })
})
