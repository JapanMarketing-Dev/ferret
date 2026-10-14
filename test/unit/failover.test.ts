import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { setLocale } from '../../src/shared/i18n'
import { DEFAULT_LIMIT_FAILOVER, sanitizeLimitFailover, type LimitFailoverPrefs } from '../../src/shared/failover'
import type { ProviderRateLimits } from '../../src/shared/usage'
import { limitOnScreen, limitedUntil, maxUsedPercent, mentionsLimit } from '../../src/main/failover/detect'
import { MAX_SWITCHES_PER_HOUR, MIN_SWITCH_INTERVAL_MS, limitKey, planFailover, planReturn, switchAllowed, tabsToSwitch, type PlanInput } from '../../src/main/failover/plan'
import { LastInputTracker, changedFilesFrom, ferretNote, findFeedbackPath, handoffFilePath, nextAgentPrompt, updateRequest } from '../../src/main/failover/handoff'
import { renderAgentPrompt } from '../../src/shared/agentPrompt'

/**
 * 上限での自動切り替え（src/main/failover）の副作用のない部分と、会話の記録の写し方。
 * 本物の CLI・アカウントは使わない。
 */

describe('上限の知らせの判定', () => {
  it('Claude Code の実際の文言を拾う', () => {
    for (const line of [
      '5-hour limit reached ∙ resets 3pm',
      "You've hit your session limit · resets 3:45pm",
      "  ⎿  You've hit your weekly limit · resets Mon 12:00am",
      'Claude usage limit reached. Your limit will reset at 3pm (Asia/Tokyo)',
      'Usage limit reached · continuing automatically at 3:45pm · esc to cancel',
      'Claude AI usage limit reached|1760000000',
      'Opus weekly limit reached ∙ resets Oct 6, 3pm'
    ]) {
      expect(limitOnScreen('claude', `some output\n${line}\n❯ `), line).toBe(true)
      expect(mentionsLimit(line), line).toBe(true)
    }
  })

  it('Codex・Gemini CLI の文言を拾う', () => {
    expect(limitOnScreen('codex', "■ You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 3 hours 2 minutes.")).toBe(true)
    expect(limitOnScreen('codex', "You've hit your usage limit. To get more access now, send a request to your admin or try again at 3:05 PM.")).toBe(true)
    expect(limitOnScreen('gemini', '✕ [API Error: Quota exceeded for quota metric \'Gemini 2.5 Pro Requests\']')).toBe(false)
    expect(limitOnScreen('gemini', 'Quota exceeded for quota metric Gemini Requests per day')).toBe(true)
    expect(limitOnScreen('gemini', 'Error: RESOURCE_EXHAUSTED (429)')).toBe(true)
  })

  it('本文の引用・差分・長い段落・他の Agent の文言では切り替えない', () => {
    expect(limitOnScreen('claude', '+  "5-hour limit reached ∙ resets 3pm",')).toBe(false)
    expect(limitOnScreen('claude', '12 + const message = "usage limit reached"')).toBe(false)
    expect(limitOnScreen('claude', `I added detection for the case where ${'x'.repeat(200)} usage limit reached appears`)).toBe(false)
    expect(limitOnScreen('claude', 'The function returns when the rate limit reached zero')).toBe(false)
    expect(limitOnScreen('codex', 'Opus weekly limit reached ∙ resets Oct 6')).toBe(false)
    expect(mentionsLimit('ordinary output without anything')).toBe(false)
  })

  it('画面の末尾から流れていった古い知らせでは切り替えない', () => {
    const old = ['5-hour limit reached ∙ resets 3pm', ...Array.from({ length: 30 }, (_, i) => `line ${i}`)].join('\n')
    expect(limitOnScreen('claude', old)).toBe(false)
  })

  it('使用量のいちばん高い枠と、戻る時刻', () => {
    const limits: ProviderRateLimits = {
      provider: 'claude', updatedAt: 0, error: null, status: 'ok',
      session: { usedPercent: 55, windowMinutes: 300, resetsAt: 1000 },
      weekly: { usedPercent: 97, windowMinutes: 10080, resetsAt: 5000 },
      fableWeekly: { usedPercent: 96, windowMinutes: 10080, resetsAt: 7000 }
    }
    expect(maxUsedPercent(limits)).toBe(97)
    expect(limitedUntil(limits, 95)).toBe(7000)
    expect(limitedUntil(limits, 98)).toBeNull()
    expect(maxUsedPercent(null)).toBeNull()
    expect(maxUsedPercent({ ...limits, session: null, weekly: null, fableWeekly: null })).toBeNull()
    expect(maxUsedPercent({ ...limits, unlimited: true })).toBe(0)
  })
})

