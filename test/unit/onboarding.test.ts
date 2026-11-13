import { describe, expect, it, vi } from 'vitest'
import {
  ONBOARDING_STEPS,
  applyOnboardingPatch,
  migrateOnboarding,
  sanitizeOnboarding,
  shouldShowOnboarding,
  type OnboardingState
} from '@shared/onboarding'
import {
  LAST_STEP_INDEX,
  clampStepIndex,
  completePatch,
  dismissPatch,
  initialStepIndex,
  isContinueShortcut,
  isSkippableStep,
  nextStepIndex,
  previousStepIndex,
  reopenPatch,
  stepIdAt,
  stepPatch
} from '../../src/renderer/onboarding/onboardingFlowState'

// settings.ts は electron の app を読み込むので、保存先だけを差し替える
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-test' } }))
const { sanitize } = await import('../../src/main/settings')

const NOW = '2026-10-03T00:00:00.000Z'

describe('shouldShowOnboarding', () => {
  it('未設定・途中（lastStep だけ）なら出す', () => {
    expect(shouldShowOnboarding(undefined)).toBe(true)
    expect(shouldShowOnboarding({})).toBe(true)
    expect(shouldShowOnboarding({ lastStep: 'voice' })).toBe(true)
  })

  it('完了・途中で閉じたなら出さない', () => {
    expect(shouldShowOnboarding({ completedAt: NOW })).toBe(false)
    expect(shouldShowOnboarding({ dismissedAt: NOW, lastStep: 'agents' })).toBe(false)
  })
})

describe('sanitizeOnboarding', () => {
  it('知っている項目だけを残す', () => {
    expect(sanitizeOnboarding({ completedAt: NOW, lastStep: 'project', extra: 1 })).toEqual({ completedAt: NOW, lastStep: 'project' })
  })

  it('壊れた値は捨て、空なら undefined（settings.json に書かない）', () => {
    expect(sanitizeOnboarding({ completedAt: 1, dismissedAt: '', lastStep: 'nope' })).toBeUndefined()
    expect(sanitizeOnboarding(null)).toBeUndefined()
    expect(sanitizeOnboarding('x')).toBeUndefined()
    expect(sanitizeOnboarding({ completedAt: 'x'.repeat(65) })).toBeUndefined()
  })
})

describe('applyOnboardingPatch', () => {
  it('null は消し、undefined は前の値のまま', () => {
    expect(applyOnboardingPatch({ completedAt: NOW, lastStep: 'voice' }, { completedAt: null, lastStep: undefined })).toEqual({ lastStep: 'voice' })
  })

  it('開き直す（reopenPatch）と全部消えて、また出る', () => {
    const next = applyOnboardingPatch({ completedAt: NOW, dismissedAt: NOW, lastStep: 'finish' }, reopenPatch())
    expect(next).toBeUndefined()
    expect(shouldShowOnboarding(next)).toBe(true)
  })

  it('知らない項目・壊れた手順は書かない', () => {
    expect(applyOnboardingPatch(undefined, { lastStep: 'bogus' as never, ...({ other: 'x' } as object) })).toBeUndefined()
  })
})

describe('migrateOnboarding（オンボーディングを足す前からの利用者）', () => {
  const now = () => NOW
  const settings = (projects: unknown[]): { projects: unknown[]; onboarding?: OnboardingState } => ({ projects })

  it('プロジェクトを登録済みなら済んだ扱いにする', () => {
    expect(migrateOnboarding(settings([{ id: 'p' }]), { now }).onboarding).toEqual({ completedAt: NOW })
  })

  it('プロジェクトが無ければ出す（初回起動）', () => {
    expect(migrateOnboarding(settings([]), { now }).onboarding).toBeUndefined()
  })

  it('途中の人（onboarding がある）はそのまま再開する', () => {
    const midway = { projects: [{ id: 'p' }], onboarding: { lastStep: 'voice' as const } }
    expect(migrateOnboarding(midway, { now })).toBe(midway)
  })

  it('skip（E2E）なら初回でも出さない', () => {
    expect(migrateOnboarding(settings([]), { skip: true, now }).onboarding).toEqual({ completedAt: NOW })
  })
})

