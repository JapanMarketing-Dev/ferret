/**
 * ビジネスのフォルダ（開いているプロジェクトのフォルダ）の中だけを読み書きする。
 *
 * - パスは renderer から受け取らない。ここが受け取るのは「ビジネスのフォルダからの相対の名前」だけで、
 *   各段が `.`・`..`・区切り文字・NUL を含めば断る（`../x`・`H01/../../` のような ID を通さない）
 * - 読み書きの前に、ビジネスのフォルダから先の今ある階層にリンク（ジャンクション）が無く、実体が中にあることを確かめる
 *   （sessions/containment.ts の assertContained。記録のフォルダがリンクなら読まない・書かない）
 * - 書き込みは一時ファイルに書いてから置き換える（containment.ts の writeFileNoFollow。末端のリンクはたどらない）
 * - 読み込みは上限のバイト数まで（boundedFile.ts）。フォルダの一覧は件数に上限を付ける
 * - 失敗は、英語の文とパスを画面に出さないよう日本語の UserFacingError にする
 */
import { lstat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { readDirEntries } from '../dirEntries'
import path from 'node:path'
import { UserFacingError, isUserFacingError } from '@shared/errors'
import { FileTooLargeError, NotRegularFileError } from '../boundedFile'
import { OutsideProjectError } from '../pinnedDir'
import {
  UnsafeStoragePathError,
  appendFileNoFollow,
  assertContained,
  mkdirContained,
  readFileNoFollow,
  removeContained,
  renameContained,
  writeFileNoFollow,
  writeNewFileContained
} from '../sessions/containment'

/** 1つのフォルダから読むファイルの数の上限 */
export const MAX_DIR_ENTRIES = 2000
/** newest で名前を見る数の上限（それより多いフォルダは途中までで決める） */
export const MAX_SCAN_ENTRIES = 20_000

export const MESSAGES = {
  link: 'フォルダの中にリンクがあるため、読み書きしません。リンクを普通のフォルダ・ファイルに置き換えてください。',
  badName: 'ファイル名が正しくありません。',
  tooLarge: 'ファイルが大きすぎるため読みません。',
  notFile: '普通のファイルではないため読みません。',
  noPermission: 'ファイルに書き込む権限がありません。',
  noSpace: 'ディスクの空きが足りないため保存できません。',
  missing: 'ファイルが見つかりません。',
  failed: 'ファイルを読み書きできませんでした。'
} as const

/** 相対の名前（区切りは /）を検査して段に分ける。使えない名前なら UserFacingError */
export function safeSegments(rel: string): string[] {
  if (typeof rel !== 'string' || !rel || rel.length > 512) throw new UserFacingError(MESSAGES.badName)
  const parts = rel.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('\\') || part.includes('\0') || part.includes(':')) throw new UserFacingError(MESSAGES.badName)
  }
  return parts
}

/** 例外を、パスを含まない日本語の UserFacingError にする（ENOENT は呼び出し側が見分けられるよう code を残す） */
export function toBusinessError(err: unknown): Error {
  if (isUserFacingError(err)) return err as Error
  if (err instanceof UnsafeStoragePathError || err instanceof OutsideProjectError) return new UserFacingError(MESSAGES.link, { cause: err })
  if (err instanceof FileTooLargeError) return new UserFacingError(MESSAGES.tooLarge, { cause: err })
  if (err instanceof NotRegularFileError) return new UserFacingError(MESSAGES.notFile, { cause: err })
  const code = (err as { code?: unknown } | null)?.code
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return new UserFacingError(MESSAGES.noPermission, { cause: err })
  if (code === 'ENOSPC') return new UserFacingError(MESSAGES.noSpace, { cause: err })
  if (code === 'ENOENT' || code === 'ENOTDIR') return Object.assign(new UserFacingError(MESSAGES.missing, { cause: err }), { code })
  if (code === 'ELOOP') return new UserFacingError(MESSAGES.link, { cause: err })
  return new UserFacingError(MESSAGES.failed, { cause: err })
}

export function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export type DirEntry = { name: string; kind: 'file' | 'dir' | 'link' | 'other' }

/** ビジネスのフォルダ1つの中の読み書き */
export class BusinessFs {
  constructor(readonly root: string) {}

  /** 相対の名前の絶対パス（検査つき） */
  abs(rel: string): string {
    return path.join(this.root, ...safeSegments(rel))
  }

  /** 今ある階層にリンクが無いことを確かめる */
  check(rel: string): string {
    const target = this.abs(rel)
    try {
      assertContained(this.root, target)
    } catch (err) {
      throw toBusinessError(err)
    }
    return target
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (err) {
      throw toBusinessError(err)
    }
  }

