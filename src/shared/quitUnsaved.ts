/**
 * 終了するときの「未保存のファイルがあります」の確認（main のネイティブのダイアログ）の、純粋な部分。
 *
 * - どのプロジェクトのファイルかを、登録済みのプロジェクトのフォルダから決めて「reply — docs/a.md」の形で出す
 *   （プロジェクトが複数あると、絶対パスだけではどれのことか分からない）
 * - ボタンの並び（保存して終了・保存せずに終了・プロジェクトを開く・キャンセル）と、押された番号から操作への対応
 * - 「プロジェクトを開く」で開く先（一覧の先頭の、プロジェクトに属するファイル）
 *
 * 文言は呼ぶ側（main）が i18n で付ける。ここは Electron にも Node にも触らない（単体テストする）。
 */

/** renderer が editor:unsaved で知らせる、未保存のファイル。root は開いたときのプロジェクトのフォルダ、path はそこからの相対パス */
export interface UnsavedFileRef {
  root: string
  path: string
}

/** editor:quitSave の、ファイルごとの結果。書けなければ error に理由 */
export interface QuitSaveOutcome extends UnsavedFileRef {
  ok: boolean
  error?: string
}

/** editor:revealUnsaved。error があれば開かずに知らせるだけ（録画中など） */
export interface UnsavedReveal extends UnsavedFileRef {
  error?: string
}

/** 照らし合わせに使うプロジェクトの形（settings の Project の一部） */
export interface QuitProjectRef {
  id: string
  name: string
  folderPath: string
}

export interface UnsavedQuitItem extends UnsavedFileRef {
  /** 属するプロジェクト。どれにも入らなければ null */
  projectId: string | null
  projectName: string | null
  /** プロジェクトからの相対パス（`/` 区切り）。プロジェクトが無ければ絶対パス */
  relativePath: string
  /** 一覧に出す1行（「reply — docs/development.md」） */
  label: string
}

export type QuitAction = 'save' | 'discard' | 'openProject' | 'cancel'

export interface UnsavedQuitPlan {
  items: UnsavedQuitItem[]
  /** ダイアログの本文に並べる行。上限を超えた分は数えて最後に「ほか N 件」を出す（その数） */
  listed: UnsavedQuitItem[]
  more: number
  /** ボタンの並び（左から／上から）。先頭が既定 */
  actions: QuitAction[]
  defaultId: number
  /** Esc・閉じるボタンで選ばれる番号（キャンセル） */
  cancelId: number
  /** 「プロジェクトを開く」で開くファイル。プロジェクトに属するファイルが無ければ null（ボタンも出さない） */
  openTarget: UnsavedQuitItem | null
}

/** 一覧に出す行の上限 */
export const UNSAVED_LIST_LIMIT = 8

/** 比べるための形。区切りを `/` にそろえ、末尾の区切りを落とす。Windows のドライブ名で始まるなら大文字小文字を区別しない */
function comparable(path: string): string {
  const slashed = path.replace(/\\/g, '/')
  const trimmed = slashed.length > 1 ? slashed.replace(/\/+$/, '') : slashed
  return /^[a-zA-Z]:/.test(trimmed) ? trimmed.toLowerCase() : trimmed
}

function joinPath(root: string, path: string): string {
  return `${root.replace(/[\\/]+$/, '')}/${path.replace(/^[\\/]+/, '')}`
}

/** ファイル（絶対パス）を含むプロジェクトのうち、いちばん深いもの。相対パスも返す */
export function projectOfFile(file: string, projects: readonly QuitProjectRef[]): { project: QuitProjectRef; relativePath: string } | null {
  const target = comparable(file)
  const display = file.replace(/\\/g, '/')
  let best: { project: QuitProjectRef; relativePath: string; depth: number } | null = null
  for (const project of projects) {
    if (!project.folderPath) continue
    const folder = comparable(project.folderPath)
    if (!target.startsWith(`${folder}/`)) continue
    if (best && best.depth >= folder.length) continue
    best = { project, relativePath: display.slice(folder.length + 1), depth: folder.length }
  }
  return best ? { project: best.project, relativePath: best.relativePath } : null
}

/** 一覧の1行 */
export function describeUnsavedFile(file: UnsavedFileRef, projects: readonly QuitProjectRef[]): UnsavedQuitItem {
  const absolute = joinPath(file.root, file.path)
  const found = projectOfFile(absolute, projects)
  if (!found) return { ...file, projectId: null, projectName: null, relativePath: absolute, label: absolute }
  return {
    ...file,
    projectId: found.project.id,
    projectName: found.project.name,
    relativePath: found.relativePath,
    label: `${found.project.name} — ${found.relativePath}`
  }
}

/** ボタンの並び。保存して終了が既定、Esc はキャンセル。開く先が無ければ「プロジェクトを開く」は出さない */
export function quitActions(canOpenProject: boolean): QuitAction[] {
  return canOpenProject ? ['save', 'discard', 'openProject', 'cancel'] : ['save', 'discard', 'cancel']
}

/** 押された番号から操作へ。範囲の外（ダイアログが閉じられた等）はキャンセル */
export function quitActionFor(response: number, actions: readonly QuitAction[]): QuitAction {
  return actions[response] ?? 'cancel'
}

