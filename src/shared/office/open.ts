/**
 * fs:openOffice の結果（main と renderer で共有する型だけ）。
 *
 *   native    … ファイルそのもの（.docx・.xlsx・.pptx。拡張子が古い形式でも中身が OOXML ならこれ）
 *   converted … LibreOffice で kind の形式に変えたもの。saveBack が convert なら、保存で元の形式へ戻して書く
 */
import type { OfficeKind } from './kinds'

export type OfficeSaveBack = 'native' | 'convert' | 'none'

export type OfficeOpenResult =
  | {
      ok: true
      kind: OfficeKind
      bytes: Uint8Array
      source: 'native' | 'converted'
      /** 保存のしかた。none は読むだけ（書き戻せない形式） */
      saveBack: OfficeSaveBack
      mtimeMs: number
    }
  | {
      ok: false
      /** noConverter は LibreOffice が無い（入れるか、外のアプリで開くよう案内する） */
      reason: 'noConverter' | 'convertFailed' | 'tooLarge' | 'unsupported'
      message: string
    }
