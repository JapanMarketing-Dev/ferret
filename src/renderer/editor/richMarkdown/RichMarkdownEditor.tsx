import { useEffect, useMemo, useRef, useState } from 'react'
import { Editor, type JSONContent } from '@tiptap/core'
import Image from '@tiptap/extension-image'
import { LabeledCodeBlock, Video, createMarkdownCodec, richMarkdownExtensions } from './codec'
import { codeBlockNodeView } from './mermaidBlock'
import { buildSourceModel, reconcileEdit, type SourceModel } from './reconcile'
import { resolveRichImage } from './images'
import { SLASH_ITEMS, filterSlashItems, moveSlashIndex, slashLabelKey, slashMarkItem, type SlashItem } from './slashCommands'
import { MarkdownInputRules } from './inputRules'
import { SlashMenu, readSlashState, runSlashItem, type SlashState } from './SlashMenu'
import { registerDraftFlush, type OpenFile, type OpenFilesApi } from '../useOpenFiles'
import { registerMarkdownDropTarget, type DropPoint, type MediaEmbed } from '../markdownDrop'
import { encodeMarkdownUrl, mediaAlt } from '@shared/markdownMedia'
import { useT } from '../../lib/i18n'
import { errorMessage } from '../../lib/errors'
import { useToast } from '../../ui'
import { clickedLinkHref } from './links'
import { reportHandled } from '@shared/report'
import './richMarkdown.css'

/** この大きさまでは打鍵のたびにすぐファイルの文字列へ写す（未保存の印・閉じる確認がすぐ正しくなる） */
const SYNC_COMMIT_LIMIT = 60_000
/** それより大きい文書は、打鍵が止まってから写す（保存の前には必ず写す） */
const COMMIT_DELAY_MS = 200

/**
 * 画像の表示。プロジェクトの中の画像は ade-media://project/ から読み、外の画像は読まずに行き先のホストだけを出す
 * （プレビューのページと同じ決まり。images.ts）。src・alt はそのまま持つので、保存すると元の記法に戻る。
 */
function imageExtension(markdownPath: string) {
  return Image.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('span')
        dom.className = 'rich-md__image'
        const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
        const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : ''
        const resolved = resolveRichImage(src, markdownPath)
        if (resolved.kind === 'local' || resolved.kind === 'data') {
          const img = document.createElement('img')
          img.src = resolved.url
          img.alt = alt
          img.draggable = false
          dom.appendChild(img)
        } else {
          dom.classList.add('rich-md__image--blocked')
          dom.dataset.testid = 'rich-md-remote-image'
          dom.textContent = resolved.kind === 'remote' ? (alt.trim() ? `${alt.trim()} · ${resolved.host}` : resolved.host) : alt || src
          dom.title = src
        }
        return { dom }
      }
    }
  })
}

/** 動画の表示。画像と同じく、プロジェクトの中だけを ade-media://project/ から読む（外の動画は読まずにホストだけ） */
function videoExtension(markdownPath: string) {
  return Video.extend({
    addNodeView() {
      return ({ node }) => {
        const dom = document.createElement('div')
        dom.className = 'rich-md__video'
        dom.contentEditable = 'false'
        const src = typeof node.attrs.src === 'string' ? node.attrs.src : ''
        const resolved = resolveRichImage(src, markdownPath)
        if (resolved.kind === 'local') {
          const video = document.createElement('video')
          video.src = resolved.url
          video.controls = true
          video.preload = 'metadata'
          video.draggable = false
          dom.appendChild(video)
        } else {
          dom.classList.add('rich-md__image--blocked')
          dom.dataset.testid = 'rich-md-remote-video'
          dom.textContent = resolved.kind === 'remote' ? resolved.host : src
          dom.title = src
        }
        return { dom }
      }
    }
  })
}

/** コードブロックの表示。```mermaid は既定で図として出し、「コード」で編集する（mermaidBlock.ts）。ほかの言語は素のまま */
const codeBlockExtension = LabeledCodeBlock.extend({
  addNodeView() {
    return ({ editor, node, getPos }) => codeBlockNodeView(editor, node, getPos)
  }
})

