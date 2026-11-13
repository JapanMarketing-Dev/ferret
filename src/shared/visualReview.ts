/**
 * ビジュアルレビュー（純粋な関数。単体テストの対象）。
 *
 * 利用者が Ferret のターミナルで画面・動きの変更を頼むと、Agent は作る前に「今の画面のここをこう変える」計画を
 * `.ferret/visual-review/<id>.json` に書いて止まる（skill「ferret-visual-review」。@shared/visualReviewSkill）。
 * Ferret は中央の「ビジュアルレビュー」タブで、画面の上に番号付きの枠と変更の一覧を出し、
 * 「これで作って」（承認）か「フィードバック」を、計画を書いた Agent のターミナルへ送る。
 *
 * 計画は Agent が書くので、壊れた・大きすぎる・おかしな値を前提にする。読めるものは直して（範囲に収める・長さを切る）使い、
 * 読めないものは理由を付けて外す。画像はプロジェクトの `.ferret/` の下の画像だけ（isSafePlanImage）。
 */

export const VISUAL_REVIEW_DIR = '.ferret/visual-review'

export const PLAN_STATUSES = ['proposed', 'approved', 'changes-requested', 'done'] as const
export type PlanStatus = (typeof PLAN_STATUSES)[number]

export const ANNOTATION_KINDS = ['change', 'add', 'remove', 'move'] as const
export type AnnotationKind = (typeof ANNOTATION_KINDS)[number]

/** 画像の上の枠。x・y・w・h は画像の幅・高さに対する割合（0〜1） */
export interface PlanBox {
  x: number
  y: number
  w: number
  h: number
}

export interface PlanAnnotation extends PlanBox {
  kind: AnnotationKind
  label: string
  before?: string
  after: string
}

export interface PlanScreen {
  /** プロジェクトの根からの相対パス（`.ferret/` の下の画像） */
  image: string
  url?: string
  caption: string
  annotations: PlanAnnotation[]
}

export interface PlanBehaviour {
  before: string
  after: string
}

/** 人の返事（Ferret が書き足す） */
export interface PlanResponse {
  at: string
  action: 'approve' | 'feedback'
  revision: number
  text?: string
  /** フィードバックで人が囲んだ場所（画面の番号ごと） */
  boxes?: Array<PlanBox & { screen: number; note?: string }>
}

export interface VisualPlan {
  id: string
  title: string
  request: string
  revision: number
  createdAt: string
  status: PlanStatus
  screens: PlanScreen[]
  behaviour: PlanBehaviour[]
  outOfScope: string[]
  questions: string[]
  /** 計画を書いた Agent のターミナル（$FERRET_TERMINAL_ID）。承認・フィードバックの送り先 */
  terminalId?: string
  responses: PlanResponse[]
}

export interface PlanListing {
  plans: VisualPlan[]
  /** 読めなかった計画のファイル（名前と理由）。タブの下に出して、Agent に直してもらえるようにする */
  invalid: Array<{ file: string; reason: string }>
}

export const LIMITS = {
  /** 計画の JSON の大きさ */
  planBytes: 512 * 1024,
  /** 画像の大きさ（data URL にして画面へ渡す） */
  imageBytes: 12 * 1024 * 1024,
  screens: 12,
  annotations: 40,
  behaviour: 40,
  listItems: 30,
  responses: 50,
  title: 200,
  text: 2000,
  label: 300,
  /** タブに出す計画の数（新しい順） */
  plans: 200
} as const

/** 計画の id（ファイル名）。英数字と . _ - だけ、80 文字まで。先頭は英数字 */
export function isValidPlanId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(id) && !id.includes('..')
}

/** `.ferret/visual-review/<id>.json` の id。計画のファイルでなければ null */
export function planIdFromFile(name: string): string | null {
  if (!name.endsWith('.json')) return null
  const id = name.slice(0, -'.json'.length)
  return isValidPlanId(id) ? id : null
}

const IMAGE_EXT = /\.(png|jpe?g|webp|gif|svg)$/i

