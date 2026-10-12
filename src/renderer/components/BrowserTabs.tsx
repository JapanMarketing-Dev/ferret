import { useEffect, useRef } from 'react'
import { Globe, LoaderCircle, Plus, X } from 'lucide-react'
import type { BrowserState } from '@shared/types'
import { MAX_BROWSER_TABS, browserTabKeyAction, canOpenTab, cycleTab, tabAtNumber, tabLabel } from '@shared/browserTabs'
import { SHORTCUTS } from '../lib/shortcut'
import { errorMessage } from '../lib/errors'
import { useToast } from '../ui'
import { useT } from '../lib/i18n'

/**
 * 内蔵ブラウザのタブの帯（@shared/browserTabs）。押すと前に出るタブが変わり、× で閉じる、＋ で空のタブを開いて URL 欄へ焦点を移す。
 * 右クリックで OS のメニュー（閉じる・ほかを閉じる・右側を閉じる・すべて閉じる。main の browser:tabMenu）。
 * エディタのブラウザのツールバーの上と、フィードバックモードの URL 欄の横に置く。
 *
 * ⌘1〜9 / Ctrl+Tab は、焦点がこの帯・URL 欄（data-browser-chrome の中）にあるときだけここで受ける。
 * ページに焦点があるときは main（browser.ts の before-input-event）が受ける
 */
export function BrowserTabs({
  state,
  onNewTab,
  testId = 'browser-tabs'
}: {
  state: BrowserState
  /** 新しいタブを開いたあと（URL 欄へ焦点を移す） */
  onNewTab?: () => void
  testId?: string
}) {
  const t = useT()
  const toast = useToast()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const tabs = state.tabs ?? []
  const active = state.activeTabId ?? ''

  const openNew = () => {
    void window.ade.invoke('browser:newTab').then(() => onNewTab?.()).catch((err) => toast({ tone: 'warning', message: errorMessage(err) }))
  }

  useEffect(() => {
    const ids = tabs.map((tab) => tab.id)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing || event.defaultPrevented) return
      const chrome = rootRef.current?.closest('[data-browser-chrome]')
      if (!chrome || !(event.target instanceof Node) || !chrome.contains(event.target)) return
      const action = browserTabKeyAction({ key: event.key, control: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey }, window.ade.platform)
      // ⌘T / ⌘W はメニュー（App の menu:command）が受ける
      if (!action || action.type === 'new' || action.type === 'close') return
      const next = action.type === 'number' ? tabAtNumber(ids, action.n) : cycleTab(ids, active, action.step)
      event.preventDefault()
      if (next && next !== active) void window.ade.invoke('browser:activateTab', next)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tabs, active])

  const full = !canOpenTab(tabs.length)
  return (
    <div ref={rootRef} className="browser-tabs" role="tablist" aria-label={t('browser.tabs.label')} data-testid={testId}>
      {tabs.map((tab, index) => {
        const label = tabLabel(tab) || t('browser.tabs.new')
        const selected = tab.id === active
        return (
          <div key={tab.id} className={`browser-tab${selected ? ' is-active' : ''}`} data-testid={`${testId}-tab-${index + 1}`} data-tab-id={tab.id}
            onContextMenu={(event) => { event.preventDefault(); void window.ade.invoke('browser:tabMenu', tab.id, { x: event.clientX, y: event.clientY }) }}
            title={tab.url && tab.url !== 'about:blank' ? `${label}\n${tab.url}` : label}>
            <button
              type="button"
              role="tab"
              className="browser-tab__main"
              aria-selected={selected}
              onClick={() => { if (!selected) void window.ade.invoke('browser:activateTab', tab.id) }}
              onAuxClick={(event) => { if (event.button === 1) void window.ade.invoke('browser:closeTab', tab.id) }}
            >
              {tab.loading
                ? <LoaderCircle size={12} strokeWidth={2} className="browser-tab__icon is-spinning" aria-hidden="true" />
                : <Globe size={12} strokeWidth={1.9} className="browser-tab__icon" aria-hidden="true" />}
              <span className="browser-tab__label">{label}</span>
            </button>
            <button
              type="button"
              className="browser-tab__close"
              aria-label={t('browser.tabs.close')}
              title={selected ? t('browser.tabs.closeWithKey', { key: SHORTCUTS.closeTerminal() }) : t('browser.tabs.close')}
              onClick={() => void window.ade.invoke('browser:closeTab', tab.id)}
              data-testid={`${testId}-close-${index + 1}`}
            >
              <X size={11} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className="browser-tabs__new"
        aria-label={t('browser.tabs.new')}
        title={full ? t('browser.tabs.limit', { n: MAX_BROWSER_TABS }) : t('browser.tabs.newWithKey', { key: SHORTCUTS.newTerminal() })}
        onClick={openNew}
        data-testid={`${testId}-new`}
      >
        <Plus size={14} strokeWidth={1.9} aria-hidden="true" />
      </button>
    </div>
  )
}
