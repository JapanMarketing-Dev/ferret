/**
 * ビジュアルレビュー・価値ユースケースの「場所」を、Claude Code・Codex などのターミナルへ貼れる文にする（コピーのボタン用）。
 * - 全体: 文書のフォルダ（.ferret/visual-review/ など）の絶対パス
 * - 文書1つ: その JSON の絶対パス
 * - 個別（価値・手順・画面・変更）: JSON のパスに、JSON の中の位置（values[1].flow[2] など）と名前を足す
 * Agent はそのファイルを開いて位置をそのまま読める。パスの区切りはプロジェクトのパスに合わせる（Windows は \）
 */

/** プロジェクトのフォルダ（絶対パス）と、その中の相対パス（/ 区切り）をつなぐ */
export function joinProjectPath(folderPath: string, rel: string): string {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(folderPath) && !folderPath.includes('/')
  const sep = windows ? '\\' : '/'
  const base = folderPath.replace(/[\\/]+$/, '')
  const tail = rel.split('/').filter(Boolean).join(sep)
  if (!base) return folderPath ? `${sep}${tail}` : tail // ルート（/）は区切りを重ねない
  return tail ? `${base}${sep}${tail}` : base
}

/** 文書のフォルダの絶対パス（全体） */
export function reviewDirPath(folderPath: string, dirRel: string): string {
  return joinProjectPath(folderPath, dirRel)
}

/** 文書1つの JSON の絶対パス */
export function reviewDocPath(folderPath: string, dirRel: string, id: string): string {
  return joinProjectPath(folderPath, `${dirRel}/${id}.json`)
}

/** 名前を1行にして短くする（貼ったときに崩れないように） */
function label(name: string | undefined): string {
  const line = (name ?? '').replace(/\s+/g, ' ').trim()
  if (!line) return ''
  const short = line.length > 80 ? `${line.slice(0, 79)}…` : line
  return ` ${JSON.stringify(short)}`
}

/** 文書の中の位置を足した参照。pointer は JSON の中の位置（values[1].flow[2] など） */
export function reviewItemRef(docPath: string, pointer: string, name?: string, id?: string): string {
  return `${docPath} → ${pointer}${id ? ` (id: ${id})` : ''}${label(name)}`
}

/** 価値ユースケースの価値1つ */
export function valueRef(docPath: string, valueIndex: number, value: { id?: string; name?: string }): string {
  return reviewItemRef(docPath, `values[${valueIndex}]`, value.name, value.id)
}

/** 価値ユースケースの手順1つ */
export function valueStepRef(docPath: string, valueIndex: number, stepIndex: number, value: { name?: string }, step: { screen?: string; step?: number }): string {
  const name = [value.name, step.screen || (step.step !== undefined ? `#${step.step}` : '')].filter(Boolean).join(' / ')
  return reviewItemRef(docPath, `values[${valueIndex}].flow[${stepIndex}]`, name)
}

/** ビジュアルレビューの画面1つ */
export function planScreenRef(docPath: string, screenIndex: number, caption?: string): string {
  return reviewItemRef(docPath, `screens[${screenIndex}]`, caption)
}

/** ビジュアルレビューの変更1つ（n は画面をまたいだ通し番号。画面の上の数字と同じ） */
export function planChangeRef(docPath: string, screenIndex: number, annotationIndex: number, n: number, changeLabel?: string): string {
  return reviewItemRef(docPath, `screens[${screenIndex}].annotations[${annotationIndex}]`, `#${n}${changeLabel ? ` ${changeLabel}` : ''}`)
}
