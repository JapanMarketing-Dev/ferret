/**
 * Agent への依頼文（src/shared/agentRequests.ts）。押すとその文を Agent へ送るだけの雛形
 */
import { describe, expect, it } from 'vitest'
import { BUILTIN_REQUESTS, composeAgentRequest, orchestraMessage, resolveAgentRequests, sanitizeAgentRequestPrefs, toPrefs } from '../../src/shared/agentRequests'

describe('組み込みの依頼文', () => {
  it('dream・コンパクト・セキュリティ・SEO・分析・Sentry・性能・アクセシビリティ・依存関係がそろい、日本語と英語がある', () => {
    expect(BUILTIN_REQUESTS.map((b) => b.id)).toEqual(['human-checklist', 'costs', 'dream', 'learn-human', 'dev-servers', 'chrome-extension', 'compact', 'security', 'seo', 'analytics', 'sentry', 'sentry-setup', 'analytics-setup', 'search-console', 'infra', 'security-deep', 'security-codex', 'test-deep', 'blog', 'youtube', 'ads', 'dm-sales', 'data-analysis', 'performance', 'accessibility', 'dependencies'])
    for (const b of BUILTIN_REQUESTS) for (const lang of ['ja', 'en'] as const) expect(b.text[lang].length).toBeGreaterThan(80)
  })

  it('登録系は、接続を全体で1回にして、プロダクトごとに設定し、値を混ぜない', () => {
    for (const id of ['sentry-setup', 'analytics-setup', 'search-console', 'infra']) {
      const text = BUILTIN_REQUESTS.find((b) => b.id === id)!.text.en
      expect(text).toMatch(/once for everything/)
      expect(text).toMatch(/per product|for each public product/)
    }
  })

  it('徹底検査は全プロダクトを並列に、独立した2つの検査で突き合わせ、インフラも含める', () => {
    const sec = BUILTIN_REQUESTS.find((b) => b.id === 'security-deep')!.text.en
    expect(sec).toMatch(/in parallel/)
    expect(sec).toMatch(/two independent checks/)
    expect(sec).toMatch(/codex exec/)
    expect(sec).toMatch(/Infrastructure/)
    expect(BUILTIN_REQUESTS.find((b) => b.id === 'test-deep')!.text.en).toMatch(/fails once against a broken version/)
  })

  it('外へ出すもの（公開・投稿・送信・予算）は人の承認を human.md で待つ', () => {
    for (const id of ['blog', 'youtube', 'ads', 'dm-sales']) expect(BUILTIN_REQUESTS.find((b) => b.id === id)!.text.en).toMatch(/human\.md/)
    expect(BUILTIN_REQUESTS.find((b) => b.id === 'dm-sales')!.text.en).toMatch(/Do not send anything/)
  })

  it('dream は記事の4つの手順（統合・刈り込み・発見・索引）と、好みと出どころを残す決まりを持つ', () => {
    const dream = BUILTIN_REQUESTS.find((b) => b.id === 'dream')!.text.en
    for (const word of ['Consolidate', 'Prune', 'Discover', 'Index', 'explicit preferences', 'source']) expect(dream).toContain(word)
    // Devin の dreaming：使われない記録を外す・矛盾は人が決める・変更の記録を残す
    for (const word of ['no task has used', 'not captured during the original work', 'a person can decide', 'dated log']) expect(dream).toContain(word)
  })

  it('人から学ぶは、過去の依頼とフィードバックを材料に、繰り返すものだけを決まりにして小さく保つ', () => {
    const text = BUILTIN_REQUESTS.find((b) => b.id === 'learn-human')!.text.en
    for (const word of ['.ferret/reviews', '~/.claude/projects', 'land the first time', 'only for what repeats', 'within 40 lines', 'Do not copy the content']) expect(text).toContain(word)
  })

  it('依頼の雛形（human-checklist）は全体から送るとすべてのプロダクトへの添え書きが付く。ダッシュボードには雛形の欄だけが残る', async () => {
    const { readFile } = await import('node:fs/promises')
    const dashboard = await readFile(new URL('../../src/renderer/components/OrchestraDashboard.tsx', import.meta.url), 'utf8')
    const id = 'human-checklist'
    expect(dashboard).toContain('<AgentRequestsSection />')
    expect(dashboard).not.toMatch(/'orchestra:overview'|formatUsd|ChecklistAnswer/)
    const main = await readFile(new URL('../../src/main/agentRequestSend.ts', import.meta.url), 'utf8')
    expect(main).toContain('composeAgentRequest(picked, lang, !!(project?.orchestrator || project?.editorWorkspace))')
    const text = composeAgentRequest(resolveAgentRequests(undefined, 'en').filter((r) => r.id === id), 'en', true)
    expect(text).toContain('run all products at the same time in parallel')
  })

  it('localhost の一括起動は、subagent に並行で任せ、ポートを重ねず、裏で動かし、確かめて human.md に一覧を書く', () => {
    const text = BUILTIN_REQUESTS.find((b) => b.id === 'dev-servers')!.text.en
    for (const word of ['subagent in parallel', 'Never share ports', 'Reuse a server that is already running', 'background', 'open each URL', 'human.md', 'never production']) expect(text).toContain(word)
  })

  it('人の確認リストの書き出しは、全プロダクトから集めて human.md の表（番号・プロダクト・URL・見てほしいこと）にする', () => {
    const text = BUILTIN_REQUESTS.find((b) => b.id === 'human-checklist')!.text.en
    for (const word of ['human.md', 'top of the All products dashboard', '| No. | Product | URL | What to check |', 'B1', 'A1', 'P1', 'D1', 'in parallel', 'Never write secret values']) expect(text).toContain(word)
  })

  it('コストの記録はインフラだけ（AI は入れない）。実績を毎月と請求ごとの形で、今のリソースからの推定を estimates に書く', () => {
    for (const lang of ['ja', 'en'] as const) {
      const text = BUILTIN_REQUESTS.find((b) => b.id === 'costs')!.text[lang]
      for (const word of ['.ferret/costs.json', 'monthlyUsd', 'since', 'until', '"usd"', '"provider"', '"estimates"', '"checkedAt"', '"basis"', 'estimate']) expect(text).toContain(word)
    }
    const en = BUILTIN_REQUESTS.find((b) => b.id === 'costs')!.text.en
    expect(en).toContain('infra, service, other')
    expect(en).toContain('Leave out AI')
    expect(en).toContain('Never write keys')
  })

  it('定期実行は持たない。1回きりの登録の依頼には印があり、隠せる', () => {
    expect(BUILTIN_REQUESTS.some((b) => b.id === 'schedule')).toBe(false)
    expect(BUILTIN_REQUESTS.filter((b) => b.once).map((b) => b.id)).toEqual(['sentry-setup', 'analytics-setup', 'search-console', 'infra'])
  })
})

