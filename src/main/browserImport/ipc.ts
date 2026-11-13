/**
 * 「ブラウザから取り込む」（パスワードの CSV・履歴）と、内蔵ブラウザのログインの欄への入力の IPC ハンドラ。
 * index.ts の registerIpc の dispatcher に混ぜて登録する（アプリの窓の本体のフレームからだけ受ける。security-5 [1]）。
 *
 * - パスワードの CSV のパスは画面から受け取らない（main がダイアログを出す）。履歴の元は main が見つけた候補の key だけ受ける
 * - 画面へ返すのはオリジン・ユーザー名・件数だけ。パスワードは main から内蔵ブラウザのページへ直接入れる
 * 重い部分（暗号化・SQLite）は使うときに読み込む（起動を遅くしない）
 */
import { Menu, dialog, safeStorage, shell, type BrowserWindow, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { IpcRequests } from '@shared/ipc'
import { BROWSER_IMPORT_LIMITS, isPasswordExportName, loginOrigin, type BrowserImportStatus, type PasswordExportFile } from '@shared/browserImport'
import { t } from '@shared/i18n'
import { UserFacingError } from '@shared/errors'
import type { SavedLoginStore } from './passwords'
import type { HistorySource, ImportedHistoryStore } from './history'

type Channel =
  | 'browserImport:status' | 'browserImport:importPasswords' | 'browserImport:findExports' | 'browserImport:trashExport' | 'browserImport:clearPasswords'
  | 'browserImport:historySources' | 'browserImport:importHistory' | 'browserImport:clearHistory' | 'browserImport:suggest'
  | 'passwords:forPage' | 'passwords:fill' | 'passwords:menu'

export interface BrowserImportDeps {
  window: () => BrowserWindow | null
  /** 内蔵ブラウザの表示中のタブ */
  pageContents: () => WebContents | null
  userDataDir: () => string
  /** 配布版だけ safeStorage で暗号化して保存する。dev 起動は保存しない（pipeline/stt/keys.ts の chooseKeyCipher） */
  isPackaged: boolean
  /** 取り込んだパスワードが変わったことを画面へ知らせる（鍵のボタンを出し直す） */
  notifyChanged?: () => void
  /** 書き出しの CSV を探すフォルダ（既定はホームのダウンロードとデスクトップ。テスト用） */
  exportDirs?: () => string[]
}

/** 書き出しの CSV を探すのは、ここ 14 日に変わったものだけ */
const EXPORT_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export function browserImportHandlers(deps: BrowserImportDeps): { [C in Channel]: (...args: Parameters<IpcRequests[C]>) => unknown } {
  let passwords: SavedLoginStore | null = null
  let history: ImportedHistoryStore | null = null
  /** 直前に見つけた履歴の元（画面が送るのは key だけ） */
  let sources = new Map<string, HistorySource>()
  /** この起動で選んだ・見つけたパスワードの CSV（key → パス）。画面はパスを持たず、key で取り込み・ごみ箱へ移すを頼む */
  const exportFiles = new Map<string, string>()
  const keyForFile = (path: string): string => {
    for (const [key, known] of exportFiles) if (known === path) return key
    const key = randomUUID()
    exportFiles.set(key, path)
    return key
  }
  const dir = () => join(deps.userDataDir(), 'browser-import')

  const passwordStore = async (): Promise<SavedLoginStore> => {
    if (!passwords) {
      const { SavedLoginStore: Store } = await import('./passwords')
      const { chooseKeyCipher } = await import('../pipeline/stt/keys')
      passwords = new Store(join(dir(), 'passwords.bin'), chooseKeyCipher({ isPackaged: deps.isPackaged, safeStorage }))
    }
    return passwords
  }
  const historyStore = async (): Promise<ImportedHistoryStore> => {
    if (!history) {
      const { ImportedHistoryStore: Store } = await import('./history')
      history = new Store(join(dir(), 'history.json'))
    }
    return history
  }
  const status = async (): Promise<BrowserImportStatus> => {
    const store = await passwordStore()
    return { passwords: { count: await store.count(), persisted: store.persisted() }, history: { count: await (await historyStore()).count() } }
  }
  /** いま表示中のタブ（破棄されていれば null） */
  const page = (): WebContents | null => {
    const contents = deps.pageContents()
    return contents && !contents.isDestroyed() ? contents : null
  }
  const fill = async (id: string): Promise<number> => {
    const contents = page()
    if (!contents) return 0
    const { fillLogin } = await import('./passwords')
    try {
      return await fillLogin(contents, await passwordStore(), id)
    } catch {
      // ページの移り変わりの途中など。中身（パスワード）を含めずに知らせる
      throw new UserFacingError(t('browserImport.passwords.fillFailed'))
    }
  }

  return {
    'browserImport:status': () => status(),
    'browserImport:importPasswords': async (key) => {
      let file: string | undefined
      if (typeof key === 'string') {
        file = exportFiles.get(key)
        if (!file) throw new UserFacingError(t('browserImport.passwords.unreadable'))
      } else {
        const parent = deps.window()
        const options: Electron.OpenDialogOptions = { title: t('browserImport.passwords.pick'), properties: ['openFile'], filters: [{ name: 'CSV', extensions: ['csv'] }] }
        const picked = parent && !parent.isDestroyed() ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
        file = picked.canceled ? undefined : picked.filePaths[0]
      }
      if (!file) return null
      const { readFileBounded } = await import('../boundedFile')
      const { parsePasswordCsv } = await import('@shared/browserImport')
      let parsed: ReturnType<typeof parsePasswordCsv>
      try {
        parsed = parsePasswordCsv((await readFileBounded(file, BROWSER_IMPORT_LIMITS.csvBytes)).toString('utf8'))
      } catch {
        // 大きすぎる・読めない。ファイルの中身は出さない
        throw new UserFacingError(t('browserImport.passwords.unreadable'))
      }
      if (!parsed) throw new UserFacingError(t('browserImport.passwords.notPasswordCsv'))
      if (parsed.logins.length === 0) throw new UserFacingError(t('browserImport.passwords.empty'))
      // 同じブラウザから前に取り込んだものは、この CSV の中身に置き換える（ブラウザで消した・変えたものを反映する）
      const result = await (await passwordStore()).importLogins(parsed.logins, parsed.source)
      deps.notifyChanged?.()
      return { ...result, skipped: parsed.skipped, file: keyForFile(file) }
    },
    'browserImport:findExports': async () => {
      const dirs = deps.exportDirs?.() ?? [join(homedir(), 'Downloads'), join(homedir(), 'Desktop')]
      const now = Date.now()
      const found: Array<PasswordExportFile & { path: string }> = []
      for (const dir of dirs) {
        let names: string[]
        try { names = await readdir(dir) } catch { continue } // 無い・読めないフォルダ（想定内）
        for (const name of names.filter(isPasswordExportName)) {
          const path = join(dir, name)
          const info = await stat(path).catch(() => null)
          if (!info?.isFile() || info.size > BROWSER_IMPORT_LIMITS.csvBytes || now - info.mtimeMs > EXPORT_MAX_AGE_MS) continue
          found.push({ key: '', name: basename(path), modifiedAt: info.mtimeMs, path })
        }
      }
      return found.sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, 10).map(({ path, ...rest }) => ({ ...rest, key: keyForFile(path) }))
    },
    'browserImport:trashExport': async (key) => {
      const file = typeof key === 'string' ? exportFiles.get(key) : undefined
      if (!file) return false
      await shell.trashItem(file)
      exportFiles.delete(String(key))
      return true
    },
    'browserImport:clearPasswords': async () => {
      await (await passwordStore()).clear()
      deps.notifyChanged?.()
      return status()
    },
    'browserImport:historySources': async () => {
      const { detectHistorySources } = await import('./history')
      const found = await detectHistorySources(process.platform, homedir(), process.env)
      sources = new Map(found.map((source) => [source.key, source]))
      return found.map(({ path: _path, ...rest }) => rest)
    },
    'browserImport:importHistory': async (key) => {
      const source = sources.get(String(key))
      if (!source) throw new UserFacingError(t('browserImport.history.notFound'))
      const { HistoryAccessDeniedError, readHistorySource } = await import('./history')
      let entries: Awaited<ReturnType<typeof readHistorySource>>
      try {
        entries = await readHistorySource(source)
      } catch (err) {
        if (err instanceof HistoryAccessDeniedError) throw new UserFacingError(t('browserImport.history.fullDiskAccess'))
        throw new UserFacingError(t('browserImport.history.failed', { browser: source.browser }))
      }
      await (await historyStore()).add(entries)
      return { read: entries.length, status: await status() }
    },
    'browserImport:clearHistory': async () => {
      await (await historyStore()).clear()
      return status()
    },
    'browserImport:suggest': async (query) => {
      if (typeof query !== 'string' || !query.trim()) return []
      return (await (await historyStore()).suggest(query.slice(0, 500))).map(({ url, title }) => ({ url, title }))
    },
    'passwords:forPage': async () => {
      const contents = page()
      const { pageHasPasswordField, topFrameUrl } = await import('./passwords')
      const url = contents ? topFrameUrl(contents) : ''
      const origin = loginOrigin(url) && /^https?:\/\//.test(url) ? new URL(url).origin : ''
      if (!contents || !origin) return { origin: '', hasPasswordField: false, accounts: [] }
      const accounts = await (await passwordStore()).accountsFor(url)
      // 保存した資格情報が無いページでは、ページの中を調べない
      const hasPasswordField = accounts.length > 0 && await pageHasPasswordField(contents)
      return { origin, hasPasswordField, accounts }
    },
    'passwords:fill': (id) => fill(String(id)),
    'passwords:menu': async (at) => {
      const window = deps.window()
      const contents = page()
      if (!window || window.isDestroyed() || !contents) return false
      const { topFrameUrl } = await import('./passwords')
      const accounts = await (await passwordStore()).accountsFor(topFrameUrl(contents))
      const x = Number(at?.x)
      const y = Number(at?.y)
      const choice = await new Promise<string | 'manage' | null>((resolve) => {
        let picked: string | 'manage' | null = null
        const items: Electron.MenuItemConstructorOptions[] = accounts.map((account) => ({
          // 別のサブドメインで保存したものは、どこのものか分かるようホスト名を添える
          label: `${account.username || t('browserImport.passwords.noUsername')}${account.site ? ` — ${account.site}` : ''}`,
          click: () => { picked = account.id }
        }))
        if (!items.length) items.push({ label: t('browserImport.passwords.none'), enabled: false })
        items.push({ type: 'separator' }, { label: t('browserImport.passwords.manage'), click: () => { picked = 'manage' } })
        Menu.buildFromTemplate(items).popup({ window, x: Math.round(Number.isFinite(x) ? x : 0), y: Math.round(Number.isFinite(y) ? y : 0), callback: () => resolve(picked) })
      })
      if (choice === 'manage') return 'manage'
      if (!choice) return false
      return (await fill(choice)) > 0
    }
  }
}
