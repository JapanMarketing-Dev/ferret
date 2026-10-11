import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import {
  buildWindowsCmdShimCommandLine,
  findWindowsExecutable,
  parseWindowsCmdShim,
  pickWindowsWhereResult,
  resolveSpawn,
  type WindowsFs
} from '../../src/main/platform/windowsSpawn'
import { quoteWindowsCmdArgument } from '../../src/shared/shellQuote'
import { commonBinaryDirs } from '../../src/main/platform/binaryDirs'
import { resolveWhisperBinary } from '../../src/main/pipeline/environment'
import { DEV_APP_NAME, devHelperName, devPlistPatches } from '../../scripts/prepare-dev-electron.mjs'

/** 中身を持つ仮のファイルシステム（パスは大文字小文字を区別しない＝Windows と同じ） */
function fakeFs(files: Record<string, string>): WindowsFs {
  const table = new Map(Object.entries(files).map(([path, body]) => [path.toLowerCase(), body]))
  return {
    fileSize: (path) => (table.has(path.toLowerCase()) ? table.get(path.toLowerCase())!.length || 1 : null),
    readText: (path) => table.get(path.toLowerCase()) ?? null
  }
}

/** 今の npm（cmd-shim）が codex に生成する .cmd（実物と同じ形） */
const NPM_CODEX_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ''
].join('\r\n')

const NPM_DIR = 'C:\\Users\\me\\AppData\\Roaming\\npm'
const WIN_ENV = { Path: `${NPM_DIR};C:\\Program Files\\nodejs`, PATHEXT: '.COM;.EXE;.BAT;.CMD', ComSpec: 'C:\\Windows\\System32\\cmd.exe' }

