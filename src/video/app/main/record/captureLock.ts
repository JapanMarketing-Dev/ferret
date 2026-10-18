/**
 * 動画の撮影中（カウントダウンから止め終わるまで）か。Ferret のレビューの録画は、これが true の間は始めない
 * （src/main/index.ts の録画の開始が見る）。逆向き（レビューの録画中は撮影を始めない）は撮影の session が VideoMainContext で確かめる。
 * Electron に依存しない小さいファイル（main の起動時に読んでも重くならない）。
 */
let active = false

export function videoCaptureActive(): boolean {
  return active
}

export function setVideoCaptureActive(value: boolean): void {
  active = value
}
