import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { createPortal } from 'react-dom'
import { Briefcase, FileCode, FileText, Globe, LayoutDashboard, ListChecks, Settings, X } from 'lucide-react'
import { applyOrder, moveItem } from '@shared/layout'
import { CountBadge } from '../ui'
import { useT } from '../lib/i18n'
import { fileTabId, type FileTabId, type OpenFile } from '../editor/useOpenFiles'
import { CLOSE_TABS_ACTIONS, tabsToClose, type CloseTabsAction } from '../editor/closeTabs'
import '../styles/editor.css'

/**
 * 中央ペインに並ぶタブ。ブラウザと指摘一覧と、開いたファイルを同じ場所で切り替える。
 * ファイルは `file:<プロジェクトの根>/<相対パス>`。
 */
/**
 * settings … 設定のページ（⌘, で開閉。開いている間だけタブを出す）。
 * business … ビジネスの画面（business.yaml のあるプロジェクト。ビジネスリサーチは上のモード切替で開く）
 */
export type CenterTab = 'dashboard' | 'business' | 'browser' | 'findings' | 'settings' | FileTabId

/** タブのドラッグで運ぶデータの種類（ほかの DnD と混ざらないように） */
const DRAG_TYPE = 'application/x-ade-center-tab'

export function isFileTab(tab: CenterTab): tab is FileTabId {
  return tab.startsWith('file:')
}

/**
 * 中央ペインのタブ列（32px）。
 *
 * 選択中は「2px の下線（ブランド）＋ごく薄い地の持ち上げ」で示す。
 * 「指摘」やファイルのタブを選ぶと内蔵ブラウザのビューを隠してDOMを出すので、
 * 呼び出し側は useViewBounds の visible を false にすること。
 *
 * Orca由来: ~/bench/orca/src/renderer/src/components/tab-bar/（MIT）の
 * 「ブラウザとファイルが同じタブ列に並び、未保存のファイルは × の代わりに点を出す（ホバーで ×）」使い心地。
 */
