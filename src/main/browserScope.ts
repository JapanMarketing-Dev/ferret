import { createHash } from 'node:crypto'

/**
 * 内蔵ブラウザを browser-use で動かす口（browserCdp.ts）の、プロジェクトの範囲。
 * ターミナルには、そのターミナルのプロジェクトの印を付けた URL（/<合言葉>/p/<scope>）を渡し、
 * そのプロジェクトのタブの組だけを動かす（画面に出していないプロジェクトでも並行して動かせる。別のプロジェクトのタブは見せない）。
 * index.ts が起動時に読むので、重い依存（ws など）を持たない
 */

/** プロジェクトの id から URL に入れる印（そのまま使えなければ短い要約）。プロジェクトが無ければ null */
export function cdpScopeOf(projectId: string | null | undefined): string | null {
  if (!projectId) return null
  return isCdpScope(projectId) ? projectId : `h${createHash('sha256').update(projectId).digest('hex').slice(0, 24)}`
}

/** ターミナルのプロジェクトが Ferret から外された（もう無い）ときに Agent へ返す理由（プロジェクトの名前は出さない） */
export const CDP_UNKNOWN_PROJECT_ERROR = "This terminal's project is no longer registered in Ferret, so Ferret's built-in browser cannot be used from it. Open a new terminal in a registered project, or use your own browser instead."

/** URL に入れるプロジェクトの印（英数字・_・-、64 字まで） */
export function isCdpScope(scope: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(scope)
}

/** 合言葉のあとの道（/p/<scope>/...）から、プロジェクトの印と残りの道を分ける */
export function splitScope(path: string): { scope: string | null; path: string } {
  const m = /^\/p\/([^/]+)(\/.*)?$/.exec(path)
  if (!m || !isCdpScope(m[1]!)) return { scope: null, path }
  return { scope: m[1]!, path: m[2] || '/' }
}
