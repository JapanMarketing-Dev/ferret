import { useEffect, useRef, useState } from 'react'
import { currentDockGroup, sameUrl, type DockGroup } from '@shared/dockGroups'
import { useT } from '../lib/i18n'
import { OrchestraComposer } from './OrchestraComposer'

/**
 * 全体のフィードバックの画面の帯（上の帯とブラウザの間）。タブは2段（@shared/dockGroups）：
 * 上の段はプロダクト、下の段はそのプロダクトの確認先（prd・local など）。押すとそのページへ移る。
 * 録画は止めないので、1回のフィードバックで全部のプロダクトを確かめられる。タブを切り替えると指摘の宛先もそのプロダクトに切り替わる
 * （送るときに main がページの URL でプロダクトごとに分ける。@shared/productSplit）。
 * 右端は開いているプロダクトへの文字のフィードバックの欄
 */
export function OrchestraDock({ groups, currentUrl, product, onOpen }: {
  groups: readonly DockGroup[]
  currentUrl: string
  /** 開いているページのプロダクト（右端の欄から送る文字のフィードバックの宛先） */
  product: { name: string; url?: string } | null
  onOpen: (url: string) => void
}) {
  const t = useT()
  const openGroup = currentDockGroup(groups, currentUrl)
  // 上の段で選んだプロダクト。開いているページが別のプロダクトへ移ったら、そちらに合わせる
  const [picked, setPicked] = useState<string | null>(openGroup)
  useEffect(() => { if (openGroup) setPicked(openGroup) }, [openGroup])
  const selected = groups.find((g) => g.id === picked) ?? groups.find((g) => g.id === openGroup) ?? groups[0]
  const lastUrl = useRef(new Map<string, string>())
  useEffect(() => { if (openGroup) lastUrl.current.set(openGroup, currentUrl) }, [openGroup, currentUrl])

  // タブが多いときは横に流す。開いているタブが見えるように寄せる
  const groupsRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    groupsRef.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    itemsRef.current?.querySelector('.is-current')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [currentUrl, selected?.id])

  /** 上の段：そのプロダクトで最後に開いたページ（無ければ最初の確認先）へ移る */
  const pickGroup = (group: DockGroup) => {
    setPicked(group.id)
    if (group.id === openGroup) return
    const last = lastUrl.current.get(group.id)
    onOpen(last && group.items.some((i) => sameUrl(i.url, last)) ? last : group.items[0]!.url)
  }

  return <div className="orchestra-dock" data-testid="orchestra-dock">
    <div className="orchestra-dock__row">
      <div ref={groupsRef} className="orchestra-dock__groups" role="tablist" aria-label={t('orchestra.dockLabel')}>
        {groups.map((group) => {
          return <button key={group.id} type="button" role="tab" aria-selected={group.id === selected?.id}
            className={`orchestra-dock__group${group.id === selected?.id ? ' is-selected' : ''}${group.id === openGroup ? ' is-current' : ''}`}
            onClick={() => pickGroup(group)} data-testid={`orchestra-group-${group.id}`}>
            <span className="orchestra-dock__label">{group.label}</span>
          </button>
        })}
      </div>
      <OrchestraComposer compact product={product} />
    </div>
    {selected && <div ref={itemsRef} className="orchestra-dock__items" role="tablist" aria-label={selected.label} data-testid="orchestra-dock-items">
      {selected.items.map((item) => (
        <button key={item.url} type="button" role="tab" aria-selected={sameUrl(item.url, currentUrl)}
          className={`orchestra-dock__chip${sameUrl(item.url, currentUrl) ? ' is-current' : ''}`} title={item.url}
          onClick={() => onOpen(item.url)} data-testid={`orchestra-chip-${selected.id}-${item.label}`}>
          <span className="orchestra-dock__label">{item.label}</span>
        </button>
      ))}
    </div>}
  </div>
}