/**
 * 終了の確認の中身を決める。並びはプロジェクトごとにまとめ（最初に出てきた順）、その中は知らされた順。
 * 「プロジェクトを開く」は、並べた先頭の、プロジェクトに属するファイルのプロジェクトを開く。
 */
export function planUnsavedQuit(files: readonly UnsavedFileRef[], projects: readonly QuitProjectRef[], limit = UNSAVED_LIST_LIMIT): UnsavedQuitPlan {
  const described = files.map((file) => describeUnsavedFile(file, projects))
  const order: string[] = []
  const groups = new Map<string, UnsavedQuitItem[]>()
  for (const item of described) {
    const key = item.projectId ?? ''
    if (!groups.has(key)) { groups.set(key, []); order.push(key) }
    groups.get(key)!.push(item)
  }
  // プロジェクトに属さないファイルは最後へ
  const keys = [...order.filter((k) => k !== ''), ...order.filter((k) => k === '')]
  const items = keys.flatMap((k) => groups.get(k) ?? [])
  const max = Math.max(1, limit)
  const listed = items.slice(0, max)
  const openTarget = items.find((item) => item.projectId !== null) ?? null
  const actions = quitActions(openTarget !== null)
  return { items, listed, more: items.length - listed.length, actions, defaultId: 0, cancelId: actions.indexOf('cancel'), openTarget }
}

/** 同じファイルかを見る鍵（root と相対パス） */
export function unsavedKey(file: UnsavedFileRef): string {
  return `${comparable(file.root)}\n${file.path}`
}

/** renderer から来た一覧を確かめる（文字列の root と path だけ。上限を超えた分は捨てる） */
export function sanitizeUnsavedRefs(value: unknown, max = 1000): UnsavedFileRef[] {
  if (!Array.isArray(value)) return []
  const out: UnsavedFileRef[] = []
  for (const entry of value.slice(0, max)) {
    if (!entry || typeof entry !== 'object') continue
    const { root, path } = entry as { root?: unknown; path?: unknown }
    if (typeof root !== 'string' || typeof path !== 'string' || !root || !path) continue
    out.push({ root, path })
  }
  return out
}

/**
 * 「保存して終了」で renderer が返す、ファイルの中身。
 * saved は renderer が自分で書き終えたもの（Office の文書は fs:writeOffice で書く）。中身は送らず、書けた扱いにだけする
 */
export type QuitSaveContent = UnsavedFileRef & { content: string }
export type QuitSaveEntry = QuitSaveContent | (UnsavedFileRef & { saved: true })

export type QuitSaveRejection = 'unexpected' | 'tooLarge'

export interface ScreenedQuitSave {
  /** 書いてよいもの（確認で示した未保存のファイルで、上限の内） */
  accepted: QuitSaveContent[]
  /** 書かないもの。unexpected は確認で示していないファイル（renderer が勝手に足したもの） */
  rejected: Array<UnsavedFileRef & { reason: QuitSaveRejection }>
  /** 確認で示したのに中身が届かなかったもの（保存できていない＝終了しない） */
  missing: UnsavedFileRef[]
  /** renderer が書き終えたと返したもの（確認で示したものだけ） */
  saved?: UnsavedFileRef[]
}

/**
 * renderer から届いた中身をふるいにかける。書いてよいのは、確認のダイアログで示した未保存のファイルだけ。
 * 1ファイルの上限（maxBytes）と、全体の上限（maxTotalBytes）を超えたものは書かない。同じファイルが2度来たら先のものだけ。
 * プロジェクトのフォルダが登録済みか・パスがその中かは、書くとき main が確かめる（files.ts の writeTextFile）。
 */
export function screenQuitSaveEntries(
  value: unknown,
  expected: readonly UnsavedFileRef[],
  limits: { maxBytes: number; maxTotalBytes: number; byteLength: (text: string) => number }
): ScreenedQuitSave {
  const wanted = new Map(expected.map((file) => [unsavedKey(file), file]))
  const seen = new Set<string>()
  const accepted: QuitSaveContent[] = []
  const rejected: ScreenedQuitSave['rejected'] = []
  const saved: UnsavedFileRef[] = []
  let total = 0
  const list = Array.isArray(value) ? value.slice(0, Math.max(expected.length, 1) * 2) : []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const { root, path, content, saved: done } = entry as { root?: unknown; path?: unknown; content?: unknown; saved?: unknown }
    if (typeof root !== 'string' || typeof path !== 'string') continue
    if (done === true && content === undefined) {
      const key = unsavedKey({ root, path })
      const file = wanted.get(key)
      if (seen.has(key) || !file) continue
      seen.add(key)
      saved.push(file)
      continue
    }
    if (typeof content !== 'string') continue
    const key = unsavedKey({ root, path })
    if (seen.has(key)) continue
    seen.add(key)
    const file = wanted.get(key)
    if (!file) { rejected.push({ root, path, reason: 'unexpected' }); continue }
    const bytes = limits.byteLength(content)
    if (bytes > limits.maxBytes || total + bytes > limits.maxTotalBytes) { rejected.push({ ...file, reason: 'tooLarge' }); continue }
    total += bytes
    accepted.push({ ...file, content })
  }
  const missing = expected.filter((file) => !seen.has(unsavedKey(file)))
  return saved.length > 0 ? { accepted, rejected, missing, saved } : { accepted, rejected, missing }
}