/**
 * 計画の画像のパスを、プロジェクトの根からの相対パスに直す（`.ferret/` の下の画像だけ）。
 * `screens/latest.jpg` のように `.ferret/` を省いた書き方も受ける。外を指す・画像でない・絶対パスは null
 */
export function normalizePlanImage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let rel = raw.trim().replace(/\\/g, '/')
  if (!rel || rel.length > 400 || rel.includes('\0')) return null
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || /^[a-z][a-z0-9+.-]*:/i.test(rel)) return null
  rel = rel.replace(/^(\.\/)+/, '')
  if (!rel.startsWith('.ferret/')) rel = `.ferret/${rel}`
  const parts = rel.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return null
  if (!IMAGE_EXT.test(rel)) return null
  return rel
}

export function isSafePlanImage(rel: string): boolean {
  return normalizePlanImage(rel) === rel
}

/** 画像の拡張子 → MIME */
export function imageMime(rel: string): string {
  const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg'
  if (ext === 'svg') return 'image/svg+xml'
  return `image/${ext}`
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n))

/**
 * 枠を画像の中に収める。数でないものは null。
 * 割合でなく画素らしい値（1 より大きい）が来たら、画像の大きさが分かればそれで割る（分からなければ null）。
 * 幅・高さが小さすぎる枠は、見えるように最小の大きさ（1%）にする
 */
export function clampBox(raw: { x?: unknown; y?: unknown; w?: unknown; h?: unknown }, size?: { width: number; height: number }): PlanBox | null {
  let [x, y, w, h] = [raw.x, raw.y, raw.w, raw.h].map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : NaN))
  if ([x, y, w, h].some(Number.isNaN)) return null
  if (Math.max(x + w, y + h) > 1.5) {
    if (!size || size.width <= 0 || size.height <= 0) return null
    x /= size.width; w /= size.width; y /= size.height; h /= size.height
  }
  // 負の幅・高さ（右下から左上へ引いた）は向きを直す
  if (w < 0) { x += w; w = -w }
  if (h < 0) { y += h; h = -h }
  const MIN = 0.01
  const x0 = clamp01(x)
  const y0 = clamp01(y)
  const x1 = clamp01(x + w)
  const y1 = clamp01(y + h)
  let cw = x1 - x0
  let ch = y1 - y0
  let cx = x0
  let cy = y0
  if (cw < MIN) { cw = MIN; cx = Math.min(cx, 1 - MIN) }
  if (ch < MIN) { ch = MIN; cy = Math.min(cy, 1 - MIN) }
  const round = (n: number): number => Math.round(n * 10000) / 10000
  return { x: round(cx), y: round(cy), w: round(cw), h: round(ch) }
}

