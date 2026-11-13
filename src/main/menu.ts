import { Menu, type MenuItemConstructorOptions } from 'electron'
import type { MenuCommand } from '@shared/types'
import { browserNavAccelerator } from '@shared/browserNav'
import { PRODUCT_NAME, onLocaleChange, t } from '@shared/i18n'

/**
 * アプリケーションメニュー。
 * キーボードショートカットは `CmdOrCtrl` で宣言し、OSごとの修飾キー分岐を書かない
 * （macOS は ⌘、Windows / Linux は Ctrl に Electron が割り当てる）。
 * macOS ではアプリメニューが無いとコピー・ペーストのショートカットが効かないため、
 * 編集メニューは標準ロールで用意する。
 */
export function installMenu(handlers: {
  onOpenFolder: () => void
  onCommand: (command: MenuCommand) => void
}): void {
  buildMenu(handlers)
  // 画面の言語を切り替えたら、メニューを作り直す
  if (!unsubscribeLocale) unsubscribeLocale = onLocaleChange(() => buildMenu(handlers))
}

let unsubscribeLocale: (() => void) | null = null

/** ターミナルの欄を隠す・出すキー（画面の表記は renderer の SHORTCUTS.toggleTerminal） */
export const TOGGLE_TERMINAL_ACCELERATOR = 'Ctrl+`'

