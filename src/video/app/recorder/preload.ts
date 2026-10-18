import { contextBridge, ipcRenderer } from 'electron'
import { RECORDER_CHANNELS as CH } from '../shared/record/channels'

/**
 * 動画の録画ウインドウと、範囲を選ぶ重ねたウインドウの preload。
 * アプリ本体の IPC（@shared/ipc）とは別系統で、撮影の制御だけを通す。main はどの知らせも送り主のウインドウを確かめる。
 */
const on = (channel: string) => (fn: (...args: unknown[]) => void) => {
  ipcRenderer.on(channel, (_event, ...args) => fn(...args))
}

contextBridge.exposeInMainWorld('ferretVideoRecorder', {
  onEnumerate: on(CH.enumerate),
  onPreview: on(CH.preview),
  onStart: on(CH.start),
  onMark: on(CH.mark),
  onStop: on(CH.stop),
  ready: () => ipcRenderer.send(CH.ready),
  devices: (devices: unknown) => ipcRenderer.send(CH.devices, devices),
  frame: (id: string, jpeg: ArrayBuffer) => ipcRenderer.send(CH.frame, id, jpeg),
  levels: (levels: unknown) => ipcRenderer.send(CH.levels, levels),
  open: (spec: unknown) => ipcRenderer.invoke(CH.open, spec),
  chunk: (file: string, data: ArrayBuffer) => ipcRenderer.send(CH.chunk, file, data),
  meta: (meta: unknown) => ipcRenderer.send(CH.meta, meta),
  started: (info: unknown) => ipcRenderer.send(CH.started, info),
  startFailed: (message: string) => ipcRenderer.send(CH.startFailed, message),
  stopped: (meta: unknown) => ipcRenderer.send(CH.stopped, meta),
  warning: (message: string) => ipcRenderer.send(CH.warning, message),
  regionDone: (rect: unknown) => ipcRenderer.send(CH.regionDone, rect)
})
