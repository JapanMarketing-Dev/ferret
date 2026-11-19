import {
  LIMITS as VR_LIMITS,
  MESSAGE_MAX,
  applyResponse,
  canRespond,
  clampBox,
  isObject,
  isValidPlanId,
  list,
  normalizePlanImage,
  optionalText,
  parseRecordedReview,
  parseSize,
  parseStatus,
  recordedReviewLines,
  replyBoxes,
  sortPlans,
  text,
  type PlanAction,
  type PlanBox,
  type PlanStatus,
  type RecordedReviewRef,
  type RecordingNote
} from './visualReview'

/**
 * 価値ユースケース（純粋な関数。単体テストの対象）。
 *
 * ビジュアルレビュー（@shared/visualReview）が「画面のここをこう変える」を確かめるのに対し、
 * こちらは「このシステムは何のためにあるか（存在意義）」を確かめる。
 * Agent（skill「ferret-value-usecases」。@shared/valueUseCaseSkill）は、システムが利用者に渡す価値をすべて書き出し、
 * 価値ごとに「最初の画面から、どの画面のどのボタンを押していけばその価値が得られるか」を手順で書く。
 * この手順がすべて書いたとおりに動けば、システムは完成。人が「これで作って」と言えば、Agent はそのとおりに作る。
 *
 * 文書は `.ferret/value-usecases/<id>.json`（システム・プロダクトごとに1つ。直すたびに revision を上げる）。
 * スクリーンショットはビジュアルレビューと同じもの（.ferret/screens/ の控え。または .ferret/value-usecases/<id>/ に写したもの）を使う。
 * Agent が書くので、壊れた・大きすぎる・おかしな値を前提にする（ビジュアルレビューと同じく、読めるものは直して使い、読めないものは理由付きで外す）。
 */

export const VALUE_USECASE_DIR = '.ferret/value-usecases'

/** 価値の今の作り（実装の状態）。書かれていなければ「分からない」 */
export const VALUE_STATES = ['not-built', 'partial', 'works', 'broken'] as const
export type ValueState = (typeof VALUE_STATES)[number]

export interface ValueStep {
  /** 手順の番号（1 から通し。並べ直したあとの番号） */
  step: number
  /** 画面の名前 */
  screen: string
  url?: string
  /** スクリーンショット（プロジェクトの根からの相対パス。`.ferret/` の下の画像） */
  image?: string
  /** 何を押す・何を入れるか（言葉で） */
  action: string
  /** 押す場所（画像の幅・高さに対する割合）。画像があるときだけ */
  target?: PlanBox
  /** 押したあとに起きること・次に見えるもの */
  expected: string
}

export interface ValueItem {
  id: string
  /** 利用者が得る価値 */
  name: string
  /** 誰が（役割・人物像） */
  who: string
  /** なぜ大事か */
  why: string
  /** 価値が得られたと分かる条件 */
  success: string
  status?: ValueState
  /** 属するグループの id（文書の groups の id）。無ければグループなし */
  group?: string
  flow: ValueStep[]
}

/**
 * 価値のグループ（Agent が書く）。価値が数百になると全部は見られないので、10〜30 のグループに分けて、
 * まずグループ単位でざっくりレビューする
 */
export interface ValueGroup {
  id: string
  name: string
  /** グループの中身を一言で */
  summary: string
}

/** フィードバックで人が囲んだ場所（価値と手順の番号。どちらも 0 から） */
export type ValueBox = PlanBox & { value: number; step: number; note?: string }

export interface ValueResponse {
  at: string
  action: PlanAction
  revision: number
  /** 'recording' … 声と書き込み（録画のレビュー）で返したフィードバック */
  kind?: 'recording'
  text?: string
  boxes?: ValueBox[]
  review?: RecordedReviewRef
}

export interface ValueUseCaseDoc {
  id: string
  /** システム・プロダクトの名前 */
  title: string
  revision: number
  createdAt: string
  updatedAt?: string
  status: PlanStatus
  /** 書いた Agent のターミナル（$FERRET_TERMINAL_ID）。承認・フィードバックの送り先 */
  terminalId?: string
  /** システムの存在意義（1〜3文） */
  purpose: string
  /** 価値のグループ（書いた順）。無ければ空（画面は自動で分ける。groupValues） */
  groups: ValueGroup[]
  values: ValueItem[]
  outOfScope: string[]
  questions: string[]
  /** 過去の指摘（skill ferret-feedback）から、この文書に先に反映したもの */
  appliedFeedback: string[]
  responses: ValueResponse[]
}

