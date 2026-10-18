/**
 * 動画の一覧・新しい動画・進み具合の純粋な処理（main・renderer・単体テストで共用。Electron にも Node にも依存しない）。
 * 旧 Solocut の shared/videoName.ts・shared/project.ts から移した。
 */

/** 動画1本の状態。posted（投稿した）→ done（完成動画がある）→ editing（撮った素材がある）→ new */
export type VideoStatus = 'new' | 'editing' | 'done' | 'posted'

export interface VideoEntry {
  /** 動画のフォルダ（絶対パス） */
  dir: string
  /** フォルダ名（チャンネルの直下）。例: 2026-10-18-ネタ */
  name: string
  title: string
  status: VideoStatus
  /** いちばん新しい変更の時刻（ms） */
  updatedAt: number
  /** 旧 Solocut のフォルダ（solocut.json）。`ferret-video migrate` で移す */
  legacy?: true
  template?: string
}

/** チャンネル（Ferret のプロジェクトのフォルダ）の中の動画。新しい順 */
export interface VideoList {
  root: string
  exists: boolean
  videos: VideoEntry[]
  /** 読めなかったとき（permission・notDir・それ以外は文言） */
  error?: string
}

export interface VideoTemplateInfo {
  id: string
  name: { ja: string; en: string }
  description?: { ja: string; en: string } | string
  kind?: string
}

export type StepStateName = 'todo' | 'running' | 'done' | 'needs-human' | 'skipped'

export interface VideoStep {
  step: string
  state: StepStateName
  note?: string
  at?: string
}

export interface VideoNextStep {
  step: string
  state: 'ready' | 'needs-human' | 'done'
  why: string
  do: string
  commands: string[]
  prompt?: string
  blocking?: string[]
}

/** 動画の画面に出す進み具合（`ferret-video status --json`） */
export interface VideoDetail {
  entry: VideoEntry
  steps: VideoStep[]
  next?: VideoNextStep
  /** 完成動画・プレビュー（チャンネルからの相対パス）。無ければ null */
  render: string | null
  /** status を読めなかったときの理由（CLI が無い・壊れた timeline など） */
  error?: string
}

/** ファイル名に使えない文字を落としたタイトル（日本語は残す。空白は -）。空になることもある */
export const SLUG_MAX = 40

export function folderSlug(title: string, max = SLUG_MAX): string {
  const clean = (s: string) => s.replace(/-{2,}/g, '-').replace(/^[-.\s]+|[-.\s]+$/g, '')
  const s = clean(
    title
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, ' ')
      .trim()
      .replace(/\s+/g, '-')
  )
  // サロゲートペア（絵文字）を途中で切らないよう、コードポイントで数える
  return clean(Array.from(s).slice(0, max).join(''))
}

const pad = (n: number) => String(n).padStart(2, '0')

/** `<YYYY-MM-DD>-<slug>`。タイトルが使えなければ `<YYYY-MM-DD>-<HHMM>`（その PC の時刻） */
export function videoFolderName(title: string, now: Date = new Date()): string {
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `${date}-${folderSlug(title) || `${pad(now.getHours())}${pad(now.getMinutes())}`}`
}

/**
 * renderer から受け取った動画のフォルダ名として使えるか（チャンネルの直下の1段だけ）。
 * `..`・区切り文字・隠しフォルダ・空・長すぎるものは断る（パスの外へ出さない）
 */
export function isSafeVideoName(name: unknown): name is string {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false
  if (name === '.' || name === '..' || name.startsWith('.')) return false
  return !/[\\/\x00-\x1f\x7f]/.test(name)
}

