import { BrowserWindow, ipcMain, screen, type IpcMainEvent } from 'electron'
import { regionFromDip, type DisplayInfo, type Rect, type Region } from '../../shared/record/region'
import { RECORDER_CHANNELS as CH } from '../../shared/record/channels'

/**
 * 録画する範囲を選ぶ重ねたウインドウ（macOS のスクリーンショットの範囲選択と同じ操作）。ディスプレイ1枚を覆う、透明で枠の無い、
 * 常に手前のウインドウ。ページ（src/video/app/recorder/region.ts）はドラッグした DIP の長方形を返し、ここで実ピクセルにする。
 * 開けるのは1つだけ。閉じた（・別のものを開いた）ら、待っている選択は null で終える。旧 Solocut の main/services/regionPicker.ts から移した。
 * このウインドウは画面・カメラ・マイクに触れない（registerRecorderContents しない）。
 */

interface Pending {
  win: BrowserWindow
  display: DisplayInfo
  resolve: (r: Region | null) => void
}

let pending: Pending | null = null
let listening = false

export function listDisplays(): DisplayInfo[] {
  return screen.getAllDisplays().map((d) => ({
    id: String(d.id),
    bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height },
    scaleFactor: d.scaleFactor
  }))
}

/** 重ねたウインドウの答え。開いている重ねたウインドウからのものだけ受ける */
function onDone(event: IpcMainEvent, rect: unknown): void {
  if (!pending || pending.win.isDestroyed() || pending.win.webContents !== event.sender) return
  finish(isRect(rect) ? rect : null)
}

function isRect(v: unknown): v is Rect {
  const o = v as Record<string, unknown> | null
  return !!o && typeof o === 'object' && ['x', 'y', 'width', 'height'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]))
}

/** @param hint 重ねたウインドウの真ん中に出す案内（画面の言語。重ねたウインドウは辞書を持たない） */
export function pickRegion(displayId: string, page: { htmlPath: string; preloadPath: string }, hint: string): Promise<Region | null> {
  finish(null)
  const display = listDisplays().find((d) => d.id === displayId)
  if (!display) return Promise.reject(new Error(`display not found: ${displayId}`))
  if (!listening) {
    ipcMain.on(CH.regionDone, onDone)
    listening = true
  }
  const b = display.bounds
  const win = new BrowserWindow({
    ...b,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // macOS: メニューバーも覆う
    enableLargerThanScreen: true,
    show: false,
    title: 'Ferret — Region',
    webPreferences: { preload: page.preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  const p = new Promise<Region | null>((resolve) => {
    pending = { win, display, resolve }
  })
  win.on('closed', () => {
    if (pending?.win === win) finish(null)
  })
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return
    // macOS は新しいウインドウをメニューバーの下に置く。ディスプレイ全体の枠を入れ直す
    win.setBounds(b)
    win.show()
    win.focus()
  })
  void win.loadFile(page.htmlPath, { query: { hint } }).catch(() => finish(null))
  return p
}

function finish(rect: Rect | null): void {
  const p = pending
  if (!p) return
  pending = null
  const region = rect ? regionFromDip(rect, p.display) : null
  if (!p.win.isDestroyed()) p.win.close()
  p.resolve(region)
}

export function cancelPick(): void {
  finish(null)
}
