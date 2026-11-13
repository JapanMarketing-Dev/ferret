/// <reference types="vite/client" />
import { loader } from '@monaco-editor/react'
import * as api from 'monaco-editor/editor/editor.api'
import * as json from 'monaco-editor/languages/features/json/register'
import * as typescript from 'monaco-editor/languages/features/typescript/register'
// 色付けの文法（言語ごとに小さな登録だけで、文法の本体は、その言語のファイルを開いたときに別のファイルから読む）
import 'monaco-editor/languages/definitions/register.all'
// エディタの機能。`monaco-editor`（全部入り）から、コードの確認と軽い編集に使うものだけを選ぶ
import 'monaco-editor/features/codeEditor/register'
import 'monaco-editor/editor/browser/coreCommands'
import 'monaco-editor/features/codicon/register'
// 読み込み中の回転などの印（.css は package.json の exports に無いので、パスで指す）
import '../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css'
import 'monaco-editor/features/bracketMatching/register'
import 'monaco-editor/features/caretOperations/register'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations'
import 'monaco-editor/features/clipboard/register'
import 'monaco-editor/features/comment/register'
import 'monaco-editor/features/contextmenu/register'
import 'monaco-editor/features/cursorUndo/register'
import 'monaco-editor/features/dnd/register'
import 'monaco-editor/features/dropOrPasteInto/register'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution'
import 'monaco-editor/features/find/register'
import 'monaco-editor/features/folding/register'
import 'monaco-editor/features/fontZoom/register'
import 'monaco-editor/features/format/register'
import 'monaco-editor/features/gotoError/register'
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus'
import 'monaco-editor/features/gotoLine/register'
import 'monaco-editor/features/hover/register'
import 'monaco-editor/features/indentation/register'
import 'monaco-editor/features/inlineProgress/register'
import 'monaco-editor/features/insertFinalNewLine/register'
import 'monaco-editor/features/lineSelection/register'
import 'monaco-editor/features/linesOperations/register'
import 'monaco-editor/features/links/register'
import 'monaco-editor/features/multicursor/register'
import 'monaco-editor/features/parameterHints/register'
import 'monaco-editor/features/quickCommand/register'
import 'monaco-editor/features/readOnlyMessage/register'
import 'monaco-editor/features/smartSelect/register'
import 'monaco-editor/features/snippet/register'
import 'monaco-editor/features/suggest/register'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController'
import 'monaco-editor/features/toggleTabFocusMode/register'
import 'monaco-editor/features/tokenization/register'
import 'monaco-editor/features/unicodeHighlighter/register'
import 'monaco-editor/features/unusualLineTerminators/register'
import 'monaco-editor/features/wordHighlighter/register'
import 'monaco-editor/features/wordOperations/register'
import 'monaco-editor/features/wordPartOperations/register'
import 'monaco-editor/editor/common/standaloneStrings'
import editorWorker from 'monaco-editor/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/language/json/json.worker?worker'
import tsWorker from 'monaco-editor/language/typescript/ts.worker?worker'
import { reportHandled } from '@shared/report'

/**
 * Monaco を同梱の版で動かす準備（CDN からは読まない。オフラインでも動く）。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/lib/monaco-setup.ts（MIT）
 *   - worker は Vite の ?worker で同梱し、言語ごとに振り分ける
 *   - TypeScript の型検査は切る（プロジェクトの import を解決できず、偽の赤線だらけになる）
 *   - loader.config({ monaco }) で @monaco-editor/react に同梱の monaco を使わせる
 * monaco-editor 0.57 は package.json の exports が `./*` → `./esm/vs/*.js` なので、
 * worker の指定は Orca（0.55）の `monaco-editor/esm/vs/...` ではなく `monaco-editor/...` にする。
 *
 * 軽くするため、`monaco-editor`（全部入り）ではなく editor.api と使う機能だけを読む。
 *   - 文法（色付け）… 全言語の登録だけを読む（本体は言語ごとに別のファイルで、開いたときに読む）
 *   - 言語の機能（補完・検査の worker）… TypeScript / JavaScript（構文の赤線と補完）と JSON（settings.json のスキーマ）だけ。
 *     CSS / HTML の言語の機能（補完・検査）は持たない（色付けは残る）。worker だけで 1MB 超あり、設定もしていなかったため
 *   - エディタの機能 … 検索・置換、折りたたみ、補完、ホバー、括弧の対応、コメント、複数カーソル、行の操作、
 *     書式、行へ移動、コマンドパレットなど。差分・インライン補完・GPU・定義へ移動・名前の変更・参照の検索・
 *     コードアクション・インレイヒント・色の選択・固定スクロールは外した
 */

/** worker の中の例外は renderer の window には上がってこないので、ここで Sentry へ知らせる */
function watched(worker: Worker, label: string): Worker {
  worker.addEventListener('error', (event) => {
    reportHandled(new Error(`monaco ${label} worker: ${event.message}`), { area: 'editor', op: 'monaco worker' })
  })
  return worker
}

globalThis.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    switch (label) {
      case 'json':
        return watched(new jsonWorker(), 'json')
      case 'typescript':
      case 'javascript':
        return watched(new tsWorker(), 'typescript')
      default:
        return watched(new editorWorker(), 'editor')
    }
  }
}

/** これまでの `import * as monaco from 'monaco-editor'` と同じ形（editor・languages・Uri など＋json・typescript） */
const monaco = { ...api, json, typescript }

const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: false
}
monaco.typescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
monaco.typescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
// .tsx / .jsx も同じ言語 ID なので、JSX を許さないと全タグに TS17004 が出る
monaco.typescript.typescriptDefaults.setCompilerOptions({
  ...monaco.typescript.typescriptDefaults.getCompilerOptions(),
  jsx: monaco.typescript.JsxEmit.Preserve
})
monaco.typescript.javascriptDefaults.setCompilerOptions({
  ...monaco.typescript.javascriptDefaults.getCompilerOptions(),
  jsx: monaco.typescript.JsxEmit.Preserve
})

// Markdown の ```bash / ```zsh のコードに色を付ける。Monaco 0.57 の shell の別名は Shell / sh だけ（Orca #20584）。
// 同じ id の登録は別名が足されるだけで、文法はそのまま
monaco.languages.register({ id: 'shell', aliases: ['bash', 'zsh', 'console'] })

loader.config({ monaco })

export { monaco }
