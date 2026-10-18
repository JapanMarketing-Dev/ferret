/**
 * Agent へ送る許可の札（ビジネスの business:armSend/send とリサーチの research:armSend/send が使う）。
 *
 * 送るボタンを押した直後（gesture の 'send'。1回きり・約1秒）に arm で作り、
 * プロンプト・本文の sha256・送り先・フォルダに結び付ける。use は札と中身が合うときだけ true を返し、札は1回で消える（60秒まで）。
 * 残る弱さ: renderer を完全に乗っ取られると、人が画面のどこかを押した直後に、乗っ取った側の本文で札を作れる
 * （main は「どのボタンが押されたか」を知らない）。本文は Agent への依頼で、守ることは main が必ず付ける。
 * 新しい Agent へ送るときは起動前に札を作るので、札の送り先 {kind:'new'} はターミナルの送り先と合うものとして扱う
 */
import { createHash, randomBytes } from 'node:crypto'
import type { BusinessSendTarget } from '@shared/business/ipc'
import { UserFacingError } from '@shared/errors'

/** 送る許可の札の有効な時間（新しい Agent の起動を待つ間も持つ） */
export const SEND_TICKET_MS = 60_000

/** 断るときの文（ビジネスは日本語の固定の文、リサーチは i18n。呼ぶたびに引く） */
export interface SendPassMessages {
  needsAction(): string
  badPrompt(): string
  badText(): string
  badTarget(): string
  noRoot(): string
}

export interface SendPassDeps {
  /** 開いているプロジェクトのフォルダ（札はこのフォルダに結び付く） */
  root(): string | null
  /** 利用者の操作の許可（1回きり） */
  consent(): boolean
  now?: () => Date
  /** 使えるプロンプトの ID か */
  isPromptId(id: unknown): id is string
  messages: SendPassMessages
}

interface SendPass { promptId: string; textHash: string; target: BusinessSendTarget; root: string; expires: number }

export const sha256Hex = (text: string) => createHash('sha256').update(text).digest('hex')

/** 送り先の形を確かめる（合わなければ UserFacingError） */
export function parseSendTarget(raw: unknown, message: () => string): BusinessSendTarget {
  const t = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null
  if (t?.kind === 'active') return { kind: 'active' }
  if (t?.kind === 'terminal' && typeof t.id === 'string' && t.id && t.id.length <= 200) return { kind: 'terminal', id: t.id }
  if (t?.kind === 'new' && (t.agent === 'claude' || t.agent === 'codex')) return { kind: 'new', agent: t.agent }
  throw new UserFacingError(message())
}

function sameTarget(pass: BusinessSendTarget, sent: unknown): boolean {
  const t = sent && typeof sent === 'object' ? sent as Record<string, unknown> : null
  if (!t) return false
  if (pass.kind === 'active') return t.kind === 'active'
  if (pass.kind === 'terminal') return t.kind === 'terminal' && t.id === pass.id
  return t.kind === 'terminal' && typeof t.id === 'string'
}

export interface SendPasses {
  /** 札を作る（{ promptId, textHash, target }）。操作の直後でなければ断る */
  arm(input: unknown): { ticket: string }
  /** 札を使う（合わなければ false。札は合っても合わなくても消す） */
  use(request: unknown): boolean
}

export function createSendPasses(deps: SendPassDeps): SendPasses {
  const passes = new Map<string, SendPass>()
  const clock = () => (deps.now ? deps.now() : new Date()).getTime()
  const fail = (message: () => string): never => { throw new UserFacingError(message()) }
  return {
    arm(input) {
      const i = input && typeof input === 'object' ? input as Record<string, unknown> : {}
      if (!deps.isPromptId(i.promptId)) fail(deps.messages.badPrompt)
      if (typeof i.textHash !== 'string' || !/^[0-9a-f]{64}$/.test(i.textHash)) fail(deps.messages.badText)
      const target = parseSendTarget(i.target, deps.messages.badTarget)
      const root = deps.root()
      if (!root) fail(deps.messages.noRoot)
      if (!deps.consent()) fail(deps.messages.needsAction)
      const ticket = randomBytes(18).toString('base64url')
      passes.set(ticket, { promptId: i.promptId as string, textHash: i.textHash as string, target, root: root as string, expires: clock() + SEND_TICKET_MS })
      return { ticket }
    },
    use(request) {
      const now = clock()
      for (const [k, p] of passes) if (p.expires < now) passes.delete(k)
      const r = request && typeof request === 'object' ? request as Record<string, unknown> : null
      if (!r || typeof r.ticket !== 'string') return false
      const pass = passes.get(r.ticket)
      if (!pass) return false
      passes.delete(r.ticket)
      return pass.root === deps.root() && pass.promptId === r.promptId && typeof r.text === 'string' &&
        pass.textHash === sha256Hex(r.text) && sameTarget(pass.target, r.target)
    }
  }
}
