import { useEffect, useState } from 'react'
import { Send } from 'lucide-react'
import { useT } from '../lib/i18n'
import { openPublishPanel } from '../lib/publishPanel'

/** フッターの「発信」。未使用の下書きの数を出し、押すと発信のパネルを開く（components/PublishPanel.tsx） */
export function PublishStatusItem() {
  const t = useT()
  const [unused, setUnused] = useState<number | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => {
      void window.ade.invoke('publish:list').then(
        (snapshot) => { if (alive) setUnused(snapshot.drafts.filter((d) => d.status === 'new').length) },
        () => { if (alive) setUnused(null) }) // プロジェクトを開いていないなど（数を出さないだけ）
    }
    load()
    const off = window.ade.on('publish:changed', load)
    return () => { alive = false; off() }
  }, [])
  return <button type="button" className="statusbar__btn" title={t('publish.footerTitle', { count: unused ?? 0 })} onClick={() => openPublishPanel()} data-testid="statusbar-publish">
    <Send size={12} strokeWidth={2} aria-hidden="true" />
    <span className="statusbar__value">{t('publish.footer')}{unused ? ` ${unused}` : ''}</span>
  </button>
}
