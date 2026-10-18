/**
 * 購買が起きる場面・調査の終了条件・次の行動（docs/business-research/knowledge.md 第2部 5・6・9章）。
 * - 調査の単位は「どんな企業の、誰が、何が起きたときに、どんな成果を必要とし、今はどう対処しているか」の一文（必須）。
 * - 対象顧客／困っている状況／現在の対処／接点／見せる成果物／収益へのつながり が具体化し、
 *   残る問いが「この相手が実際に使うか、払うか」になったら実験へ（調査の終了条件）。
 * - 次の行動は4つ: 調査を続ける / 小さく実験する / 保留・除外する / 投資を増やす候補にする。決めるのは人（Candidate.decision）。
 */
import { CONDITION_PRINCIPLES, hasCriticalCounter } from './conditions'
import { businessStage } from './stage'
import type { Check } from './principles'
import {
  CHANNELS,
  EXIT_KEYS,
  SCENE_KEYS,
  SEGMENT_AXES,
  type Candidate,
  type ExitKey,
  type NextDecision,
  type PrincipleKey,
  type PurchaseScene,
  type ResearchData
} from './model'

function filled(v: unknown): boolean {
  return typeof v === 'string' && v.trim() !== ''
}

/** 調査の終了条件 → いちばん近い原則（Check の i18n キー research.check.<principle>.<exitKey>） */
export const EXIT_PRINCIPLES: Record<ExitKey, PrincipleKey> = {
  targetCustomer: 'who',
  situation: 'who',
  currentHandling: 'what',
  contactPoint: 'where',
  deliverable: 'why',
  revenueLink: 'how'
}

/** 購買が起きる場面の5欄がすべて埋まっているか */
export function sceneComplete(scene: PurchaseScene): boolean {
  return !!scene && typeof scene === 'object' && SCENE_KEYS.every((k) => filled(scene[k]))
}

function part(v: unknown): string {
  return typeof v === 'string' ? v.trim().replace(/[。.、,\s]+$/u, '') : ''
}

/**
 * 購買が起きる場面の一文。空の欄は「（未記入）」/「(not written)」で示す（空欄を黙って詰めない）。
 * ja: 「{company}の{who}が、{event}ときに、{outcome}を必要とし、今は{currentHandling}。」（event の末尾の「とき（に）」「時（に）」は重ねない）
 * en: "When {event}, {who} at {company} needs {outcome}; today: {currentHandling}."
 */
export function sceneSentence(scene: PurchaseScene, locale: 'ja' | 'en'): string {
  const blank = locale === 'en' ? '(not written)' : '（未記入）'
  const get = (k: keyof PurchaseScene) => part(scene && typeof scene === 'object' ? scene[k] : '') || blank
  if (locale === 'en') {
    return `When ${get('event')}, ${get('who')} at ${get('company')} needs ${get('outcome')}; today: ${get('currentHandling')}.`
  }
  const event = part(scene?.event).replace(/(とき|時)に?$/u, '') || blank
  return `${get('company')}の${get('who')}が、${event}ときに、${get('outcome')}を必要とし、今は${get('currentHandling')}。`
}

/**
 * 調査の終了条件の6項目:
 * - targetCustomer:  場面の「どんな企業」と、Who のセグメント5軸のどれか1つ以上
 * - situation:       場面の「何が起きたときに」
 * - currentHandling: 場面の「今はどう対処しているか」
 * - contactPoint:    Where の経路が1つ以上、または対象企業のどれかに到達経路（reachPath）がある
 * - deliverable:     最初に見せる成果物
 * - revenueLink:     無料から有料へのつながりの文、または How の月額（> 0）
 * done はすべて満たしたとき
 */
export function researchExit(candidate: Candidate, _data: ResearchData): { done: boolean; items: Record<ExitKey, boolean> } {
  const c = candidate
  const scene = c?.scene
  const channels = (Array.isArray(c?.where?.channels) ? c.where.channels : []).filter((p) => p && (CHANNELS as readonly string[]).includes(p.channel))
  const companies = Array.isArray(c?.who?.companies) ? c.who.companies : []
  const price = c?.how?.monthlyPrice
  const items: Record<ExitKey, boolean> = {
    targetCustomer: filled(scene?.company) && SEGMENT_AXES.some((a) => filled(c?.who?.segment?.[a])),
    situation: filled(scene?.event),
    currentHandling: filled(scene?.currentHandling),
    contactPoint: channels.length > 0 || companies.some((x) => x && filled(x.reachPath)),
    deliverable: filled(c?.deliverable),
    revenueLink: filled(c?.monetization?.freeToPaidPath) || (typeof price === 'number' && Number.isFinite(price) && price > 0)
  }
  return { done: EXIT_KEYS.every((k) => items[k]), items }
}

/** 調査の終了条件を Check の並びにする（画面・理由用。満たさない項目は null＝まだ） */
export function exitChecks(candidate: Candidate, data: ResearchData): Check[] {
  const { items } = researchExit(candidate, data)
  return EXIT_KEYS.map((k) => ({ id: k, principle: EXIT_PRINCIPLES[k], ok: items[k] ? true : null }))
}

/**
 * 次の行動の機械の目安（上から順に判定。決めるのは人）:
 * 1. holdOrDrop: 重要な成立条件に反証がある（hasCriticalCounter が空でない）。理由は条件ごとの conditionAlarm
 * 2. invest:     事業を進める段階で、再現性と採算の両方が確認できた（実顧客で獲得・取引・利益の再現）
 * 3. experiment: 調査の終了条件をすべて満たした（残る問いが「使うか・払うか」＝反応・支払いは実験でしか確かめられない）。
 *                初回取引が確認できた後も、再現性・採算がそろうまではここ
 * 4. continue:   それ以外（公開情報で確かめられることが残っている）。理由はまだの終了条件
 */
export function nextDecision(candidate: Candidate, data: ResearchData): { suggestion: NextDecision; reasons: Check[] } {
  const alarms = hasCriticalCounter(candidate, data)
  if (alarms.length > 0) {
    return {
      suggestion: 'holdOrDrop',
      reasons: alarms.map((k) => ({ id: 'conditionAlarm', principle: CONDITION_PRINCIPLES[k], ok: false, params: { condition: k } }))
    }
  }
  const stage = businessStage(candidate, data)
  if (stage.checks.repeatability.ok === true && stage.checks.unitEconomics.ok === true) {
    return { suggestion: 'invest', reasons: [stage.checks.repeatability, stage.checks.unitEconomics] }
  }
  const exit = researchExit(candidate, data)
  if (exit.done) return { suggestion: 'experiment', reasons: [stage.checks.firstDeal, stage.checks.repeatability, stage.checks.unitEconomics] }
  return { suggestion: 'continue', reasons: exitChecks(candidate, data).filter((c) => c.ok !== true) }
}