function input(overrides: Omit<Partial<PlanInput>, 'prefs'> & { prefs?: Partial<LimitFailoverPrefs> } = {}): PlanInput {
  return {
    from: { agent: 'claude', accountId: null },
    accounts: {
      claude: [
        { accountId: null, signedIn: true, usedPercent: 100, active: true },
        { accountId: 'a', signedIn: true, usedPercent: 40, active: false },
        { accountId: 'b', signedIn: true, usedPercent: 10, active: false }
      ],
      codex: [{ accountId: null, signedIn: true, usedPercent: 5, active: true }]
    },
    available: new Set(['claude', 'codex', 'antigravity']),
    limited: new Map(),
    now: 1_000_000,
    ...overrides,
    prefs: { ...DEFAULT_LIMIT_FAILOVER, ...overrides.prefs }
  }
}

describe('切り替え先の選び方', () => {
  it('同じ Agent の別のアカウントを、使用量の低い順に選ぶ', () => {
    expect(planFailover(input())).toEqual({ agent: 'claude', accountId: 'b' })
  })

  it('しきい値以上・上限とみなしたアカウント・ログインしていないアカウントは選ばない', () => {
    const accounts = {
      claude: [
        { accountId: null, signedIn: true, usedPercent: 100, active: true },
        { accountId: 'a', signedIn: true, usedPercent: 96, active: false },
        { accountId: 'b', signedIn: true, usedPercent: 10, active: false },
        { accountId: 'c', signedIn: false, usedPercent: 0, active: false }
      ],
      codex: [{ accountId: null, signedIn: true, usedPercent: 5, active: true }]
    }
    const limited = new Map([[limitKey({ agent: 'claude', accountId: 'b' }), 2_000_000]])
    expect(planFailover(input({ accounts, limited }))).toEqual({ agent: 'codex', accountId: null })
    // 上限の期間が過ぎていれば選ぶ
    expect(planFailover(input({ accounts, limited: new Map([[limitKey({ agent: 'claude', accountId: 'b' }), 500]]) }))).toEqual({ agent: 'claude', accountId: 'b' })
  })

  it('使用量が分からないアカウントは、分かっているものの後に選ぶ', () => {
    const accounts = {
      claude: [
        { accountId: null, signedIn: true, usedPercent: 99, active: true },
        { accountId: 'x', signedIn: true, usedPercent: null, active: false },
        { accountId: 'y', signedIn: true, usedPercent: 70, active: false }
      ],
      codex: []
    }
    expect(planFailover(input({ accounts }))).toEqual({ agent: 'claude', accountId: 'y' })
  })

  it('アカウントの切り替えを切にすると、優先順位の次の Agent へ渡す', () => {
    expect(planFailover(input({ prefs: { switchAccounts: false } }))).toEqual({ agent: 'codex', accountId: null })
  })

  it('優先順位の順に、インストール済みで上限でない Agent を選ぶ。一覧に無い Agent は使わない', () => {
    const accounts = { claude: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }], codex: [{ accountId: null, signedIn: true, usedPercent: 99, active: true }] }
    expect(planFailover(input({ accounts }))).toEqual({ agent: 'antigravity' })
    expect(planFailover(input({ accounts, available: new Set(['claude', 'codex']) }))).toBeNull()
    expect(planFailover(input({ accounts, prefs: { agentOrder: ['claude', 'codex'] } }))).toBeNull()
    expect(planFailover(input({ accounts, limited: new Map([['antigravity', 2_000_000]]) }))).toBeNull()
    expect(planFailover(input({ accounts, prefs: { agentOrder: ['antigravity', 'claude', 'codex'] } }))).toEqual({ agent: 'antigravity' })
  })

  it('Codex が上限なら、先頭の Claude Code の枠が戻っていればそちらへ（今の Agent は飛ばす）', () => {
    const accounts = { claude: [{ accountId: null, signedIn: true, usedPercent: 20, active: true }], codex: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }] }
    expect(planFailover(input({ accounts, from: { agent: 'codex', accountId: null } }))).toEqual({ agent: 'claude', accountId: null })
  })

  it('アカウントの切り替えが切なら、ほかの Agent でも選択中のアカウントだけを使う', () => {
    const accounts = {
      claude: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }],
      codex: [{ accountId: null, signedIn: true, usedPercent: 100, active: true }, { accountId: 'k', signedIn: true, usedPercent: 0, active: false }]
    }
    expect(planFailover(input({ accounts, prefs: { switchAccounts: false } }))).toEqual({ agent: 'antigravity' })
    expect(planFailover(input({ accounts }))).toEqual({ agent: 'codex', accountId: 'k' })
  })

  it('戻すのは、今の Agent より優先順位の高い Agent が使えるときだけ', () => {
    const base = input()
    const free = { claude: [{ accountId: null, signedIn: true, usedPercent: 10, active: true }], codex: base.accounts.codex }
    expect(planReturn({ ...base, accounts: free, current: 'codex' })).toEqual({ agent: 'claude', accountId: null })
    expect(planReturn({ ...base, accounts: { claude: [{ accountId: null, signedIn: true, usedPercent: 99, active: true }], codex: base.accounts.codex }, current: 'codex' })).toBeNull()
    expect(planReturn({ ...base, accounts: free, current: 'claude' })).toBeNull()
  })
})

