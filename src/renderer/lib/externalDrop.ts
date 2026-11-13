import type { DroppedEntry } from '@shared/externalDrop'

/**
 * 外（Finder・デスクトップ・エクスプローラー）からのファイル・フォルダのドロップ。
 * タブ・ペイン・パネルの並べ替えのドラッグ（独自のデータの種類だけを運ぶ）と区別するため、
 * DataTransfer に 'Files' があるときだけ外からのドロップとして扱う。
 */
export function hasExternalFiles(dataTransfer: DataTransfer | null | undefined): boolean {
  return !!dataTransfer && Array.from(dataTransfer.types ?? []).includes('Files')
}

/** 落とされたものの実パスを main で確かめて返す（無いもの・読めないものは入らない） */
export async function readDrop(dataTransfer: DataTransfer): Promise<DroppedEntry[]> {
  const files = Array.from(dataTransfer.files ?? [])
  if (files.length === 0 || typeof window.ade.inspectDrop !== 'function') return []
  return window.ade.inspectDrop(files)
}

/** 名前だけ（トーストの文言に使う） */
export function droppedName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * エディタの領域へ落としたものの振り分け（App.tsx）。どれを開き、どれをコピーしてから開くか。
 * プロジェクトの外のファイルは、プロジェクトの根へコピー（fs:import。同じ名前があれば「名前 copy」）してから開く。
 * ファイルツリーへ落としたときと同じく、元のファイルは読むだけで変えない（読み取り専用で外のファイルを開く仕組みは無いので、取り込んで開く）
 */
export interface EditorDropPlan {
  /** プロジェクトの中のファイル（相対パス）。エディタ・ビューアで開く */
  open: string[]
  /** プロジェクトの外のファイル（絶対パス）。プロジェクトの根へコピーしてから開く */
  copy: string[]
  /** プロジェクトとして追加して開くフォルダ（ファイルが1つも無いときの、いちばん初めの1つ） */
  folder: string | null
  /** 読み取れたものが1つも無い */
  unreadable: boolean
}

export function planEditorDrop(entries: readonly DroppedEntry[]): EditorDropPlan {
  const files = entries.filter((entry) => entry.kind === 'file')
  const open = files.flatMap((entry) => (entry.relPath ? [entry.relPath] : []))
  const copy = files.flatMap((entry) => (entry.relPath ? [] : [entry.path]))
  const folder = files.length === 0 ? entries.find((entry) => entry.kind === 'dir')?.path ?? null : null
  return { open, copy, folder, unreadable: entries.length === 0 }
}
