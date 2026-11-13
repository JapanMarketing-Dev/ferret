import type { CaptureSourceInfo, CaptureSourceList } from './types'

/**
 * フィードバックの「ワンクリック録画」（押したらすぐ、Ferret の窓がある画面の全体を録る）の決め方。
 * 対象の選択画面・確認は出さない。Electron に依存しない純粋な処理だけを置く（main と単体テストで共用）。
 */

/**
 * 画面収録の許可の状態から、次にすること。
 *   start    … そのまま録り始める（許可あり。'unknown' も試す。だめなら録画側がエラーを出す）
 *   ask      … まだ聞いていない。OS の確認を1回だけ出し（desktopCapturer を呼ぶと出る）、許可されたら押し直してもらう
 *   settings … 断られている。システム設定の「画面収録」を開いて案内する
 */
export type QuickScreenStep = 'start' | 'ask' | 'settings'

export function quickScreenStep(access: CaptureSourceList['screenAccess']): QuickScreenStep {
  if (access === 'not-determined') return 'ask'
  if (access === 'denied' || access === 'restricted') return 'settings'
  return 'start'
}

/**
 * Ferret の窓があるディスプレイ（displayId）の「画面全体」の候補。
 * 見つからなければ（ID がずれた・1枚しかないのに ID が無い等）最初の画面。画面が1つも無ければ null
 */
export function screenSourceForDisplay(sources: readonly CaptureSourceInfo[], displayId: string | undefined): CaptureSourceInfo | null {
  const screens = sources.filter((source) => source.kind === 'screen')
  if (screens.length === 0) return null
  if (displayId) {
    const match = screens.find((source) => source.displayId === displayId)
    if (match) return match
  }
  return screens[0]!
}
