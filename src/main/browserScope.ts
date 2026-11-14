import { createHash } from 'node:crypto'

/**
 * 内蔵ブラウザを browser-use で動かす口（browserCdp.ts）の、プロジェクトの範囲。
 * ターミナルには、そのターミナルのプロジェクトの印を付けた URL（/<合言葉>/p/<scope>）を渡し、
 * いま開いているプロジェクトと違えば動かさない（プロジェクトをまたいで、見ている別のプロジェクトの内蔵ブラウザを開かない）。
 * index.ts が起動時に読むので、重い依存（ws など）を持たない
 */

/** プロジェクトの id から URL に入れる印（そのまま使えなければ短い要約）。プロジェクトが無ければ null */
export function cdpScopeOf(projectId: string | null | undefined): string | null {
  if (!projectId) return null
  return isCdpScope(projectId) ? projectId : `h${createHash('sha256').update(projectId).digest('hex').slice(0, 24)}`
}

/** 別のプロジェクトを開いているときに Agent へ返す理由（プロジェクトの名前は出さない） */
export const CDP_OTHER_PROJECT_ERROR = "Ferret's built-in browser is showing another project right now, so it cannot be used from this project's terminal (Ferret never drives the browser across projects). Ask the person to open this project in Ferret first, or use your own browser instead."

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