const STEP_STATES = new Set<string>(['todo', 'running', 'done', 'needs-human', 'skipped'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** `StepState[]`・`{ steps }`・`{ status }`・`{ pipeline }` を受ける（status --json・status.json） */
export function parseSteps(input: unknown): VideoStep[] {
  let arr: unknown = input
  if (isObj(input)) arr = input.steps ?? input.status ?? input.pipeline
  if (!Array.isArray(arr)) return []
  const out: VideoStep[] = []
  for (const raw of arr) {
    if (!isObj(raw)) continue
    const step = str(raw.step) ?? str(raw.id)
    if (!step) continue
    const st = str(raw.state) ?? 'todo'
    const s: VideoStep = { step, state: (STEP_STATES.has(st) ? st : 'todo') as StepStateName }
    const note = str(raw.note)
    const at = str(raw.at)
    if (note) s.note = note
    if (at) s.at = at
    out.push(s)
  }
  return out
}

export function parseNext(input: unknown): VideoNextStep | undefined {
  const o = isObj(input) && isObj(input.next) ? input.next : input
  if (!isObj(o)) return undefined
  const step = str(o.step)
  if (!step) return undefined
  const state = str(o.state)
  const n: VideoNextStep = {
    step,
    state: state === 'needs-human' || state === 'done' ? state : 'ready',
    why: str(o.why) ?? '',
    do: str(o.do) ?? '',
    commands: Array.isArray(o.commands) ? o.commands.filter((c): c is string => typeof c === 'string') : []
  }
  const prompt = str(o.prompt)
  if (prompt) n.prompt = prompt
  if (Array.isArray(o.blocking)) n.blocking = o.blocking.filter((c): c is string => typeof c === 'string')
  return n
}

/** 済んだ（done・skipped）手順の割合（0..1） */
export function progressOf(steps: readonly VideoStep[]): number {
  if (steps.length === 0) return 0
  return steps.filter((s) => s.state === 'done' || s.state === 'skipped').length / steps.length
}

/** CLI の stdout の JSON。全体が JSON でなければ、最後に読める行（進み具合の NDJSON が前に混ざる） */
export function parseCliJson(stdout: string): unknown {
  const t = stdout.trim()
  if (!t) return undefined
  try {
    return JSON.parse(t)
  } catch {
    const lines = t.split(/\r?\n/)
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!.trim()
      if (!l.startsWith('{') && !l.startsWith('[')) continue
      try {
        return JSON.parse(l)
      } catch {
        /* 前の行を見る */
      }
    }
    return undefined
  }
}

/** `templates --json` の一覧（壊れた項目は落とす） */
export function parseTemplates(input: unknown): VideoTemplateInfo[] {
  const arr = isObj(input) ? input.templates : input
  if (!Array.isArray(arr)) return []
  const out: VideoTemplateInfo[] = []
  for (const raw of arr) {
    if (!isObj(raw) || typeof raw.id !== 'string' || !raw.id) continue
    const name = isObj(raw.name) ? raw.name : {}
    const ja = str(name.ja) ?? raw.id
    const en = str(name.en) ?? ja
    const item: VideoTemplateInfo = { id: raw.id, name: { ja, en } }
    if (typeof raw.description === 'string') item.description = raw.description
    else if (isObj(raw.description)) item.description = { ja: str(raw.description.ja) ?? '', en: str(raw.description.en) ?? str(raw.description.ja) ?? '' }
    if (typeof raw.kind === 'string') item.kind = raw.kind
    out.push(item)
  }
  return out
}

/** プレビュー（`render --preview`）の置き場。動画のフォルダからの相対、ありそうな順 */
export const PREVIEW_CANDIDATES = ['renders/youtube/preview.mp4', 'renders/preview.mp4', 'renders/preview/preview.mp4'] as const
/** 完成動画の置き場 */
export const FINAL_CANDIDATES = ['renders/youtube/final.mp4', 'renders/final.mp4'] as const

/**
 * Agent へ送る依頼文に、動画のフォルダを添える。Agent の作業フォルダはチャンネル（動画のフォルダの親）なので、
 * どの動画の話かと、そこへ移ってから `ferret-video` を使うことを先頭に書く。
 */
export function inVideoFolder(dir: string, body: string, lang: 'ja' | 'en'): string {
  const head = lang === 'ja'
    ? `対象の動画のフォルダ: ${dir}\nこの動画のフォルダへ移ってから（cd "${dir}"）、以下を行ってください。`
    : `Video folder: ${dir}\nWork in that folder (cd "${dir}") and do the following.`
  return `${head}\n\n${body.trim()}`
}

/** 画面の言語（Ferret の locale）→ CLI の言語。ja 以外は en */
export function cliLang(locale: string | undefined): 'ja' | 'en' {
  return locale?.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}

/**
 * CLI の引数に画面の言語（`--lang ja|en`）を足す。CLI が画面に出す文（next の why など）を画面の言語にそろえる。
 * init の --lang はプロジェクトの言語（字幕・文字起こし）なので足さない。もう --lang があればそのまま
 */
export function withUiLang(argv: readonly string[], locale: string | undefined): string[] {
  if (argv[0] === 'init' || argv.some((a) => a === '--lang' || a.startsWith('--lang='))) return [...argv]
  return [...argv, '--lang', cliLang(locale)]
}

/** CLI の失敗の理由（--json の `{ ok: false, error: { message } }`、無ければ stderr の最後の行） */
export function cliFailure(r: { code: number; stdout: string; stderr: string }): string {
  for (const out of [r.stdout, r.stderr]) {
    const j = parseCliJson(out)
    if (isObj(j) && isObj(j.error) && typeof j.error.message === 'string' && j.error.message) return j.error.message
    if (isObj(j) && typeof j.error === 'string' && j.error) return j.error
  }
  const lines = r.stderr.trim().split(/\r?\n/).filter((l) => l.trim())
  return lines.at(-1)?.trim() || `ferret-video exited with ${r.code}`
}

/** 新しい順の比較（同じ時刻ならフォルダ名の逆順＝日付の新しい順） */
export function compareVideos(a: VideoEntry, b: VideoEntry): number {
  return b.updatedAt - a.updatedAt || b.name.localeCompare(a.name)
}

/**
 * フォルダの変化（fs:changed の相対パス）のうち、動画の一覧を読み直すものか:
 * 直下のフォルダの増減・動画の設定ファイル（ferret-video.json など）・手順の状態・投稿の結果・書き出した動画
 */
export function listChanged(paths: readonly string[]): boolean {
  return paths.some((raw) => {
    const parts = raw.replace(/\\/g, '/').split('/').filter(Boolean)
    const [top, second, third] = parts
    if (!top || top.startsWith('.')) return false
    if (parts.length === 1) return true
    if (parts.length === 2) return /^(ferret-video|solocut|timeline|publish)\.json$/.test(second!) || second === 'renders'
    if ((second === '.ferret-video' || second === '.solocut') && parts.length === 3) return /^(status|publish-result)\.json$/.test(third!)
    return second === 'renders' && /\.(mp4|mov|webm)$/i.test(parts.at(-1)!)
  })
}
