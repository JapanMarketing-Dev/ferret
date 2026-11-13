/*
 * Office の文書（OfficeViewer で編集している Excel・Word・PowerPoint）の、保存していない直しと保存の口。
 *
 * 直しはタブを切り替えて OfficeViewer が消えても残るよう、ここ（タブの id ごと）に持つ。
 * useOpenFiles の save（⌘S・閉じるときの「保存」・終了の「保存して終了」）は、表に出ていないタブでもここから保存する。
 * タブを閉じたら forgetOffice で捨てる。
 */
const savers = new Map<string, () => Promise<void>>()
const sessions = new Map<string, unknown>()
const listeners = new Map<string, (session: unknown) => void>()

export function registerOfficeSaver(id: string, save: () => Promise<void>): () => void {
  savers.set(id, save)
  return () => { if (savers.get(id) === save) savers.delete(id) }
}

export function officeSaverFor(id: string): (() => Promise<void>) | undefined {
  return savers.get(id)
}

export function officeSession<T>(id: string): T | undefined {
  return sessions.get(id) as T | undefined
}

/** 持っている直しを差し替える。notify なら表に出ている OfficeViewer にも知らせる（保存の後など） */
export function setOfficeSession<T>(id: string, session: T, notify = false): void {
  sessions.set(id, session)
  if (notify) listeners.get(id)?.(session)
}

export function subscribeOfficeSession<T>(id: string, listener: (session: T) => void): () => void {
  const wrapped = listener as (session: unknown) => void
  listeners.set(id, wrapped)
  return () => { if (listeners.get(id) === wrapped) listeners.delete(id) }
}

/** タブを閉じた。直しと保存の口を捨てる */
export function forgetOffice(id: string): void {
  savers.delete(id)
  sessions.delete(id)
  listeners.delete(id)
}