describe('切り替えの回数と間隔の上限', () => {
  it('続けて切り替えるときは最短の間隔を空ける', () => {
    expect(switchAllowed([], 0)).toEqual({ ok: true })
    expect(switchAllowed([1000], 1000 + MIN_SWITCH_INTERVAL_MS - 1)).toEqual({ ok: false, retryAt: 1000 + MIN_SWITCH_INTERVAL_MS })
    expect(switchAllowed([1000], 1000 + MIN_SWITCH_INTERVAL_MS)).toEqual({ ok: true })
  })

  it('1時間の回数を超えたら、いちばん古い切り替えから1時間たつまで止める', () => {
    const history = Array.from({ length: MAX_SWITCHES_PER_HOUR }, (_, i) => i * 5 * 60_000)
    const now = history[history.length - 1]! + 10 * 60_000
    expect(switchAllowed(history, now)).toEqual({ ok: false, retryAt: 60 * 60_000 })
    expect(switchAllowed(history, 60 * 60_000 + 1)).toEqual({ ok: true })
  })
})

describe('フッター・設定でアカウントを選び直したとき', () => {
  it('その Agent のタブのうち、起動したアカウントが違うものだけを開き直す（起動したアカウントが分からないものは既定とみなす）', () => {
    const tabs = [
      { id: 't1', agent: 'claude' as const, launchedAccount: 'a' },
      { id: 't2', agent: 'claude' as const, launchedAccount: 'b' },
      { id: 't3', agent: 'codex' as const, launchedAccount: 'a' },
      { id: 't4', agent: 'claude' as const, launchedAccount: undefined },
      { id: 't5', agent: null, launchedAccount: undefined }
    ]
    expect(tabsToSwitch(tabs, 'claude', 'b').map((t) => t.id)).toEqual(['t1', 't4'])
    expect(tabsToSwitch(tabs, 'claude', null).map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('開き直したタブには、選んだアカウントで続けるよう送る', () => {
    const prompt = nextAgentPrompt({ reason: 'switch', from: 'Claude Code', to: 'Claude Code (work)', path: '/p/.ferret/handoff.md' })
    expect(prompt).toContain('/p/.ferret/handoff.md')
    expect(prompt).toContain('Claude Code (work)')
  })
})

describe('引き継ぎのファイル', () => {
  beforeEach(() => setLocale('en'))
  afterEach(() => setLocale('en'))

  it('プロジェクトの .ferret/handoff.md に置く', () => {
    expect(handoffFilePath('/w/acme-shop')).toBe(join('/w/acme-shop', '.ferret', 'handoff.md'))
  })

  it('切り替える前の Agent には、決まった項目でファイルを更新するよう頼む', () => {
    const text = updateRequest('/w/acme-shop/.ferret/handoff.md')
    expect(text).toContain('update "/w/acme-shop/.ferret/handoff.md"')
    for (const item of ['the goal', 'what is done', 'remaining work as a checklist', 'files you changed', 'next step', 'feedback.md', 'watch out for']) expect(text).toContain(item)
  })

  it('次の Agent には、まずファイルを読んで残りを続けるよう送る（アプリの表示言語で）', () => {
    expect(nextAgentPrompt({ reason: 'limit', from: 'Codex', to: 'Claude Code', path: '/w/a/.ferret/handoff.md' }))
      .toBe('Codex reached its usage limit, so Claude Code is taking over this work. First read "/w/a/.ferret/handoff.md", then continue with the remaining work listed there. Keep that file up to date at each milestone.')
    setLocale('ja')
    expect(nextAgentPrompt({ reason: 'return', from: 'Codex', to: 'Claude Code', path: '/w/a/.ferret/handoff.md' }))
      .toBe('Claude Code の利用上限が戻ったため、Codex からこの作業を Claude Code に戻します。まず "/w/a/.ferret/handoff.md" を読み、そこにある残りの作業を続けてください。区切りごとにそのファイルを更新してください。')
  })

  it('Agent が更新できなかったときの Ferret の追記: 直前の依頼・feedback.md の場所・変更ファイル', () => {
    const request = 'Read "/w/acme-shop/.ferret/reviews/20261004-101500/feedback.md" and fix the items.'
    const note = ferretNote({ time: '10/4 10:00', agent: 'Codex', lastRequest: request, changedFiles: changedFilesFrom(' M src/App.tsx\n?? src/new.ts\n'), fileExists: false })
    expect(note).toBe([
      '# Handoff', '',
      '## Added by Ferret (10/4 10:00)', '',
      'Codex did not update this file before the switch (it was at its usage limit or not responding). This is what Ferret knows:', '',
      'Last request:', '', `> ${request}`, '',
      'Feedback being worked on: /w/acme-shop/.ferret/reviews/20261004-101500/feedback.md', '',
      'Changed files (git status):', '', '```', ' M src/App.tsx', '?? src/new.ts', '```', ''
    ].join('\n'))
    // 既にあるファイルには見出し無しで足す。git でなければ変更ファイルの節を書かない
    const appended = ferretNote({ time: 't', agent: 'Claude Code', lastRequest: null, changedFiles: null, fileExists: true })
    expect(appended.startsWith('\n## Added by Ferret (t)')).toBe(true)
    expect(appended).not.toContain('Last request')
    expect(appended).not.toContain('git status')
    expect(ferretNote({ time: 't', agent: 'x', lastRequest: null, changedFiles: [], fileExists: true })).toContain('No uncommitted changes (git status).')
  })

  it('feedback.md の場所を指示から取り出す', () => {
    expect(findFeedbackPath('Read .ferret/reviews/x/feedback.md')).toBe('.ferret/reviews/x/feedback.md')
    expect(findFeedbackPath('nothing here')).toBeNull()
  })

  it('Ferret が送る指示文に「区切りごと・上限が近づいたら更新する」を入れる（利用者の文でも足す）', () => {
    const target = { relativeDir: '.ferret/reviews/1', feedbackMd: '/w/a/.ferret/reviews/1/feedback.md', handoff: '/w/a/.ferret/handoff.md' }
    expect(renderAgentPrompt(target, null, 'en')).toContain('Keep "/w/a/.ferret/handoff.md" up to date at each milestone and when you get close to a usage limit')
    expect(renderAgentPrompt(target, 'Fix {{path}}', 'ja')).toBe('Fix /w/a/.ferret/reviews/1/feedback.md 区切りごとと利用上限が近づいたときに "/w/a/.ferret/handoff.md" を更新してください。目的、終わったこと、残りの作業（チェックリスト）、変えたファイル、次にやる一手、関係する feedback.md やレビューのパス、注意点を書きます。別の Agent がこのファイルから続けることがあります。')
    expect(renderAgentPrompt({ ...target, handoff: undefined }, 'Fix {{path}}')).toBe('Fix /w/a/.ferret/reviews/1/feedback.md')
  })
})

describe('直前の入力', () => {
  it('Enter で送った1件を覚える。消した文字・矢印・短い返事・スラッシュコマンドは除く', () => {
    const tracker = new LastInputTracker()
    tracker.push('fix the heade')
    tracker.push('\x7fer\x1b[A')
    tracker.push('\r')
    expect(tracker.lastRequest()).toBe('fix the header')
    tracker.push('y\r')
    tracker.push('/usage\r')
    expect(tracker.lastRequest()).toBe('fix the header')
  })

  it('貼り付けはまとめて1件。Ferret が送った指示で上書きする', () => {
    const tracker = new LastInputTracker()
    tracker.push('\x1b[200~line one\rline two\x1b[201~\r')
    expect(tracker.lastRequest()).toBe('line one\nline two')
    tracker.record('Read /p/feedback.md')
    expect(tracker.lastRequest()).toBe('Read /p/feedback.md')
  })
})


describe('設定', () => {
  it('既定は入・95%・アカウントを先に・Claude Code → Codex → Antigravity・戻さない', () => {
    expect(sanitizeLimitFailover(undefined)).toEqual(DEFAULT_LIMIT_FAILOVER)
    expect(DEFAULT_LIMIT_FAILOVER).toEqual({ enabled: true, thresholdPercent: 95, switchAccounts: true, agentOrder: ['claude', 'codex', 'antigravity'], returnToPreferred: false, handoffPercent: 98 })
  })

  it('壊れた値は直す（しきい値は 50〜100、知らない Agent・重複は除く）', () => {
    expect(sanitizeLimitFailover({ enabled: false, thresholdPercent: 10, agentOrder: ['codex', 'nope', 'codex', 'custom:mine', 3], returnToPreferred: true, switchAccounts: 'x' }))
      .toEqual({ enabled: false, thresholdPercent: 50, switchAccounts: true, agentOrder: ['codex', 'custom:mine'], returnToPreferred: true, handoffPercent: 98 })
    expect(sanitizeLimitFailover({ thresholdPercent: 1000 }).thresholdPercent).toBe(100)
    expect(sanitizeLimitFailover({ agentOrder: [] }).agentOrder).toEqual([])
  })
})
