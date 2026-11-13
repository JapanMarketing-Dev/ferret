/**
 * ⌘P のクイックオープンの絞り込み（純粋関数。IO なし）。
 *
 * Orca由来: src/shared/quick-open-path-search.ts（MIT）
 * 文字を順に拾うあいまい一致で、点数は小さいほど良い。
 *   - 一致した文字の間の飛びを足す
 *   - `/` `.` `-` の直後で一致したら 5 引く（単語の頭）
 *   - ファイル名に問い合わせがそのまま含まれていれば 100 引く
 * 上位 limit 件だけを並べたまま持つ（Orca のヒープと同じ考え。全件の並べ替えはしない）。
 */

export const QUICK_OPEN_RESULT_LIMIT = 50

interface IndexedFile {
  path: string
  lowerPath: string
  lowerFilename: string
  inputIndex: number
}

interface QuickOpenResult {
  path: string
  score: number
}

function normalizeQuery(query: string): string {
  return query.trim().replace(/\\/g, '/').toLowerCase()
}

function prepare(path: string, inputIndex: number): IndexedFile {
  const searchPath = path.replace(/\\/g, '/')
  const lastSlash = searchPath.lastIndexOf('/')
  return {
    path,
    lowerPath: searchPath.toLowerCase(),
    lowerFilename: searchPath.slice(lastSlash + 1).toLowerCase(),
    inputIndex
  }
}

/** 一致しなければ -1 */
function fuzzyScore(query: string, file: IndexedFile): number {
  let score = 0
  let lastMatchIdx = -1
  for (let qi = 0; qi < query.length; qi++) {
    const next = lastMatchIdx + 1
    const ti = file.lowerPath[next] === query[qi] ? next : file.lowerPath.indexOf(query[qi]!, next + 1)
    if (ti === -1) return -1
    score += lastMatchIdx === -1 ? 0 : ti - lastMatchIdx - 1
    const before = file.lowerPath[ti - 1]
    if (ti > 0 && (before === '/' || before === '.' || before === '-')) score -= 5
    lastMatchIdx = ti
  }
  if (file.lowerFilename.includes(query)) score -= 100
  return score
}

/** パスを短い方・名前順で並べる（同点のときの順） */
function compareNames(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0)
}

/** 絞り込み用に下ごしらえした一覧。打鍵のたびに小文字のパスを作り直さないよう、一覧ごとに1回だけ作る */
export type PreparedQuickOpenFiles = readonly IndexedFile[]

export function prepareQuickOpenFiles(files: readonly string[]): PreparedQuickOpenFiles {
  return files.map(prepare)
}

type Ranked = QuickOpenResult & { inputIndex: number }

function compareRanked(a: Ranked, b: Ranked): number {
  return a.score - b.score || compareNames(a.path, b.path) || a.inputIndex - b.inputIndex
}

/**
 * 下ごしらえした一覧から、問い合わせに合うものを良い順に limit 件。
 * 全件を並べ替えず、上位 limit 件だけを並べたまま持つ（数十万件で1文字だけ打ったときも重くしない）
 */
export function rankPreparedQuickOpenFiles(
  query: string,
  files: PreparedQuickOpenFiles,
  limit = QUICK_OPEN_RESULT_LIMIT
): QuickOpenResult[] {
  if (limit <= 0) return []
  const normalized = normalizeQuery(query)
  if (!normalized) return files.slice(0, limit).map(({ path }) => ({ path, score: 0 }))
  const top: Ranked[] = []
  for (const file of files) {
    const score = fuzzyScore(normalized, file)
    if (score === -1) continue
    const item: Ranked = { path: file.path, score, inputIndex: file.inputIndex }
    if (top.length >= limit && compareRanked(item, top[top.length - 1]!) >= 0) continue
    // 並びを保ったまま差し込む位置（二分探索）
    let lo = 0
    let hi = top.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (compareRanked(top[mid]!, item) <= 0) lo = mid + 1
      else hi = mid
    }
    top.splice(lo, 0, item)
    if (top.length > limit) top.pop()
  }
  return top.map(({ path, score }) => ({ path, score }))
}

/**
 * 問い合わせに合うファイルを良い順に返す。空の問い合わせなら先頭から limit 件。
 */
export function rankQuickOpenFiles(
  query: string,
  files: readonly string[],
  limit = QUICK_OPEN_RESULT_LIMIT
): QuickOpenResult[] {
  if (limit <= 0) return []
  if (!normalizeQuery(query)) return files.slice(0, limit).map((path) => ({ path, score: 0 }))
  return rankPreparedQuickOpenFiles(query, prepareQuickOpenFiles(files), limit)
}

/**
 * 問い合わせが一致した文字の位置（強調表示用）。rankQuickOpenFiles と同じ拾い方をする。
 * 一致しなければ空配列。
 */
export function quickOpenMatchIndices(query: string, text: string): number[] {
  const normalized = normalizeQuery(query)
  if (!normalized) return []
  const lower = text.replace(/\\/g, '/').toLowerCase()
  const out: number[] = []
  let last = -1
  for (const ch of normalized) {
    const next = last + 1
    const at = lower[next] === ch ? next : lower.indexOf(ch, next + 1)
    if (at === -1) return []
    out.push(at)
    last = at
  }
  return out
}
