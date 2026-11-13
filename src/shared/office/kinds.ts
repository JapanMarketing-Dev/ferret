/** Office の文書の種類の判定（main も読むので、変換の部品は含めない） */

export type OfficeKind = 'docx' | 'xlsx' | 'pptx'

const OFFICE_EXTENSIONS: Record<string, OfficeKind> = {
  '.docx': 'docx', '.docm': 'docx', '.dotx': 'docx', '.dotm': 'docx',
  '.xlsx': 'xlsx', '.xlsm': 'xlsx', '.xltx': 'xlsx', '.xltm': 'xlsx',
  '.pptx': 'pptx', '.pptm': 'pptx', '.ppsx': 'pptx', '.ppsm': 'pptx', '.potx': 'pptx', '.potm': 'pptx'
}

/**
 * そのままでは読めない形式（Office 97-2003 のバイナリ・OpenDocument・RTF・Apple の iWork など）。
 * main が LibreOffice（soffice）で kind の形式に変えてからプレビュー・編集する。
 * exportFilter は編集を元の形式へ戻すときの LibreOffice の書き出しの指定（無ければ書き戻せない＝読むだけ）
 */
export interface ConvertibleOffice {
  kind: OfficeKind
  exportFilter: string | null
}

const CONVERTIBLE: Record<string, ConvertibleOffice> = {
  '.doc': { kind: 'docx', exportFilter: 'doc:MS Word 97' },
  '.dot': { kind: 'docx', exportFilter: null },
  '.rtf': { kind: 'docx', exportFilter: 'rtf:Rich Text Format' },
  '.odt': { kind: 'docx', exportFilter: 'odt:writer8' },
  '.ott': { kind: 'docx', exportFilter: null },
  '.fodt': { kind: 'docx', exportFilter: null },
  '.wpd': { kind: 'docx', exportFilter: null },
  '.pages': { kind: 'docx', exportFilter: null },
  '.xls': { kind: 'xlsx', exportFilter: 'xls:MS Excel 97' },
  '.xlt': { kind: 'xlsx', exportFilter: null },
  '.xlsb': { kind: 'xlsx', exportFilter: null },
  '.ods': { kind: 'xlsx', exportFilter: 'ods:calc8' },
  '.ots': { kind: 'xlsx', exportFilter: null },
  '.fods': { kind: 'xlsx', exportFilter: null },
  '.numbers': { kind: 'xlsx', exportFilter: null },
  '.ppt': { kind: 'pptx', exportFilter: 'ppt:MS PowerPoint 97' },
  '.pps': { kind: 'pptx', exportFilter: null },
  '.pot': { kind: 'pptx', exportFilter: null },
  '.odp': { kind: 'pptx', exportFilter: 'odp:impress8' },
  '.otp': { kind: 'pptx', exportFilter: null },
  '.fodp': { kind: 'pptx', exportFilter: null },
  '.key': { kind: 'pptx', exportFilter: null }
}

/** プレビューする大きさの上限（全体を読み込んで展開するので絞る） */
export const MAX_OFFICE_BYTES = 50 * 1024 * 1024

export function extensionOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

export function officeKindOf(path: string): OfficeKind | null {
  return OFFICE_EXTENSIONS[extensionOf(path)] ?? null
}

/** LibreOffice で変えてから開く形式なら、その種類と書き戻しの指定 */
export function convertibleOfficeOf(path: string): ConvertibleOffice | null {
  return CONVERTIBLE[extensionOf(path)] ?? null
}

/** そのままでは読めない（LibreOffice で変えてから開く）形式 */
export function isLegacyOffice(path: string): boolean {
  return convertibleOfficeOf(path) !== null
}

/**
 * 中身の先頭から入れ物の種類を見る。zip は OOXML・OpenDocument・iWork、ole は Office 97-2003 のバイナリ
 * （パスワード付きの OOXML もこれ）、ほかは other（RTF・HTML・XML など）
 */
export function sniffContainer(head: Uint8Array): 'zip' | 'ole' | 'other' {
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)) return 'zip'
  if (head.length >= 8 && head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0 && head[4] === 0xa1 && head[5] === 0xb1 && head[6] === 0x1a && head[7] === 0xe1) return 'ole'
  return 'other'
}

/** ZIP の部品の名前から OOXML の種類（拡張子が違っていても中身が .docx などなら、そのまま開ける） */
export function ooxmlKindFromNames(names: readonly string[]): OfficeKind | null {
  const set = new Set(names.map((n) => n.replace(/^\/+/, '')))
  if (set.has('word/document.xml')) return 'docx'
  if (set.has('xl/workbook.xml')) return 'xlsx'
  if (set.has('ppt/presentation.xml')) return 'pptx'
  return null
}
