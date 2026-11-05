import { resolve } from 'node:path'
import { copyFileSync, mkdirSync } from 'node:fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { build, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const shared = resolve(__dirname, 'src/shared')
const recorderSrc = resolve(__dirname, 'src/recorder')
const recorderOut = resolve(__dirname, 'out/recorder')
/**
 * 配布版のスタックトレースを Sentry で読むためのソースマップ。
 * hidden なので JS に sourceMappingURL は書かず、.map は配布物に入れない（electron-builder の files で .map を除いている）。
 * scripts/sentry-sourcemaps.mjs が out/ の .map を Sentry へ上げる。
 */
const sourcemap = 'hidden' as const

/**
 * 録画用ウィンドウ（設計4章）の中身を組み立てる。
 *
 * electron-vite の設定は main / preload / renderer の3つしか持てず、
 * renderer のルートは `src/renderer` に固定したい（そこの index.html が
 * `/main.tsx` を絶対パスで読んでいるため、ルートを動かすと壊れる）。
 * そこで録画ページだけ Vite を直接呼んで別に組み立てる。
 *
 * 出力は `out/recorder/`。`recorderWindow.ts` が `out/main` からの相対で読む。
 * 非表示ウィンドウの素朴な1ページなので、古い形式のスクリプト（IIFE）にして
 * file:// でのモジュール読み込みと CSP の面倒を避ける。
 */
function recorderPagePlugin(): Plugin {
  return {
    name: 'ade-recorder-page',
    async closeBundle() {
      await build({
        configFile: false,
        logLevel: 'warn',
        build: {
          outDir: recorderOut,
          emptyOutDir: true,
          // 録画ウインドウのスタックも Sentry で元の行に戻せるように（.map は配布物に入らない）
          sourcemap,
          lib: {
            entry: resolve(recorderSrc, 'recorder.ts'),
            formats: ['iife'],
            name: 'adeRecorderBundle',
            fileName: () => 'recorder.js'
          }
        }
      })
      mkdirSync(recorderOut, { recursive: true })
      for (const file of ['index.html', 'pcm-worklet.js', 'mirror.html', 'mirror.css', 'mirror.js']) {
        copyFileSync(resolve(recorderSrc, file), resolve(recorderOut, file))
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), recorderPagePlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      sourcemap,
      // 起動時間（NF-5）のため、メインプロセスは単一ファイルに固め、
      // 録画・分解・セッション一覧は動的 import で遅延読み込みする。
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: {
      sourcemap,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // 録画用ウィンドウの preload
          recorder: resolve(__dirname, 'src/preload/recorder.ts'),
          // レビュー対象ページへ入れる注入スクリプト（操作ログ・ペン・テキスト）
          review: resolve(__dirname, 'src/preload/review.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: { alias: { '@shared': shared, '@': resolve(__dirname, 'src/renderer') } },
    build: {
      sourcemap,
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } }
    }
  }
})