function text(raw: unknown, max: number): string {
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  if (typeof raw !== 'string') return ''
  const trimmed = raw.replace(/\0/g, '').trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

function optionalText(raw: unknown, max: number): string | undefined {
  const value = text(raw, max)
  return value ? value : undefined
}

function list<T>(raw: unknown, max: number, item: (value: unknown) => T | null): T[] {
  if (!Array.isArray(raw)) return []
  const out: T[] = []
  for (const value of raw) {
    if (out.length >= max) break
    const parsed = item(value)
    if (parsed !== null) out.push(parsed)
  }
  return out
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function parseKind(raw: unknown): AnnotationKind {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (ANNOTATION_KINDS as readonly string[]).includes(value) ? value as AnnotationKind : 'change'
}

function parseStatus(raw: unknown): PlanStatus {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return (PLAN_STATUSES as readonly string[]).includes(value) ? value as PlanStatus : 'proposed'
}

function parseAnnotation(raw: unknown, size?: { width: number; height: number }): PlanAnnotation | null {
  if (!isObject(raw)) return null
  const box = clampBox(raw, size)
  if (!box) return null
  const label = text(raw.label, LIMITS.label)
  const after = text(raw.after, LIMITS.text)
  if (!label && !after) return null
  const before = optionalText(raw.before, LIMITS.text)
  return { ...box, kind: parseKind(raw.kind), label: label || after.slice(0, LIMITS.label), ...(before ? { before } : {}), after }
}

function parseSize(raw: unknown): { width: number; height: number } | undefined {
  if (!isObject(raw)) return undefined
  const { width, height } = raw
  return typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0 ? { width, height } : undefined
}

function parseScreen(raw: unknown): PlanScreen | null {
  if (!isObject(raw)) return null
  const image = normalizePlanImage(raw.image)
  if (!image) return null
  const size = parseSize(raw) ?? parseSize(raw.size)
  const url = optionalText(raw.url, 2000)
  return {
    image,
    ...(url ? { url } : {}),
    caption: text(raw.caption, LIMITS.text),
    annotations: list(raw.annotations, LIMITS.annotations, (value) => parseAnnotation(value, size))
  }
}

function parseResponse(raw: unknown): PlanResponse | null {
  if (!isObject(raw)) return null
  const action = raw.action === 'approve' || raw.action === 'feedback' ? raw.action : null
  if (!action) return null
  const at = text(raw.at, 40)
  const revision = typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? Math.max(1, Math.floor(raw.revision)) : 1
  const responseText = optionalText(raw.text, LIMITS.text * 2)
  const boxes = list(raw.boxes, LIMITS.annotations, (value) => {
    if (!isObject(value)) return null
    const box = clampBox(value)
    if (!box) return null
    const screen = typeof value.screen === 'number' && Number.isInteger(value.screen) && value.screen >= 0 ? value.screen : 0
    const note = optionalText(value.note, LIMITS.label)
    return { ...box, screen, ...(note ? { note } : {}) }
  })
  return { at, action, revision, ...(responseText ? { text: responseText } : {}), ...(boxes.length ? { boxes } : {}) }
}

/**
 * 計画の JSON を読む。fileId はファイル名の id（中の id より優先する。ファイル名で返事を書き戻すため）。
 * 読めなければ理由（英語の短い文。Agent が読んで直せるように）
 */
export function parseVisualPlan(raw: unknown, fileId: string): { ok: true; plan: VisualPlan } | { ok: false; reason: string } {
  if (!isValidPlanId(fileId)) return { ok: false, reason: 'invalid file name (use [A-Za-z0-9._-], up to 80 characters)' }
  if (!isObject(raw)) return { ok: false, reason: 'not a JSON object' }
  const title = text(raw.title, LIMITS.title)
  if (!title) return { ok: false, reason: '"title" is missing' }
  const screens = list(raw.screens, LIMITS.screens, parseScreen)
  const behaviour = list(raw.behaviour ?? raw.behavior, LIMITS.behaviour, (value) => {
    if (!isObject(value)) return null
    const after = text(value.after, LIMITS.text)
    if (!after) return null
    return { before: text(value.before, LIMITS.text), after }
  })
  if (screens.length === 0 && behaviour.length === 0) {
    return { ok: false, reason: Array.isArray(raw.screens) && raw.screens.length > 0
      ? 'no usable screen: "image" must be an image path under .ferret/ (e.g. .ferret/visual-review/<id>/screen-1.jpg)'
      : 'needs at least one entry in "screens" or "behaviour"' }
  }
  const revision = typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? Math.max(1, Math.floor(raw.revision)) : 1
  const createdAt = text(raw.createdAt, 40)
  const terminalId = typeof raw.terminalId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.terminalId) ? raw.terminalId : undefined
  return {
    ok: true,
    plan: {
      id: fileId,
      title,
      request: text(raw.request, LIMITS.text * 2),
      revision,
      createdAt: Number.isNaN(Date.parse(createdAt)) ? '' : createdAt,
      status: parseStatus(raw.status),
      screens,
      behaviour,
      outOfScope: list(raw.outOfScope, LIMITS.listItems, (value) => optionalText(value, LIMITS.text) ?? null),
      questions: list(raw.questions, LIMITS.listItems, (value) => optionalText(value, LIMITS.text) ?? null),
      ...(terminalId ? { terminalId } : {}),
      responses: list(raw.responses, LIMITS.responses, parseResponse)
    }
  }
}

/** 計画の時刻（並びに使う）。書かれていなければ、ファイルの更新時刻 */
function planTime(plan: VisualPlan, mtime?: number): number {
  const at = Date.parse(plan.createdAt)
  return Number.isNaN(at) ? (mtime ?? 0) : at
}

/** 新しい順（作った時刻 → 版 → id）。待っている（proposed）ものを先にはしない（時刻の順のまま） */
export function sortPlans(entries: ReadonlyArray<{ plan: VisualPlan; mtime?: number }>): VisualPlan[] {
  return [...entries]
    .sort((a, b) => planTime(b.plan, b.mtime) - planTime(a.plan, a.mtime) || b.plan.revision - a.plan.revision || a.plan.id.localeCompare(b.plan.id))
    .slice(0, LIMITS.plans)
    .map((entry) => entry.plan)
}

/** 返事を待っている計画の数（タブの数字） */
export function pendingCount(plans: readonly VisualPlan[]): number {
  return plans.filter((plan) => plan.status === 'proposed').length
}

export type PlanAction = 'approve' | 'feedback'

/** 返事ができる状態か。待っている（proposed）ものにだけ返事する（承認済み・作り直し待ち・完了には返さない） */
export function canRespond(plan: Pick<VisualPlan, 'status'>): boolean {
  return plan.status === 'proposed'
}

export function nextStatus(status: PlanStatus, action: PlanAction): PlanStatus | null {
  if (status !== 'proposed') return null
  return action === 'approve' ? 'approved' : 'changes-requested'
}

/**
 * 計画の JSON（Agent が書いた生のもの）に返事を書き足す。知らない項目は残す。
 * 返事できない状態なら null
 */
export function applyResponse(raw: Record<string, unknown>, plan: VisualPlan, response: Omit<PlanResponse, 'revision'>): Record<string, unknown> | null {
  const status = nextStatus(plan.status, response.action)
  if (!status) return null
  const previous = Array.isArray(raw.responses) ? raw.responses.slice(-(LIMITS.responses - 1)) : []
  return { ...raw, status, responses: [...previous, { ...response, revision: plan.revision }] }
}

/** 新しく出た、返事を待っている計画（前に見たものを除く。知らせ・タブへの切り替えに使う） */
export function newlyProposed(previous: ReadonlyMap<string, string>, plans: readonly VisualPlan[]): VisualPlan[] {
  return plans.filter((plan) => plan.status === 'proposed' && previous.get(plan.id) !== `${plan.revision}:proposed`)
}

/** 前の一覧の印（id → 版:状態） */
export function planMarks(plans: readonly VisualPlan[]): Map<string, string> {
  return new Map(plans.map((plan) => [plan.id, `${plan.revision}:${plan.status}`]))
}

/** フィードバックで囲んだ場所を、Agent へ送る文の1行にする */
function boxLine(box: PlanBox & { screen: number; note?: string }, index: number): string {
  const pct = (n: number): string => `${Math.round(n * 100)}%`
  return `  ${index + 1}. screen ${box.screen + 1}: x=${pct(box.x)} y=${pct(box.y)} w=${pct(box.w)} h=${pct(box.h)}${box.note ? ` — ${box.note}` : ''}`
}

const MESSAGE_MAX = 7500

/**
 * 承認・フィードバックのときに Agent のターミナルへ送る文（Agent が読む。人も読めるように、利用者の言語）。
 * 計画のファイルの場所と、次にやること（作る／直してまた待つ）を書く
 */
export function responseMessage(plan: Pick<VisualPlan, 'id' | 'title' | 'revision'>, response: { action: PlanAction; text?: string; boxes?: PlanResponse['boxes'] }, locale: 'ja' | 'en'): string {
  const file = `${VISUAL_REVIEW_DIR}/${plan.id}.json`
  const ja = locale === 'ja'
  if (response.action === 'approve') {
    return ja
      ? `[Ferret ビジュアルレビュー] 計画「${plan.title}」（第${plan.revision}版・${file}）が承認されました。この計画のとおりに実装してください（計画にないものは変えない）。終わったら計画の status を "done" にしてください。`
      : `[Ferret visual review] The plan "${plan.title}" (revision ${plan.revision}, ${file}) was approved. Implement exactly this plan (do not change anything it does not list). When you finish, set the plan's status to "done".`
  }
  const lines = [
    ja
      ? `[Ferret ビジュアルレビュー] 計画「${plan.title}」（第${plan.revision}版・${file}）にフィードバックがありました。まだ実装しないでください。計画を直し、revision を 1 上げて status を "proposed" にして同じファイルに書き、もう一度承認を待ってください。`
      : `[Ferret visual review] The plan "${plan.title}" (revision ${plan.revision}, ${file}) got feedback. Do not implement yet. Revise the plan, bump "revision" by 1, set "status" to "proposed", write it to the same file, and wait for approval again.`
  ]
  const body = response.text?.trim()
  if (body) lines.push(ja ? `フィードバック: ${body}` : `Feedback: ${body}`)
  if (response.boxes?.length) {
    lines.push(ja ? '人が囲んだ場所（画像の幅・高さに対する割合）:' : 'Areas the person marked (fractions of the image size):')
    response.boxes.forEach((box, index) => lines.push(boxLine(box, index)))
  }
  const message = lines.join('\n')
  return message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 1)}…` : message
}

/** 枠の色の種類（画面の CSS のクラスに使う） */
export function kindClass(kind: AnnotationKind): string {
  return `vr-kind--${kind}`
}

/** 変更の通知の相対パスが、計画のフォルダ（`.ferret/visual-review/` の下）のものか（画像の追加も含む） */
export function isVisualReviewPath(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith(`${VISUAL_REVIEW_DIR}/`)
}

/** 画面からの返事 */
export interface VisualPlanReply {
  action: PlanAction
  text?: string
  boxes?: PlanResponse['boxes']
}

/** 返事の結果。送れなかったら copyText（人がターミナルへ貼れる文） */
export interface VisualPlanReplyResult {
  ok: boolean
  /** 利用者向けの短い文 */
  message: string
  /** Agent のターミナルへ送れた */
  sent: boolean
  copyText?: string
  plan?: VisualPlan
}

/** 画面から来た返事を確かめる（文の長さ・枠の数と範囲）。おかしければ null */
export function sanitizeReply(raw: unknown): VisualPlanReply | null {
  if (!isObject(raw)) return null
  if (raw.action !== 'approve' && raw.action !== 'feedback') return null
  const replyText = optionalText(raw.text, LIMITS.text * 2)
  const boxes = list(raw.boxes, LIMITS.annotations, (value) => {
    if (!isObject(value)) return null
    const box = clampBox(value)
    if (!box) return null
    const screen = typeof value.screen === 'number' && Number.isInteger(value.screen) && value.screen >= 0 && value.screen < LIMITS.screens ? value.screen : null
    if (screen === null) return null
    const note = optionalText(value.note, LIMITS.label)
    return { ...box, screen, ...(note ? { note } : {}) }
  })
  // フィードバックは、文か囲んだ場所のどちらかが要る
  if (raw.action === 'feedback' && !replyText && boxes.length === 0) return null
  return { action: raw.action, ...(replyText ? { text: replyText } : {}), ...(boxes.length ? { boxes } : {}) }
}

/**
 * 新しい計画が出たとき、ビジュアルレビューのタブへ自動で切り替えてよいか。
 * ブラウザ・指摘を見ているだけのときだけ切り替える（ファイルの編集・設定・ダッシュボード・録画中・文字を打っている間は知らせるだけ）。
 * ターミナルの入力（xterm）は「打っている」に数えない（依頼を打ったあと、そのまま待っているのが普通なので）
 */
export function shouldAutoOpenVisualReview({ tab, recording, typing }: { tab: string; recording: boolean; typing: boolean }): boolean {
  if (recording || typing) return false
  return tab === 'browser' || tab === 'findings'
}
