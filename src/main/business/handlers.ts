/**
 * ビジネスの IPC（business:*）の処理。index.ts の registerIpc() の handlers に `...businessHandlers(deps)` で入れる。
 * ビジネスのフォルダは deps.root()（開いているプロジェクトのフォルダ）だけ。renderer からパスは受け取らない
 */
import type { BusinessIpcRequests } from '@shared/business/ipc'
import type { RecordKind } from '@shared/business/model'
import { UserFacingError } from '@shared/errors'
import { BusinessStore, type AgentSender, type ConfirmFn, type PageCapture } from './store'
import { FileApprovalLedger, MemoryApprovalLedger, type ApprovalLedger } from './approvalLedger'
import { listBusinesses, type ListedProject } from './list'
import { originOf, type PageConfigStore } from './pages'
import { createSendPasses } from './sendPass'

export interface BusinessDeps {
  /** 開いているプロジェクトのフォルダ（SSH のプロジェクト・未選択なら null） */
  root(): string | null
  projects(): readonly ListedProject[]
  /** resources/business/手法.md の本文 */
  manual: string
  sender: AgentSender
  capture(): Promise<PageCapture>
  pages: PageConfigStore
  now?: () => Date
  /** Agent へ送る許可（index.ts ではアプリの窓での本物のクリック・キーの直後に1回だけ。gestures.consume('send')） */
  consentSend(): boolean
  /** 承認・公開の確認（index.ts ではアプリの窓のネイティブのダイアログ） */
  confirm: ConfirmFn
  /** 人の判断の正本を置くフォルダ（userData/business-approvals）と HMAC の鍵。省略時は起動中だけ */
  ledger?: { dir: string; key: () => Promise<Buffer> }
  /** 使っている人の状況（Ferret の「あなたの状況」）。context.md に入れる */
  founder?: () => Promise<string>
}

export { SEND_TICKET_MS } from './sendPass'
export const SEND_NEEDS_ACTION = '送るボタンを押してから、もう一度お試しください。'

export type BusinessHandlers = { [C in keyof BusinessIpcRequests]: (...args: Parameters<BusinessIpcRequests[C]>) => unknown }

export function businessHandlers(deps: BusinessDeps): BusinessHandlers {
  let cached: BusinessStore | null = null
  const ledgers = new Map<string, ApprovalLedger>()
  const ledgerFor = (root: string): ApprovalLedger => {
    let l = ledgers.get(root)
    if (!l) {
      l = deps.ledger ? new FileApprovalLedger(deps.ledger.dir, root, deps.ledger.key) : new MemoryApprovalLedger()
      ledgers.set(root, l)
    }
    return l
  }
  const store = (): BusinessStore => {
    const root = deps.root()
    if (!root) throw new UserFacingError('プロジェクトのフォルダを開いてください。')
    if (!cached || cached.root !== root) {
      cached = new BusinessStore({ root, manual: deps.manual, ledger: ledgerFor(root), confirm: deps.confirm, pageOrigin: async () => originOf(await deps.pages.endpoint()), ...(deps.founder ? { founder: deps.founder } : {}), ...(deps.now ? { now: deps.now } : {}) })
    }
    return cached
  }
  // 送る許可の札（sendPass.ts）。送るボタンを押した直後に作り、プロンプト・本文・送り先・フォルダに結び付ける
  const passes = createSendPasses({
    root: deps.root,
    consent: deps.consentSend,
    ...(deps.now ? { now: deps.now } : {}),
    isPromptId: (id): id is string => typeof id === 'string' && id.length <= 100,
    messages: {
      needsAction: () => SEND_NEEDS_ACTION,
      badPrompt: () => 'プロンプトが見つかりません。',
      badText: () => '送る本文が正しくありません。',
      badTarget: () => '送り先が正しくありません。',
      noRoot: () => 'プロジェクトのフォルダを開いてください。'
    }
  })

  const api = () => deps.pages.api()
  return {
    'business:status': async () => {
      const root = deps.root()
      if (!root) return { root: null, isBusiness: false, name: null }
      return { root, ...(await store().status()) }
    },
    'business:list': () => listBusinesses(deps.projects(), deps.now),
    'business:init': (input) => store().init(input ?? { name: '', target: '' }),
    'business:load': () => store().load(),
    'business:saveRecord': (kind, record, body) => store().saveRecord(kind, record, body),
    'business:deleteRecord': (kind, id) => store().deleteRecord(kind as RecordKind, id),
    'business:updateBusiness': (patch) => store().updateBusiness(patch),
    'business:advanceStage': (id, to, note) => store().advanceStage(id, to, note),
    'business:closeLoop': (input) => store().closeLoop(input),
    'business:prompt': (id) => store().prompt(id),
    'business:savePromptOverride': (id, body) => store().savePromptOverride(id, body),
    'business:armSend': (input) => passes.arm(input),
    'business:send': (request) => {
      // 送るボタンを押した直後に作った札と、プロンプト・本文・送り先・フォルダが合うときだけ送る。renderer の申告だけでは送らない
      if (!passes.use(request)) throw new UserFacingError(SEND_NEEDS_ACTION)
      return store().send(request, deps.sender)
    },
    'business:sentHistory': () => store().sentHistory(),
    'business:decideApproval': (id, status, answer) => store().decideApproval(id, status, answer),
    'business:addSearch': (search) => store().addSearch(search),
    'business:captureEvidence': (input) => store().captureEvidence(deps.capture, input?.hypothesisId ?? null),
    'business:pageConfig': () => deps.pages.config(),
    'business:setPageConfig': (input) => deps.pages.set(input ?? { endpoint: '', token: '' }),
    'business:pushPage': (input) => store().pushPage(input, api),
    'business:pageContent': (id) => store().pageContent(id),
    'business:unpublishPage': (id) => store().unpublishPage(id, api),
    'business:pageStats': (id) => store().pageStats(id, api),
    'business:applyPageStats': (id) => store().applyPageStats(id, api)
  }
}
