/**
 * 0.6.8：オーケストレーター前提の画面
 * - ターミナルは全プロジェクトで隠しておき、エディタでは右下の小さなボタン、フィードバックでは右下の並びから出す
 * - 左のファイル一覧の開いているフォルダはプロジェクトごとに覚え、更新・再起動の後も戻す
 */
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { expandedStorageKey, parseExpanded, serializeExpanded } from '../../src/shared/fileTreeState'

const read = (p: string) => readFile(new URL(`../../${p}`, import.meta.url), 'utf8')

describe('ターミナルは右下に小さく（全プロジェクト）', () => {
  it('どのプロジェクトでも、押すまでターミナルを隠す。プロジェクトを切り替えても開いた状態を戻さない', async () => {
    const app = await read('src/renderer/App.tsx')
    expect(app).toMatch(/const layout = !terminalPeek \?/)
    expect(app).toContain("{mode === 'editor' && !terminalPeek && <button type=\"button\" className={`orchestra-peek")
    // 開いたあとの「ターミナルを閉じる」ボタンは出さない（右のファイルの欄と重なる）
    expect(app).not.toContain('orchestra.hideTerminal')
    expect(app).toContain("{mode === 'feedback' && <div className=\"orchestra-peeks\">")
    // 隠すのは人の操作（ターミナルの見出しのボタン）だけ。プロジェクトの切り替えなどでは戻さない
    expect(app.match(/setTerminalPeek\(false\)/g)).toEqual(['setTerminalPeek(false)'])
    expect(app).toContain('const hideTerminalPane = useCallback(() => setTerminalPeek(false), [])')
  })
})

describe('左のファイル一覧の開いているフォルダを覚える', () => {
  it('FileExplorer はプロジェクトごとの鍵で開閉を覚える', async () => {
    const explorer = await read('src/renderer/components/FileExplorer.tsx')
    expect(explorer).toContain("expandedKey: root ? expandedStorageKey('files', projectId ?? root) : null")
    expect(expandedStorageKey('files', 'p1')).toBe('ade.files.expanded.p1')
    expect([...parseExpanded(serializeExpanded(['src/a', 'src', 'docs']))]).toEqual(['docs', 'src', 'src/a'])
  })
})
