/**
 * ビジネスの処理と Electron（ターミナル・ネイティブのダイアログ）のつなぎ。ビジネス担当の electronGlue.ts の terminalSender・dialogConfirm の写し。
 * Electron の値は呼び出し側から受け取り、ここでは import しない（型だけ）
 */
import type { BrowserWindow, MessageBoxOptions } from 'electron'
import { agentLabel } from '@shared/agentCatalog'
import { isUserFacingError } from '@shared/errors'
import { t } from '@shared/i18n'
import type { VentureSendTarget } from '@shared/venture/ipc'
import type { TerminalManager } from '../terminal'

export interface SendOutcome {
  ok: boolean
  message: string
  /** 送った Agent の名前（分からなければ空） */
  label: string
}

export interface AgentSender {
  send(target: VentureSendTarget, text: string): Promise<SendOutcome>
}

export interface ConfirmRequest {
  message: string
  detail: string
  /** 「する」側のボタンの文 */
  confirmLabel: string
}

/** 確かめる（はい なら true。やめた・窓が無いなら false） */
export type ConfirmFn = (request: ConfirmRequest) => Promise<boolean>

type Terminals = Pick<TerminalManager, 'resolveSendTarget' | 'agentState' | 'sendReview'>

/**
 * Ferret の「Agent へ送信」と同じ送り方（TerminalManager.sendReview: bracketed paste のあと Enter）。
 * - active: 開いているプロジェクトの Agent（resolveSendTarget）
 * - terminal: そのターミナルに Agent が動いているときだけ
 * - new: ここでは起動しない（タブを開くのは画面の TerminalPane）。起動してから terminal を指定して送り直してもらう
 * 送れなければ ok:false（送ったとは言わない）
 */
export function terminalSender(terminals: () => Terminals | null, folder: () => string | null): AgentSender {
  return {
    async send(target, text) {
      try {
        const manager = terminals()
        if (!manager) return { ok: false, message: t('venture.error.sendNoTerminal'), label: '' }
        if (target.kind === 'new') {
          const name = target.agent === 'codex' ? 'Codex' : 'Claude Code'
          return { ok: false, message: t('venture.error.sendStartNew', { name }), label: name }
        }
        let id: string | null = null
        if (target.kind === 'active') id = await manager.resolveSendTarget(null, folder())
        else {
          const chosen = await manager.agentState(target.id).catch(() => null) // 閉じたばかりのタブ（想定内）
          if (chosen && chosen.kind !== 'unknown') id = target.id
        }
        if (!id) return { ok: false, message: t('venture.error.sendNoAgent'), label: '' }
        const state = await manager.agentState(id).catch(() => null)
        const label = agentLabel(state?.agent ?? null) || 'Agent'
        const result = await manager.sendReview(id, text)
        return { ok: result.ok === true, message: result.message || (result.ok ? '' : t('venture.error.sendFailed')), label }
      } catch (err) {
        return { ok: false, message: isUserFacingError(err) ? (err as Error).message : t('venture.error.sendFailed'), label: '' }
      }
    }
  }
}

/**
 * 承認・予算・運営の判断の確認（アプリの窓のネイティブのダイアログ。renderer からは押せない）。
 * 「やめる」が既定。窓が無ければ確かめられないので断る。
 * E2E のときだけ、e2eAnswer（ADE_E2E_VENTURE_CONFIRM=yes|no）で答えを決められる
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
      buttons: [request.confirmLabel, t('venture.dialog.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      message: request.message,
      detail: request.detail
    })
    return response === 0
  }
}
