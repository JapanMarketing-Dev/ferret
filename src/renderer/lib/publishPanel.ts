import { useSyncExternalStore } from 'react'

/**
 * 「発信」のパネルを開く口（どこからでも開けるように、App が1つだけ置く。components/PublishPanel.tsx）。
 * draftId を渡すとその下書きを選んで開き、sourceText を渡すと「この文章から AI で作る」を出す
 */
export interface PublishPanelRequest {
  draftId?: string
  sourceText?: string
  sourceLabel?: string
}

let current: PublishPanelRequest | null = null
const listeners = new Set<() => void>()
const emit = () => { for (const listener of listeners) listener() }

export function openPublishPanel(request: PublishPanelRequest = {}): void {
  current = { ...request }
  emit()
}

export function closePublishPanel(): void {
  current = null
  emit()
}

export function usePublishPanelRequest(): PublishPanelRequest | null {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => current)
}
