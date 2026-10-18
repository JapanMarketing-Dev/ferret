/**
 * ビジネス（venture:*）を index.ts につなぐ口。index.ts は ventureOpsHandlers({...})（registerIpc の handlers に広げる）と
 * ventureForBusiness（リサーチの「プロジェクトにする」の行き先）だけを使う。
 * 承認の台帳と鍵は Ferret の userData に置く:
 *   userData/venture-approvals/        人の判断の正本（HMAC の署名つき。フォルダの実体のパスの sha256 ごと）
 *   userData/venture-approvals-key.bin その鍵（配布版は OS の鍵の保管庫で暗号化）
 * 型（VentureOpsWiring）は index.ts との約束なので、変えるときは owner-venture に相談する
 */
import { lstatSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { BrowserWindow, Dialog, SafeStorage } from 'electron'
import type { Project, ProjectsState } from '@shared/types'
import type { VentureIpcRequests } from '@shared/venture/ipc'
import { chooseKeyCipher } from '../pipeline/stt/keys'
import type { TerminalManager } from '../terminal'
import { ventureHandlers } from './handlers'
import { FileVentureLedger, VentureLedgerKeyStore } from './ledger'
import { dialogConfirm, terminalSender } from './sender'
import { fail, initialFiles, toVentureError, writeInitialFilesSync } from './store'

export type VentureOpsHandlers = { [C in keyof VentureIpcRequests]: (...args: Parameters<VentureIpcRequests[C]>) => unknown }

export interface VentureOpsWiring {
  userData: string
  isPackaged: boolean
  isE2E: boolean
  safeStorage: SafeStorage
  dialog: Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>
  window(): BrowserWindow | null
  /** 開いているプロジェクトのフォルダ（SSH・未選択なら null） */
  root(): string | null
  /** 開いているプロジェクトの id */
  openProjectId(): string | null
  projects(): readonly Project[]
  /**
   * フォルダをプロジェクトとして登録する（登録済みならそれ）。orchestra なら新しいオーケストラ（editorWorkspace）にする。
   * orchestraId を渡せばそのオーケストラに入れる。名前を渡せば付ける。設定の保存・オーケストラの同期・画面への知らせは index.ts がする
   */
  registerFolder(folder: string, options: { name?: string; orchestra?: boolean; orchestraId?: string }): Project
  /** プロジェクトを開く（project:switch と同じ） */
  openProject(id: string): void
  projectsState(): ProjectsState
  /** 録画中ならフォルダを替えない（UserFacingError を投げる） */
  assertNotRecording(): void
  terminals(): TerminalManager | null
  /** 利用者の操作の直後か（Agent へ送るボタン。1回きり） */
  consentSend(): boolean
  locale(): 'ja' | 'en'
  /** 画面へ知らせる（venture:changed） */
  notify(): void
  /** 動画チャンネルのフォルダの中の動画の数（分からなければ null） */
  videoCount?(folder: string): Promise<number | null>
}

/** 台帳の置き場所（userData の下） */
export const VENTURE_LEDGER_DIR = 'venture-approvals'
export const VENTURE_LEDGER_KEY_FILE = 'venture-approvals-key.bin'
/** <フォルダ名>-venture が埋まっているときに試す数 */
export const MAX_VENTURE_FOLDER_TRIES = 100

export function ventureOpsHandlers(w: VentureOpsWiring): VentureOpsHandlers {
  const cipher = chooseKeyCipher({ isPackaged: w.isPackaged, isE2E: w.isE2E, safeStorage: w.safeStorage })
  const keys = new VentureLedgerKeyStore(path.join(w.userData, VENTURE_LEDGER_KEY_FILE), cipher)
  const ledgerDir = path.join(w.userData, VENTURE_LEDGER_DIR)
  const win = (): BrowserWindow | null => {
    const x = w.window()
    return x && !x.isDestroyed() ? x : null
  }
  return ventureHandlers({
    wiring: w,
    ledgerFor: (root) => new FileVentureLedger(ledgerDir, root, () => keys.key()),
    confirm: dialogConfirm({
      window: w.window,
      showMessageBox: (window, options) => w.dialog.showMessageBox(window, options),
      e2eAnswer: w.isE2E ? (process.env.ADE_E2E_VENTURE_CONFIRM ?? null) : null
    }),
    sender: terminalSender(w.terminals, w.root),
    pickers: {
      pickFolder: async ({ title, defaultPath, create }) => {
        const x = win()
        if (!x) return null
        const result = await w.dialog.showOpenDialog(x, {
          title,
          properties: create ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
          ...(defaultPath ? { defaultPath } : {})
        })
        return result.canceled ? null : result.filePaths[0] ?? null
      },
      pickFile: async ({ title, filters }) => {
        const x = win()
        if (!x) return null
        const result = await w.dialog.showOpenDialog(x, { title, properties: ['openFile'], filters })
        return result.canceled ? null : result.filePaths[0] ?? null
      }
    }
  })
}

/** folder の隣で空いている <フォルダ名>-venture（あれば -venture-2, -venture-3…）を作る（同期・排他）。作ったフォルダ */
export function makeVentureFolderSync(folder: string): string {
  const parent = path.dirname(path.resolve(folder))
  const st = lstatSync(parent, { throwIfNoEntry: false })
  if (!st || st.isSymbolicLink() || !st.isDirectory()) fail('parentInvalid')
  const base = `${path.basename(path.resolve(folder))}-venture`
  for (let n = 1; n <= MAX_VENTURE_FOLDER_TRIES; n++) {
    const target = path.join(parent, n === 1 ? base : `${base}-${n}`)
    try {
      mkdirSync(target)
      return target
    } catch (err) {
      if ((err as { code?: unknown }).code === 'EEXIST') continue
      throw toVentureError(err)
    }
  }
  fail('folderTaken')
}

/**
 * リサーチの「プロジェクトにする」の行き先（ResearchDeps['registerBusiness'] と同じ形・同期）。
 * ビジネス記録のフォルダ（folder）を登録し、隣に <フォルダ名>-venture（あれば -2, -3…）のビジネスを作って business の役割で入れ、ビジネスを開く。
 * 返す projectId はビジネス記録のプロジェクト（リサーチの markPromoted が使う）。
 * orchestraId 引数は使わない（ビジネス自体が新しいオーケストラで、ビジネス記録はそこに入る）
 */
export function ventureForBusiness(w: VentureOpsWiring): (folder: string, name: string, orchestraId: string | null) => { projectId: string } {
  return (folder, name) => {
    w.assertNotRecording()
    const business = w.registerFolder(folder, {})
    const ventureFolder = makeVentureFolderSync(folder)
    const ventureName = String(name ?? '').trim() || path.basename(ventureFolder)
    writeInitialFilesSync(ventureFolder, initialFiles(ventureName, new Date().toISOString(), w.locale(), [
      { role: 'business', folder: path.resolve(folder), projectId: business.id }
    ]))
    const venture = w.registerFolder(ventureFolder, { name: ventureName, orchestra: true })
    w.registerFolder(folder, { orchestraId: venture.id })
    w.openProject(venture.id)
    return { projectId: business.id }
  }
}
