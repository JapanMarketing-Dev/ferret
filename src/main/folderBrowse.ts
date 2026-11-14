import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'
import { isValidNewFolderName, type FolderListing } from '@shared/remoteFiles'

/**
 * 「新しいプロジェクト」の場所選び（この PC）。フォルダだけを並べ、. で始まるものは出さない。
 * renderer から任意のフォルダをプロジェクトにさせないよう、ここで一覧に出した場所と、ここで作ったフォルダだけを覚えておき、
 * 登録はそのどれかに限る（isBrowsedFolder）。
 */

const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
/** 一覧に出した場所・作ったフォルダ（この起動の間だけ） */
const browsed = new Set<string>()

export function isBrowsedFolder(path: string): boolean {
  return typeof path === 'string' && browsed.has(resolve(path))
}

/** テスト用 */
export function forgetBrowsedFolders(): void {
  browsed.clear()
}

/** 場所の一覧。path が null ならホーム */
export async function browseLocalFolders(path: string | null, home: string = homedir()): Promise<FolderListing> {
  const target = resolve(path === null ? home : path)
  if (path !== null && (typeof path !== 'string' || !isAbsolute(path))) throw new UserFacingError(t('newProject.errors.notFolder'))
  const info = await stat(target).catch(() => null)
  if (!info?.isDirectory()) throw new UserFacingError(t('newProject.errors.notFolder'))
  const folders: string[] = []
  for (const dirent of await readdir(target, { withFileTypes: true })) {
    if (dirent.name.startsWith('.')) continue
    let dir = dirent.isDirectory()
    if (!dir && dirent.isSymbolicLink()) dir = (await stat(join(target, dirent.name)).catch(() => null))?.isDirectory() ?? false
    if (dir) folders.push(dirent.name)
  }
  folders.sort((a, b) => NAME_ORDER.compare(a, b))
  browsed.add(target)
  const parent = dirname(target)
  return { path: target, parent: parent === target ? null : parent, folders }
}

/** 一覧に出した場所の下にフォルダを作る。作ったフォルダの絶対パスを返す */
export async function createLocalFolder(parent: string, name: string): Promise<string> {
  if (!isBrowsedFolder(parent)) throw new UserFacingError(t('newProject.errors.notFolder'))
  if (!isValidNewFolderName(name)) throw new UserFacingError(t('newProject.errors.name'))
  const folder = join(resolve(parent), name.trim())
  try {
    await mkdir(folder)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new UserFacingError(t('newProject.errors.exists', { name: name.trim() }))
    throw err
  }
  browsed.add(folder)
  return folder
}
