import { copyFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { build, type Plugin } from 'vite'

/**
 * 動画の撮影の録画ウインドウ（src/video/app/recorder/）を out/video-recorder/ に組み立てる Vite のプラグイン
 * （electron.vite.config.ts の main が使う。担当: 撮影）。Ferret の録画ウインドウ（recorderPagePlugin）と同じ形:
 * 非表示のウインドウの素朴なページなので、古い形式のスクリプト（IIFE）にして file:// でのモジュール読み込みと CSP の面倒を避ける。
 * 出力: index.html・recorder.js（取り込み）・pcm-worklet.js、region.html・region.js・region.css（範囲を選ぶ重ねたウインドウ）
 */
export function videoRecorderPlugin(root: string, sourcemap: boolean | 'hidden' = 'hidden'): Plugin {
  const src = resolve(root, 'src/video/app/recorder')
  const out = resolve(root, 'out/video-recorder')
  return {
    name: 'ferret-video-recorder-page',
    async closeBundle() {
      const entries = [
        { entry: 'recorder.ts', name: 'ferretVideoRecorderBundle', file: 'recorder.js' },
        { entry: 'region.ts', name: 'ferretVideoRegionBundle', file: 'region.js' }
      ]
      for (const [i, e] of entries.entries()) {
        await build({
          configFile: false,
          logLevel: 'warn',
          build: {
            outDir: out,
            // 1つ目のときだけ空にする（2つ目が1つ目を消さない）
            emptyOutDir: i === 0,
            sourcemap,
            lib: { entry: resolve(src, e.entry), formats: ['iife'], name: e.name, fileName: () => e.file }
          }
        })
      }
      mkdirSync(out, { recursive: true })
      for (const file of ['index.html', 'pcm-worklet.js', 'region.html', 'region.css']) copyFileSync(resolve(src, file), resolve(out, file))
    }
  }
}