export interface ValueUseCaseListing {
  docs: ValueUseCaseDoc[]
  invalid: Array<{ file: string; reason: string }>
}

export const VALUE_LIMITS = {
  /** 価値ユースケースは完成の定義として細かく書く（数百の価値・手順）ので、文書1つは 16MB まで読む */
  docBytes: 16 * 1024 * 1024,
  values: 1000,
  steps: 30,
  /** 手順を通しで数えた数の上限（フィードバックの囲みの画像の番号） */
  totalSteps: 1000 * 30,
  docs: 200,
  /** グループの数の上限（読むのは 60 まで。画面で勧めるのは 10〜30） */
  groups: 60
} as const

function parseValueState(raw: unknown): ValueState | undefined {
  if (typeof raw !== 'string') return undefined
  const value = raw.trim().toLowerCase().replace(/[\s_]+/g, '-')
  if (value === 'working' || value === 'done' || value === 'ok') return 'works'
  if (value === 'notbuilt' || value === 'todo' || value === 'missing') return 'not-built'
  return (VALUE_STATES as readonly string[]).includes(value) ? value as ValueState : undefined
}

function stepNumber(raw: unknown): number | null {
  const n = typeof raw === 'string' && raw.trim() ? Number(raw) : raw
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}

function parseStep(raw: unknown, index: number): (ValueStep & { order: number; index: number }) | null {
  if (!isObject(raw)) return null
  const action = text(raw.action, VR_LIMITS.text)
  const expected = text(raw.expected, VR_LIMITS.text)
  if (!action && !expected) return null
  const image = normalizePlanImage(raw.image) ?? undefined
  const url = optionalText(raw.url, 2000)
  const target = image && isObject(raw.target) ? clampBox(raw.target, parseSize(raw) ?? parseSize(raw.size)) ?? undefined : undefined
  return {
    order: stepNumber(raw.step) ?? index + 1,
    index,
    step: 0,
    screen: text(raw.screen, VR_LIMITS.label),
    ...(url ? { url } : {}),
    ...(image ? { image } : {}),
    action,
    ...(target ? { target } : {}),
    expected
  }
}

/**
 * 手順を並べる。書かれた step の番号の順（同じ番号・番号なしは書いた順）にして、1 から振り直す
 * （Agent が番号を飛ばした・重ねたときも、画面の番号と送る文の番号を合わせる）
 */
export function orderFlow(raw: unknown): ValueStep[] {
  const steps = Array.isArray(raw) ? raw.slice(0, VALUE_LIMITS.steps * 2).map((value, index) => parseStep(value, index)).filter((step) => step !== null) : []
  return steps
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .slice(0, VALUE_LIMITS.steps)
    .map(({ order: _order, index: _index, ...step }, i) => ({ ...step, step: i + 1 }))
}

const VALUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function parseGroups(raw: unknown): ValueGroup[] {
  const used = new Set<string>()
  if (!Array.isArray(raw)) return []
  const out: ValueGroup[] = []
  raw.slice(0, VALUE_LIMITS.groups * 2).forEach((value, index) => {
    if (out.length >= VALUE_LIMITS.groups || !isObject(value)) return
    const name = text(value.name, VR_LIMITS.label)
    if (!name) return
    let id = typeof value.id === 'string' && VALUE_ID.test(value.id) ? value.id : `g${index + 1}`
    for (let n = 2; used.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`
    used.add(id)
    out.push({ id, name, summary: text(value.summary, VR_LIMITS.text) })
  })
  return out
}

/** 価値の group を、グループの id に合わせる（id でも名前でもよい。大文字・小文字は問わない）。合わなければ消す */
function linkGroups(values: ValueItem[], groups: readonly ValueGroup[]): ValueItem[] {
  if (groups.length === 0) return values.map(({ group: _group, ...value }) => value)
  const byKey = new Map<string, string>()
  for (const group of groups) {
    byKey.set(group.id.toLowerCase(), group.id)
    if (!byKey.has(group.name.toLowerCase())) byKey.set(group.name.toLowerCase(), group.id)
  }
  return values.map(({ group, ...value }) => {
    const id = group ? byKey.get(group.trim().toLowerCase()) : undefined
    return id ? { ...value, group: id } : value
  })
}

function parseValue(raw: unknown, index: number, used: Set<string>): ValueItem | null {
  if (!isObject(raw)) return null
  const name = text(raw.name, VR_LIMITS.label)
  if (!name) return null
  let id = typeof raw.id === 'string' && VALUE_ID.test(raw.id) ? raw.id : `v${index + 1}`
  // 同じ id が重なったら、後のものに番号を付ける（返事の囲みで価値を取り違えないように）
  for (let n = 2; used.has(id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`
  used.add(id)
  const status = parseValueState(raw.status)
  const group = typeof raw.group === 'string' ? raw.group.trim().slice(0, VR_LIMITS.label) : ''
  return {
    id,
    name,
    ...(group ? { group } : {}),
    who: text(raw.who, VR_LIMITS.label),
    why: text(raw.why, VR_LIMITS.text),
    success: text(raw.success, VR_LIMITS.text),
    ...(status ? { status } : {}),
    flow: orderFlow(raw.flow)
  }
}

function parseValueResponse(raw: unknown): ValueResponse | null {
  if (!isObject(raw)) return null
  const action = raw.action === 'approve' || raw.action === 'feedback' ? raw.action : null
  if (!action) return null
  const revision = typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? Math.max(1, Math.floor(raw.revision)) : 1
  const responseText = optionalText(raw.text, VR_LIMITS.text * 2)
  const boxes = list(raw.boxes, VR_LIMITS.annotations, (value) => {
    if (!isObject(value)) return null
    const box = clampBox(value)
    if (!box) return null
    const index = (n: unknown): number => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0)
    const note = optionalText(value.note, VR_LIMITS.label)
    return { ...box, value: index(value.value), step: index(value.step), ...(note ? { note } : {}) }
  })
  const review = action === 'feedback' && raw.kind === 'recording' ? parseRecordedReview(raw.review) : null
  return {
    at: text(raw.at, 40),
    action,
    revision,
    ...(review ? { kind: 'recording' as const, review } : {}),
    ...(responseText ? { text: responseText } : {}),
    ...(boxes.length ? { boxes } : {})
  }
}

const isoOrEmpty = (raw: unknown): string => {
  const value = text(raw, 40)
  return Number.isNaN(Date.parse(value)) ? '' : value
}

/** 価値ユースケースの JSON を読む。fileId はファイル名の id（中の id より優先する）。読めなければ理由（英語。Agent が読んで直す） */
export function parseValueUseCase(raw: unknown, fileId: string): { ok: true; doc: ValueUseCaseDoc } | { ok: false; reason: string } {
  if (!isValidPlanId(fileId)) return { ok: false, reason: 'invalid file name (use [A-Za-z0-9._-], up to 80 characters)' }
  if (!isObject(raw)) return { ok: false, reason: 'not a JSON object' }
  const title = text(raw.title, VR_LIMITS.title)
  if (!title) return { ok: false, reason: '"title" is missing' }
  const used = new Set<string>()
  const groups = parseGroups(raw.groups)
  const values = linkGroups(Array.isArray(raw.values)
    ? raw.values.slice(0, VALUE_LIMITS.values * 2).map((value, index) => parseValue(value, index, used)).filter((value) => value !== null).slice(0, VALUE_LIMITS.values)
    : [], groups)
  const status = parseStatus(raw.status)
  // 下書きは、まだ価値が無くてよい（存在意義だけでも先に出す）
  if (values.length === 0 && status !== 'drafting') {
    return { ok: false, reason: Array.isArray(raw.values) && raw.values.length > 0 ? 'no usable value: each value needs a "name"' : 'needs at least one entry in "values"' }
  }
  const revision = typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? Math.max(1, Math.floor(raw.revision)) : 1
  const terminalId = typeof raw.terminalId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.terminalId) ? raw.terminalId : undefined
  const updatedAt = isoOrEmpty(raw.updatedAt)
  return {
    ok: true,
    doc: {
      id: fileId,
      title,
      revision,
      createdAt: isoOrEmpty(raw.createdAt),
      ...(updatedAt ? { updatedAt } : {}),
      status,
      ...(terminalId ? { terminalId } : {}),
      purpose: text(raw.purpose, VR_LIMITS.text),
      groups,
      values,
      outOfScope: list(raw.outOfScope, VR_LIMITS.listItems, (value) => optionalText(value, VR_LIMITS.text) ?? null),
      questions: list(raw.questions, VR_LIMITS.listItems, (value) => optionalText(value, VR_LIMITS.text) ?? null),
      appliedFeedback: list(raw.appliedFeedback, VR_LIMITS.listItems, (value) => optionalText(value, VR_LIMITS.text) ?? null),
      responses: list(raw.responses, VR_LIMITS.responses, parseValueResponse)
    }
  }
}

/** 新しい順（直した時刻 → 作った時刻 → 版 → id） */
export function sortValueDocs(entries: ReadonlyArray<{ plan: ValueUseCaseDoc; mtime?: number }>): ValueUseCaseDoc[] {
  return sortPlans(entries).slice(0, VALUE_LIMITS.docs)
}

/** 価値の数と、今の作りごとの数（「N 個の価値 / M 個が動く」）。状態が書かれていない価値は unknown */
export interface ValueSummary {
  values: number
  works: number
  partial: number
  broken: number
  notBuilt: number
  unknown: number
  steps: number
}

export function summarizeValues(doc: Pick<ValueUseCaseDoc, 'values'>): ValueSummary {
  const summary: ValueSummary = { values: doc.values.length, works: 0, partial: 0, broken: 0, notBuilt: 0, unknown: 0, steps: 0 }
  for (const value of doc.values) {
    summary.steps += value.flow.length
    if (value.status === 'works') summary.works++
    else if (value.status === 'partial') summary.partial++
    else if (value.status === 'broken') summary.broken++
    else if (value.status === 'not-built') summary.notBuilt++
    else summary.unknown++
  }
  return summary
}

/** これより価値が多ければグループに分けて見せる（少なければ今までどおり全部を並べる） */
export const GROUP_FROM_VALUES = 13
/** 自動で分けるときのグループの数の目安 */
export const AUTO_GROUPS_MAX = 30

/** 画面で見せるグループ（文書のもの・自動で分けたもの） */
export interface ValueGroupView {
  /** 画面の中で一意（開いた・閉じたの控え） */
  key: string
  name: string
  summary: string
  /**
   * doc … 文書の groups / other … 文書のグループに入っていない価値 /
   * who … 誰が（who）で自動に分けた / range … 書いた順に自動で区切った
   */
  source: 'doc' | 'other' | 'who' | 'range'
  /** 文書の groups の中の位置（source が doc のときだけ） */
  groupIndex?: number
  /** 文書の values の中の位置（書いた順） */
  indices: number[]
  stats: ValueSummary
}

function groupView(doc: Pick<ValueUseCaseDoc, 'values'>, base: Omit<ValueGroupView, 'stats'>): ValueGroupView {
  return { ...base, stats: summarizeValues({ values: base.indices.map((i) => doc.values[i]!) }) }
}

/**
 * 価値をグループに分ける。グループに分けないとき（価値が少なく、文書にグループも無い）は null。
 * - 文書に groups があればそれを使う（書いた順。空のグループは外す。どれにも入らない価値は最後の「その他」）
 * - 無ければ自動で: 誰が（who）が 2〜30 種類に分かれるならそれで、だめなら書いた順に 30 以下に区切る
 */
export function groupValues(doc: Pick<ValueUseCaseDoc, 'values' | 'groups'>): ValueGroupView[] | null {
  const n = doc.values.length
  if (doc.groups.length > 0 && n > 0) {
    const members = new Map<string, number[]>(doc.groups.map((group) => [group.id, []]))
    const other: number[] = []
    doc.values.forEach((value, i) => {
      const bucket = value.group ? members.get(value.group) : undefined
      if (bucket) bucket.push(i)
      else other.push(i)
    })
    const views = doc.groups.flatMap((group, groupIndex) => {
      const indices = members.get(group.id) ?? []
      return indices.length ? [groupView(doc, { key: `doc:${group.id}`, name: group.name, summary: group.summary, source: 'doc', groupIndex, indices })] : []
    })
    if (other.length) views.push(groupView(doc, { key: 'other', name: '', summary: '', source: 'other', indices: other }))
    return views
  }
  if (n < GROUP_FROM_VALUES) return null
  const byWho = new Map<string, number[]>()
  doc.values.forEach((value, i) => {
    const who = value.who.trim()
    const bucket = byWho.get(who)
    if (bucket) bucket.push(i)
    else byWho.set(who, [i])
  })
  if (byWho.size >= 2 && byWho.size <= AUTO_GROUPS_MAX && !byWho.has('')) {
    return [...byWho].map(([who, indices]) => groupView(doc, { key: `who:${who}`, name: who, summary: '', source: 'who', indices }))
  }
  const size = Math.max(10, Math.ceil(n / AUTO_GROUPS_MAX))
  const views: ValueGroupView[] = []
  for (let start = 0; start < n; start += size) {
    const indices = Array.from({ length: Math.min(size, n - start) }, (_, k) => start + k)
    views.push(groupView(doc, { key: `range:${start}`, name: '', summary: '', source: 'range', indices }))
  }
  return views
}

/** すべての価値が動く（完成）。価値が無ければ false */
export function isComplete(doc: Pick<ValueUseCaseDoc, 'values'>): boolean {
  return doc.values.length > 0 && doc.values.every((value) => value.status === 'works')
}

/**
 * 手順を価値をまたいで通しで数えた番号（0 から）。フィードバックの囲みは、この番号を画像の番号（screen）にして送る
 * （ビジュアルレビューの録画のフィードバックと同じ形 RecordingNote を使うため）
 */
export function flatStepIndex(doc: Pick<ValueUseCaseDoc, 'values'>, value: number, step: number): number {
  let n = 0
  for (let v = 0; v < value; v++) n += doc.values[v]?.flow.length ?? 0
  return n + step
}

/** 通しの番号 → 価値と手順の番号（どちらも 0 から）。範囲の外なら null */
export function stepAt(doc: Pick<ValueUseCaseDoc, 'values'>, flat: number): { value: number; step: number } | null {
  if (!Number.isInteger(flat) || flat < 0) return null
  let rest = flat
  for (let v = 0; v < doc.values.length; v++) {
    const length = doc.values[v]!.flow.length
    if (rest < length) return { value: v, step: rest }
    rest -= length
  }
  return null
}

/** 画面から来た囲み（screen は通しの番号）を、価値と手順の番号に直す。画像の無い手順・範囲の外は落とす */
export function toValueBoxes(doc: Pick<ValueUseCaseDoc, 'values'>, boxes: RecordingNote['boxes']): ValueBox[] {
  const out: ValueBox[] = []
  for (const { screen, ...box } of boxes ?? []) {
    const at = stepAt(doc, screen)
    if (!at || !doc.values[at.value]!.flow[at.step]!.image) continue
    out.push({ ...box, value: at.value, step: at.step })
  }
  return out
}

/** 画面からの返事（囲みの screen は通しの番号） */
export interface ValueReply {
  action: PlanAction
  text?: string
  boxes?: RecordingNote['boxes']
}

/** 画面から来た返事を確かめる。フィードバックは文か囲みが要る。おかしければ null */
export function sanitizeValueReply(raw: unknown): ValueReply | null {
  if (!isObject(raw)) return null
  if (raw.action !== 'approve' && raw.action !== 'feedback') return null
  const replyText = optionalText(raw.text, VR_LIMITS.text * 2)
  const boxes = replyBoxes(raw.boxes, VALUE_LIMITS.totalSteps)
  if (raw.action === 'feedback' && !replyText && boxes.length === 0) return null
  return { action: raw.action, ...(replyText ? { text: replyText } : {}), ...(boxes.length ? { boxes } : {}) }
}

/** 文書の JSON（生のもの）に返事を書き足す。知らない項目は残す。返事できない状態なら null */
export function applyValueResponse(raw: Record<string, unknown>, doc: Pick<ValueUseCaseDoc, 'status' | 'revision'>, response: Omit<ValueResponse, 'revision'>): Record<string, unknown> | null {
  return applyResponse(raw, doc, response)
}

export { canRespond }

const pct = (n: number): string => `${Math.round(n * 100)}%`

/**
 * 承認・フィードバックのときに Agent のターミナルへ送る文（利用者の言語）。
 * 承認なら「書いた価値と手順のとおりにシステムを作り、動いた価値から status を works にする」。
 * フィードバックなら「まだ作らず、文書を直して版を上げ、また待つ」
 */
export function valueResponseMessage(
  doc: Pick<ValueUseCaseDoc, 'id' | 'title' | 'revision' | 'values'>,
  response: { action: PlanAction; text?: string; boxes?: ValueBox[]; review?: RecordedReviewRef },
  locale: 'ja' | 'en'
): string {
  const file = `${VALUE_USECASE_DIR}/${doc.id}.json`
  const ja = locale === 'ja'
  const count = doc.values.length
  if (response.action === 'approve') {
    return ja
      ? `[Ferret 価値ユースケース] 「${doc.title}」の価値ユースケース（第${doc.revision}版・${file}・価値 ${count} 個）が承認されました。書かれた価値と手順のとおりにシステムを作ってください（最初の画面から、手順の画面・ボタン・結果がそのとおりになるように）。価値ごとに、手順を最初から最後まで確かめて動いたら、その価値の status を "works" にしてください。すべて "works" になったら文書の status を "done" にしてください。手順を変える必要が出たら、作る前に文書を直して（revision を 1 上げ、status を "proposed" に）もう一度承認を待ってください。`
      : `[Ferret value use cases] The value use cases for "${doc.title}" (revision ${doc.revision}, ${file}, ${count} values) were approved. Build the system so that every value's flow works exactly as written, from the very first screen (same screens, buttons and results). For each value, walk its flow end to end; when it works, set that value's "status" to "works". When every value works, set the document's "status" to "done". If a flow must change, revise the document first (bump "revision", set "status" to "proposed") and wait for approval again.`
  }
  const lines = [
    ja
      ? `[Ferret 価値ユースケース] 「${doc.title}」の価値ユースケース（第${doc.revision}版・${file}）にフィードバックがありました。まだ作らないでください。文書を直し、revision を 1 上げて status を "proposed" にし、updatedAt を今にして同じファイルに書き、もう一度承認を待ってください。`
      : `[Ferret value use cases] The value use cases for "${doc.title}" (revision ${doc.revision}, ${file}) got feedback. Do not build yet. Revise the document, bump "revision" by 1, set "status" to "proposed" and "updatedAt" to now, write it to the same file, and wait for approval again.`
  ]
  const body = response.text?.trim()
  if (body) lines.push(ja ? `フィードバック: ${body}` : `Feedback: ${body}`)
  if (response.boxes?.length) {
    lines.push(ja ? '人が囲んだ場所（手順のスクリーンショットの幅・高さに対する割合）:' : 'Areas the person marked (fractions of the step screenshot size):')
    response.boxes.forEach((box, index) => {
      const value = doc.values[box.value]
      const name = value ? ` (${value.name})` : ''
      const where = ja ? `価値 ${box.value + 1}${name} 手順 ${box.step + 1}` : `value ${box.value + 1}${name} step ${box.step + 1}`
      lines.push(`  ${index + 1}. ${where}: x=${pct(box.x)} y=${pct(box.y)} w=${pct(box.w)} h=${pct(box.h)}${box.note ? ` — ${box.note}` : ''}`)
    })
  }
  if (response.review) lines.push(...recordedReviewLines(response.review, ja))
  const message = lines.join('\n')
  return message.length > MESSAGE_MAX ? `${message.slice(0, MESSAGE_MAX - 1)}…` : message
}

/** 変更の通知の相対パスが、価値ユースケースのフォルダ（`.ferret/value-usecases/` の下）のものか */
export function isValueUseCasePath(path: string): boolean {
  return path.replace(/\\/g, '/').startsWith(`${VALUE_USECASE_DIR}/`)
}

/** 返事の結果。送れなかったら copyText（人がターミナルへ貼れる文） */
export interface ValueReplyResult {
  ok: boolean
  message: string
  sent: boolean
  copyText?: string
  doc?: ValueUseCaseDoc
}
