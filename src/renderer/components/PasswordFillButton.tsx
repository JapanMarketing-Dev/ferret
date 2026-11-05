import { useEffect, useState, type MouseEvent } from 'react'
import { KeyRound } from 'lucide-react'
import type { BrowserState } from '@shared/types'
import type { PageLogins } from '@shared/browserImport'
import { IconButton, Tooltip, useToast } from '../ui'
import { errorMessage } from '../lib/errors'
import { useT } from '../lib/i18n'

const NONE: PageLogins = { origin: '', hasPasswordField: false, accounts: [] }

/**
 * 表示中のタブのページに使える、取り込んだパスワード（ユーザー名だけ）。ページを読み終えるたび・タブを替えるたび・
 * 取り込み直したとき（passwords:changed）・窓に戻ったときに main へ聞く。
 * 照合（オリジン・同じサイト）も、ページにパスワードの欄があるかを調べるのも main（src/main/browserImport/ipc.ts）
 */
function usePageLogins(state: BrowserState): PageLogins {
  const [logins, setLogins] = useState<PageLogins>(NONE)
  const [changed, setChanged] = useState(0)
  useEffect(() => {
    const bump = () => setChanged((n) => n + 1)
    const off = window.ade.on('passwords:changed', bump)
    window.addEventListener('focus', bump)
    return () => { off(); window.removeEventListener('focus', bump) }
  }, [])
  useEffect(() => {
    if (state.loading) return
    let alive = true
    void window.ade.invoke('passwords:forPage').then((next) => { if (alive) setLogins(next?.accounts ? next : NONE) }).catch(() => { if (alive) setLogins(NONE) }) // 失敗は main の IPC が Sentry へ送る
    return () => { alive = false }
  }, [state.url, state.loading, state.activeTabId, changed])
  return logins
}

/**
 * ツールバーの鍵のボタン。取り込んだパスワードがこのページ（スキーム・ホスト・ポートが一致。www の有無は同じとみなす。
 * http で保存したものは https でも使う）か、同じサイトの別のサブドメインにあるときだけ出る。
 * 1件なら押すとすぐ入れる。複数ならネイティブのメニュー（内蔵ブラウザのビューの上にも出る）で選ぶ。
 * パスワードは画面に来ない。選んだ id を main へ送り、main がページのオリジンを確かめてから入れる
 */
export function PasswordFillButton({ state, className }: { state: BrowserState; className?: string }) {
  const t = useT()
  const toast = useToast()
  const logins = usePageLogins(state)
  if (logins.accounts.length === 0) return null

  const done = (filled: number | boolean) => {
    if (filled === 0 || filled === false) toast({ tone: 'warning', message: t('browserImport.passwords.nothingFilled') })
  }
  const open = (event: MouseEvent<HTMLButtonElement>) => {
    // 同じオリジンの1件だけならすぐ入れる。別のサブドメインのもの（site）は、メニューでホスト名を見て選んでから
    const only = logins.accounts.length === 1 && !logins.accounts[0]!.site ? logins.accounts[0] : null
    if (only) {
      void window.ade.invoke('passwords:fill', only.id).then(done).catch((err: unknown) => toast({ tone: 'warning', message: errorMessage(err) }))
      return
    }
    const rect = event.currentTarget.getBoundingClientRect()
    void window.ade.invoke('passwords:menu', { x: rect.left, y: rect.bottom })
      .then((choice) => {
        // 「取り込みを管理」は設定のページの取り込みの節へ
        if (choice === 'manage') window.dispatchEvent(new CustomEvent('ade:open-settings', { detail: { section: 'browserImport' } }))
      })
      .catch((err: unknown) => toast({ tone: 'warning', message: errorMessage(err) }))
  }
  const label = logins.accounts.length === 1 && !logins.accounts[0]!.site
    ? t('browser.fillPasswordAs', { user: logins.accounts[0]!.username || t('browserImport.passwords.noUsername') })
    : t('browser.fillPassword')
  return <Tooltip label={logins.hasPasswordField ? label : `${label} — ${t('browser.fillPasswordNoField')}`} side="top">
    <IconButton label={label} className={className} icon={<KeyRound size={15} strokeWidth={1.75} />} onClick={open} data-testid="browser-fill-password" />
  </Tooltip>
}