export function CenterTabs({
  active,
  pageTitle,
  findingCount,
  files = [],
  onChange,
  onCloseFile,
  onCloseFiles,
  onMenuOpenChange,
  order = [],
  onReorder,
  settingsOpen = false,
  dashboard = false,
  venture = null,
  onCloseSettings
}: {
  /** 先頭にビジネス（business）のタブを出す（src/renderer/business/ventureShell.tsx） */
  venture?: 'business' | null
  /** 全体（すべてのプロダクト）を開いている間だけ、先頭にダッシュボードのタブを出す */
  dashboard?: boolean
  active: CenterTab
  /** ブラウザタブに出すページ名 */
  pageTitle: string
  findingCount: number
  /** 開いているファイル（今のプロジェクトの分） */
  files?: OpenFile[]
  onChange: (tab: CenterTab) => void
  onCloseFile?: (id: string) => void
  /** 右クリックのメニューからまとめて閉じる（ファイルの id）。未保存の確認は呼び出し側 */
  onCloseFiles?: (ids: string[]) => void
  /** 右クリックのメニューの開閉。開いている間は内蔵ブラウザのビューを隠す（ネイティブのビューが DOM の上に重なるため） */
  onMenuOpenChange?: (open: boolean) => void
  /** タブの並び（ドラッグで並べ替えた順）。無いものは後ろに付く */
  order?: readonly string[]
  /** ドラッグで並べ替えたとき、新しい並びを返す */
  onReorder?: (order: CenterTab[]) => void
  /** 設定のページを開いているか（開いている間だけタブを出す） */
  settingsOpen?: boolean
  onCloseSettings?: () => void
}) {
  const t = useT()
  // Orca のタブ列と同じく、タブをドラッグして別のタブの前後へ落とすと並びが変わる
  const [drop, setDrop] = useState<{ id: CenterTab; before: boolean } | null>(null)
  // ファイルのタブの右クリックのメニュー（VS Code と同じ「閉じる」の並び。closeTabs.ts）
  const [menu, setMenu] = useState<{ tab: FileTabId; x: number; y: number } | null>(null)
  const menuOpenChange = useRef(onMenuOpenChange)
  menuOpenChange.current = onMenuOpenChange
  useEffect(() => {
    menuOpenChange.current?.(menu !== null)
  }, [menu !== null])
  useEffect(() => () => menuOpenChange.current?.(false), [])
  const closeMenu = useCallback(() => setMenu(null), [])
  const isDirty = (tab: string) => files.some((file) => fileTabId(file.id) === tab && file.dirty)
  const ids = [...(dashboard ? ['dashboard' as const] : []), ...(venture ? [venture] : []), ...applyOrder<CenterTab>(['browser', 'findings', ...(settingsOpen ? ['settings' as const] : []), ...files.map((file) => fileTabId(file.id))], order).filter((tab) => tab !== 'dashboard' && tab !== 'business')]
  const dragProps = (id: CenterTab) => onReorder ? {
    draggable: true,
    onDragStart: (e: DragEvent<HTMLElement>) => {
      e.dataTransfer.setData(DRAG_TYPE, id)
      e.dataTransfer.effectAllowed = 'move'
    },
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return
      e.preventDefault()
      const rect = e.currentTarget.getBoundingClientRect()
      const before = e.clientX < rect.left + rect.width / 2
      if (drop?.id !== id || drop.before !== before) setDrop({ id, before })
    },
    onDragLeave: () => setDrop(null),
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault()
      const from = e.dataTransfer.getData(DRAG_TYPE) as CenterTab
      const before = drop?.before ?? true
      setDrop(null)
      if (from) onReorder(moveItem(ids, from, id, before))
    },
    onDragEnd: () => setDrop(null),
    'data-drop': drop?.id === id ? (drop.before ? 'before' : 'after') : undefined
  } : {}

  return (
    <div className="ctabs" role="tablist" aria-label={t('centerTabs.label')}>
      <div className="ctabs__files">
          {ids.map((tab) => {
            if (tab === 'browser') return (
              <button
                key={tab}
                type="button"
                role="tab"
                className="ctab ctab--page"
                aria-selected={active === 'browser'}
                onClick={() => onChange('browser')}
                data-testid="ctab-browser"
                title={pageTitle || undefined}
                {...dragProps(tab)}
              >
                <Globe size={13} strokeWidth={1.75} />
                <span className="ctab__label">{pageTitle || t('centerTabs.browser')}</span>
              </button>
            )
            if (tab === 'dashboard') return (
              <button key={tab} type="button" role="tab" className="ctab" aria-selected={active === 'dashboard'} onClick={() => onChange('dashboard')} data-testid="ctab-dashboard">
                <LayoutDashboard size={13} strokeWidth={1.75} />
                <span className="ctab__label">{t('orchestra.dashboard')}</span>
              </button>
            )
            if (tab === 'business') return (
              <button key={tab} type="button" role="tab" className="ctab" aria-selected={active === 'business'} onClick={() => onChange('business')} data-testid="ctab-business">
                <Briefcase size={13} strokeWidth={1.75} />
                <span className="ctab__label">{t('centerTabs.business')}</span>
              </button>
            )
            if (tab === 'findings') return (
              <button
                key={tab}
                type="button"
                role="tab"
                className="ctab"
                aria-selected={active === 'findings'}
                onClick={() => onChange('findings')}
                data-testid="ctab-findings"
                {...dragProps(tab)}
              >
                <ListChecks size={13} strokeWidth={1.75} />
                <span className="ctab__label">{t('centerTabs.findings')}</span>
                <CountBadge count={findingCount} />
              </button>
            )
            if (tab === 'settings') return (
              <div
                key={tab}
                role="tab"
                tabIndex={0}
                className="ctab ctab--file"
                aria-selected={active === 'settings'}
                onClick={() => onChange('settings')}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange('settings') } }}
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseSettings?.() } }}
                data-testid="ctab-settings"
                {...dragProps(tab)}
              >
                <Settings size={13} strokeWidth={1.75} />
                <span className="ctab__label">{t('common.settings')}</span>
                <button
                  type="button"
                  className="ctab__close"
                  aria-label={t('centerTabs.closeSettings')}
                  onClick={(e) => { e.stopPropagation(); onCloseSettings?.() }}
                  data-testid="ctab-settings-close"
                >
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            )
            const file = files.find((f) => fileTabId(f.id) === tab)
            if (!file) return null
            const Icon = file.language === 'markdown' || file.language === 'plaintext' ? FileText : FileCode
            return (
              <div
                key={file.id}
                role="tab"
                tabIndex={0}
                className={`ctab ctab--file${file.dirty ? ' is-dirty' : ''}`}
                aria-selected={active === tab}
                title={file.dirty ? t('centerTabs.unsaved', { path: file.path }) : file.path}
                onClick={() => onChange(tab)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onChange(tab) } }}
                // 中クリックで閉じる（ブラウザ・エディタと同じ）
                onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); onCloseFile?.(file.id) } }}
                onContextMenu={onCloseFiles ? (e) => { e.preventDefault(); setMenu({ tab, x: e.clientX, y: e.clientY }) } : undefined}
                data-testid="ctab-file"
                data-path={file.path}
                {...dragProps(tab)}
              >
                <Icon size={13} strokeWidth={1.75} />
                <span className="ctab__label">{file.name}</span>
                <button
                  type="button"
                  className="ctab__close"
                  aria-label={t('centerTabs.close', { name: file.name })}
                  onClick={(e) => { e.stopPropagation(); onCloseFile?.(file.id) }}
                  data-testid="ctab-file-close"
                >
                  <span className="ctab__dirty" aria-hidden="true" />
                  <X size={12} strokeWidth={2} />
                </button>
              </div>
            )
          })}
      </div>
      {menu && onCloseFiles && (
        <TabMenu
          at={menu}
          enabled={(action) => tabsToClose(action, menu.tab, ids, isDirty).length > 0}
          onPick={(action) => {
            setMenu(null)
            onCloseFiles(tabsToClose(action, menu.tab, ids, isDirty).map((tab) => tab.slice('file:'.length)))
          }}
          onClose={closeMenu}
        />
      )}
    </div>
  )
}