/** 落とした画像・動画を入れる。画像は落とした位置の行の中へ、動画（塊）はその位置を含む最上位の塊の後ろへ */
function insertMedia(editor: Editor, media: readonly MediaEmbed[], point: DropPoint): void {
  const found = editor.view.posAtCoords({ left: point.x, top: point.y })
  const pos = Math.min(found?.pos ?? editor.state.selection.to, editor.state.doc.content.size)
  const $pos = editor.state.doc.resolve(pos)
  const blockEnd = $pos.depth >= 1 ? $pos.after(1) : pos
  const images: JSONContent[] = []
  for (const m of media.filter((x) => x.kind === 'image')) {
    if (images.length > 0) images.push({ type: 'text', text: ' ' })
    images.push({ type: 'image', attrs: { src: encodeMarkdownUrl(m.link), alt: mediaAlt(m.link) } })
  }
  const videos: JSONContent[] = media.filter((x) => x.kind === 'video').map((m) => ({ type: 'video', attrs: { src: encodeMarkdownUrl(m.link) } }))
  // 後ろから入れる（先に入れた分で、前の位置がずれないように）
  let chain = editor.chain()
  if (videos.length > 0) chain = chain.insertContentAt(blockEnd, videos)
  if (images.length > 0) chain = chain.insertContentAt(pos, images)
  chain.focus().run()
}

/** 文書の中の外の画像のホスト（帯に出す） */
function remoteHosts(nodes: JSONContent[], markdownPath: string): string[] {
  const hosts = new Set<string>()
  const walk = (node: JSONContent) => {
    if (node.type === 'image' && typeof node.attrs?.src === 'string') {
      const resolved = resolveRichImage(node.attrs.src, markdownPath)
      if (resolved.kind === 'remote') hosts.add(resolved.host)
    }
    node.content?.forEach(walk)
  }
  nodes.forEach(walk)
  return [...hosts]
}

/** 空の文書は段落1つで開く（ProseMirror の文書は塊が1つ以上要る）。戻すときは空に戻す */
function contentOf(nodes: JSONContent[]): JSONContent {
  return { type: 'doc', content: nodes.length > 0 ? nodes : [{ type: 'paragraph' }] }
}
function editedNodes(editor: Editor): JSONContent[] {
  const nodes = editor.getJSON().content ?? []
  return nodes.length === 1 && nodes[0]!.type === 'paragraph' && !nodes[0]!.content?.length ? [] : nodes
}

/**
 * Markdown をプレビューの見た目のまま編集する（FileEditor の「プレビュー」。Markdown のプレビューはいつでも編集できる）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/editor/RichMarkdownEditor.tsx・useRichMarkdownEditorInstance.ts（MIT）
 *   - TipTap の編集した文書を Markdown に戻すとき、変えていない部分は元の文字列のまま残す（reconcile.ts）
 *   - 未保存の印・保存（⌘S / Ctrl+S）・閉じる確認は、ソースの編集と同じ drafts を通す
 *   - frontmatter は文書の外に出して、文字のまま編集する
 * 生の HTML は文字として出す（プレビューのページと同じく、ファイルの中のスクリプトを動かさない）。
 * ただし1行の <video src="…" controls></video> だけは動画として出す（落として埋め込んだ動画。codec.ts の Video）。
 * tiptap を含むので、FileEditor からは React.lazy で、このモードを開いたときだけ読む。
 */
