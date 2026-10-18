/**
 * main ⇄ 動画の録画ウインドウ（src/video/app/recorder/）のチャネル。アプリ本体の IPC（@shared/ipc）とは混ぜない。
 * Ferret のレビューの録画ウインドウ（ade-recorder:）とも別。
 */
export const RECORDER_CHANNELS = {
  // main → 録画ウインドウ
  enumerate: 'ferret-video-rec:enumerate',
  preview: 'ferret-video-rec:preview',
  start: 'ferret-video-rec:start',
  mark: 'ferret-video-rec:mark',
  stop: 'ferret-video-rec:stop',
  // 録画ウインドウ → main
  ready: 'ferret-video-rec:ready',
  devices: 'ferret-video-rec:devices',
  frame: 'ferret-video-rec:frame',
  levels: 'ferret-video-rec:levels',
  /** invoke。トラックのファイルを開く */
  open: 'ferret-video-rec:open',
  chunk: 'ferret-video-rec:chunk',
  meta: 'ferret-video-rec:meta',
  started: 'ferret-video-rec:started',
  startFailed: 'ferret-video-rec:start-failed',
  stopped: 'ferret-video-rec:stopped',
  warning: 'ferret-video-rec:warning',
  // 範囲を選ぶ重ねたウインドウ → main
  regionDone: 'ferret-video-region:done'
} as const
