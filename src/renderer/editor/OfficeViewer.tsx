import { useCallback, useEffect, useRef, useState } from 'react'
import { Eye, Pencil } from 'lucide-react'
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS, parseCellRef, readWorkbook, type WorkbookInfo } from '@shared/office/xlsx'
import { OfficeFormatError, convertibleOfficeOf, renderOfficeZip, type OfficeKind, type OfficePreview } from '@shared/office'
import { openZip, type ZipArchive } from '@shared/office/zip'
import { overlayZip, rewriteZip } from '@shared/office/zipWrite'
import { readSheetGrid, xlsxChanges, cellKey, type SheetGrid } from '@shared/office/xlsxEdit'
import { readTextParts, textChanges, type TextPart } from '@shared/office/textParts'
import { hasEdits, textFormatRefs, updateEdit, type PartEdits } from '@shared/office/editState'
import type { OfficeSaveBack } from '@shared/office/open'
import { formatByteSize, type FsFileInfo } from '@shared/fileViewer'
import { reportHandled } from '@shared/report'
import { t as translate } from '@shared/i18n'
import { Button, Spinner } from '../ui'
import { useT } from '../lib/i18n'
import { officeSession, registerOfficeSaver, setOfficeSession, subscribeOfficeSession } from './officeSave'
import XlsxGridEditor from './XlsxGridEditor'
import OfficeTextEditor from './OfficeTextEditor'

/** 文字を直してから右のプレビューを描き直すまでの待ち */
const PREVIEW_DELAY_MS = 400

interface LoadedDoc {
  kind: OfficeKind
  bytes: Uint8Array
  zip: ZipArchive
  source: 'native' | 'converted'
  saveBack: OfficeSaveBack
}

/** タブごとに持つ状態（タブを切り替えて OfficeViewer が消えても、保存していない直しを残す。officeSave.ts） */
interface OfficeSessionState {
  path: string
  revision: number
  editing: boolean
  doc: LoadedDoc | null
  book: WorkbookInfo | null
  grids: ReadonlyMap<string, SheetGrid>
  textParts: TextPart[] | null
  cellEdits: PartEdits<string>
  textEdits: PartEdits<number>
}

/** いまの直しを、元の ZIP の部品の差し替えにする（Excel はシート、Word・PowerPoint は本文・スライド） */
async function changesOf(state: Pick<OfficeSessionState, 'doc' | 'grids' | 'textParts' | 'cellEdits' | 'textEdits'>): Promise<Map<string, string | null>> {
  const doc = state.doc
  if (!doc) return new Map()
  if (doc.kind === 'xlsx') {
    return xlsxChanges(doc.zip, [...state.cellEdits].map(([part, cells]) => ({ part, cells, textFormatRefs: textFormatRefs(state.grids.get(part), cells) })))
  }
  return textChanges(doc.zip, state.textParts ?? [], state.textEdits)
}

/** 保存（useOpenFiles の save が呼ぶ）。表に出ていないタブでも、持っている状態から書く */
async function saveSession(fileId: string): Promise<void> {
  const state = officeSession<OfficeSessionState>(fileId)
  const doc = state?.doc
  if (!state || !doc) throw new Error(translate('viewer.officeFailed'))
  if (doc.saveBack === 'none') throw new Error(translate('viewer.officeReadOnly'))
  const bytes = await rewriteZip(doc.bytes, await changesOf(state))
  await window.ade.invoke('fs:writeOffice', state.path, bytes)
  // 書いた内容を新しい元にする（書いている間に直したものがあれば、その直しは残す）
  const current = officeSession<OfficeSessionState>(fileId)
  if (current && current.doc === doc && current.cellEdits === state.cellEdits && current.textEdits === state.textEdits) {
    setOfficeSession<OfficeSessionState>(fileId, {
      ...current, doc: { ...doc, bytes, zip: openZip(bytes) }, grids: new Map(), textParts: null, cellEdits: new Map(), textEdits: new Map()
    }, true)
  }
}

