import { createElement, type FunctionComponent } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getLocale, translate, type MessageParams, type TranslationKey } from '../../src/shared/i18n'
import type { Project, ProjectsState, WorkspaceState } from '../../src/shared/types'

/**
 * ビジネスリサーチの画面で開いたファイル。エディタへ移らずに、同じ帯にタブで並べてその場で中身を出す
 */

vi.mock('../../src/renderer/lib/i18n', () => ({
  useT: () => (key: TranslationKey, params?: MessageParams) => translate(getLocale(), key, params),
  useLocale: () => getLocale()
}))
// 本文（リサーチの画面）は IPC を使うので、ここでは目印だけにする
vi.mock('../../src/renderer/research/ResearchWorkspace', () => ({
  ResearchWorkspace: () => createElement('div', { 'data-testid': 'research-body' })
}))

// tsconfig.test.json は JSX を持たないので、.tsx は型を通さず実行時に読む
const MODULE = '../../src/renderer/research/researchMode'
const { ResearchModeView } = (await import(/* @vite-ignore */ MODULE)) as { ResearchModeView: FunctionComponent<Record<string, unknown>> }

const research: Project = { id: 'r1', name: 'ビジネスリサーチ', folderPath: '/w/research', urls: [], research: true }
const projects = { projects: [research] } as unknown as ProjectsState
const workspace = { projectId: 'r1', folderPath: '/w/research' } as unknown as WorkspaceState
const tabs = [
  { id: '/w/research/research.yaml', name: 'research.yaml', path: 'research.yaml', dirty: false },
  { id: '/w/research/AGENTS.md', name: 'AGENTS.md', path: 'AGENTS.md', dirty: true }
]
const noop = () => undefined
const render = (files: Record<string, unknown> | undefined) =>
  renderToStaticMarkup(createElement(ResearchModeView, { projects, workspace, onOpenProject: noop, files }))

describe('ビジネスリサーチの画面で開いたファイル', () => {
  it('開いたファイルがあれば、その中身を出し、フォルダの帯にファイルのタブを並べる（未保存は ● 付き）', () => {
    const html = render({ tabs, activeId: tabs[0]!.id, onSelect: noop, onClose: noop, onShowResearch: noop, view: createElement('div', { 'data-testid': 'file-view' }) })
    expect(html).toContain('data-testid="file-view"')
    expect(html).not.toContain('data-testid="research-body"')
    expect(html).toContain('data-testid="research-mode-file-research.yaml"')
    expect(html).toContain('● AGENTS.md')
    // フォルダのタブは選ばれていない（ファイルを出している）
    expect(html).toMatch(/aria-selected="false"[^>]*data-testid="research-mode-folder-r1"/)
  })

  it('ファイルを出していない（activeId が null・閉じたファイル）ときはリサーチの画面', () => {
    for (const activeId of [null, '/w/research/closed.md']) {
      const html = render({ tabs, activeId, onSelect: noop, onClose: noop, onShowResearch: noop, view: createElement('div', { 'data-testid': 'file-view' }) })
      expect(html).toContain('data-testid="research-body"')
      expect(html).not.toContain('data-testid="file-view"')
      expect(html).toMatch(/aria-selected="true"[^>]*data-testid="research-mode-folder-r1"/)
    }
  })

  it('ファイルを開いていなければ、ファイルのタブも区切りも出さない', () => {
    const html = render(undefined)
    expect(html).toContain('data-testid="research-body"')
    expect(html).not.toContain('research-mode-file-')
    expect(html).not.toContain('rs-mode__sep')
  })
})
