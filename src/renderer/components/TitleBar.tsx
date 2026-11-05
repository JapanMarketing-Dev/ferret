import {
  MessageSquarePlus,
  MessageSquareQuote,
  PanelsTopLeft,
  Settings
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { AppMode, ProjectsState, WorkspaceState } from '@shared/types'
import { SHORTCUTS } from '../lib/shortcut'
import { Button, IconButton, Logo, RecordButton, Segmented, Tooltip } from '../ui'
import { ProjectMenu } from './ProjectMenu'
import { LayoutToggles } from './LayoutToggles'
import { useT } from '../lib/i18n'

/**
 * タイトルバー（36px）。ウィンドウをドラッグできる帯。
 *
 * 並びはベンチのADEに合わせる:
 *   左  … ロゴ / プロジェクト名（押すとプロジェクト一覧・切替・追加）
 *   中央… モード切替
 *   右  … パネルの開閉（左のプロジェクト一覧・右のファイルツリー・ブラウザに集中。VS Code と同じ位置）/ ● 録画 / 設定
 *
 * macOS の信号機ボタンぶんの余白は CSS の --titlebar-inset が持つ。
 * ツールチップは下向き（下にあるのはタブ列＝DOMなので隠れない）。
 */
export function TitleBar({
  workspace,
  projects,
  mode,
  recording,
  onChangeMode,
  onProjectMenuChange,
  onToggleRecording,
  onOpenSettings,
  onFocusBrowser,
  busy = false,
  noteMode = false,
  noteDisabled = false,
  onToggleNote,
  round
}: {
  workspace: WorkspaceState
  projects: ProjectsState
  mode: AppMode
  recording: boolean
  onChangeMode: (mode: AppMode) => void
  /** プロジェクト一覧の開閉。開いている間は内蔵ブラウザのビューを隠す */
  onProjectMenuChange?: (open: boolean) => void
  onToggleRecording: () => void
  onOpenSettings?: () => void
  /** ブラウザに集中し始めたとき（中央のタブをブラウザへ） */
  onFocusBrowser?: () => void
  busy?: boolean
  /** 文字で指摘（録画の右。音声の代わりに枠と文字で指摘する）。押せないとき（録画中・プロジェクト未選択）は disabled */
  noteMode?: boolean
  noteDisabled?: boolean
  onToggleNote?: () => void
  /** 巡回の帯（RoundBar）。巡回していなければ無い */
  round?: ReactNode
}) {
  const t = useT()
  return (
    <header className="titlebar" data-testid="topbar">
      <div className="titlebar__left">
        <span className="titlebar__logo">
          <Logo size={18} />
        </span>
        <span className="titlebar__sep" aria-hidden="true" />

        <ProjectMenu workspace={workspace} projects={projects} onOpenChange={onProjectMenuChange} />
      </div>

      <div className="titlebar__center">
        <Segmented
          ariaLabel={t('titleBar.mode')}
          value={mode}
          onChange={onChangeMode}
          options={[
            {
              value: 'editor',
              label: t('titleBar.editor'),
              icon: <PanelsTopLeft size={13} strokeWidth={1.75} />,
              testId: 'mode-editor',
              title: t('titleBar.editorTitle', { key: SHORTCUTS.toggleMode() })
            },
            {
              value: 'feedback',
              label: t('titleBar.feedback'),
              icon: <MessageSquareQuote size={13} strokeWidth={1.75} />,
              testId: 'mode-feedback',
              title: t('titleBar.feedbackTitle', { key: SHORTCUTS.toggleMode() })
            }
          ]}
        />
        {round}
      </div>

      <div className="titlebar__right">
        <LayoutToggles onFocusBrowser={onFocusBrowser} />
        <RecordButton
          recording={recording}
          disabled={busy}
          onClick={onToggleRecording}
          data-testid="record-button"
        />
        {onToggleNote && (
          <Tooltip label={noteMode ? t('textNote.button.stopTitle') : t('textNote.button.title')}>
            <Button
              variant="ghost"
              className="titlebar__note"
              icon={<MessageSquarePlus size={14} strokeWidth={1.75} aria-hidden="true" />}
              selected={noteMode}
              disabled={noteDisabled && !noteMode}
              onClick={onToggleNote}
              data-testid="titlebar-text-note"
            >
              {t('textNote.button.label')}
            </Button>
          </Tooltip>
        )}
        <Tooltip label={t('common.settings')}>
          <IconButton
            label={t('common.settings')}
            icon={<Settings size={14} strokeWidth={1.75} />}
            onClick={onOpenSettings}
            data-testid="settings-button"
          />
        </Tooltip>
      </div>
    </header>
  )
}
