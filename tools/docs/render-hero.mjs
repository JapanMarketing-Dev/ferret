// LP のヒーローアニメーション（site/js/hero.js、Claude Opus 5.5 で作成）から、静止画と README 用の動く画像を書き出す。
//   node tools/docs/render-hero.mjs            … site/assets/hero-poster.webp、site/assets/scenes/<name>.webp（LP の各節）、site/assets/demo/<tab>.webp（製品デモのタブ）。動きを減らす設定・狭い幅・JS なし用の静止画
//   node tools/docs/render-hero.mjs --readme   … 上に加えて docs/images/hero.gif（GitHub の README 用。JS も canvas も動かないので GIF にする）
// hero.js をそのまま Chromium（devDependencies の Playwright）で描くので、絵はサイトと必ず一致する。
// 圧縮には cwebp と ffmpeg を使う。
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { posterStamp } from './poster-stamp.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const SITE = join(ROOT, 'site')
const README = process.argv.includes('--readme')

// 背景つきの描画台。README では透明にできないので、サイトの舞台に近い暗い面と光を敷く
const STAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:transparent}
#s{position:relative;width:1000px;height:640px;overflow:hidden}
#s.bg{background:#050508}
#s.bg::before{content:'';position:absolute;inset:0;background:radial-gradient(70% 70% at 70% 0%,rgba(255,255,255,.05),transparent 70%)}
canvas{position:absolute;inset:0;width:1000px;height:640px}
</style><div id="s"><canvas id="c"></canvas></div>
<script type="module">
import { drawHero, heroState, posterState, HERO_W, HERO_H } from '/js/hero.js'
import { drawScene, sceneNames, SCENE_W, SCENE_H, drawApp, APP_TABS, APP_W, APP_H } from '/js/scenes.js'
const c = document.getElementById('c')
window.setup = (scale, bg) => {
  c.width = HERO_W * scale; c.height = HERO_H * scale
  document.getElementById('s').classList.toggle('bg', bg)
  window.ctx = c.getContext('2d'); window.ctx.setTransform(scale, 0, 0, scale, 0, 0)
}
window.frame = (t, loop) => drawHero(window.ctx, heroState(t, loop))
window.poster = () => drawHero(window.ctx, posterState())
window.sceneNames = sceneNames
window.appTabs = APP_TABS
window.app = (tab, scale) => {
  c.width = APP_W * scale; c.height = APP_H * scale
  c.style.width = APP_W + 'px'; c.style.height = APP_H + 'px'
  document.getElementById('s').style.cssText = 'width:' + APP_W + 'px;height:' + APP_H + 'px'
  const ctx = c.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0)
  drawApp(ctx, tab, 0, true)
}
window.scene = (name, scale) => {
  c.width = SCENE_W * scale; c.height = SCENE_H * scale
  c.style.width = SCENE_W + 'px'; c.style.height = SCENE_H + 'px'
  document.getElementById('s').style.cssText = 'width:' + SCENE_W + 'px;height:' + SCENE_H + 'px'
  const ctx = c.getContext('2d'); ctx.setTransform(scale, 0, 0, scale, 0, 0)
  drawScene(ctx, name, 0, true)
}
window.ready = true
</script>`

const TYPES = { '.js': 'text/javascript', '.html': 'text/html' }
const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  if (path === '/__stage.html') return res.writeHead(200, { 'content-type': 'text/html' }).end(STAGE)
  try {
    const body = readFileSync(join(SITE, path))
    res.writeHead(200, { 'content-type': TYPES[extname(path)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404).end()
  }
}).listen(0)
const base = `http://127.0.0.1:${server.address().port}`
const tmp = mkdtempSync(join(tmpdir(), 'ferret-hero-'))
const browser = await chromium.launch()

async function stage(scale) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 640 }, deviceScaleFactor: scale })
  await page.goto(`${base}/__stage.html`)
  await page.waitForFunction(() => window.ready)
  return page
}
const kb = (f) => `${Math.round(statSync(f).size / 1024)} KB`

try {
  // 静止画: 透明背景（サイトの舞台の上に重ねる）
  let page = await stage(1.6)
  await page.evaluate(() => {
    window.setup(1.6, false)
    window.poster()
  })
  await page.locator('#s').screenshot({ path: join(tmp, 'poster.png'), omitBackground: true })
  const poster = join(SITE, 'assets/hero-poster.webp')
  execFileSync('cwebp', ['-quiet', '-q', '82', '-alpha_q', '90', join(tmp, 'poster.png'), '-o', poster])
  console.log(`site/assets/hero-poster.webp ${kb(poster)}`)
  await page.close()

  // 各節の静止画（2x、透明背景）
  mkdirSync(join(SITE, 'assets/scenes'), { recursive: true })
  page = await stage(2)
  for (const name of await page.evaluate(() => window.sceneNames)) {
    await page.evaluate((n) => window.scene(n, 2), name)
    await page.locator('#s').screenshot({ path: join(tmp, `scene-${name}.png`), omitBackground: true })
    const out = join(SITE, `assets/scenes/${name}.webp`)
    execFileSync('cwebp', ['-quiet', '-q', '80', '-alpha_q', '90', join(tmp, `scene-${name}.png`), '-o', out])
    console.log(`site/assets/scenes/${name}.webp ${kb(out)}`)
  }
  await page.close()

  // 製品デモ（タブ）の静止画（2x）
  mkdirSync(join(SITE, 'assets/demo'), { recursive: true })
  page = await browser.newPage({ viewport: { width: 1200, height: 700 }, deviceScaleFactor: 2 })
  await page.goto(`${base}/__stage.html`)
  await page.waitForFunction(() => window.ready)
  for (const tab of await page.evaluate(() => window.appTabs)) {
    await page.evaluate((n) => window.app(n, 2), tab)
    await page.locator('#s').screenshot({ path: join(tmp, `demo-${tab}.png`), omitBackground: true })
    const out = join(SITE, `assets/demo/${tab}.webp`)
    execFileSync('cwebp', ['-quiet', '-q', '80', '-alpha_q', '90', join(tmp, `demo-${tab}.png`), '-o', out])
    console.log(`site/assets/demo/${tab}.webp ${kb(out)}`)
  }
  await page.close()

  // 静止画を描いた時の JS を記録する（JS だけ直して静止画が古いまま、を test/unit/site-scenes.test.ts で止める）
  writeFileSync(join(ROOT, 'tools/docs/poster-stamp.json'), JSON.stringify(posterStamp(), null, 2) + '\n')

  if (README) {
    // 2周目以降の状態（ブラウザの枠が出たまま）を1周ぶん描くので、GIF の継ぎ目が見えない
    const fps = 20
    const loop = 8.8
    const n = Math.round(loop * fps)
    page = await stage(1.28)
    await page.evaluate(() => window.setup(1.28, true))
    for (let i = 0; i < n; i++) {
      await page.evaluate((t) => window.frame(t, 2), i / fps)
      await page.locator('#s').screenshot({ path: join(tmp, `f${String(i).padStart(4, '0')}.png`) })
    }
    const gif = join(ROOT, 'docs/images/hero.gif')
    execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-framerate', String(fps), '-i', join(tmp, 'f%04d.png'), '-vf',
      'split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      '-loop', '0', gif])
    console.log(`docs/images/hero.gif ${kb(gif)}`)
  }
} finally {
  await browser.close()
  server.close()
  rmSync(tmp, { recursive: true, force: true })
}