describe('Windows で CLI を起動する', () => {
  it('Windows 以外は何も変えない', () => {
    const resolved = resolveSpawn('codex', ['exec', '-'], { PATH: '/usr/bin' }, 'linux', fakeFs({}))
    expect(resolved).toEqual({ file: 'codex', args: ['exec', '-'], env: { PATH: '/usr/bin' } })
  })

  it('PATHEXT で .cmd を見つけ、拡張子の無い sh 用スクリプトは選ばない', () => {
    const fs = fakeFs({ [`${NPM_DIR}\\codex`]: '#!/bin/sh', [`${NPM_DIR}\\codex.cmd`]: NPM_CODEX_SHIM })
    expect(findWindowsExecutable('codex', WIN_ENV, fs)).toBe(`${NPM_DIR}\\codex.cmd`)
  })

  it('.exe があればそのまま起動する（claude のネイティブ版など）', () => {
    const fs = fakeFs({ 'C:\\Users\\me\\.local\\bin\\claude.exe': 'MZ' })
    const resolved = resolveSpawn('claude', ['-p'], { PATH: 'C:\\Users\\me\\.local\\bin' }, 'win32', fs)
    expect(resolved.file).toBe('C:\\Users\\me\\.local\\bin\\claude.exe')
    expect(resolved.windowsVerbatimArguments).toBeUndefined()
  })

  it('npm の .cmd は中身を読んで node.exe で直接起動する（cmd.exe を通さない）', () => {
    const fs = fakeFs({
      [`${NPM_DIR}\\codex.cmd`]: NPM_CODEX_SHIM,
      [`${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '// js',
      'C:\\Program Files\\nodejs\\node.exe': 'MZ'
    })
    const resolved = resolveSpawn('codex', ['exec', '--output-schema', 'C:\\tmp\\s.json', '-'], WIN_ENV, 'win32', fs)
    expect(resolved.file).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(resolved.args).toEqual([`${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`, 'exec', '--output-schema', 'C:\\tmp\\s.json', '-'])
    expect(resolved.windowsVerbatimArguments).toBeUndefined()
  })

  it('読めない .cmd は cmd.exe 経由にし、引数を組み立て済みの1行で渡す', () => {
    const fs = fakeFs({ [`${NPM_DIR}\\tool.cmd`]: '@echo off\r\ncall something.bat %*' })
    const resolved = resolveSpawn('tool', ['a b', '{"x":1}'], WIN_ENV, 'win32', fs)
    expect(resolved.file).toBe('C:\\Windows\\System32\\cmd.exe')
    expect(resolved.windowsVerbatimArguments).toBe(true)
    expect(resolved.args).toEqual([`/d /v:off /s /c ""${NPM_DIR}\\tool.cmd" "a b" "{""x"":1}""`])
  })

  it('PATH の最初の node が .cmd なら、その先の node.exe を勝手に選ばない', () => {
    const fs = fakeFs({
      [`${NPM_DIR}\\codex.cmd`]: NPM_CODEX_SHIM,
      [`${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '// js',
      'C:\\shims\\node.cmd': '@echo off',
      'C:\\Program Files\\nodejs\\node.exe': 'MZ'
    })
    const env = { ...WIN_ENV, Path: `${NPM_DIR};C:\\shims;C:\\Program Files\\nodejs` }
    expect(resolveSpawn('codex', [], env, 'win32', fs).file).toBe('C:\\Windows\\System32\\cmd.exe')
  })
})

describe('cmd.exe 用の引数の書き方（Orca の検証例）', () => {
  it('" は "" にし、% は囲みの外で ^% にする', () => {
    expect(quoteWindowsCmdArgument('plain')).toBe('"plain"')
    expect(quoteWindowsCmdArgument('c"d')).toBe('"c""d"')
    expect(quoteWindowsCmdArgument('e%F%g')).toBe('"e"^%"F"^%"g"')
    expect(quoteWindowsCmdArgument('C:\\dir\\')).toBe('"C:\\dir\\\\"')
  })

  it('改行を含む引数は渡せない', () => {
    expect(() => buildWindowsCmdShimCommandLine('x.cmd', ['a\nb'])).toThrow()
  })

  it('形の違う .cmd や、フォルダの外を指すものは読まない', () => {
    expect(parseWindowsCmdShim('@echo off\r\nnode evil.js %*')).toBeNull()
    expect(parseWindowsCmdShim(NPM_CODEX_SHIM.replace('node_modules\\@openai', 'D:node_modules\\@openai'))).toBeNull()
    expect(parseWindowsCmdShim(NPM_CODEX_SHIM)).toEqual({ kind: 'node', script: 'node_modules\\@openai\\codex\\bin\\codex.js' })
  })

  it('where の出力から起動できるものを選ぶ', () => {
    const out = `${NPM_DIR}\\codex\r\n${NPM_DIR}\\codex.cmd\r\n${NPM_DIR}\\codex.ps1\r\n`
    expect(pickWindowsWhereResult(out)).toBe(`${NPM_DIR}\\codex.cmd`)
    expect(pickWindowsWhereResult(`${NPM_DIR}\\codex\r\n`)).toBeNull()
  })
})

describe('CLI のよくある置き場（OSごと）', () => {
  it('macOS は Homebrew、Linux は linuxbrew・snap、Windows は PATH だけ', () => {
    expect(commonBinaryDirs('darwin', '/Users/me')).toEqual(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/Users/me/.local/bin'])
    expect(commonBinaryDirs('linux', '/home/me')).toContain('/home/linuxbrew/.linuxbrew/bin')
    expect(commonBinaryDirs('linux', '/home/me')).toContain('/home/me/.local/bin')
    expect(commonBinaryDirs('linux', '/home/me')).not.toContain('/opt/homebrew/bin')
    expect(commonBinaryDirs('win32', 'C:\\Users\\me')).toEqual([])
  })

  it('Linux では ~/.local/bin の whisper-cli も見つける', async () => {
    const found = await resolveWhisperBinary(
      { modelDir: '/m' },
      { platform: 'linux', arch: 'x64', home: '/home/me', exists: (p) => p === '/home/me/.local/bin/whisper-cli', which: () => null }
    )
    expect(found).toBe('/home/me/.local/bin/whisper-cli')
  })

  it('Windows では macOS の置き場を探さない', async () => {
    const seen: string[] = []
    await resolveWhisperBinary({ modelDir: 'C:\\m' }, { platform: 'win32', arch: 'x64', exists: (p) => (seen.push(p), false), which: () => null })
    expect(seen.some((p) => p.includes('homebrew'))).toBe(false)
  })
})

describe('配布の設定（electron-builder.config.cjs）', () => {
  const require = createRequire(import.meta.url)
  const config = require('../../electron-builder.config.cjs')

  it('製品名とファイル名は Ferret-<version>-<os>-<arch>（ダウンロードサイトと合意した形）', () => {
    expect(config.productName).toBe('Ferret')
    expect(config.dmg.artifactName).toBe('Ferret-${version}-mac-${arch}.${ext}')
    expect(config.nsis.artifactName).toBe('Ferret-${version}-win-${arch}.${ext}')
    expect(config.appImage.artifactName).toBe('Ferret-${version}-linux-${arch}.${ext}')
    expect(config.deb.artifactName).toBe('Ferret-${version}-linux-${arch}.${ext}')
    expect(config.linux.executableName).toBe('ferret')
    expect(config.win.executableName).toBe('Ferret')
  })

  it('macOS: 内蔵ブラウザで LAN の開発サーバーを開けるよう、ローカルネットワークの利用目的を書く（Orca #18900）', () => {
    expect(config.mac.extendInfo.NSLocalNetworkUsageDescription).toMatch(/local network/)
    expect(config.mac.extendInfo.NSMicrophoneUsageDescription).toBeTruthy()
  })

  it('旧名 MOVIE-ADE の入った環境を置き換える（Windows はインストーラの GUID、Linux は deb の replaces）', () => {
    // electron-builder が旧 appId（com.japanmarketing.movieade）から作った GUID
    expect(config.nsis.guid).toBe('a380747a-7ef6-5f56-83af-53845ee2cb83')
    expect(config.deb.fpm).toEqual(['--replaces=movie-ade', '--conflicts=movie-ade'])
  })

  it('deb は Electron が直接リンクする ALSA を入れる（Ubuntu 24.04 の t64 を先に。デスクトップの無い環境で起動できなかった）', () => {
    expect(config.deb.depends).toContain('libasound2t64 | libasound2')
    expect(config.deb.depends).toContain('libgtk-3-0')
  })

  it('Windows のインストーラは実行すれば入って起動する（選択の画面・管理者の確認なし。旧版と同じユーザーごとの入れ方）', () => {
    expect(config.nsis.oneClick).toBe(true)
    expect(config.nsis.perMachine).toBe(false)
    expect(config.nsis.runAfterFinish).toBe(true)
    // oneClick では electron-builder が受け付けない
    expect(config.nsis.allowToChangeInstallationDirectory).toBeUndefined()
  })

  it('旧版を「すべてのユーザー」（HKLM）で入れた人は、先にその旧版のアンインストーラを走らせ、残ったら1行で案内する（build/installer.nsh）', () => {
    expect(config.nsis.include).toBe('build/installer.nsh')
    const nsh = readFileSync(join(__dirname, '../../build/installer.nsh'), 'utf8')
    const body = nsh.split('\n').filter((l) => !l.trimStart().startsWith(';')).join('\n')
    expect(body).toMatch(/^!macro customInit\n[\s\S]*\n!macroend\s*$/m)
    // HKLM の登録だけを見る（HKCU の旧版は electron-builder の uninstallOldVersion が消す）
    expect(body).toContain('ReadRegStr $R0 HKLM "${UNINSTALL_REGISTRY_KEY}" UninstallString')
    expect(body).not.toMatch(/HKCU|HKEY_CURRENT_USER|SHELL_CONTEXT/)
    // 一時フォルダへ写して、元の場所を _?= で渡し、終わるまで待つ。/allusers で旧版が自分で管理者に上がる。データは消さない
    expect(body).toContain('CopyFiles /SILENT "$R1" "$PLUGINSDIR\\old-machine-uninstaller.exe"')
    expect(body).toContain(`ExecWait '"$PLUGINSDIR\\old-machine-uninstaller.exe" /S /KEEP_APP_DATA /allusers --updated _?=$R2' $R3`)
    expect(body).not.toMatch(/--delete-app-data|DeleteRegKey|RMDir|Delete /)
    // 残ったときはインストールを止めず、1行のメッセージだけ（サイレントでは出さない）
    const box = body.match(/MessageBox [^\n]*/g) ?? []
    expect(box).toHaveLength(1)
    expect(box[0]).toMatch(/^MessageBox MB_OK\|MB_ICONINFORMATION "[^"\n]+" \/SD IDOK$/)
    expect(body).not.toMatch(/\bAbort\b|\bQuit\b/)
  })

  it('3つのOSの配布物を用意している（Windows は1本に両方入らないよう既定を1つにする）', () => {
    // zip はアプリの自動更新（Squirrel.Mac）用。サイトには dmg だけを出す
    expect(config.mac.target).toEqual([{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }])
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
    expect(config.linux.target).toEqual([
      { target: 'AppImage', arch: ['x64'] },
      { target: 'deb', arch: ['x64'] }
    ])
    expect(config.win.icon).toBe('build/icon.ico')
    expect(config.linux.icon).toBe('build/icons')
    expect(config.publish).toBeNull()
  })

  it('手元の Electron はこの OS・CPU と同じときだけ使い、ほかは取ってこさせる', () => {
    const other = process.platform === 'win32' ? 'linux' : 'win32'
    expect(config.electronDist({ platformName: other, arch: 'x64' })).toBeNull()
    expect(config.electronDist({ platformName: process.platform, arch: process.arch === 'x64' ? 'arm64' : 'x64' })).toBeNull()
  })

  it('dev 版は表示名は同じ Ferret のまま、識別子とファイル名で本番版と分ける', () => {
    const dev = require('../../electron-builder.dev.cjs')
    expect(dev.appId).toBe('dev.ferretade.ferret.dev')
    expect(dev.productName).toBe('Ferret')
    expect(dev.nsis.guid).toBeUndefined()
    expect(dev.directories.output).toBe('dist/dev')
    expect(dev.afterPack).toBe(config.afterPack)
    expect(config.appId).toBe('dev.ferretade.ferret')
  })

  it('Linux 以外の上で Linux 版を作ろうとすると、理由を書いて止める', async () => {
    if (process.platform === 'linux') return
    await expect(config.beforePack({ electronPlatformName: 'linux', arch: 1 })).rejects.toThrow(/Linux の上で/)
  })
})

describe('開発起動の Electron.app の名前（scripts/prepare-dev-electron.mjs）', () => {
  it('メニューバー・Dock・⌘Tab に出る名前と識別子を固定の値で差し替える', () => {
    expect(DEV_APP_NAME).toBe('Ferret')
    expect(devPlistPatches()).toEqual([
      { key: 'CFBundleName', value: 'Ferret' },
      { key: 'CFBundleDisplayName', value: 'Ferret' },
      { key: 'CFBundleIdentifier', value: 'dev.ferretade.ferret.dev' }
    ])
  })

  it('Helper も本体と同じ名前で始める（Electron は本体の名前から Helper を探す）', () => {
    expect(devHelperName('Electron Helper')).toBe('Ferret Helper')
    expect(devHelperName('Electron Helper (Renderer)')).toBe('Ferret Helper (Renderer)')
  })

  it('Linux の .desktop は package.json の desktopName に揃える', () => {
    const require = createRequire(import.meta.url)
    expect(require('../../electron-builder.config.cjs').linux.syncDesktopName).toBe(true)
    expect(require('../../package.json').desktopName).toBe('ferret.desktop')
  })
})

describe('Windows のインストーラの中のアーカイブ（NSIS / nsis7z）', () => {
  it('配布の設定を読むと、7z のフィルタを BCJ に固定する（ARM64 の分岐フィルタ 0A を使わせない）', () => {
    const require = createRequire(import.meta.url)
    require('../../electron-builder.config.cjs')
    expect(process.env.ELECTRON_BUILDER_7Z_FILTER).toBe('BCJ')
  })

  it('古い 7-Zip の検査結果から、読めないファイルと許していないメソッドを拾う', async () => {
    const { findArchiveProblems } = await import('../../scripts/check-nsis-archive.mjs')
    const test = ['Testing     Ferret.exe', 'ERROR: Unsupported Method : Ferret.exe', 'ERROR: Unsupported Method : ffmpeg.dll'].join('\n')
    const list = [
      'Path = app-arm64.7z', 'Method = 0A LZMA2:20', // アーカイブ全体のまとめ（数えない）
      '----------',
      'Path = Ferret.exe', 'Method = 0A LZMA2:20',
      'Path = resources/app.asar', 'Method = BCJ LZMA2:20',
      'Path = resources', 'Method = '
    ].join('\n')
    expect(findArchiveProblems(test, list)).toEqual({
      unsupported: ['Ferret.exe', 'ffmpeg.dll'],
      badMethods: [{ path: 'Ferret.exe', method: '0A' }]
    })
    expect(findArchiveProblems('Everything is Ok', ['----------', 'Path = Ferret.exe', 'Method = BCJ LZMA2:20'].join('\n'))).toEqual({ unsupported: [], badMethods: [] })
  })
})

describe('Mac で NSIS を作るときのパスの長さ（scripts/check-nsis-paths.mjs）', () => {
  it('テンプレートの一番長いパスが 260 文字を超えたら止める（228 文字は通り、344 文字で makensis が落ちた）', async () => {
    const { nsisPathProblem, NSIS_PATH_LIMIT } = await import('../../scripts/check-nsis-paths.mjs')
    expect(NSIS_PATH_LIMIT).toBe(260)
    expect(nsisPathProblem('x'.repeat(228))).toBeNull()
    expect(nsisPathProblem('x'.repeat(344))).toMatch(/344 文字/)
  })

  it('build-release.sh は NSIS を /tmp の下の短いフォルダから作り、作る前にパスを確かめる', () => {
    const script = readFileSync(join(__dirname, '../../scripts/build-release.sh'), 'utf8')
    const nsisLines = script.split('\n').filter((line) => line.includes('--win nsis'))
    expect(nsisLines.length).toBe(2)
    for (const line of nsisLines) expect(line).toContain('-c.directories.output="${NSIS_DIR}/out"')
    expect(script).toContain('NSIS_DIR="$(mktemp -d /tmp/fnsis.XXXXXX)"')
    expect(script.indexOf('check-nsis-paths.mjs')).toBeLessThan(script.indexOf('--win nsis'))
  })
})

describe('Agent の起動の cmd.exe の引数も同じ書き方（以前は % の前の \\ を倍にせず a\\%b が a"%b になっていた）', () => {
  it('quoteStartupArg の cmd は quoteWindowsCmdArgument と同じ', async () => {
    const { quoteStartupArg } = await import('../../src/shared/agentLaunch')
    for (const value of ['plain', 'c"d', 'e%F%g', 'C:\\dir\\', 'a\\%b', 'x\\\\"y', '']) {
      expect(quoteStartupArg(value, 'cmd'), value).toBe(quoteWindowsCmdArgument(value))
    }
    expect(quoteStartupArg('a\\%b', 'cmd')).toBe('"a\\\\"^%"b"')
  })
})