function buildMenu(handlers: Parameters<typeof installMenu>[0]): void {
  const isMac = process.platform === 'darwin'

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: PRODUCT_NAME,
            submenu: [
              { role: 'about', label: t('menu.about', { app: PRODUCT_NAME }) },
              { type: 'separator' },
              { label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => handlers.onCommand('toggleSettings') },
              { type: 'separator' },
              { role: 'hide', label: t('menu.hide', { app: PRODUCT_NAME }) },
              { role: 'hideOthers', label: t('menu.hideOthers') },
              { role: 'unhide', label: t('menu.showAll') },
              { type: 'separator' },
              { role: 'quit', label: t('menu.quit', { app: PRODUCT_NAME }) }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: t('menu.file'),
      submenu: [
        {
          label: t('menu.openProjectFolder'),
          accelerator: 'CmdOrCtrl+O',
          click: () => handlers.onOpenFolder()
        },
        {
          label: t('menu.quickOpen'),
          accelerator: 'CmdOrCtrl+P',
          click: () => handlers.onCommand('quickOpen')
        },
        { label: t('menu.save'), accelerator: 'CmdOrCtrl+S', click: () => handlers.onCommand('saveFile') },
        // macOS はアプリメニューに置く（OS の慣習）。ほかの OS はファイルメニューに置く
        ...(isMac ? [] : [{ label: t('menu.settings'), accelerator: 'CmdOrCtrl+,', click: () => handlers.onCommand('toggleSettings') }]),
        { type: 'separator' },
        // role 'close' の既定は ⌘W で、ターミナル（ペイン／タブ）を閉じる ⌘W とぶつかるため ⌘⇧W にする
        isMac
          ? { role: 'close', label: t('menu.closeWindow'), accelerator: 'Cmd+Shift+W' }
          : { role: 'quit', label: t('menu.exit') }
      ]
    },
    {
      label: t('menu.edit'),
      submenu: [
        { role: 'undo', label: t('menu.undo') },
        { role: 'redo', label: t('menu.redo') },
        { type: 'separator' },
        { role: 'cut', label: t('menu.cut') },
        { role: 'copy', label: t('menu.copy') },
        { role: 'paste', label: t('menu.paste') },
        { role: 'selectAll', label: t('menu.selectAll') }
      ]
    },
    {
      label: t('menu.view'),
      submenu: [
        { label: t('menu.toggleRecording'), accelerator: 'CmdOrCtrl+Shift+R', click: () => handlers.onCommand('toggleRecording') },
        {
          label: t('menu.toggleMode'),
          accelerator: 'CmdOrCtrl+Shift+M',
          click: () => handlers.onCommand('toggleMode')
        },
        {
          label: t('menu.toggleExplorer'),
          accelerator: 'CmdOrCtrl+Shift+E',
          click: () => handlers.onCommand('toggleExplorer')
        },
        {
          // フィードバックモードの右パネル（レビュー対象の一覧）。録画中に画面を広く使いたいときに隠す
          label: t('menu.toggleTargets'),
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => handlers.onCommand('toggleTargets')
        },
        { label: t('menu.toggleFooter'), click: () => handlers.onCommand('toggleFooter') },
        {
          // ターミナルの欄を隠す・出す。VS Code と同じ Control+`（macOS の ⌘` はウインドウの切り替えなので使わない）
          label: t('menu.toggleTerminal'),
          accelerator: TOGGLE_TERMINAL_ACCELERATOR,
          click: () => handlers.onCommand('toggleTerminal')
        },
        {
          label: t('menu.toggleViewport'),
          accelerator: 'CmdOrCtrl+Shift+V',
          click: () => handlers.onCommand('toggleViewport')
        },
        { type: 'separator' },
        {
          label: t('menu.focusUrl'),
          accelerator: 'CmdOrCtrl+L',
          click: () => handlers.onCommand('focusUrl')
        },
        {
          label: t('menu.reloadPage'),
          accelerator: 'CmdOrCtrl+R',
          click: () => handlers.onCommand('reloadPage')
        },
        // 内蔵ブラウザの戻る・進む（フィードバックモードのツールバーのボタンと同じ。録画中も使える）
        {
          label: t('browser.back'),
          accelerator: browserNavAccelerator('back', process.platform),
          click: () => handlers.onCommand('browserBack')
        },
        {
          label: t('browser.forward'),
          accelerator: browserNavAccelerator('forward', process.platform),
          click: () => handlers.onCommand('browserForward')
        },
        { type: 'separator' },
        { role: 'togglefullscreen', label: t('menu.fullscreen') },
        { role: 'toggleDevTools', label: t('menu.devTools') },
        {
          // 共通部品の一覧。画面を作るときの参照先（NF-13）
          label: t('menu.gallery'),
          accelerator: 'CmdOrCtrl+Shift+U',
          click: () => handlers.onCommand('toggleGallery')
        }
      ]
    },
    {
      label: t('menu.terminal'),
      submenu: [
        {
          label: t('menu.newTerminal'),
          accelerator: 'CmdOrCtrl+T',
          click: () => handlers.onCommand('newTerminal')
        },
        {
          label: t('menu.closeTerminal'),
          accelerator: 'CmdOrCtrl+W',
          click: () => handlers.onCommand('closeTerminal')
        },
        // 最後に閉じたターミナルを、前の画面の文字と会話のまま開き直す。キーは分割と同じく、ターミナルにフォーカスが
        // あるときだけ TerminalPane が拾う（内蔵ブラウザ・エディタの ⌘⇧T を奪わない）。メニューは表示とクリックだけ
        isMac
          ? { label: `${t('menu.reopenTerminal')} (⌘⇧T)`, click: () => handlers.onCommand('reopenTerminal') }
          : {
              label: t('menu.reopenTerminal'),
              accelerator: 'Ctrl+Shift+T',
              registerAccelerator: false,
              click: () => handlers.onCommand('reopenTerminal')
            },
        { type: 'separator' },
        // Orca と同じ割り当て（~/bench/orca/src/shared/keybindings/definitions-core-4.ts）。
        // macOS は ⌘D / ⌘⇧D、Windows / Linux は Ctrl+Shift+D / Alt+Shift+D。
        // Orca と同じく、ターミナルにフォーカスがあるときだけ効かせるので、キーは TerminalPane が拾う。
        // メニューは表示だけ（エディタの ⌘D「次の一致を選択に追加」を奪わない）。
        // registerAccelerator は Windows / Linux にしか効かないため、macOS はショートカットを名前に書く
        isMac
          ? { label: `${t('menu.splitRight')} (⌘D)`, click: () => handlers.onCommand('splitTerminalRight') }
          : {
              label: t('menu.splitRight'),
              accelerator: 'Ctrl+Shift+D',
              registerAccelerator: false,
              click: () => handlers.onCommand('splitTerminalRight')
            },
        isMac
          ? { label: `${t('menu.splitDown')} (⌘⇧D)`, click: () => handlers.onCommand('splitTerminalDown') }
          : {
              label: t('menu.splitDown'),
              accelerator: 'Alt+Shift+D',
              registerAccelerator: false,
              click: () => handlers.onCommand('splitTerminalDown')
            }
      ]
    },
    // macOS のウインドウメニュー（⌘M でしまう・拡大/縮小・ウインドウの一覧）。無いと ⌘M が効かない（Orca #21281 #20837）。
    // Windows / Linux には置かない（Ctrl+M をターミナルから奪わない）
    ...(isMac
      ? ([
          {
            label: t('menu.window'),
            role: 'window',
            submenu: [
              { role: 'minimize', label: t('menu.minimize') },
              { role: 'zoom', label: t('menu.zoom') },
              { type: 'separator' },
              { role: 'front', label: t('menu.bringAllToFront') }
            ]
          }
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      // ヘルプ。初回起動のセットアップ（オンボーディング）を開き直す（Orca の「Setup guide」に相当）
      label: t('menu.help'),
      role: 'help',
      submenu: [
        { label: t('menu.showOnboarding'), click: () => handlers.onCommand('showOnboarding') },
        { type: 'separator' },
        { label: t('feedback.menu'), click: () => handlers.onCommand('sendFeedback') },
        { label: t('menu.starOnGitHub'), click: () => handlers.onCommand('starOnGitHub') }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