describe('sanitize（settings.json）の onboarding', () => {
  it('正しい値は残り、壊れた値は落ちる', () => {
    expect(sanitize({ onboarding: { dismissedAt: NOW, lastStep: 'agents' } }).onboarding).toEqual({ dismissedAt: NOW, lastStep: 'agents' })
    expect('onboarding' in sanitize({ onboarding: { lastStep: 3 } })).toBe(false)
    expect('onboarding' in sanitize({})).toBe(false)
  })

  it('updateSettings と同じく、undefined を重ねると消える', () => {
    const before = sanitize({ onboarding: { completedAt: NOW } })
    expect('onboarding' in sanitize({ ...before, onboarding: undefined })).toBe(false)
  })
})

describe('手順の進め方', () => {
  it('手順は7つで、最後は finish', () => {
    expect(ONBOARDING_STEPS).toEqual(['appearance', 'agents', 'decision', 'project', 'voice', 'permissions', 'finish'])
    expect(stepIdAt(LAST_STEP_INDEX)).toBe('finish')
  })

  it('次へ・戻るは範囲に収まり、最後の次は null（完了）', () => {
    expect(nextStepIndex(0)).toBe(1)
    expect(nextStepIndex(LAST_STEP_INDEX - 1)).toBe(LAST_STEP_INDEX)
    expect(nextStepIndex(LAST_STEP_INDEX)).toBeNull()
    expect(previousStepIndex(0)).toBe(0)
    expect(previousStepIndex(3)).toBe(2)
    expect(clampStepIndex(99)).toBe(LAST_STEP_INDEX)
    expect(clampStepIndex(-4)).toBe(0)
    expect(clampStepIndex(Number.NaN)).toBe(0)
  })

  it('飛ばせるのはプロジェクトと文字起こしだけ', () => {
    expect(ONBOARDING_STEPS.filter((_, i) => isSkippableStep(i))).toEqual(['decision', 'project', 'voice'])
  })

  it('再開: 最後に見ていた手順から始め、無い・知らない手順なら先頭', () => {
    expect(initialStepIndex(undefined)).toBe(0)
    expect(initialStepIndex(null)).toBe(0)
    expect(initialStepIndex({ lastStep: 'voice' })).toBe(4)
    expect(initialStepIndex({ lastStep: 'gone' as never })).toBe(0)
  })

  it('移るたびの保存値で再開位置が決まる（途中終了 → 再起動）', () => {
    const saved = applyOnboardingPatch(undefined, stepPatch(5))
    expect(saved).toEqual({ lastStep: 'permissions' })
    expect(shouldShowOnboarding(saved)).toBe(true)
    expect(initialStepIndex(saved)).toBe(5)
  })

  it('完了は completedAt を書いて再開位置を消す', () => {
    const done = applyOnboardingPatch({ lastStep: 'finish', dismissedAt: NOW }, completePatch(NOW))
    expect(done).toEqual({ completedAt: NOW })
    expect(shouldShowOnboarding(done)).toBe(false)
  })

  it('閉じる（スキップ）は dismissedAt を書き、開き直すと先頭から', () => {
    const skipped = applyOnboardingPatch({ lastStep: 'voice' }, dismissPatch(NOW))
    expect(skipped).toEqual({ dismissedAt: NOW })
    expect(shouldShowOnboarding(skipped)).toBe(false)
    const reopened = applyOnboardingPatch(skipped, reopenPatch())
    expect(shouldShowOnboarding(reopened)).toBe(true)
    expect(initialStepIndex(reopened)).toBe(0)
  })
})

