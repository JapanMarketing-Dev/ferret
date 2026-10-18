/**
 * 録画する範囲を選ぶ重ねたウインドウの中身（main/record/regionPicker.ts）。四角をドラッグする。選んだ外は暗くし、大きさを実ピクセルで出す。
 * 離す・Enter で決め、Esc・右クリックでやめる。答えはドラッグした DIP の長方形（main が実ピクセルにする）。旧 Solocut の RegionPicker.tsx から移した。
 */
import { dragRect, type Rect } from '../shared/record/region'

export {}

/** これより短い（DIP）ドラッグはクリックとみなす */
const MIN_DRAG = 8

const bridge = (window as unknown as { ferretVideoRecorder: { regionDone(rect: Rect | null): void } }).ferretVideoRecorder
const dim = document.getElementById('dim')!
const sel = document.getElementById('sel')!
const size = document.getElementById('size')!
const hint = document.getElementById('hint')!
hint.textContent = new URLSearchParams(location.search).get('hint') ?? ''
if (!hint.textContent) hint.hidden = true

let start: { x: number; y: number } | null = null
let rect: Rect | null = null
let done = false

const limit = () => ({ width: window.innerWidth, height: window.innerHeight })
const bigEnough = (r: Rect | null): r is Rect => !!r && r.width >= MIN_DRAG && r.height >= MIN_DRAG

function finish(r: Rect | null): void {
  if (done) return
  done = true
  bridge.regionDone(r)
}

function draw(): void {
  const r = rect
  if (!r || r.width <= 0 || r.height <= 0) {
    sel.hidden = true
    dim.hidden = false
    return
  }
  dim.hidden = true
  sel.hidden = false
  sel.style.left = `${r.x}px`
  sel.style.top = `${r.y}px`
  sel.style.width = `${r.width}px`
  sel.style.height = `${r.height}px`
  const dpr = window.devicePixelRatio || 1
  size.textContent = `${Math.round(r.width * dpr)} × ${Math.round(r.height * dpr)}`
}

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return
  start = { x: e.clientX, y: e.clientY }
  rect = { x: e.clientX, y: e.clientY, width: 0, height: 0 }
  hint.hidden = true
  draw()
})
window.addEventListener('mousemove', (e) => {
  if (!start) return
  rect = dragRect(start, { x: e.clientX, y: e.clientY }, limit())
  draw()
})
window.addEventListener('mouseup', (e) => {
  if (!start) return
  const r = dragRect(start, { x: e.clientX, y: e.clientY }, limit())
  start = null
  if (bigEnough(r)) finish(r)
  else {
    rect = null
    draw()
  }
})
window.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  finish(null)
})
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') finish(null)
  else if (e.key === 'Enter' && bigEnough(rect)) finish(rect)
})
