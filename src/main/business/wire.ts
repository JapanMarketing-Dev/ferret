/**
 * ビジネス（business:*）とビジネスリサーチ（research:*）を index.ts につなぐ口。index.ts は
 *   ...ventureHandlers({...})（registerIpc の handlers）と ventureWatcher（setWorkspace で watch）
 * だけを使う。鍵・承認の台帳・実験ページの接続先は Ferret の userData（ほかの鍵と同じ置き場）に置く:
 *   userData/business-approvals/        人の判断の正本（HMAC の署名つき）
 *   userData/business-approvals-key.bin その鍵（配布版は OS の鍵の保管庫で暗号化）
 *   userData/business-pages.json        実験ページの接続先
 *   userData/business-pages-token.bin   その管理トークン（同上）
 *   userData/research-gates/            ビジネスリサーチのゲートの人の判断の正本（同じ鍵で HMAC の署名つき）
 */
import { join } from 'node:path'
import type { BrowserWindow, Dialog, SafeStorage, WebContents } from 'electron'
import { chooseKeyCipher } from '../pipeline/stt/keys'
import type { TerminalManager } from '../terminal'
import { LedgerKeyStore } from './approvalLedger'
import { captureActivePage, dialogConfirm, terminalSender } from './electronGlue'
import { businessHandlers, type BusinessHandlers } from './handlers'
import { PageConfigStore } from './pages'
import { BusinessWatcher } from './watcher'
import { researchHandlers, type ResearchDeps, type ResearchHandlers } from '../research/handlers'
import { KeepGoing } from '../research/keepGoing'
import { ResearchStore } from '../research/store'
import type { ListedProject } from './list'

export interface VentureWiring {
  userData: string
  isPackaged: boolean
  isE2E: boolean
  safeStorage: SafeStorage
  dialog: Pick<Dialog, 'showMessageBox' | 'showOpenDialog'>
  /** 開いているプロジェクトのフォルダ（SSH・未選択なら null） */
  root(): string | null
  projects(): readonly ListedProject[]
  terminals(): TerminalManager | null
  /** 内蔵ブラウザで前に出ているページ */
  browserContents(): WebContents | null
  /** そのページを1枚撮る（PNG。撮る場所は index.ts に限る: security-5 [1]） */
  shootPage(contents: WebContents): Promise<Uint8Array>
  /** 利用者の操作の許可（captureConsent.ts の UserGestures） */
  consume(kind: 'send' | 'screenshot'): boolean
  window(): BrowserWindow | null
  locale(): 'ja' | 'en'
  manual: string
  /** 集客の5原則のナレッジ（docs/business-research/knowledge.md。英語の画面は knowledge.en.md） */
  knowledge: string
  registerResearch: ResearchDeps['registerResearch']
  registerBusiness: ResearchDeps['registerBusiness']
  /** 使っている人の状況（Ferret の「あなたの状況」。リサーチ・ビジネスの context.md に入れる） */
  founder?: () => Promise<string>
}

export function ventureHandlers(w: VentureWiring): BusinessHandlers & ResearchHandlers {
  const cipher = () => chooseKeyCipher({ isPackaged: w.isPackaged, isE2E: w.isE2E, safeStorage: w.safeStorage })
  const ledgerKey = new LedgerKeyStore(join(w.userData, 'business-approvals-key.bin'), cipher())
  const sender = terminalSender(w.terminals, w.root)
  // 「参入先を決め切る」を、どの Agent でも決め切るまで止めない（Claude Code で Stop フックがあるフォルダはフックに任せる）
  const keepGoing = new KeepGoing({
    exists: (id) => w.terminals()?.list().some((s) => s.id === id) ?? false,
    agentState: async (id) => (await w.terminals()?.agentState(id)) ?? { kind: 'unknown', state: 'unknown', agent: null },
    screenText: (id) => w.terminals()?.screenText(id) ?? '',
    send: async (id, text) => (await w.terminals()?.sendReview(id, text)) ?? { ok: false, message: '' },
    check: (root, locale) => new ResearchStore({ root, locale: () => locale }).conclusionMissing(),
    hasClaudeHook: (root) => new ResearchStore({ root }).hasClaudeHook()
  })
  const confirm = dialogConfirm({
    window: w.window,
    showMessageBox: (win, options) => w.dialog.showMessageBox(win, options),
    e2eAnswer: w.isE2E ? (process.env.ADE_E2E_BUSINESS_CONFIRM ?? null) : null
  })
  return {
    ...businessHandlers({
      root: w.root,
      projects: w.projects,
      manual: w.manual,
      sender,
      // 証拠に追加: アプリの窓での操作の許可（1回きり）を使えたときだけ、内蔵ブラウザのページを1枚撮る
      capture: () => captureActivePage(w.browserContents(), {
        consent: () => w.consume('screenshot'),
        shoot: w.shootPage
      }),
      pages: new PageConfigStore({ config: join(w.userData, 'business-pages.json'), token: join(w.userData, 'business-pages-token.bin') }, cipher(), w.isPackaged),
      // Agent へ送る: アプリの窓での本物の操作の直後に1回だけ。承認・公開: main が読んだ中身をネイティブのダイアログで確かめる
      consentSend: () => w.consume('send'),
      confirm,
      ledger: { dir: join(w.userData, 'business-approvals'), key: () => ledgerKey.key() },
      ...(w.founder ? { founder: w.founder } : {})
    }),
    ...researchHandlers({
      root: w.root,
      locale: w.locale,
      sender,
      consentSend: () => w.consume('send'),
      confirm,
      pickFolder: async ({ title, defaultPath, create }) => {
        const win = w.window()
        if (!win || win.isDestroyed()) return null
        const result = await w.dialog.showOpenDialog(win, {
          title,
          properties: create === false ? ['openDirectory'] : ['openDirectory', 'createDirectory'],
          ...(defaultPath ? { defaultPath } : {})
        })
        return result.canceled ? null : result.filePaths[0] ?? null
      },
      registerResearch: w.registerResearch,
      registerBusiness: w.registerBusiness,
      manual: w.manual,
      knowledge: w.knowledge,
      ledger: { dir: join(w.userData, 'research-gates'), key: () => ledgerKey.key() },
      keepGoing,
      ...(w.founder ? { founder: w.founder } : {})
    })
  }
}

/** ビジネス・リサーチのフォルダの変更（Agent が書いた・人が保存した）を画面へ知らせる。両方に同じ合図を送る */
export function ventureWatcher(send: (channel: 'business:changed' | 'research:changed') => void): BusinessWatcher {
  return new BusinessWatcher(() => {
    send('business:changed')
    send('research:changed')
  })
}
