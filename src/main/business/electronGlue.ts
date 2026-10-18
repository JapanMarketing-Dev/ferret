/**
 * ビジネスの処理と Electron（ターミナル・内蔵ブラウザ）のつなぎ。index.ts を薄く保つためにここへ置く。
 * Electron の値は呼び出し側から受け取り、ここでは import しない（型だけ）
 */
import type { BrowserWindow, MessageBoxOptions, WebContents } from 'electron'
import { agentLabel } from '@shared/agentCatalog'
import type { BusinessSendTarget } from '@shared/business/ipc'
import { UserFacingError } from '@shared/errors'
import type { TerminalManager } from '../terminal'
import type { AgentSender, ConfirmFn, PageCapture, SendOutcome } from './store'

/** 隔離した world で選んだ文を読む（ページの JS が getSelection を差し替えても影響しない） */
const SELECTION_WORLD_ID = 1311
const SELECTION_SCRIPT = `(() => { try { const s = window.getSelection(); return s ? String(s.toString()).slice(0, 5000) : '' } catch { return '' } })()`
const CAPTURE_TIMEOUT_MS = 8000

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new UserFacingError('ページの取り込みに時間がかかりすぎたため、やめました。')), ms)
    p.then((v) => { clearTimeout(timer); resolve(v) }, (err: unknown) => { clearTimeout(timer); reject(err) })
  })
}

/**
 * 内蔵ブラウザで見ているページの URL・題名・選んだ文・画面の写し。
 * 画面を撮るのは index.ts（security-5 [1] の許可の一覧）で、利用者の操作の許可（captureConsent.ts の
 * UserGestures の 'screenshot'。1回の操作で1回だけ）を使えたときだけ。許可が無ければ何も読まずに断る
 */
export async function captureActivePage(
  contents: WebContents | null,
  pixels: { consent(): boolean; shoot(contents: WebContents): Promise<Uint8Array> }
): Promise<PageCapture> {
  if (!pixels.consent()) throw new UserFacingError('証拠に追加するボタンを押してから、もう一度お試しください。')
  if (!contents || contents.isDestroyed()) throw new UserFacingError('ブラウザでページを開いてから追加してください。')
  let url = ''
  try {
    url = contents.mainFrame.url || contents.getURL()
  } catch {
    url = ''
  }
  if (!/^https?:\/\//i.test(url)) throw new UserFacingError('http・https のページだけ証拠に追加できます。')
  const title = contents.getTitle()
  const selection = await withTimeout(
    contents.executeJavaScriptInIsolatedWorld(SELECTION_WORLD_ID, [{ code: SELECTION_SCRIPT }]).then((v: unknown) => (typeof v === 'string' ? v : '')),
    CAPTURE_TIMEOUT_MS
  ).catch(() => '') // 読み込みの途中など（選んだ文なし＝発見のみ として続ける）
  const png = await withTimeout(pixels.shoot(contents), CAPTURE_TIMEOUT_MS)
  return { url, title, selection, png }
}

/**
 * Ferret の「Agent へ送信」と同じ送り方（TerminalManager.sendReview: bracketed paste のあと Enter）。
 * - active: 開いているプロジェクトの Agent（resolveSendTarget）
 * - terminal: そのターミナルに Agent が動いているときだけ
 * - new: ここでは起動しない（タブを開くのは画面の TerminalPane）。起動してから terminal を指定して送り直してもらう
 * 送れなければ ok:false（送ったとは言わない）
 */
export function terminalSender(terminals: () => TerminalManager | null, folder: () => string | null): AgentSender {
  return {
    async send(target: BusinessSendTarget, text: string): Promise<SendOutcome> {
      const manager = terminals()
      if (!manager) return { ok: false, message: 'ターミナルで Claude Code か Codex を起動してから送ってください。', label: '' }
      if (target.kind === 'new') {
        const name = target.agent === 'codex' ? 'Codex' : 'Claude Code'
        return { ok: false, message: `新しい ${name} を起動してから、もう一度送ってください。`, label: name }
      }
      let id: string | null = null
      if (target.kind === 'active') id = await manager.resolveSendTarget(null, folder())
      else {
        const chosen = await manager.agentState(target.id).catch(() => null) // 閉じたばかりのタブ（想定内）
        if (chosen && chosen.kind !== 'unknown') id = target.id
      }
      if (!id) return { ok: false, message: '送り先の Agent がいません。ターミナルで Claude Code か Codex を起動してから送ってください。', label: '' }
      const state = await manager.agentState(id).catch(() => null)
      const label = agentLabel(state?.agent ?? null) || 'Agent'
      const result = await manager.sendReview(id, text)
      return { ok: result.ok, message: result.message, label }
    }
  }
}

/**
 * 承認・公開の確認（アプリの窓のネイティブのダイアログ。renderer からは押せない）。
 * 「やめる」が既定。窓が無ければ確かめられないので断る。
 * E2E（ADE_E2E=1）のときだけ、e2eAnswer（ADE_E2E_BUSINESS_CONFIRM=yes|no）で答えを決められる
 */
export function dialogConfirm(deps: {
  window(): BrowserWindow | null
  showMessageBox(window: BrowserWindow, options: MessageBoxOptions): Promise<{ response: number }>
  e2eAnswer?: string | null
}): ConfirmFn {
  return async (request) => {
    if (deps.e2eAnswer === 'yes') return true
    if (deps.e2eAnswer === 'no') return false
    const win = deps.window()
    if (!win || win.isDestroyed()) return false
    const { response } = await deps.showMessageBox(win, {
      type: 'question',
      buttons: [request.confirmLabel, 'やめる'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: request.message,
      detail: request.detail
    })
    return response === 0
  }
}