  /** 何があるか（無ければ null）。リンクはたどらない */
  async kind(rel: string): Promise<DirEntry['kind'] | null> {
    const target = this.abs(rel)
    // 途中の段だけを確かめる（末端のリンクは 'link' として返す）
    try {
      assertContained(this.root, path.dirname(target))
    } catch (err) {
      throw toBusinessError(err)
    }
    const st = await lstat(target).catch((err: unknown) => {
      if (isMissing(err)) return null
      throw toBusinessError(err)
    })
    if (!st) return null
    return st.isSymbolicLink() ? 'link' : st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other'
  }

  async exists(rel: string): Promise<boolean> {
    return (await this.kind(rel)) !== null
  }

  /** 上限までの文字列を読む。無ければ null */
  async readText(rel: string, maxBytes: number): Promise<string | null> {
    const target = this.check(rel)
    try {
      return await readFileNoFollow(target, 'utf8', { maxBytes })
    } catch (err) {
      if (isMissing(err)) return null
      throw toBusinessError(err)
    }
  }

  /** フォルダを作る（途中の段も）。リンクの段があれば断る */
  async mkdir(rel: string): Promise<void> {
    const target = this.check(rel)
    await this.run(() => mkdirContained(target, { root: this.root }))
  }

  /** 置き換えて書く（一時ファイル → rename）。親フォルダが無ければ作る */
  async write(rel: string, data: string | Uint8Array): Promise<void> {
    const target = this.check(rel)
    const parent = path.dirname(target)
    if (parent !== this.root) await this.run(() => mkdirContained(parent, { root: this.root }))
    this.check(rel)
    await this.run(() => writeFileNoFollow(target, data))
  }

  /** まだ無いときだけ作る。作ったら true、既にあれば false（中身は変えない） */
  async writeIfMissing(rel: string, data: string | Uint8Array): Promise<boolean> {
    const target = this.check(rel)
    const parent = path.dirname(target)
    if (parent !== this.root) await this.run(() => mkdirContained(parent, { root: this.root }))
    this.check(rel)
    try {
      await writeNewFileContained(target, data)
      return true
    } catch (err) {
      if ((err as { code?: unknown }).code === 'EEXIST') return false
      throw toBusinessError(err)
    }
  }

  /** 追記する（無ければ作る）。末端がリンク・ハードリンクなら断る */
  async append(rel: string, data: string): Promise<void> {
    const target = this.check(rel)
    const parent = path.dirname(target)
    if (parent !== this.root) await this.run(() => mkdirContained(parent, { root: this.root }))
    await this.run(() => appendFileNoFollow(target, data))
  }

  /** 動かす（上書きしない） */
  async move(fromRel: string, toRel: string): Promise<void> {
    const from = this.check(fromRel)
    const to = this.check(toRel)
    const parent = path.dirname(to)
    if (parent !== this.root) await this.run(() => mkdirContained(parent, { root: this.root }))
    await this.run(() => renameContained(from, to, { root: this.root }))
  }

  /** ファイルを消す（無ければ何もしない） */
  async remove(rel: string): Promise<void> {
    const target = this.check(rel)
    await this.run(() => removeContained(this.root, target))
  }

  /** フォルダの実体のパス（無い・普通のフォルダでなければ null。フォルダ自体がリンクなら UserFacingError） */
  private async dirPath(rel: string): Promise<string | null> {
    const k = await this.kind(rel)
    if (k === null) return null
    if (k === 'link') throw new UserFacingError(MESSAGES.link)
    if (k !== 'dir') return null
    return this.check(rel)
  }

  /**
   * フォルダの中の名前（上限つき）。macOS・Linux は少しずつ読み、上限に達したら読むのをやめる（dirEntries.ts。全部を読み込まない）。
   * 返すものは名前順。フォルダが無ければ空。フォルダ自体がリンクなら UserFacingError。truncated は上限で打ち切ったか
   */
  async list(rel: string, limit = MAX_DIR_ENTRIES): Promise<{ entries: DirEntry[]; truncated: boolean }> {
    const target = await this.dirPath(rel)
    if (!target) return { entries: [], truncated: false }
    const read = await this.run(() => readDirEntries(target, limit))
    const entries = read.entries.map(toEntry)
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    return { entries, truncated: read.truncated }
  }

  /**
   * 名前（key で比べる）の大きい順に n 件（名前に日時が入ったファイルの「新しい順」）。
   * 見るのは名前だけで maxScan 件まで。中身は読まない
   */
  async newest(rel: string, n: number, filter: (e: DirEntry) => boolean, key: (name: string) => string = (x) => x, maxScan = MAX_SCAN_ENTRIES): Promise<string[]> {
    const target = await this.dirPath(rel)
    if (!target) return []
    const read = await this.run(() => readDirEntries(target, maxScan))
    return read.entries.map(toEntry).filter(filter).map((e) => e.name)
      .sort((a, b) => { const ka = key(a); const kb = key(b); return ka < kb ? 1 : ka > kb ? -1 : 0 })
      .slice(0, n)
  }
}

function toEntry(d: Dirent): DirEntry {
  return { name: d.name, kind: d.isSymbolicLink() ? 'link' : d.isFile() ? 'file' : d.isDirectory() ? 'dir' : 'other' }
}
