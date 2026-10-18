/**
 * electron-builder の設定（Ferret。旧名 MOVIE-ADE。当面は署名・公証しない）。
 *
 * 3つのOSの配布物（ファイル名は download-site と合意した Ferret-<version>-<os>-<arch>.<ext>。0.1.x は MOVIE-ADE-…）：
 *   macOS   … dmg（arm64・x64。サイトから入れる）と zip（arm64・x64。アプリの自動更新が Squirrel.Mac で入れ替えに使う。サイトには出さない）
 *   Windows … nsis（x64・arm64。1つのインストーラに両方入らないよう、CPU ごとに別々に走らせる）
 *   Linux   … AppImage / deb（x64。Linux の上でだけ作れる）
 * `pnpm build:<os>:dev` は --dir で展開済みのアプリだけを作る（速い確認用）。
 * `pnpm dist:<os>` が上の配布物を作る。配布は Cloudflare R2（scripts/release-r2.mjs）で、GitHub には添付しない。
 *
 * Orca由来: ~/bench/orca/config/electron-builder.config.cjs（MIT, Copyright 2026 Lovecast Inc.）
 *   mac / nsis / linux / deb の各項目の選び方と、deb の依存パッケージの一覧
 *
 * YAML ではなく JS にしているのは electronDist を関数にするため。
 * 手元の node_modules/electron/dist は「この Mac 用」なので、同じ OS・同じ CPU のときだけ使い、
 * それ以外（Windows / Linux / 別の CPU）は electron-builder に正しい Electron を取ってこさせる。
 *
 * userData は製品名ではなく ade-movie に固定している（src/main/index.ts）。製品名を変えても既存のデータは残る。
 */
const { chmodSync, existsSync, readdirSync, rmSync } = require('node:fs')
const { execFileSync } = require('node:child_process')

const MAC_IDENTITY = process.env.FERRET_MAC_IDENTITY || null
const MAC_NOTARIZE = Boolean(
  MAC_IDENTITY && process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER
)
const { join } = require('node:path')

const localElectronDist = join(__dirname, 'node_modules', 'electron', 'dist')

/*
 * Windows のインストーラ（NSIS）の中のアーカイブで、ARM64 の分岐フィルタ（7z のメソッド 0A）を使わせない。
 * electron-builder が使う 7-Zip 24 は、ARM64 の exe / dll に自動でこのフィルタを掛ける。インストーラが展開に使う
 * nsis7z.dll はこれを読めず、エラーも出さずにそのファイルを飛ばす（win-arm64 版で Ferret.exe や ffmpeg.dll が
 * 入らなかった。vm-qa が Windows 11 ARM64 で確かめた）。フィルタを BCJ（x86 用。nsis7z が読める）に固定する。
 * ARM64 のファイルには効かないので圧縮率が少し落ちるだけで、中身は変わらない。
 * electron-builder は 7z を呼ぶたびにこの環境変数を読む（app-builder-lib/out/targets/archive.js）。
 * scripts/check-nsis-archive.mjs が、作ったインストーラにこのフィルタが残っていないかを確かめる。
 */
process.env.ELECTRON_BUILDER_7Z_FILTER = 'BCJ'

/**
 * node-pty から、このアプリの OS・CPU で使わないものを外す（配布物を小さくし、別の CPU 用の exe を入れない）。
 *   - prebuilds/ は <os>-<cpu> の1つだけを残す（Linux は prebuilds を使わず build/Release を使う）
 *   - third_party/（conpty のソース側の写し）は使わない。Windows の conpty.dll は prebuilds/<os>-<cpu>/conpty/ から読む
 */
function pruneNodePty(ptyDir, platform, arch) {
  for (const dir of listDirs(join(ptyDir, 'prebuilds'))) {
    if (!dir.endsWith(`${platform}-${arch}`)) rmSync(dir, { recursive: true, force: true })
  }
  rmSync(join(ptyDir, 'third_party'), { recursive: true, force: true })
}

/** electron-builder の Arch の番号（ia32=0, x64=1, armv7l=2, arm64=3, universal=4） */
const ARCH_NAME = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