/** ファイルのタブの右クリックのメニュー。外を押す・Esc で閉じる。↑↓で項目を移る。窓の端では内側へ寄せる */
function TabMenu({ at, enabled, onPick, onClose }: {
  at: { x: number; y: number }
  enabled: (action: CloseTabsAction) => boolean
  onPick: (action: CloseTabsAction) => void
  onClose: () => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: at.x, top: at.y })
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    const { width, height } = node.getBoundingClientRect()
    setPosition({
      left: Math.max(4, Math.min(at.x, window.innerWidth - width - 4)),
      top: Math.max(4, Math.min(at.y, window.innerHeight - height - 4))
    })
  }, [at.x, at.y])
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [])
  useEffect(() => {
    const down = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose() } }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])
  // body へ出す。中央のペインの中に置くと、祖先の封じ込め（@container など）で position: fixed がその枠の左上からになり、右クリックした場所からずれる
  return createPortal(
    <div
      ref={ref}
      className="sb-menu explorer-menu"
      role="menu"
      aria-label={t('centerTabs.menu.label')}
      style={position}
      data-testid="ctab-menu"
      onKeyDown={(e) => {
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
        e.preventDefault()
        const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])]
        const index = items.indexOf(document.activeElement as HTMLButtonElement)
        items[(index + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
      }}
    >
      {CLOSE_TABS_ACTIONS.map((action) => (
        <button key={action} type="button" role="menuitem" disabled={!enabled(action)} onClick={() => onPick(action)} data-testid={`ctab-menu-${action}`}>
          {t(`centerTabs.menu.${action}`)}
        </button>
      ))}
    </div>,
    document.body
  )
}