describe('isContinueShortcut', () => {
  const key = (p: Partial<{ key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }>) =>
    ({ key: 'Enter', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...p })

  it('macOS は ⌘↩、ほかは Ctrl+Enter', () => {
    expect(isContinueShortcut(key({ metaKey: true }), true)).toBe(true)
    expect(isContinueShortcut(key({ ctrlKey: true }), true)).toBe(false)
    expect(isContinueShortcut(key({ ctrlKey: true }), false)).toBe(true)
    expect(isContinueShortcut(key({ metaKey: true }), false)).toBe(false)
  })

  it('Enter だけ・Shift / Alt 付き・ほかのキーは進まない', () => {
    expect(isContinueShortcut(key({}), true)).toBe(false)
    expect(isContinueShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false)
    expect(isContinueShortcut(key({ ctrlKey: true, altKey: true }), false)).toBe(false)
    expect(isContinueShortcut(key({ key: 'a', metaKey: true }), true)).toBe(false)
  })
})

describe('製品の考え方の文言（最初の画面・最後の手順・指摘が無い画面・判定モデル）', async () => {
  const { LOCALES } = await import('@shared/i18n')
  const { FINISH_STEP_KEYS, ONBOARDING_CONCEPT_KEYS } = await import('../../src/renderer/onboarding/onboardingFlowState')

  it('最初の画面は3段（印と声 → 会議 → 判定モデル）で、手順は7つ（判定モデルは Agent の次）', () => {
    expect(ONBOARDING_CONCEPT_KEYS).toEqual(['onboarding.concept.feedback', 'onboarding.concept.meetings', 'onboarding.concept.decision'])
    expect(ONBOARDING_STEPS).toHaveLength(7)
    expect(ONBOARDING_STEPS.indexOf('decision')).toBe(ONBOARDING_STEPS.indexOf('agents') + 1)
  })

  it('最後の手順の流れに、会議での使い方と判定モデルが入っている', () => {
    expect(FINISH_STEP_KEYS).toContain('onboarding.finish.meetings')
    expect(FINISH_STEP_KEYS[FINISH_STEP_KEYS.length - 1]).toBe('onboarding.finish.decision')
  })

  it.each(Object.keys(LOCALES))('%s: 考え方の文言がすべてある', (locale) => {
    const dict = LOCALES[locale as keyof typeof LOCALES] as Record<string, string>
    for (const key of [...ONBOARDING_CONCEPT_KEYS, ...FINISH_STEP_KEYS, 'decision.settings.concept', 'review.emptyDescription', 'onboarding.tagline']) {
      expect(dict[key], key).toBeTruthy()
    }
  })

  it('指摘が無い画面は、廃止した文字入力に触れない（声とペン・四角の枠）', () => {
    const en = LOCALES.en!
    expect(en['review.emptyDescription']).not.toMatch(/write/i)
    expect(en['review.emptyDescription']).toMatch(/box/)
  })
})

describe('Agent の手順：どれか1つを選ぶ', async () => {
  const { agentsStepGate, recommendedAgent } = await import('../../src/renderer/onboarding/onboardingFlowState')
  const opt = (id: string, installed: boolean, custom = false) => ({ id, installed, custom })

  it('おすすめは、インストール済みのうち Claude Code → Codex → … の順で最初のもの', () => {
    expect(recommendedAgent([opt('codex', true), opt('claude', true)], [])).toBe('claude')
    expect(recommendedAgent([opt('claude', false), opt('codex', true)], [])).toBe('codex')
    expect(recommendedAgent([opt('claude', false), opt('gemini', true)], [])).toBe('gemini')
  })

  it('もう選んでいる・何も入っていない・探している途中なら、勝手に選ばない', () => {
    expect(recommendedAgent([opt('claude', true)], ['codex'])).toBeNull()
    expect(recommendedAgent([opt('claude', false), opt('codex', false)], [])).toBeNull()
    expect(recommendedAgent(null, [])).toBeNull()
    // 自作の Agent はおすすめにしない
    expect(recommendedAgent([opt('custom:x', true, true)], [])).toBeNull()
  })

  it('1つ以上選んでいれば進める', () => {
    expect(agentsStepGate([opt('claude', true)], ['claude'])).toBe('ok')
    expect(agentsStepGate(null, ['claude'])).toBe('ok')
  })

  it('インストール済みがあるのに0件なら止める', () => {
    expect(agentsStepGate([opt('claude', true), opt('codex', false)], [])).toBe('needSelection')
  })

  it('インストール済みが1つも無ければ、0件でも進める（行き止まりにしない）', () => {
    expect(agentsStepGate([opt('claude', false), opt('codex', false)], [])).toBe('noneInstalled')
    expect(agentsStepGate([opt('custom:x', true, true)], [])).toBe('noneInstalled')
    expect(agentsStepGate([], [])).toBe('noneInstalled')
  })

  it('探している途中は待たせない', () => {
    expect(agentsStepGate(null, [])).toBe('detecting')
  })
})