// deb の depends を書くと electron-builder の既定が置き換わるので、Electron が必要とするものを並べる（Orca と同じ一覧）。
// ALSA（libasound.so.2）は既定の一覧に無いが、Electron の実行ファイルが直接リンクしている。デスクトップの無い Ubuntu 24.04 に
// apt で入れると入らず、起動できなかった。24.04 以降は libasound2t64、22.04・Debian 12 は libasound2。
// libasound2 だけを書くと、24.04 の apt は同じ名前を提供する別物（liboss4-salsa-asound2）を選ぶことがあるので、t64 を先に書く
const debElectronRuntimeDependencies = [
  'libasound2t64 | libasound2',
  'libgtk-3-0',
  'libnotify4',
  'libnss3',
  'libxss1',
  'libxtst6',
  'xdg-utils',
  'libatspi2.0-0',
  'libuuid1',
  'libsecret-1-0'
]

function listDirs(dir) {
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => join(dir, d.name)) : []
}

/**
 * 配布物（app.asar）に入れるもの。out/・package.json・node_modules だけ。
 * OS ごとの files（win.files など）を書くときは、必ずこの一覧に足す形にする。OS の側に除外だけを書くと、
 * この一覧が効かずに作業フォルダが丸ごと入る（0.4.6 の公開前に、Windows 版へ Agent の作業ツリーとレビューの記録が入った）。
 * 中身は scripts/check-app-asar.mjs がビルドのたびに確かめる
 */
const APP_FILES = [
  'out/**/*',
  'package.json',
  'node_modules/**/*',
  '!**/*.map',
  '!**/.env*',
  '!**/e2e-artifacts/**',
  // @sentry/node が依存に持つビルド用の道具（vite / rollup などのプラグイン用）。実行時は読まない（@sentry/node の
  // 本体は bundler-plugin を import せず、サブパスの ./vite などからだけ読む）。Sentry CLI（FSL ライセンス・15MB）と
  // ネイティブ付きの oxc-parser を配布物に入れない
  '!**/node_modules/@sentry/bundler-plugins/**',
  '!**/node_modules/sentry/**',
  '!**/node_modules/oxc-parser/**',
  '!**/node_modules/@oxc-parser/**'
]

