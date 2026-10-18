/**
 * ビジネスの画面の表示用の小さな関数（副作用なし。単体テストは test/unit/business-ui.test.ts）。
 * 未確認（U）と未計測（null）を 0 と書かない、が一番の決まり。
 */
import {
  CHANGE_AXES,
  STAGES,
  STEP_IDS,
  UNKNOWN,
  type Approval,
  type BusinessData,
  type BusinessFile,
  type ChangeAxis,
  type ExperimentNumbers,
  type Hypothesis,
  type RecordKind,
  type RecordTypes,
  type Stage,
  type StepId
} from '@shared/business/model'
import type { Issue } from '@shared/business/rules'
import { provisionSummary } from '@shared/business/scoring'

/** 実験の数の欄（表の並び順） */
export const NUMBER_FIELDS: ReadonlyArray<{ key: keyof ExperimentNumbers; label: string; unit: '' | '円' | '時間'; group: '経路' | '別の数' | '費用' | '継続' }> = [
  { key: 'contacts', label: '接触', unit: '', group: '経路' },
  { key: 'replies', label: '返信', unit: '', group: '経路' },
  { key: 'qualified', label: '適格商談', unit: '', group: '経路' },
  { key: 'priced', label: '価格提示', unit: '', group: '経路' },
  { key: 'paid', label: '有料顧客', unit: '', group: '経路' },
  { key: 'payments', label: '入金', unit: '', group: '経路' },
  { key: 'accepted', label: '成果受入', unit: '', group: '経路' },
  { key: 'repurchased', label: '再購入', unit: '', group: '経路' },
  { key: 'interest', label: '関心表明', unit: '', group: '別の数' },
  { key: 'quoteRequests', label: '見積依頼', unit: '', group: '別の数' },
  { key: 'revenue', label: '入金額（税抜）', unit: '円', group: '費用' },
  { key: 'adCost', label: '広告費', unit: '円', group: '費用' },
  { key: 'outsourceCost', label: '外注費・紹介料', unit: '円', group: '費用' },
  { key: 'salesHours', label: '営業時間', unit: '時間', group: '費用' },
  { key: 'hourlyCost', label: '営業1時間の原価', unit: '円', group: '費用' },
  { key: 'deliveryCost', label: '提供の変動費', unit: '円', group: '費用' },
  { key: 'setupCost', label: '初期導入費', unit: '円', group: '継続' },
  { key: 'monthlyPrice', label: '月額', unit: '円', group: '継続' },
  { key: 'monthlyVariableCost', label: '月次の変動費', unit: '円', group: '継続' }
]

export const DETAIL_LABELS: Record<keyof RecordTypes['evidence']['details'], string> = {
  scene: '発生場面',
  loss: '損失',
  deadline: '期限・頻度',
  action: '取った対策',
  spend: '支出・時間',
  conditions: '製品の条件',
  gap: '残る不足',
  workaround: '回避策',
  payer: '支払主体',
  nextQuestion: '次に聞くこと'
}

/** 数の表示。未計測（null）は「未計測」で、0 と書かない */
export function numberText(value: number | null, unit: '' | '円' | '時間' = ''): string {
  if (value === null) return '未計測'
  const n = value.toLocaleString('ja-JP')
  return unit ? `${n} ${unit}` : n
}

/**
 * 数の入力欄の値を読む。空は未計測（null）。読めない・負の数は error。
 * 全角の数字とカンマ・「円」は受け付ける。
 */
export function parseNumberInput(raw: string): { ok: true; value: number | null } | { ok: false; message: string } {
  const s = raw
    .replace(/[０-９．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，円\s]/g, '')
  if (s === '') return { ok: true, value: null }
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, message: '0 以上の数を入れてください' }
  const n = Number(s)
  if (!Number.isFinite(n) || n > 1e12) return { ok: false, message: '大きすぎます' }
  return { ok: true, value: n }
}

/** その欄（field。前方一致で子の欄も含む）の検査結果 */
export function issuesFor(issues: readonly Issue[], ref: string, field?: string): Issue[] {
  return issues.filter((i) => i.ref === ref && (field === undefined || i.field === field || i.field.startsWith(`${field}.`)))
}

/** 提供条件 P の要約（U を 0 と数えない） */
export function provisionText(h: Hypothesis): string {
  const p = provisionSummary(h)
  return `はい ${p.yes}・いいえ ${p.no}・U ${p.unknown}`
}