describe('判定モデルの手順', async () => {
  const { RECOMMENDED_DECISION_PRESET, decisionReady } = await import('../../src/renderer/onboarding/onboardingFlowState')
  const { applyDecisionPreset, DEFAULT_DECISION_PREFERENCES } = await import('@shared/decision')
  const cloudflare = applyDecisionPreset(DEFAULT_DECISION_PREFERENCES, 'cloudflare')

  it('おすすめは端末内の Ollama（モデルは PC に合わせて渡したもの）で、判定モデルの手順は飛ばせる', () => {
    expect(RECOMMENDED_DECISION_PRESET).toBe('ollama')
    expect(applyDecisionPreset(DEFAULT_DECISION_PREFERENCES, RECOMMENDED_DECISION_PRESET, 'clef').model).toBe('clef')
    expect(applyDecisionPreset(DEFAULT_DECISION_PREFERENCES, RECOMMENDED_DECISION_PRESET).model).toBe('clef-flash')
    // ほかの提供元には PC のモデルを持ち込まない
    expect(applyDecisionPreset(DEFAULT_DECISION_PREFERENCES, 'cloudflare', 'clef').model).toBe('clef-flash')
    expect(cloudflare.model).toBe('clef-flash')
    expect(isSkippableStep(ONBOARDING_STEPS.indexOf('decision'))).toBe(true)
  })

  it('Cloudflare は Account ID とキーが揃ったときだけ有効にしてよい', () => {
    expect(decisionReady(cloudflare, false)).toBe(false)
    expect(decisionReady({ ...cloudflare, accountId: 'abc123' }, false)).toBe(false)
    expect(decisionReady(cloudflare, true)).toBe(false)
    expect(decisionReady({ ...cloudflare, accountId: 'abc123' }, true)).toBe(true)
  })

  it('キーの要らない端末内の Ollama は、キーが無くても有効にしてよい', () => {
    expect(decisionReady(applyDecisionPreset(DEFAULT_DECISION_PREFERENCES, 'ollama'), false)).toBe(true)
  })

  it('Custom は URL が無ければ有効にしない', () => {
    expect(decisionReady(applyDecisionPreset(DEFAULT_DECISION_PREFERENCES, 'custom'), true)).toBe(false)
  })
})

describe('許可の手順の説明は OS ごと', async () => {
  const { stepSubtitleKey } = await import('../../src/renderer/onboarding/onboardingFlowState')
  const { en } = await import('@shared/i18n/en')

  it('macOS だけ「macOS では最初に1回だけ」の文、Windows・Linux は別の文', () => {
    expect(stepSubtitleKey('permissions', 'darwin')).toBe('onboarding.permissions.subtitle')
    expect(stepSubtitleKey('permissions', 'win32')).toBe('onboarding.permissions.subtitleOther')
    expect(stepSubtitleKey('permissions', 'linux')).toBe('onboarding.permissions.subtitleOther')
    expect((en as Record<string, string>)['onboarding.permissions.subtitleOther']).not.toMatch(/macOS/)
  })

  it('ほかの手順はどの OS でも同じキー', () => {
    expect(stepSubtitleKey('agents', 'win32')).toBe('onboarding.agents.subtitle')
    expect(stepSubtitleKey('finish', 'linux')).toBe('onboarding.finish.subtitle')
  })
})
