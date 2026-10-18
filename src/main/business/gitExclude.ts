/**
 * 画面の写し（.business/captures/）とゴミ箱（.business/trash/）を git の管理から外す。
 * .gitignore は変えず、.git/info/exclude（コミットされない手元だけの除外）へ足す。
 *
 * 書くのは、ビジネスのフォルダの直下の `.git` がリンクでない普通のフォルダで、途中の段・末端にリンクが無く、
 * 末端にほかの名前（ハードリンク）が無いときだけ（sessions/gitexclude.ts の plainExclude と同じ決まり）。
 * worktree・submodule の `.git` ファイル（gitdir: の先）には書かない。書けないときは何もしない（エラーにしない）
 */
import { lstat } from 'node:fs/promises'
import type { BusinessFs } from './fsx'

/** git の除外に足す */
export const GIT_EXCLUDES = ['.business/captures/', '.business/trash/'] as const

const HEADER = '# Ferret が追記（画面の写しとゴミ箱を git の管理から外す）'
const EXCLUDE = '.git/info/exclude'

function has(text: string, entry: string): boolean {
  const bare = entry.replace(/\/$/, '')
  return text.split('\n').map((l) => l.trim()).some((l) => l === entry || l === bare || l === `/${entry}` || l === `/${bare}`)
}

/** entries・header はビジネスリサーチ（.research/sent/・.research/trash/）が差し替える */
export async function ensureBusinessGitExclude(fs: BusinessFs, entries: readonly string[] = GIT_EXCLUDES, header = HEADER): Promise<'added' | 'already' | 'no-git'> {
  try {
    if ((await fs.kind('.git')) !== 'dir') return 'no-git'
    const leafKind = await fs.kind(EXCLUDE)
    if (leafKind !== null && leafKind !== 'file') return 'no-git'
    if (leafKind === 'file' && (await lstat(fs.abs(EXCLUDE))).nlink > 1) return 'no-git'
    const current = await fs.readText(EXCLUDE, 1024 * 1024)
    const missing = entries.filter((e) => current === null || !has(current, e))
    if (missing.length === 0) return 'already'
    const sep = current && !current.endsWith('\n') ? '\n' : ''
    await fs.write(EXCLUDE, `${current ?? ''}${sep}${header}\n${missing.map((e) => `${e}\n`).join('')}`)
    return 'added'
  } catch {
    // リンク・権限・大きすぎる除外ファイル: 書かない（ビジネスの作成は続ける）
    return 'no-git'
  }
}
