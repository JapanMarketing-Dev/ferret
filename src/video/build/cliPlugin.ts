import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'
import { build, type Plugin } from 'vite'
import { VIDEO_CLI } from '../names'

/**
 * `ferret-video` CLI（src/video/cli）を out/video-cli/ にまとめる Vite のプラグイン（electron.vite.config.ts の main が使う。担当: CLI）。
 * 組み込みのテンプレートも out/video-cli/templates/ へ写す。
 *
 * 出力は ESM の1ファイル（zod・yaml・budoux も中に入れる。Node の組み込みだけ外）。アプリは内蔵ターミナルのラッパー
 * （src/video/app/main/cli/env.ts）から ELECTRON_RUN_AS_NODE=1 の Electron で動かす。配布版では asar の外（app.asar.unpacked）に置く。
 */
export function videoCliPlugin(root: string): Plugin {
  return {
    name: 'ferret-video-cli',
    apply: 'build',
    async closeBundle() {
      await buildVideoCli({ root, outDir: resolve(root, 'out', 'video-cli') })
    }
  }
}

export interface BuildVideoCliOptions {
  /** リポジトリの根（src/video がある所） */
  root: string
  /** 出力先（ferret-video.mjs と templates/ を作る） */
  outDir: string
}

/** 先頭に入れる文。ESM でも CommonJS の依存が require を使えるようにする（旧 scripts/build-cli.mjs と同じ） */
export function cliBanner(version: string): string {
  return [
    `// ${VIDEO_CLI} (Ferret ${version}) — bundled by src/video/build/cliPlugin.ts. Do not edit.`,
    "import { createRequire as __ferretVideoCreateRequire } from 'node:module';",
    'const require = __ferretVideoCreateRequire(import.meta.url);'
  ].join('\n')
}

/** Node の組み込み（node:fs・fs など）。まとめずに外に置く */
export const NODE_BUILTINS: readonly string[] = [...builtinModules, ...builtinModules.map((m) => `node:${m}`)]

export async function buildVideoCli(o: BuildVideoCliOptions): Promise<{ bundle: string; templatesDir: string; bytes: number }> {
  const video = resolve(o.root, 'src', 'video')
  const version = (JSON.parse(readFileSync(resolve(o.root, 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  const bundle = join(o.outDir, `${VIDEO_CLI}.mjs`)
  mkdirSync(o.outDir, { recursive: true })
  await build({
    configFile: false,
    // vitest の中から呼んでも本番と同じ形にする（開発の形だと任意の依存 canvas の代わりが例外を投げる）
    mode: 'production',
    logLevel: 'warn',
    root: o.root,
    publicDir: false,
    resolve: {
      alias: [
        { find: /^@video\//, replacement: `${video}/` },
        { find: /^@video$/, replacement: video },
        { find: /^@shared\//, replacement: `${resolve(o.root, 'src', 'shared')}/` },
        { find: /^canvas$/, replacement: join(video, 'build', 'canvasStub.ts') }
      ]
    },
    // 依存（zod・yaml・budoux）もまとめる
    ssr: { noExternal: true, target: 'node' },
    build: {
      ssr: join(video, 'cli', 'bin.ts'),
      outDir: o.outDir,
      emptyOutDir: false,
      target: 'node22',
      minify: false,
      sourcemap: false,
      copyPublicDir: false,
      reportCompressedSize: false,
      rollupOptions: {
        external: [...NODE_BUILTINS],
        // zod の注釈コメントの位置の警告は害が無いので出さない
        onwarn(warning, warn) {
          if (warning.code !== 'INVALID_ANNOTATION') warn(warning)
        },
        output: {
          format: 'es',
          entryFileNames: `${VIDEO_CLI}.mjs`,
          inlineDynamicImports: true
        }
      }
    }
  })
  // 先頭の文は書き出したあとに足す（output.banner は Vite の後処理で require の名前が変えられてしまう）。#! の行は先頭のまま
  const js = readFileSync(bundle, 'utf8')
  const shebang = js.startsWith('#!') ? js.slice(0, js.indexOf('\n') + 1) : ''
  writeFileSync(bundle, shebang + cliBanner(version) + '\n' + js.slice(shebang.length))
  const templatesDir = join(o.outDir, 'templates')
  rmSync(templatesDir, { recursive: true, force: true })
  cpSync(join(video, 'builtin-templates'), templatesDir, { recursive: true })
  return { bundle, templatesDir, bytes: statSync(bundle).size }
}