export default function RichMarkdownEditor({ file, editor: api }: { file: OpenFile; editor: OpenFilesApi }) {
  const t = useT()
  const toast = useToast()
  const toastRef = useRef(toast)
  toastRef.current = toast
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<Editor | null>(null)
  const modelRef = useRef<SourceModel | null>(null)
  const frontmatterRef = useRef('')
  const timer = useRef<number | undefined>(undefined)
  /** ディスクの内容を読んだもの（打鍵のたびに読み直さない） */
  const savedRef = useRef<{ text: string; model: SourceModel } | null>(null)
  const [frontmatter, setFrontmatter] = useState('')
  const [hosts, setHosts] = useState<string[]>([])
  const extensions = useMemo(() => richMarkdownExtensions(imageExtension(file.path) as typeof Image, videoExtension(file.path) as typeof Video, codeBlockExtension), [file.path])
  const codec = useMemo(() => createMarkdownCodec(extensions), [extensions])
  const fileRef = useRef(file)
  fileRef.current = file

  // 「/」メニュー（SlashMenu.tsx）。Esc で閉じた「/」は、その「/」を消すまで開き直さない
  const [slash, setSlash] = useState<SlashState | null>(null)
  const [slashIndex, setSlashIndex] = useState(0)
  const slashRef = useRef<SlashState | null>(null)
  const slashDismissedRef = useRef<number | null>(null)
  const slashItems = useMemo(
    () => (slash ? filterSlashItems(SLASH_ITEMS, slash.context, slash.query, (item) => t(slashLabelKey(item.id))) : []),
    [slash?.context, slash?.query, t]
  )
  const activeSlashIndex = Math.min(slashIndex, Math.max(0, slashItems.length - 1))
  const closeSlash = () => { slashRef.current = null; setSlash(null) }
  const refreshSlash = () => {
    const editor = editorRef.current
    const next = editor ? readSlashState(editor) : null
    if (!next) { slashDismissedRef.current = null; closeSlash(); return }
    if (slashDismissedRef.current === next.from) { closeSlash(); return }
    slashDismissedRef.current = null
    const prev = slashRef.current
    if (!prev || prev.from !== next.from || prev.query !== next.query) setSlashIndex(0)
    slashRef.current = next
    setSlash(next)
  }
  const pickSlashItem = (item: SlashItem | undefined) => {
    const editor = editorRef.current
    const state = slashRef.current
    if (!editor || !state || !item) return
    closeSlash()
    runSlashItem(editor, item.id, state)
  }
  const pickSlash = (index: number) => pickSlashItem(slashItems[index])
  /**
   * 「/##」「/-」のように Markdown の記号を打った後の空白。行の頭で「## 」と打ったのと同じに、その塊へ変える（空白は入れない）。
   * 全角の空白（日本語入力のまま）も同じ。扱ったら true
   */
  const slashText = (text: string): boolean => {
    const state = slashRef.current
    if (!state || (text !== ' ' && text !== '　')) return false
    const item = slashMarkItem(SLASH_ITEMS, state.context, state.query)
    if (!item) return false
    pickSlashItem(item)
    return true
  }
  /** メニューが開いているときの ↑↓・Enter・Tab・Esc（エディタの handleKeyDown から呼ぶ）。扱ったら true */
  const slashKey = (event: KeyboardEvent): boolean => {
    const state = slashRef.current
    if (!state || slashItems.length === 0 || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return false
    switch (event.key) {
      case 'ArrowDown': setSlashIndex(moveSlashIndex(activeSlashIndex, 1, slashItems.length)); return true
      case 'ArrowUp': setSlashIndex(moveSlashIndex(activeSlashIndex, -1, slashItems.length)); return true
      case 'Enter':
      case 'Tab':
        if (event.shiftKey) return false
        pickSlash(activeSlashIndex)
        return true
      case 'Escape':
        event.stopPropagation()
        slashDismissedRef.current = state.from
        closeSlash()
        return true
      default: return false
    }
  }
  const slashKeyRef = useRef(slashKey)
  slashKeyRef.current = slashKey
  const slashTextRef = useRef(slashText)
  slashTextRef.current = slashText
  const refreshSlashRef = useRef(refreshSlash)
  refreshSlashRef.current = refreshSlash

  // 開いている間は、ページを動かしたら「/」の位置に付いていく
  useEffect(() => {
    if (!slash) return
    const onScroll = () => refreshSlashRef.current()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [slash !== null])

  /** 編集中の文書を、元の書き方に合わせた文字列にして drafts へ写す */
  const commit = () => {
    window.clearTimeout(timer.current)
    timer.current = undefined
    const editor = editorRef.current
    const model = modelRef.current
    if (!editor || !model) return
    const current = fileRef.current
    try {
      const nodes = editedNodes(editor)
      // 開いたときの内容に戻った（undo など）なら、ディスクの文字列をそのまま使う（未保存の印も消える）
      if (savedRef.current?.text !== current.saved) savedRef.current = { text: current.saved, model: buildSourceModel(current.saved, codec) }
      // （reconcileEdit は、ディスクの内容と同じ文書ならディスクの文字列をそのまま返す）
      const text = reconcileEdit(savedRef.current, model, nodes, codec, frontmatterRef.current)
      if (text === (api.getDraft(current.id) ?? current.saved)) return
      api.setDraft(current.id, text)
      modelRef.current = buildSourceModel(text, codec)
      setHosts(remoteHosts(nodes, current.path))
    } catch (err) {
      reportHandled(err, { area: 'editor', op: 'reconcile markdown' })
    }
  }
  const commitRef = useRef(commit)
  commitRef.current = commit

  const schedule = () => {
    const size = (api.getDraft(fileRef.current.id) ?? fileRef.current.saved).length
    if (size <= SYNC_COMMIT_LIMIT) { commitRef.current(); return }
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => commitRef.current(), COMMIT_DELAY_MS)
  }

  // エディタを作る（ファイル・拡張が変わったら作り直す）
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const source = api.getDraft(file.id) ?? file.saved
    const model = buildSourceModel(source, codec)
    modelRef.current = model
    frontmatterRef.current = model.frontmatter
    setFrontmatter(model.frontmatter)
    setHosts(remoteHosts(model.nodes, file.path))
    const readOnly = file.readOnly === true
    const editor = new Editor({
      element: host,
      // 読むだけのファイル（SSH のプロジェクト）は、プレビューとして見せるだけで編集させない
      editable: !readOnly,
      // 行の頭の Markdown の記法（「- [ ] 」・全角の「＃　」など）で塊に変える規則は、編集のエディタにだけ足す（スキーマは変えない）
      extensions: [...extensions, MarkdownInputRules],
      content: contentOf(model.nodes),
      editorProps: {
        attributes: { class: 'rich-md markdown-body', spellcheck: 'false', 'data-testid': 'rich-md-editor' },
        handleKeyDown: (_view, event) => slashKeyRef.current(event),
        // リンクは押すと外部のブラウザで開く（編集のカーソルは動かさない）
        handleClick: (_view, _pos, event) => {
          const href = clickedLinkHref(event.target)
          if (!href) return false
          event.preventDefault()
          void window.ade.invoke('app:openExternal', href).catch((err: unknown) => toastRef.current({ tone: 'warning', message: errorMessage(err) }))
          return true
        },
        handleTextInput: (_view, _from, _to, text) => slashTextRef.current(text)
      },
      onUpdate: ({ transaction }) => { if (transaction.docChanged) schedule() },
      onTransaction: () => refreshSlashRef.current(),
      onBlur: () => { slashRef.current = null; setSlash(null) }
    })
    editorRef.current = editor
    // チェックボックスにフォーカスを取らせない（取ると、次にクリックした箇所へカーソルが移らない）。切り替えはそのまま効く
    const keepFocus = (event: MouseEvent) => {
      if (event.target instanceof HTMLInputElement && event.target.type === 'checkbox') event.preventDefault()
    }
    host.addEventListener('mousedown', keepFocus, true)
    const unregister = registerDraftFlush(file.id, () => { if (timer.current !== undefined) commitRef.current() })
    // 落とした画像・動画を、落とした位置に埋め込む（受けるのは App の中央のペイン。markdownDrop.ts）
    const unregisterDrop = readOnly ? () => undefined : registerMarkdownDropTarget({
      path: file.path,
      element: () => host.closest<HTMLElement>('.rich-md-host'),
      insert: (media, point) => { if (editorRef.current === editor) insertMedia(editor, media, point) }
    })
    return () => {
      if (timer.current !== undefined) commitRef.current()
      unregister()
      unregisterDrop()
      host.removeEventListener('mousedown', keepFocus, true)
      editorRef.current = null
      slashRef.current = null
      setSlash(null)
      editor.destroy()
    }
    // revision はディスクの内容で差し替えたとき（外部の変更の取り込み・読み直し）に増える
  }, [file.id, file.revision, file.readOnly, extensions, codec])

  const onFrontmatter = (value: string) => {
    // 区切りの行と末尾の改行は保つ（消したら frontmatter ごと無くす）
    const next = value.trim() === '' ? '' : value.endsWith('\n') ? value : `${value}\n`
    setFrontmatter(value)
    frontmatterRef.current = next
    schedule()
  }

  return (
    <div className="rich-md-host" data-testid="rich-md">
      {hosts.length > 0 && (
        <div className="rich-md__banner" data-testid="rich-md-remote-banner">
          {t('preview.remoteImagesBlocked', { hosts: hosts.join(', ') })}
        </div>
      )}
      <div className="rich-md__page">
        {frontmatter !== '' && (
          <label className="rich-md__frontmatter">
            <span>{t('editor.frontmatter')}</span>
            <textarea
              value={frontmatter.replace(/\n$/, '')}
              rows={Math.min(12, frontmatter.split('\n').length)}
              spellCheck={false}
              readOnly={file.readOnly === true}
              onChange={(event) => onFrontmatter(event.target.value)}
              data-testid="rich-md-frontmatter"
            />
          </label>
        )}
        <div ref={hostRef} />
      </div>
      {slash && (
        <SlashMenu state={slash} items={slashItems} index={activeSlashIndex} onPick={(item) => pickSlash(slashItems.indexOf(item))} onHover={setSlashIndex} />
      )}
    </div>
  )
}
