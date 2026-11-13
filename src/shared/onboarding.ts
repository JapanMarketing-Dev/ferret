/**
 * 初回起動のセットアップ（オンボーディング）の状態。main・renderer・単体テストで共有する純粋な関数。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/onboarding/should-show-onboarding.ts と
 *           ~/bench/orca/src/main/persistence/applying-settings/onboarding-normalization.ts の考え方（MIT）。
 * Orca は closedAt / outcome / lastCompletedStep を持つ。本システムでは「最後まで進んだ（completedAt）」
 * 「途中で閉じた（dismissedAt）」「最後に見ていた手順（lastStep）」の3つだけにした。
 */

/** 手順の並び。順番を変えるときは途中から再開する利用者がいることに気をつける（知らない id は先頭へ戻る） */
export const ONBOARDING_STEPS = ['appearance', 'agents', 'decision', 'project', 'voice', 'permissions', 'finish'] as const
export type OnboardingStepId = (typeof ONBOARDING_STEPS)[number]

export interface OnboardingState {
  /** 最後の手順で「始める」を押した日時（ISO） */
  completedAt?: string
  /** 「セットアップを閉じる」で途中で閉じた日時（ISO） */
  dismissedAt?: string
  /** 最後に見ていた手順。次に開いたときにここから再開する */
  lastStep?: OnboardingStepId
}

/** settings:onboarding で送る変更。null はその項目を消す（「もう一度セットアップ」で開き直すとき） */
export type OnboardingPatch = { [K in keyof OnboardingState]?: OnboardingState[K] | null }

export function isOnboardingStepId(value: unknown): value is OnboardingStepId {
  return typeof value === 'string' && (ONBOARDING_STEPS as readonly string[]).includes(value)
}

const stamp = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64

/** 読み込んだ値を型どおりに直す。中身が空なら undefined（settings.json に書かない） */
export function sanitizeOnboarding(raw: unknown): OnboardingState | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: OnboardingState = {
    ...(stamp(r.completedAt) ? { completedAt: r.completedAt } : {}),
    ...(stamp(r.dismissedAt) ? { dismissedAt: r.dismissedAt } : {}),
    ...(isOnboardingStepId(r.lastStep) ? { lastStep: r.lastStep } : {})
  }
  return Object.keys(out).length ? out : undefined
}

export function applyOnboardingPatch(prev: OnboardingState | undefined, patch: OnboardingPatch): OnboardingState | undefined {
  const next: Record<string, unknown> = { ...prev }
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (key !== 'completedAt' && key !== 'dismissedAt' && key !== 'lastStep') continue
    if (value === null) delete next[key]
    else if (value !== undefined) next[key] = value
  }
  return sanitizeOnboarding(next)
}

/** 閉じていなければ出す（Orca の shouldShowOnboarding と同じ考え方） */
export function shouldShowOnboarding(state: OnboardingState | undefined): boolean {
  return !state?.completedAt && !state?.dismissedAt
}

/**
 * 設定ファイルを読んだときに1度だけ通す引き継ぎ。
 * オンボーディングを足す前から使っている人（プロジェクトを登録済み）には出さず、済んだ扱いにする。
 * skip は出したくないとき。onboarding が既にあれば何もしない（途中の人はそのまま再開する）。
 */
export function migrateOnboarding<T extends { onboarding?: OnboardingState; projects: readonly unknown[] }>(
  settings: T,
  options: { skip?: boolean; now?: () => string } = {}
): T {
  if (settings.onboarding) return settings
  if (!options.skip && settings.projects.length === 0) return settings
  const now = options.now ?? (() => new Date().toISOString())
  return { ...settings, onboarding: { completedAt: now() } }
}

/** OS の許可の状態（Electron の systemPreferences.getMediaAccessStatus と同じ値）。macOS 以外は常に granted */
export type MediaAccessStatus = 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown'
export interface PermissionsState {
  microphone: MediaAccessStatus
  screen: MediaAccessStatus
}
export type PermissionKind = keyof PermissionsState
