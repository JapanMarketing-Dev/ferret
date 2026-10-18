import type { StreamCrop } from '../shared/record/region'

/**
 * 画面の映像を、録る範囲（設定 record.region）だけに切り抜く。画面のトラックのフレームを canvas に切り抜いて描き、
 * その captureStream() を MediaRecorder で録る。フレームは MediaStreamTrackProcessor があればそれで受け
 * （取り込みに合わせて動き、requestAnimationFrame と違って非表示でも止まらない）、無ければ隠した <video> をタイマーで読む。
 * 旧 Solocut の lib/crop.ts から移した。
 */

export interface CroppedTrack {
  track: MediaStreamTrack
  stop: () => void
}

type Processor = new (o: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }

export function cropVideoTrack(src: MediaStreamTrack, crop: StreamCrop, fps: number): CroppedTrack {
  const canvas = document.createElement('canvas')
  canvas.width = crop.width
  canvas.height = crop.height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('canvas 2d context unavailable')
  const out = canvas.captureStream(fps).getVideoTracks()[0]
  if (!out) throw new Error('canvas capture unavailable')
  let stopped = false
  const draw = (img: CanvasImageSource, w: number, h: number) => {
    if (w <= 0 || h <= 0) return
    ctx.drawImage(img, crop.fx * w, crop.fy * h, crop.fw * w, crop.fh * h, 0, 0, crop.width, crop.height)
  }

  const MSTP = (globalThis as unknown as { MediaStreamTrackProcessor?: Processor }).MediaStreamTrackProcessor
  let cleanup: () => void
  if (MSTP) {
    // 複製を読む（読み終えてもプレビューのトラックを終わらせない）
    const clone = src.clone()
    const reader = new MSTP({ track: clone }).readable.getReader()
    void (async () => {
      while (!stopped) {
        const r = await reader.read().catch(() => ({ done: true, value: undefined }) as const)
        if (r.done || !r.value) break
        const f = r.value
        try {
          if (!stopped) draw(f, f.displayWidth, f.displayHeight)
        } finally {
          f.close()
        }
      }
    })()
    cleanup = () => {
      void reader.cancel().catch(() => undefined)
      clone.stop()
    }
  } else {
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.srcObject = new MediaStream([src])
    void video.play().catch(() => undefined)
    const timer = window.setInterval(() => {
      if (video.readyState >= 2) draw(video, video.videoWidth, video.videoHeight)
    }, 1000 / Math.max(1, fps))
    cleanup = () => {
      window.clearInterval(timer)
      video.srcObject = null
    }
  }
  return {
    track: out,
    stop: () => {
      if (stopped) return
      stopped = true
      cleanup()
      out.stop()
    }
  }
}
