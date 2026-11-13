/**
 * Word・PowerPoint の文字の編集の入口。どの部品（本文・スライド）のどの段落を直せるかを読み、
 * 直した段落を部品の XML の差し替えにする（textEdit.ts）。
 */
import { attr, child, children, documentElement, parseRels, parseXml } from './xml'
import { relsPathOf, resolvePartPath, type ZipArchive } from './zip'
import { applyParagraphEdits, readParagraphs, type TextDialect, type TextParagraph } from './textEdit'

export interface TextPart {
  /** ZIP の部品の名前（word/document.xml・ppt/slides/slide3.xml） */
  part: string
  /** スライドの番号（1 から）。Word は 0 */
  slide: number
  dialect: TextDialect
  paragraphs: TextParagraph[]
}

const PRESENTATION = 'ppt/presentation.xml'

export async function readTextParts(kind: 'docx' | 'pptx', zip: ZipArchive): Promise<TextPart[]> {
  if (kind === 'docx') {
    const xml = await zip.text('word/document.xml')
    if (xml === null) throw new Error('word/document.xml is missing')
    return [{ part: 'word/document.xml', slide: 0, dialect: 'w', paragraphs: readParagraphs(xml, 'w') }]
  }
  const source = await zip.text(PRESENTATION)
  if (source === null) throw new Error('ppt/presentation.xml is missing')
  const presentation = documentElement(parseXml(source))
  const rels = parseRels(await zip.text(relsPathOf(PRESENTATION)))
  const parts: TextPart[] = []
  let slide = 0
  for (const id of children(child(presentation, 'sldIdLst'), 'sldId')) {
    const rel = rels.get(id.attrs['r:id'] ?? attr(id, 'id') ?? '')
    if (!rel || rel.external) continue
    slide += 1
    const part = resolvePartPath(PRESENTATION, rel.target)
    const xml = await zip.text(part)
    if (xml === null) continue
    parts.push({ part, slide, dialect: 'a', paragraphs: readParagraphs(xml, 'a') })
  }
  return parts
}

/** 部品の名前 → 段落の番号 → 新しい文字 */
export type TextEdits = ReadonlyMap<string, ReadonlyMap<number, string>>

/** 直した段落を、部品の XML の差し替え（名前 → 新しい XML）にする。変わらない部品は含めない */
export async function textChanges(zip: ZipArchive, parts: readonly Pick<TextPart, 'part' | 'dialect'>[], edits: TextEdits): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (const { part, dialect } of parts) {
    const forPart = edits.get(part)
    if (!forPart || forPart.size === 0) continue
    const xml = await zip.text(part)
    if (xml === null) continue
    const next = applyParagraphEdits(xml, dialect, forPart)
    if (next !== xml) out.set(part, next)
  }
  return out
}
