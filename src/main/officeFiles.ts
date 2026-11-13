/**
 * Office の文書を開く・書く（fs:openOffice・fs:writeOffice）。
 *
 * 開く: .docx・.xlsx・.pptx はそのまま返す。古い形式・OpenDocument・RTF・iWork（.doc・.xls・.ppt・.odt・.key など）は
 *       LibreOffice で .docx・.xlsx・.pptx に変えて返す（officeConvert.ts）。拡張子が古い形式でも中身が OOXML の ZIP なら、
 *       変えずにそのまま返す（名前だけ .xls の .xlsx など）。
 * 書く: renderer が編集した OOXML の中身を受け取る。元が古い形式なら LibreOffice で元の形式へ戻してから書く。
 *       書くのは、一時ファイルに書いてから置き換える（途中で止まっても元のファイルが半端に壊れない）。
 *       一時ファイルは確かめた実体のフォルダに O_EXCL で作り（containedFile.ts）、元の権限をそろえてから rename する。
 * どちらも src/main/files.ts の resolveInside と containedFile.ts で、プロジェクトの外・外を指すリンクを断ってから触る。
 */
import { randomBytes } from 'node:crypto'
import { chmod, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { resolveInside } from './files'
import { assertStillInside, createContained, openContained } from './containedFile'
import { ConvertFailedError, OOXML_TARGETS, SofficeMissingError, type OfficeConverter } from './officeConvert'
import { MAX_OFFICE_BYTES, convertibleOfficeOf, extensionOf, officeKindOf, ooxmlKindFromNames, sniffContainer, type OfficeKind } from '@shared/office/kinds'
import { openZip } from '@shared/office/zip'
import type { OfficeOpenResult } from '@shared/office/open'
import type { FsWriteResult } from '@shared/files'
import { formatByteSize } from '@shared/fileViewer'
import { UserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'

/** 中身が OOXML の ZIP なら、その種類 */
export function ooxmlKindOf(bytes: Uint8Array): OfficeKind | null {
  if (sniffContainer(bytes.subarray(0, 8)) !== 'zip') return null
  try {
    return ooxmlKindFromNames(openZip(bytes).names())
  } catch {
    return null
  }
}

/** プロジェクトの中の普通のファイルを、上限までまるごと読む（開いた fd から。security-4 [5]） */
async function readContained(root: string, relPath: string): Promise<{ bytes: Uint8Array; size: number; mtimeMs: number; dev: number; ino: number } | { tooLarge: number }> {
  const file = await resolveInside(root, relPath)
  const handle = await openContained(root, file, 'read')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new UserFacingError(t('files.errors.notRegular'))
    if (info.size > MAX_OFFICE_BYTES) return { tooLarge: info.size }
    const buffer = Buffer.alloc(info.size)
    let read = 0
    while (read < buffer.length) {
      const { bytesRead } = await handle.read(buffer, read, buffer.length - read, read)
      if (bytesRead === 0) break
      read += bytesRead
    }
    return { bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, read), size: info.size, mtimeMs: info.mtimeMs, dev: info.dev, ino: info.ino }
  } finally {
    await handle.close()
  }
}

/** 文書を開く（変えられないときは理由を返す。例外は想定外のものだけ） */
export async function openOfficeDocument(root: string, relPath: string, converter: OfficeConverter): Promise<OfficeOpenResult> {
  const native = officeKindOf(relPath)
  const convertible = convertibleOfficeOf(relPath)
  if (!native && !convertible) return { ok: false, reason: 'unsupported', message: t('viewer.loadFailed') }
  const read = await readContained(root, relPath)
  if ('tooLarge' in read) {
    return { ok: false, reason: 'tooLarge', message: t('viewer.tooLargeToShow', { size: formatByteSize(read.tooLarge), limit: formatByteSize(MAX_OFFICE_BYTES) }) }
  }
  // 中身が OOXML なら、拡張子が何でもそのまま（名前だけ古い形式の .xlsx など）
  const inside = ooxmlKindOf(read.bytes)
  if (inside) return { ok: true, kind: inside, bytes: read.bytes, source: 'native', saveBack: 'native', mtimeMs: read.mtimeMs }
  // .xlsx なのに ZIP でない（中身が古い形式・HTML など）なら、変えて読むだけ（元の形式が分からないので書き戻さない）。
  // パスワード付きの OOXML（OLE の入れ物）は LibreOffice でも開けないので、変換の失敗として案内する
  const kind = native ?? convertible!.kind
  const saveBack = native ? 'none' : convertible!.exportFilter ? 'convert' : 'none'
  const inputExt = native ? guessInputExtension(read.bytes, kind) : extensionOf(relPath)
  try {
    const key = `${root}\n${relPath}\n${read.dev}:${read.ino}\n${read.size}\n${read.mtimeMs}`
    const bytes = await converter.convert(read.bytes, inputExt, OOXML_TARGETS[kind], key)
    if (ooxmlKindOf(bytes) !== kind) throw new ConvertFailedError('conversion produced an unexpected file')
    return { ok: true, kind, bytes, source: 'converted', saveBack, mtimeMs: read.mtimeMs }
  } catch (err) {
    if (err instanceof SofficeMissingError) return { ok: false, reason: 'noConverter', message: t('viewer.officeNoConverter') }
    if (err instanceof ConvertFailedError) return { ok: false, reason: 'convertFailed', message: t('viewer.officeConvertFailed') }
    throw err
  }
}