/**
 * Word・Excel・PowerPoint のプレビューと編集（中央のファイルタブの本体）。
 *
 * 中身は fs:openOffice で受け取る（古い形式・OpenDocument・iWork は main が LibreOffice で .docx・.xlsx・.pptx に変えて渡す）。
 * プレビューは @shared/office が HTML にし、sandbox の iframe（スクリプト無し・外へ読みに行かない CSP）に出す。
 * 「編集」にすると、Excel はセルの表（XlsxGridEditor）、Word・PowerPoint は段落の欄（OfficeTextEditor）と右のプレビューになる。
 * 直しは保存（⌘S・タブの「保存」）まで officeSave.ts に持ち、保存で元の ZIP の直した部品だけを差し替えて fs:writeOffice へ送る
 * （古い形式は main が元の形式へ戻して書く）。読めなかったら onError で大きさと16進数の表示に切り替える。
 */
export default function OfficeViewer({ fileId, path, name, info, revision, onError, onDirty }: {
  fileId: string
  path: string
  name: string
  info?: FsFileInfo
  revision: number
  onError: (message: string) => void
  onDirty: (dirty: boolean) => void
}) {
  const t = useT()
  // 同じ内容（revision）のまま戻ってきたタブは、前の状態から続ける
  const [resume] = useState(() => {
    const stored = officeSession<OfficeSessionState>(fileId)
    return stored && stored.path === path && stored.revision === revision ? stored : null
  })
  const [doc, setDoc] = useState<LoadedDoc | null>(resume?.doc ?? null)
  const [editing, setEditing] = useState(resume?.editing ?? false)
  const [book, setBook] = useState<WorkbookInfo | null>(resume?.book ?? null)
  const [grids, setGrids] = useState<ReadonlyMap<string, SheetGrid>>(resume?.grids ?? new Map())
  const [textParts, setTextParts] = useState<TextPart[] | null>(resume?.textParts ?? null)
  const [cellEdits, setCellEdits] = useState<PartEdits<string>>(resume?.cellEdits ?? new Map())
  const [textEdits, setTextEdits] = useState<PartEdits<number>>(resume?.textEdits ?? new Map())
  const [preview, setPreview] = useState<OfficePreview | null>(null)
  const [sheet, setSheet] = useState(0)
  const [sheetHtml, setSheetHtml] = useState<string | null>(null)
  const skipLoad = useRef(resume?.doc != null)
  const legacy = convertibleOfficeOf(path)
  const legacyExt = path.slice(path.lastIndexOf('.'))

  const fail = useCallback((err: unknown, op: string) => {
    // パスワード付き・壊れた文書（OfficeFormatError）は想定内なので送らない。読み取りの不具合だけ送る（中身は含めない）
    if (!(err instanceof OfficeFormatError)) reportHandled(err, { area: 'editor', op })
    onError(t('viewer.officeFailed'))
  }, [onError, t])

  // 開く（ディスクの内容が変わるたびに読み直し、保存していない直しは捨てる。直しがあるときは useOpenFiles が上書きせずに知らせる）
  useEffect(() => {
    if (skipLoad.current) {
      skipLoad.current = false
      return
    }
    let cancelled = false
    setDoc(null)
    setPreview(null)
    setBook(null)
    setGrids(new Map())
    setTextParts(null)
    setCellEdits(new Map())
    setTextEdits(new Map())
    void (async () => {
      try {
        const result = await window.ade.invoke('fs:openOffice', path)
        if (cancelled) return
        if (!result.ok) {
          onError(result.message)
          return
        }
        setDoc({ kind: result.kind, bytes: result.bytes, zip: openZip(result.bytes), source: result.source, saveBack: result.saveBack })
      } catch (err) {
        if (!cancelled) fail(err, `open ${legacy ? 'converted' : 'office'}`)
      }
    })()
    return () => { cancelled = true }
  }, [path, revision])

  // タブごとの状態へ写す（表に出ていなくても保存できるように）
  useEffect(() => {
    setOfficeSession<OfficeSessionState>(fileId, { path, revision, editing, doc, book, grids, textParts, cellEdits, textEdits })
  }, [fileId, path, revision, editing, doc, book, grids, textParts, cellEdits, textEdits])

  // 保存の後（saveSession）に、書いた内容を新しい元として受け取る
  useEffect(() => subscribeOfficeSession<OfficeSessionState>(fileId, (state) => {
    setDoc(state.doc)
    setGrids(state.grids)
    setTextParts(state.textParts)
    setCellEdits(state.cellEdits)
    setTextEdits(state.textEdits)
  }), [fileId])

  // 保存の口は、タブを閉じるまで残す（表に出ていないタブも「保存して終了」で書けるように。閉じたら useOpenFiles が forgetOffice で捨てる）
  useEffect(() => { registerOfficeSaver(fileId, () => saveSession(fileId)) }, [fileId])

  const dirty = hasEdits(cellEdits) || hasEdits(textEdits)
  useEffect(() => { onDirty(dirty) }, [dirty])

  // プレビュー（直しがあれば、直した部品に差し替えて描く。文字を打つたびには描かない）
  const showPreview = !editing || doc?.kind !== 'xlsx'
  useEffect(() => {
    if (!doc || !showPreview) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          let zip = doc.zip
          if (dirty) {
            const changes = await changesOf({ doc, grids, textParts, cellEdits, textEdits })
            zip = overlayZip(doc.zip, new Map([...changes].filter((entry): entry is [string, string] => typeof entry[1] === 'string')))
          }
          const result = await renderOfficeZip(doc.kind, zip, name, {
            missingImage: t('viewer.officeMissingImage'),
            chart: t('viewer.officeChart'),
            slide: (n, total) => t('viewer.officeSlide', { n, total }),
            sheetTruncated: t('viewer.officeTruncated', { rows: MAX_SHEET_ROWS, columns: MAX_SHEET_COLUMNS })
          })
          if (cancelled) return
          setPreview(result)
          if (result.kind === 'sheets') setSheet((current) => (current < result.sheets.length ? current : Math.max(0, result.sheets.findIndex((s) => !s.hidden))))
        } catch (err) {
          if (!cancelled) fail(err, `preview ${doc.kind}`)
        }
      })()
    }, preview && dirty ? PREVIEW_DELAY_MS : 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [doc, showPreview, cellEdits, textEdits])

  useEffect(() => {
    setSheetHtml(null)
    if (preview?.kind !== 'sheets') return
    const target = preview.sheets[sheet]
    if (!target) return
    let cancelled = false
    target.render().then((html) => { if (!cancelled) setSheetHtml(html) }, (err) => { if (!cancelled) fail(err, 'preview xlsx sheet') })
    return () => { cancelled = true }
  }, [preview, sheet])

  // 編集に使う中身（ブックのシートの並び・段落）
  useEffect(() => {
    if (!doc || !editing) return
    let cancelled = false
    void (async () => {
      try {
        if (doc.kind === 'xlsx') {
          if (!book) {
            const loaded = await readWorkbook(doc.zip)
            if (!cancelled) setBook(loaded)
          }
        } else if (!textParts) {
          const parts = await readTextParts(doc.kind, doc.zip)
          if (!cancelled) setTextParts(parts)
        }
      } catch (err) {
        if (!cancelled) fail(err, `edit ${doc.kind}`)
      }
    })()
    return () => { cancelled = true }
  }, [doc, editing, book, textParts])

  const sheetPart = book?.sheets[sheet]?.part
  useEffect(() => {
    if (!doc || !book || !sheetPart || grids.has(sheetPart)) return
    let cancelled = false
    void doc.zip.text(sheetPart).then((source) => {
      if (cancelled) return
      const grid = readSheetGrid(source, book)
      setGrids((current) => new Map(current).set(sheetPart, grid))
    }, (err) => { if (!cancelled) fail(err, 'edit xlsx sheet') })
    return () => { cancelled = true }
  }, [doc, book, sheetPart, grids])

  const onCellEdit = useCallback((ref: string, value: string) => {
    if (!sheetPart) return
    const at = parseCellRef(ref)
    const original = at ? grids.get(sheetPart)?.cells.get(cellKey(at.row, at.col))?.input ?? '' : ''
    setCellEdits((current) => updateEdit(current, sheetPart, ref, value, original))
  }, [sheetPart, grids])

  const onTextEdit = useCallback((part: string, index: number, value: string) => {
    const original = textParts?.find((p) => p.part === part)?.paragraphs[index]?.text ?? ''
    setTextEdits((current) => updateEdit(current, part, index, value, original))
  }, [textParts])

  const canEdit = doc !== null && doc.saveBack !== 'none'
  const sheetNames = preview?.kind === 'sheets' ? preview.sheets : book?.sheets
  const html = preview ? (preview.kind === 'sheets' ? sheetHtml : preview.html) : null
  const note = doc?.source === 'converted'
    ? (doc.saveBack === 'convert' ? t('viewer.officeConvertedNote', { ext: legacyExt }) : t('viewer.officeConvertedReadOnly', { ext: legacyExt }))
    : editing && doc ? (doc.kind === 'xlsx' ? t('viewer.officeEditNoteGrid') : t('viewer.officeEditNoteText')) : t('viewer.officeNote')

  const frame = html === null
    ? <div className="editor-body__center"><Spinner size={18} /></div>
    : <iframe className="file-viewer__office" sandbox="" srcDoc={html} title={t('viewer.officeTitle', { name })} data-testid="file-viewer-office-frame" />

  let body
  if (!doc) {
    body = (
      <div className="editor-body__center office-loading">
        <Spinner size={18} />
        {legacy && <span className="file-viewer__note">{t('viewer.officeConverting')}</span>}
      </div>
    )
  } else if (editing && canEdit && doc.kind === 'xlsx') {
    const grid = sheetPart ? grids.get(sheetPart) : undefined
    body = grid && sheetPart
      ? (
        <>
          {grid.truncated && <div className="office-edit__notice">{t('viewer.officeGridTruncated', { rows: MAX_SHEET_ROWS, columns: MAX_SHEET_COLUMNS })}</div>}
          <XlsxGridEditor key={sheetPart} grid={grid} edits={cellEdits.get(sheetPart) ?? new Map()} onEdit={onCellEdit} />
        </>
      )
      : <div className="editor-body__center"><Spinner size={18} /></div>
  } else if (editing && canEdit) {
    body = (
      <div className="office-edit">
        <div className="office-edit__text">
          {textParts ? <OfficeTextEditor parts={textParts} edits={textEdits} onEdit={onTextEdit} /> : <div className="editor-body__center"><Spinner size={18} /></div>}
        </div>
        <div className="office-edit__preview">{frame}</div>
      </div>
    )
  } else {
    body = frame
  }

  return (
    <div className="file-viewer file-viewer--office" data-testid="file-viewer-office">
      <div className="file-viewer__toolbar">
        {sheetNames && sheetNames.length > 0 && (
          <span className="file-viewer__sheets" role="tablist" aria-label={t('viewer.officeSheets')}>
            {sheetNames.map((s, index) => (
              <Button key={index} variant="ghost" role="tab" aria-selected={index === sheet} selected={index === sheet} onClick={() => setSheet(index)} data-testid="file-viewer-sheet">
                {s.hidden ? t('viewer.officeHiddenSheet', { name: s.name }) : s.name}
              </Button>
            ))}
          </span>
        )}
        <span className="file-viewer__note" title={note}>{note}</span>
        {doc && (
          <Button
            variant="ghost"
            icon={editing ? <Eye size={13} /> : <Pencil size={13} />}
            selected={editing}
            disabled={!canEdit}
            title={canEdit ? t('viewer.officeEditTitle') : t('viewer.officeReadOnly')}
            onClick={() => setEditing((value) => !value)}
            data-testid="office-edit-toggle"
          >
            {editing ? t('viewer.officePreview') : t('viewer.officeEdit')}
          </Button>
        )}
        {info && <span className="file-viewer__meta">{formatByteSize(info.size)}</span>}
      </div>
      {body}
    </div>
  )
}
