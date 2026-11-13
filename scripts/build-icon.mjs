/**
 * build/icon.svg から、3つのOS用のアイコンを書き出す。
 *   build/icon.png（1024）… 元画像・開発時の Dock
 *   build/icon.icns       … macOS
 *   build/icon.ico        … Windows（16〜256px の PNG を1つにまとめる）
 *   build/icons/NxN.png   … Linux（AppImage / deb の hicolor テーマ用）
 * 16px・24px（.ico と Linux）だけは、小さいサイズ用に線を太らせた build/brand/ferret-favicon.svg があればそれを使う
 * （大きいアイコンをそのまま縮めると図柄がつぶれるため）。macOS の icns は icon.svg だけから作る。
 * SVG→PNG は Playwright の Chromium（背景は透明のまま）、縮小と icns は macOS 標準の sips / iconutil。
 *   node scripts/build-icon.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const buildDir = resolve(import.meta.dirname, '..', 'build')
const svg = readFileSync(join(buildDir, 'icon.svg'), 'utf8')
const png = join(buildDir, 'icon.png')
const smallSvgPath = join(buildDir, 'brand', 'ferret-favicon.svg')
const smallSvg = existsSync(smallSvgPath) ? readFileSync(smallSvgPath, 'utf8') : null
const work = mkdtempSync(join(tmpdir(), 'ade-icon-'))
const smallPng = join(work, 'small.png')

const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } })
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${svg}`
  )
  await page.locator('svg').screenshot({ path: png, omitBackground: true })
  if (smallSvg) {
    await page.setContent(
      `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:256px;height:256px}</style>${smallSvg}`
    )
    await page.locator('svg').screenshot({ path: smallPng, omitBackground: true })
  }
} finally {
  await browser.close()
}

// iconset の決まった名前と寸法（@2x は倍の画素）
const iconset = join(work, 'icon.iconset')
execFileSync('mkdir', [iconset])
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    const px = String(size * scale)
    const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`
    execFileSync('sips', ['-z', px, px, png, '--out', join(iconset, name)], { stdio: 'ignore' })
  }
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(buildDir, 'icon.icns')])

/** png を指定の画素に縮小して中身を返す */
function resized(px) {
  const out = join(work, `resized-${px}.png`)
  const source = smallSvg && px <= 24 ? smallPng : png
  execFileSync('sips', ['-z', String(px), String(px), source, '--out', out], { stdio: 'ignore' })
  return readFileSync(out)
}

// Linux: electron-builder はフォルダの NxN.png を hicolor の各サイズに配る
const linuxDir = join(buildDir, 'icons')
rmSync(linuxDir, { recursive: true, force: true })
mkdirSync(linuxDir)
for (const px of [16, 24, 32, 48, 64, 128, 256, 512]) {
  writeFileSync(join(linuxDir, `${px}x${px}.png`), resized(px))
}

// Windows: ICO は PNG をそのまま格納できる（Vista 以降）。ヘッダ6バイト＋1枚16バイトの目録＋本体
const icoSizes = [16, 24, 32, 48, 64, 128, 256]
const images = icoSizes.map((px) => resized(px))
const header = Buffer.alloc(6 + 16 * images.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // 1 = アイコン
header.writeUInt16LE(images.length, 4)
let offset = header.length
images.forEach((data, i) => {
  const px = icoSizes[i]
  const entry = 6 + 16 * i
  header.writeUInt8(px >= 256 ? 0 : px, entry) // 256 は 0 と書く決まり
  header.writeUInt8(px >= 256 ? 0 : px, entry + 1)
  header.writeUInt8(0, entry + 2) // パレットなし
  header.writeUInt8(0, entry + 3)
  header.writeUInt16LE(1, entry + 4) // 色平面
  header.writeUInt16LE(32, entry + 6) // ビット深度
  header.writeUInt32LE(data.length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += data.length
})
writeFileSync(join(buildDir, 'icon.ico'), Buffer.concat([header, ...images]))

rmSync(work, { recursive: true, force: true })
console.log('build/icon.png・icon.icns・icon.ico・icons/ を書き出しました')
