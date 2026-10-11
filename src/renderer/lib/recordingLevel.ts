import { useSyncExternalStore } from 'react'

/**
 * 録画中のマイクのレベル（main から 100ms ごとに届く recording:level。0〜1）。
 * App の state に置くと、届くたびに画面全体を描き直す（録画中に1秒に10回）。
 * ここに置いて、メーターだけが読む
 */
let level = 0
const listeners = new Set<() => void>()

export function setRecordingLevel(next: number): void {
  if (!Number.isFinite(next) || next === level) return
  level = next
  for (const listener of listeners) listener()
}

export function subscribeRecordingLevel(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const recordingLevel = (): number => level

export function useRecordingLevel(): number {
  return useSyncExternalStore(subscribeRecordingLevel, recordingLevel, recordingLevel)
}
