import { memo } from 'react'
import type { TextPart, TextEdits } from '@shared/office/textParts'
import { useT } from '../lib/i18n'

/**
 * Word・PowerPoint の文字を段落ごとに直す欄（OfficeViewer の編集。右に直した結果のプレビューを並べる）。
 * PowerPoint はスライドごと、同じテキストボックス・表のセルの段落はひとまとまりに見せる。
 * 段落の中の改行（Shift+Enter ではなく普通の改行）は、Word の改行（w:br）・PowerPoint の改行（a:br）になる。
 */
export default function OfficeTextEditor({ parts, edits, onEdit }: {
  parts: readonly TextPart[]
  edits: TextEdits
  onEdit: (part: string, index: number, value: string) => void
}) {
  const t = useT()
  const total = parts.reduce((n, p) => n + p.paragraphs.length, 0)
  if (total === 0) return <p className="office-text__empty">{t('viewer.officeNoText')}</p>
  return (
    <div className="office-text" data-testid="office-text-editor">
      {parts.map((part) => {
        const groups: { group: number; items: { index: number; text: string }[] }[] = []
        part.paragraphs.forEach((p, index) => {
          const last = groups[groups.length - 1]
          if (last && last.group === p.group && p.group !== -1) last.items.push({ index, text: p.text })
          else groups.push({ group: p.group, items: [{ index, text: p.text }] })
        })
        const forPart = edits.get(part.part)
        return (
          <section key={part.part} className="office-text__part">
            {part.slide > 0 && <h3 className="office-text__heading">{t('viewer.officeSlideHeading', { n: part.slide })}</h3>}
            {part.paragraphs.length === 0 && <p className="office-text__empty">{t('viewer.officeNoText')}</p>}
            {groups.map((group, g) => (
              <div key={g} className={group.group === -1 ? 'office-text__flow' : 'office-text__box'}>
                {group.items.map(({ index, text }) => (
                  <Paragraph
                    key={index}
                    part={part.part}
                    index={index}
                    value={forPart?.get(index) ?? text}
                    edited={forPart?.has(index) ?? false}
                    label={t('viewer.officeParagraphLabel', { n: index + 1 })}
                    placeholder={t('viewer.officeEmptyParagraph')}
                    onEdit={onEdit}
                  />
                ))}
              </div>
            ))}
          </section>
        )
      })}
    </div>
  )
}

/** 1つの段落の欄。直していない段落は描き直さない（長い文書でも打鍵を重くしない） */
const Paragraph = memo(function Paragraph({ part, index, value, edited, label, placeholder, onEdit }: {
  part: string
  index: number
  value: string
  edited: boolean
  label: string
  placeholder: string
  onEdit: (part: string, index: number, value: string) => void
}) {
  return (
    <textarea
      className={`office-text__paragraph${edited ? ' is-edited' : ''}`}
      value={value}
      rows={1}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={label}
      onChange={(event) => onEdit(part, index, event.target.value)}
      data-testid="office-text-paragraph"
    />
  )
})