/** @type {import('electron-builder').Configuration} */
module.exports = {
  // 0.1.x（MOVIE-ADE）は com.japanmarketing.movieade。変えると macOS では画面収録・マイクの許可を取り直すことになる。
  // Windows はインストーラの GUID を下の nsis.guid で旧版のまま保ち、上書きで入れ替わるようにしている
  appId: 'dev.ferretade.ferret',
  productName: 'Ferret',
  copyright: 'Copyright © 2026 JapanMarketing-Dev',
  // 各ターゲットの既定。OS と CPU の語はダウンロードサイトがファイル名から判別する
  artifactName: 'Ferret-${version}-${os}-${arch}.${ext}',
  electronDist: (options) => {
    const sameHost = options.platformName === process.platform && options.arch === process.arch
    return sameHost && existsSync(localElectronDist) ? localElectronDist : null
  },
  directories: {
    output: 'dist/release',
    buildResources: 'build'
  },
  files: APP_FILES,
  // node-pty はネイティブモジュールと補助の実行ファイル（spawn-helper、Windows の conpty.dll / OpenConsole.exe）を
  // asar の外に置かないと起動できない
  // 動画づくりの CLI（ferret-video）は Electron の Node（ELECTRON_RUN_AS_NODE）で asar の外から動かす
  asarUnpack: ['node_modules/node-pty/**/*', 'out/video-cli/**/*'],
  /*
   * node-pty 1.1 は N-API なので Electron 向けに作り直さなくても読める。
   * macOS / Windows は同梱の prebuilds/<os>-<cpu> があり、読み込み側（node-pty の loadNativeModule）が
   * build/Release で失敗するとそちらへ切り替える。ここで作り直すと、別 OS 向けのときに失敗するので切っておく。
   * Linux は prebuilds が無いので、Linux 上の `pnpm install` で作ったもの（build/Release）を使う（beforePack で確かめる）。
   */
  npmRebuild: false,
  beforePack: async (context) => {
    const target = context.electronPlatformName
    if (target === 'linux' && process.platform !== 'linux') {
      throw new Error(
        'Linux 版は Linux の上で作ってください。node-pty の Linux 用バイナリは同梱されておらず、' +
          'この OS の build/Release を詰めると起動できません（CI の ubuntu で作ります）。'
      )
    }
    const arch = ARCH_NAME[context.arch]
    const prebuilt = join(__dirname, 'node_modules', 'node-pty', 'prebuilds', `${target}-${arch}`)
    if (target !== 'linux' && !existsSync(prebuilt)) {
      throw new Error(`node-pty の ${target}-${arch} 用バイナリが見つかりません: ${prebuilt}`)
    }
  },
  /*
   * node-pty の spawn-helper（macOS が PTY を開くのに使う）は、prebuilds の中で実行権限が揃っていない。
   * インストール時の post-install はこの CPU（darwin-arm64）の分しか直さないので、darwin-x64 版は
   * 実行できず、Intel Mac で「posix_spawnp failed」になる（この Mac で x64 版を Rosetta で動かして確かめた）。
   * Orca由来: ~/bench/orca/config/electron-builder.config.cjs の afterPack（実行権限を揃える処理）（MIT）
   */
  afterPack: async (context) => {
    const resources =
      context.electronPlatformName === 'darwin'
        ? join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
        : join(context.appOutDir, 'resources')
    const ptyDir = join(resources, 'app.asar.unpacked', 'node_modules', 'node-pty')
    // macOS の ad-hoc 署名より前に外す（署名のあとでファイルを消すと、署名が壊れる）
    pruneNodePty(ptyDir, context.electronPlatformName, ARCH_NAME[context.arch])
    if (context.electronPlatformName === 'win32') return
    for (const dir of [join(ptyDir, 'build', 'Release'), ...listDirs(join(ptyDir, 'prebuilds'))]) {
      const helper = join(dir, 'spawn-helper')
      if (existsSync(helper)) chmodSync(helper, 0o755)
    }
    /*
     * macOS: 未署名（identity: null）のままだと、Electron 本体のリンカ署名だけが残り、アプリ全体の署名が壊れる
     * （codesign --verify で「code has no resources but signature indicates they must be present」）。
     * ダウンロードした（quarantine の付いた）アプリを Apple silicon で開くと「壊れているため開けません」になり、
     * 「このまま開く」の道も出ない。ad-hoc 署名（費用なし）をアプリ全体に付け直して、ほかの未署名アプリと同じ
     * 「開発元を確認できません」の扱い（システム設定から開ける）にする。Developer ID で署名するときは electron-builder が署名する。
     */
    if (context.electronPlatformName === 'darwin' && !MAC_IDENTITY) {
      const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
      execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
    }
  },
  mac: {
    icon: 'build/icon.icns',
    // Developer ID の署名と公証は、FERRET_MAC_IDENTITY と APPLE_API_KEY / APPLE_API_KEY_ID / APPLE_API_ISSUER が
    // あるときだけ（scripts/build-release.sh が ~/.ferret-signing/env から読む。値はリポジトリに入れない）。
    // 無ければ未署名のまま作り、afterPack で ad-hoc 署名を付ける
    identity: MAC_IDENTITY,
    hardenedRuntime: Boolean(MAC_IDENTITY),
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: MAC_NOTARIZE,
    category: 'public.app-category.developer-tools',
    // 許可を求めるときの説明の日本語（Info.plist の英語は下の extendInfo）
    extraResources: [{ from: 'build/mac/ja.lproj', to: 'ja.lproj' }],
    extendInfo: {
      NSMicrophoneUsageDescription: 'Ferret records your voice during a review and saves it with the findings on screen.',
      // 動画づくりの撮影で、カメラの映像を画面とは別のトラックとして録る（src/video/）。日本語は build/mac/ja.lproj/InfoPlist.strings
      NSCameraUsageDescription: 'Ferret records your camera as its own track when you shoot a video.',
      // 「相手の声も録る」を入れたときだけ、会議の相手の声（PC の音声）を録る（src/shared/systemAudio.ts）
      NSAudioCaptureUsageDescription: 'Ferret records the other side of a call (your computer\'s audio) when you turn on Record the other side too.',
      // 内蔵ブラウザで同じ LAN の開発サーバー（http://192.168.…:3000 など）を開くため。macOS 15 以降のローカルネットワークの許可の確認に使う（Orca #18900）
      NSLocalNetworkUsageDescription: 'Ferret opens development servers on your local network in its built-in browser.'
    },
    // zip は自動更新用（src/main/autoUpdate.ts。Squirrel.Mac は zip しか読めない）。名前は上の artifactName（Ferret-<版>-mac-<arch>.zip）
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] }
    ]
  },
  dmg: {
    artifactName: 'Ferret-${version}-mac-${arch}.${ext}',
    title: '${productName} ${version}'
  },
  win: {
    icon: 'build/icon.ico',
    executableName: 'Ferret',
    // この Mac で作った node-pty の build/Release は Windows では読めない。prebuilds/win32-<cpu> だけを使わせる
    files: [...APP_FILES, '!node_modules/node-pty/build/**'],
    // ウインドウのアイコン（src/main/index.ts の windowIcon。exe のアイコンとは別にタイトルバー用）
    extraResources: [{ from: 'build/icons/256x256.png', to: 'icon.png' }],
    // 署名しない（アイコンと版の埋め込みだけ行う）。
    // arch を2つ書くと両方入りの1本になるので、既定は x64 にし、arm64 は `--arm64` で別に走らせる（package.json の dist:win）
    target: [{ target: 'nsis', arch: ['x64'] }]
  },
  // Mac で作るとき、makensis（wine 経由で uninstaller を作る）は長いパスの下で失敗する（-1 で落ちる）。
  // 浅いフォルダ（このリポジトリの dist/release など）で作る
  nsis: {
    artifactName: 'Ferret-${version}-win-${arch}.${ext}',
    // MOVIE-ADE 0.1.x の appId（com.japanmarketing.movieade）から electron-builder が作った GUID。
    // 同じ GUID にしておくと、Ferret のインストーラが旧版を「同じアプリの更新」として入れ替える（アンインストールの項目が二重にならない）
    guid: 'a380747a-7ef6-5f56-83af-53845ee2cb83',
    // 実行すればそのまま入って起動する（画面の選択なし）。ユーザーごとに %LOCALAPPDATA%\Programs へ入れるので管理者の確認も出ない。
    // 同じ GUID なので、旧版（oneClick: false でユーザーごとに入れたもの）の入れ先を HKCU から読んで同じ場所に上書きし、
    // 旧版のアンインストーラを先に走らせる（アンインストールの項目は1つのまま）
    oneClick: true,
    perMachine: false,
    runAfterFinish: true,
    // 旧版を「すべてのユーザー」（HKLM）で入れた人の旧版を先に消す（中身と理由は build/installer.nsh）
    include: 'build/installer.nsh',
    shortcutName: '${productName}',
    uninstallDisplayName: '${productName}',
    createDesktopShortcut: 'always'
  },
  linux: {
    // フォルダの NxN.png を hicolor の各サイズに配る（scripts/build-icon.mjs が書き出す）
    icon: 'build/icons',
    // 製品名の空白と括弧はコマンド名・パッケージ名に使えない
    executableName: 'ferret',
    // .desktop のファイル名・StartupWMClass を package.json の desktopName（ferret.desktop）に揃える。
    // Electron はこれをウインドウの app_id / WM_CLASS に使うので、ドックでランチャーと同じアイコンにまとまる
    syncDesktopName: true,
    // ウインドウのアイコン（src/main/index.ts の windowIcon）
    extraResources: [{ from: 'build/icons/512x512.png', to: 'icon.png' }],
    category: 'Development',
    maintainer: 'JapanMarketing-Dev',
    synopsis: 'Give UI feedback to coding agents by talking and circling',
    target: [
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] }
    ]
  },
  appImage: {
    // x64 は x86_64 になる
    artifactName: 'Ferret-${version}-linux-${arch}.${ext}'
  },
  deb: {
    packageName: 'ferret',
    // 旧パッケージ（movie-ade）が入っていれば、置き換える
    fpm: ['--replaces=movie-ade', '--conflicts=movie-ade'],
    // x64 は amd64 になる
    artifactName: 'Ferret-${version}-linux-${arch}.${ext}',
    depends: debElectronRuntimeDependencies
  },
  // 配布は R2 に scripts/release-r2.mjs で上げる。electron-builder からは公開しない（latest*.yml も作らない）。
  // 自動更新は electron-updater ではなく、署名した SHA256SUMS で確かめたファイルを使う（src/main/autoUpdate.ts）
  publish: null
}