/** 表に出す短い合計（U があれば「未完了 U2」。U を 0 として足さない） */
export function compactTotal(t: { complete: true; total: number; max: number } | { complete: false; unknown: number; max: number }): string {
  return t.complete ? `${t.total}/${t.max}` : `未完了 U${t.unknown}`
}

/** 表に出す短い P の要約 */
export function compactProvision(h: Hypothesis): string {
  const p = provisionSummary(h)
  return `はい${p.yes} いいえ${p.no} U${p.unknown}`
}

export function scoreText(value: number | typeof UNKNOWN): string {
  return value === UNKNOWN ? 'U' : String(value)
}

/** 次の段階（最後なら null） */
export function nextStage(stage: Stage): Stage | null {
  const i = STAGES.indexOf(stage)
  return i >= 0 && i < STAGES.length - 1 ? STAGES[i + 1]! : null
}

/** 変えるものごとの、戻るステップの初期値 */
export function defaultBackStep(axis: ChangeAxis): StepId {
  return ({ 対象: 'S1', 成果: 'S6', 価格: 'S6', 経路: 'S8' } as const)[axis]
}

/** 周を閉じるときに戻れるステップ（S1〜S8） */
export const BACK_STEPS: readonly StepId[] = STEP_IDS.slice(0, 8)

export function isChangeAxis(value: unknown): value is ChangeAxis {
  return typeof value === 'string' && (CHANGE_AXES as readonly string[]).includes(value)
}

/** 前の周で何を変えたか（無ければ null） */
export function lastLoopText(business: BusinessFile): string | null {
  const last = [...business.loops].reverse().find((l) => l.changed !== null)
  if (!last?.changed) return null
  return `${last.loop}周目で${last.changed}を変更${last.backTo ? `・${last.backTo} へ戻した` : ''}`
}

/** 承認の並び。待ちを先（古い順）、決めたものは新しい順 */
export function sortApprovals(list: readonly Approval[]): { pending: Approval[]; decided: Approval[] } {
  const pending = list.filter((a) => a.status === '待ち').sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
  const decided = list.filter((a) => a.status !== '待ち').sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
  return { pending, decided }
}

/** 種類ごとの記録の一覧 */
export function recordsOf<K extends RecordKind>(data: BusinessData, kind: K): Array<RecordTypes[K]> {
  const map: { [P in RecordKind]: Array<RecordTypes[P]> } = {
    hypothesis: data.hypotheses,
    evidence: data.evidence,
    alternative: data.alternatives,
    interview: data.interviews,
    experiment: data.experiments,
    decision: data.decisions,
    approval: data.approvals
  }
  return map[kind]
}

/** 記録が同じか（下書きの未保存の判定）。読み込んだ記録と同じ形なので、キーの順で比べられる */
export function sameRecord(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * 例外から画面に出す文。Electron の包み（チャネル名・Error:）を外し、英語だけの文は日本語に置き換える。
 * ファイルのパスも出さない。
 */
export function errorText(err: unknown, fallback = '処理できませんでした'): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const text = raw
    .replace(/^Error invoking remote method '[^']*': /, '')
    .replace(/^(?:[A-Za-z]*Error: )+/, '')
    .trim()
  if (!text) return fallback
  // 日本語を含まない（生の英語のエラー）は出さない
  if (!/[぀-ヿ㐀-鿿]/.test(text)) return fallback
  // パスらしきものは消す
  return text.replace(/(?:[A-Za-z]:)?[\\/](?:[^\s\\/]+[\\/])+[^\s\\/]*/g, '（ファイル）').slice(0, 200)
}


/** 文字の一覧（1行1件）を配列に。空行は外す */
export function linesToList(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
}

/** 実験の状態ごとの札の色 */
export function experimentTone(status: RecordTypes['experiment']['status']): 'neutral' | 'brand' | 'success' | 'warning' {
  return status === '実施中' ? 'brand' : status === '完了' ? 'success' : status === '中止' ? 'warning' : 'neutral'
}

/** 日時の表示（YYYY-MM-DD HH:mm。秒とタイムゾーンは出さない） */
export function dateTimeText(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso.slice(0, 16)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 一覧の行の key を中身から作る（並びが変わっても同じ行に同じ key）。同じ中身が続くときは #2, #3 … を付けて重ならないようにする
 */
export function contentKeys<T>(items: readonly T[], keyOf: (item: T) => string): string[] {
  const used = new Set<string>()
  return items.map((item) => {
    const base = keyOf(item)
    let key = base
    for (let n = 2; used.has(key); n++) key = `${base}#${n}`
    used.add(key)
    return key
  })
}
