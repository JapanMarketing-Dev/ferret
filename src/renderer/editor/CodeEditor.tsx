import { useEffect, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { monaco } from './monacoSetup'
import { applyEditorTheme, useAppTheme } from './editorTheme'
import { registerModelDisposer, type OpenFilesApi, type OpenFile } from './useOpenFiles'
import { Spinner } from '../ui'

export type CodeEditorInstance = Parameters<OnMount>[0]

/** モデルの URI。プロジェクトの根を含めて、別のプロジェクトの同名ファイルと分ける */
function modelPath(file: OpenFile): string {
  return monaco.Uri.file(file.id).toString()
}

registerModelDisposer((id) => monaco.editor.getModel(monaco.Uri.file(id))?.dispose())

/**
 * ソースの編集（Monaco）。monaco-editor は数MBあるので、FileEditor からは React.lazy で、
 * ソースを開いたときだけ読む（Markdown のプレビュー・ビューアで開くファイルは Monaco を待たない）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/editor/EditorPanel.tsx（MIT）
 *   - エディタは1つだけ置き、タブを切り替えるとモデルを差し替える（undo とスクロール位置がタブごとに残る）
 */
export default function CodeEditor({ file, editor: api, wordWrap, onEditor, onChange }: {
  file: OpenFile
  editor: OpenFilesApi
  wordWrap: boolean
  /** 作った・消えたエディタ（FileEditor が「この箇所を編集」と、落とした画像の挿入に使う） */
  onEditor: (editor: CodeEditorInstance | null) => void
  onChange: (value: string) => void
}) {
  const theme = useAppTheme()
  const [themeName, setThemeName] = useState(() => applyEditorTheme(monaco, theme))
  const [instance, setInstance] = useState<CodeEditorInstance | null>(null)

  useEffect(() => setThemeName(applyEditorTheme(monaco, theme)), [theme])
  useEffect(() => () => onEditor(null), [])

  // ディスクの内容で差し替えた（外部の変更の取り込み・再読込）。undo で戻れるよう編集として入れる
  useEffect(() => {
    const model = monaco.editor.getModel(monaco.Uri.parse(modelPath(file)))
    const next = api.getDraft(file.id) ?? file.saved
    if (!model || model.getValue() === next) return
    // 全体を置き換えるとカーソルと選択が末尾へ飛ぶ。置き換えの前の位置・スクロールを戻す
    // （行が減っていれば Monaco が範囲の中に丸める。Orca #13756）
    const editor = instance?.getModel() === model ? instance : null
    const view = editor?.saveViewState() ?? null
    model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null)
    if (editor && view) editor.restoreViewState(view)
  }, [file.id, file.revision])

  return (
    <Editor
      path={modelPath(file)}
      defaultValue={api.getDraft(file.id) ?? file.saved}
      defaultLanguage={file.language}
      language={file.language}
      theme={themeName}
      loading={<Spinner size={18} />}
      onMount={(editor) => {
        setInstance(editor)
        onEditor(editor)
        // プレビューで編集した後に戻ってきたとき、モデルを編集中の内容に合わせる（undo で戻れるよう編集として入れる）
        const model = editor.getModel()
        const next = api.getDraft(file.id) ?? file.saved
        if (model && model.getValue() !== next) model.pushEditOperations([], [{ range: model.getFullModelRange(), text: next }], () => null)
      }}
      onChange={(value) => onChange(value ?? '')}
      options={{
        automaticLayout: true,
        fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim() || undefined,
        fontSize: 13,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        renderWhitespace: 'selection',
        tabSize: 2,
        wordWrap: wordWrap ? 'on' : 'off',
        contextmenu: true,
        // SSH のプロジェクトのファイルは読むだけ
        readOnly: file.readOnly === true,
        // 日本語の全角の括弧や記号を「紛らわしい文字」として枠で囲まない
        unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false },
        // Monaco 0.57 の既定（EditContext）では、Windows の Microsoft Pinyin などが候補窓を出さない。
        // 入力を従来の textarea で受ける（Orca #23360、microsoft/vscode#259380）
        editContext: false
      }}
    />
  )
}