describe('保存と一覧', () => {
  it('変えた文面・まとめる印・隠した印だけを保存し、既定のままのものは持たない。足した依頼文は名前と文が要る', () => {
    const list = resolveAgentRequests(undefined, 'ja').map((r) => (r.id === 'security' ? { ...r, batch: true } : r.id === 'sentry-setup' ? { ...r, hidden: true } : r))
    const withCustom = [...list, { id: 'custom-1', title: 'Lint', text: 'Run the linter', batch: false, custom: true, edited: false, hidden: false, once: false }]
    const prefs = toPrefs(withCustom, 'ja')
    expect(prefs.items).toEqual([{ id: 'security', batch: true }, { id: 'sentry-setup', hidden: true }, { id: 'custom-1', title: 'Lint', custom: true, text: 'Run the linter' }])
    const back = resolveAgentRequests(sanitizeAgentRequestPrefs(prefs), 'ja')
    expect(back.find((r) => r.id === 'security')).toMatchObject({ batch: true, edited: false, hidden: false })
    expect(back.find((r) => r.id === 'sentry-setup')).toMatchObject({ hidden: true, once: true })
    expect(back.at(-1)).toMatchObject({ id: 'custom-1', title: 'Lint', custom: true })
  })

  it('壊れた値・知らない組み込み・名前の無い依頼文は捨て、古い定期の値（schedule・lastRunAt）は読み捨てる', () => {
    expect(sanitizeAgentRequestPrefs({ items: [{ id: 'dream', schedule: 'daily', batch: true }], lastRunAt: { dream: '2026-10-01T00:00:00Z' } })).toEqual({ items: [{ id: 'dream', batch: true }] })
    expect(sanitizeAgentRequestPrefs({ items: [{ id: 'nope' }, { id: 'x', custom: true, text: 'a' }, { id: 'bad id!' }, { id: 'seo', schedule: 'hourly' }] })).toEqual({ items: [{ id: 'seo' }] })
    expect(sanitizeAgentRequestPrefs('x')).toBeUndefined()
  })
})

describe('送る文', () => {
  const [a, b] = resolveAgentRequests(undefined, 'ja')
  it('1件はその文と共通の決まり。複数は番号付きでまとめ、並行して進めるよう添える', () => {
    const one = composeAgentRequest([a!], 'ja', false)
    expect(one.startsWith(a!.text)).toBe(true)
    expect(one).toContain('人に質問せず')
    const two = composeAgentRequest([a!, b!], 'ja', false)
    expect(two).toContain(`## 1. ${a!.title}`)
    expect(two).toContain(`## 2. ${b!.title}`)
    expect(two).toContain('並行して')
  })

  it('オーケストレーターからは、プロダクトごとの subagent で全部を同時に、プロダクトの中でも並行、インフラは分ける', () => {
    const text = composeAgentRequest([a!], 'en', true)
    expect(text).toMatch(/one subagent per included product and run all products at the same time in parallel/)
    expect(text).toMatch(/Inside each product too/)
    expect(text).toMatch(/keep infrastructure and other per-product things separate/)
  })

  it('全体の指示の欄：ダッシュボードからは並行の決まりを添え、帯でプロダクトを開いていればそのプロダクトへの指示にする', () => {
    expect(orchestraMessage(' Fix the header ', 'en')).toMatch(/^This request comes from the orchestrator[\s\S]*\n\nFix the header$/)
    const one = orchestraMessage('Too slow', 'ja', { name: 'Shop', url: 'http://localhost:3000/' })
    expect(one).toContain('[Shop (http://localhost:3000/)]')
    expect(one).toContain('並行')
    expect(one.endsWith('Too slow')).toBe(true)
  })
})