/** 拡張子が .docx などなのに中身が違うとき、LibreOffice に渡す拡張子（中身から見当を付ける。拡張子でも形式を推すため） */
export function guessInputExtension(bytes: Uint8Array, kind: OfficeKind): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 64)).trimStart().toLowerCase()
  if (head.startsWith('{\\rtf')) return '.rtf'
  if (head.startsWith('<')) return kind === 'xlsx' ? '.xml' : '.html'
  return kind === 'docx' ? '.doc' : kind === 'xlsx' ? '.xls' : '.ppt'
}

/**
 * 編集した OOXML の中身を書く。古い形式なら LibreOffice で元の形式へ戻してから書く。
 * 読むだけの形式（書き戻せない・中身が分からない）・中身が文書でないものは断る
 */
export async function writeOfficeDocument(root: string, relPath: string, data: unknown, converter: OfficeConverter): Promise<FsWriteResult> {
  if (!(data instanceof Uint8Array) || data.length === 0 || data.length > MAX_OFFICE_BYTES * 2) throw new UserFacingError(t('viewer.officeSaveBadContent'))
  const native = officeKindOf(relPath)
  const convertible = convertibleOfficeOf(relPath)
  if (!native && !convertible) throw new UserFacingError(t('viewer.officeReadOnly'))
  const kind = ooxmlKindOf(data)
  if (!kind) throw new UserFacingError(t('viewer.officeSaveBadContent'))
  const file = await resolveInside(root, relPath)
  // いまのファイルの中身の形（名前だけ古い形式の OOXML なら、そのまま書く）
  const current = await readContained(root, relPath)
  const currentKind = 'bytes' in current ? ooxmlKindOf(current.bytes) : null
  let output: Uint8Array
  if (native || currentKind) {
    const expected = currentKind ?? native
    if (kind !== expected) throw new UserFacingError(t('viewer.officeSaveBadContent'))
    if (native && !currentKind && 'bytes' in current && current.bytes.length > 0) throw new UserFacingError(t('viewer.officeReadOnly'))
    output = data
  } else {
    if (!convertible!.exportFilter || kind !== convertible!.kind) throw new UserFacingError(t('viewer.officeReadOnly'))
    try {
      output = await converter.convert(data, `.${kind}`, convertible!.exportFilter)
    } catch (err) {
      if (err instanceof SofficeMissingError) throw new UserFacingError(t('viewer.officeNoConverter'))
      if (err instanceof ConvertFailedError) throw new UserFacingError(t('viewer.officeSaveConvertFailed'))
      throw err
    }
  }
  return replaceContained(root, file, output)
}

/**
 * プロジェクトの中のファイルを、一時ファイルに書いてから置き換える。権限は元のファイルにそろえる。
 * リンクは、指している実体（プロジェクトの中）を置き換える（リンクそのものは残す）
 */
export async function replaceContained(root: string, file: string, data: Uint8Array): Promise<FsWriteResult> {
  const real = await assertStillInside(root, file)
  const original = await openContained(root, real, 'read')
  let mode: number
  try {
    const info = await original.stat()
    if (!info.isFile()) throw new UserFacingError(t('files.errors.notRegular'))
    mode = info.mode & 0o7777
  } finally {
    await original.close()
  }
  const tmp = join(dirname(real), `.${basename(real)}.${randomBytes(6).toString('hex')}.ferret-tmp`)
  const handle = await createContained(root, tmp)
  try {
    try {
      await handle.writeFile(data)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(tmp, mode)
    // 書いている間に、置き換える先がリンクに差し替えられていないか（外を指していないか）をもう一度見る
    await assertStillInside(root, real)
    await rename(tmp, real)
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined)
    throw err
  }
  const after = await openContained(root, real, 'read')
  try {
    return { mtimeMs: (await after.stat()).mtimeMs }
  } finally {
    await after.close()
  }
}
