/**
 * 判定モデルのローカル中継（127.0.0.1 の空いているポート）。
 *
 * Agent は feedback.md の手順で判定モデルを呼ぶ。直接プロバイダへ送ると Ferret からは回数も費用も見えないので、
 * Agent には中継の URL（起動ごとの合言葉 t= 付き）だけを渡し、中継が本当の接続先へそのまま送り直す。
 *   - キーと追加のヘッダーは中継が付ける。Agent の環境変数・指示文・会話の記録にキーは出ない
 *   - 合言葉の無い・違う依頼は断る（ほかのローカルのプロセスに利用者のキーを使わせない）
 *   - 応答は状態コードも本文も変えずに返す（Cloudflare の { result, success } の包みもそのまま）
 *   - 1回ごとに数だけを記録する（callLog.ts）。画像・本文・キーは残さない
 *   - 合言葉ごと・プロジェクトごとに、回数・1分あたりの回数・トークン数・費用の総量の枠を持つ（security-5 [4]）。
 *     枠は送る前に予約し（同時の依頼でも超えない）、応答の数で精算する。合言葉の枠を使い切ったら合言葉を無効にする
 *   - 予約は、まだ1回も応答を見ていなくても枠の 1/RELAY_RESERVE_FLOOR_DIVISOR を下回らない（security-6 [1]）。
 *     応答に量が無い・読めないときは、予約した分を使ったものとして精算する（0 にしない）
 *   - 合言葉を無効にしたら、受け付け済みで途中の依頼も切る。本文は RELAY_BODY_TIMEOUT_MS までに届かなければ切る。
 *     接続先とキーを決める直前と送る直前に、合言葉がまだ有効かを確かめ直す（security-6 [2]）
 *   - プロジェクトのその日の量は main のファイルにも残し、起動し直しても空に戻さない（projectLedger.ts。security-6 [8]）
 *   - 本文は System One の形だけを受け付け、model を設定のものに書き換え、1回で使いうる量の上限（requestBound.ts）を
 *     送る前にまるごと予約する。残りの枠に収まらなければ送らない。単価の分からない接続先も費用の枠で数える（security-7 [7]）
 *   - 接続先が OpenAI の Decisions API（/v1/decisions）なら、System One の形を写して送り、応答を System One の形へ戻す（openaiDecisions.ts）
 *   - 接続先が端末内・LAN のモデル（Ollama の clef / clef-flash など。@shared/localModels の isLocalModelEndpoint）なら、
 *     上の回数・1分あたり・トークン・費用・プロジェクトの1日の枠をかけない（提供元の上限も費用も無い。2026-10-12 本人の指摘）。
 *     量の分からない応答（Ollama は量を返さない）を予約の分で数えると、16回ほどで合言葉を使い切っていた。
 *     同時の数だけは、本文（最大 32MB）でメモリを使い切らないための RELAY_MAX_CONCURRENT_LOCAL で絞る
 * Ferret が自分から判定モデルを呼ぶことはない。利用者の支払いも今までどおりプロバイダへ直接。
 *
 * Electron に依存させない（単体テストでローカルの偽の接続先に向けるため）。
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DecisionPricing } from '@shared/decision'
import type { ApiCallRecord } from '@shared/apiUsage'
import { estimateCost, extractUsage } from './callLog'
import type { ProjectLedgerEntry, ProjectUsageStore } from './projectLedger'
import { AI_RESPONSE_MAX_BYTES, ResponseTooLargeError, readBoundedBytes } from '../boundedResponse'
import { budgetPricing, checkDecisionRequest, costOf } from './requestBound'
import { isLocalModelEndpoint } from '@shared/localModels'
import { decisionWireFor, fromOpenAiDecisions, toOpenAiDecisions } from './openaiDecisions'

/** 画像を2枚含むので大きめ */
const RELAY_MAX_BODY_BYTES = 32 * 1024 * 1024
const RELAY_PATH = '/v1/systemone'
export const RELAY_TOKEN_HEADER = 'x-ferret-token'
/** @deprecated 改名前のヘッダー名。受け付けるだけ */
export const LEGACY_RELAY_TOKEN_HEADER = 'x-movie-ade-token'

export interface RelayUpstream {
  url: string
  /** キーのヘッダーと追加のヘッダー（解決済み）。値は記録・エラーに出さない */
  headers: Record<string, string>
  provider: string
  model: string
  pricing?: DecisionPricing
  timeoutMs: number
}

export interface RelayTokenMeta {
  projectId?: string
  agent?: string
  /** 合言葉を渡したターミナルの ID。ターミナルが閉じたら revokeSession で無効にする */
  sessionId?: string
}

/** 1つの合言葉で同時に送れる依頼の数 */
export const RELAY_MAX_CONCURRENT_PER_TOKEN = 4
/**
 * 接続先が端末内・LAN のモデルのときの、1つの合言葉で同時に送れる依頼の数。回数の枠ではなく、
 * 受け取り途中の本文（1件 32MB まで）でメモリを使い切らないための上限（ふだんの判定は1件ずつなので届かない）
 */
export const RELAY_MAX_CONCURRENT_LOCAL = 16
/** 出してからこの時間で無効にする（長い作業でも、ターミナルを開き直せば新しい合言葉になる） */
export const RELAY_TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000
/** 依頼の本文を受け取り終えるまでの上限（127.0.0.1 なので 32MB でも数秒。途中で止めた依頼で予約を持ち続けさせない。security-6 [2]） */
export const RELAY_BODY_TIMEOUT_MS = 30_000
/**
 * 1回の依頼で最低限押さえる量は、枠（合言葉のトークン数・費用）のこの分の1（security-6 [1]）。
 * これまでに見た1回の最大がこれより小さい・まだ無い（最初の依頼）ときも、これだけは押さえる。
 * 同時に送れるのは RELAY_MAX_CONCURRENT_PER_TOKEN までなので、応答を見る前に押さえるのは枠の 4/16 まで
 */
export const RELAY_RESERVE_FLOOR_DIVISOR = 16

/**
 * 写し取った合言葉で、順番に（同時の数の上限の下で）いくらでも呼べないようにする総量の枠（security-5 [4]）。
 * 合言葉の枠を使い切ったら、その合言葉は無効になる（ターミナルを開き直すと新しい枠）。
 * 費用は応答に入っている・単価を設定しているときだけ分かる。分からない呼び出しは回数とトークン数の枠で止まる
 */
export const RELAY_BUDGET = {
  /** 1つの合言葉で送れる回数 */
  callsPerToken: 500,
  /** 1つの合言葉で1分間に送れる回数 */
  callsPerMinute: 30,
  /** 1つの合言葉で使えるトークン数（入力＋出力） */
  tokensPerToken: 20_000_000,
  /** 1つの合言葉で使える費用（USD） */
  usdPerToken: 5,
  /** 1つのプロジェクト（合言葉をまたいで）で1日に送れる回数 */
  callsPerProjectPerDay: 2000,
  /** 1つのプロジェクトで1日に使える費用（USD） */
  usdPerProjectPerDay: 20
} as const

export type RelayBudget = { [K in keyof typeof RELAY_BUDGET]: number }

/** 使った量と、送っている途中の依頼のために押さえている量 */
interface Usage {
  calls: number
  tokens: number
  usd: number
  /** 1回の呼び出しで見た最大（送る前に、これだけを押さえる） */
  maxCallTokens: number
  maxCallUsd: number
  heldTokens: number
  heldUsd: number
}

const emptyUsage = (): Usage => ({ calls: 0, tokens: 0, usd: 0, maxCallTokens: 0, maxCallUsd: 0, heldTokens: 0, heldUsd: 0 })

interface IssuedToken {
  meta: RelayTokenMeta
  issuedAt: number
  usage: Usage
  /** 直近1分の送った時刻 */
  recent: number[]
  /** revoke・revokeSession・revokeAll・stop で無効にした。受け付け済みの依頼も、これを見て送らずに止める（security-6 [2]） */
  revoked: boolean
  /** 受け付け済みで途中の依頼。無効にしたら切る */
  active: Set<AbortController>
}

/** 送る前の予約。応答のあとで settle する */
interface Reservation {
  token: IssuedToken
  project: Usage | null
  projectId: string | undefined
  heldTokens: number
  heldUsd: number
}

/** 送った結果。量が分からないときに予約の分で精算するため、分かったかどうかも返す（security-6 [1]） */
interface Outcome {
  /** 接続先へ送った（送っていなければ 0 で精算） */
  dispatched: boolean
  tokens?: number
  usd?: number
  /** 単価を設定している（費用を数えている）接続先 */
  priced: boolean
}

const NOT_SENT: Outcome = { dispatched: false, priced: false }

type Refusal = 'token' | 'busy' | 'rate' | 'project' | 'request'

/** 接続先を決められない（URL・アカウント ID・キーが無いなど）。Agent へは 400 と理由を返す */
export class RelayConfigError extends Error {}

interface DecisionRelayOptions {
  /** 依頼のたびに呼ぶ。キーの復号は初めて呼ばれたときだけ行い、呼び出し側で覚えておく */
  upstream: () => Promise<RelayUpstream>
  onCall?: (record: ApiCallRecord) => void
  maxBodyBytes?: number
  /** 接続先の応答の上限。超えたら読むのをやめ、Agent へは 502 を返す */
  maxResponseBytes?: number
  tokenMaxAgeMs?: number
  /** 総量の枠（テスト用に小さくする）。省略時は RELAY_BUDGET */
  budget?: Partial<RelayBudget>
  /** 本文を受け取り終えるまでの上限（テスト用に短くする）。省略時は RELAY_BODY_TIMEOUT_MS */
  bodyTimeoutMs?: number
  /** プロジェクトのその日の量を残す先（security-6 [8]）。省略時はメモリだけ（テスト用） */
  ledger?: ProjectUsageStore
  /**
   * 今の設定の接続先が端末内・LAN のモデルか（同期で分かる値。DecisionService が設定の URL から決める）。
   * true なら枠を予約せずに受け付け、接続先を決めたあと URL でもう一度確かめる（クラウドなら、そこで予約する）。省略時は false
   */
  localUpstream?: () => boolean
  fetch?: typeof fetch
  now?: () => Date
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (res.headersSent || res.destroyed) return
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

const relayError = (message: string, type: string) => ({ message, error_type: type, source: 'ferret-relay' })

export class DecisionRelay {
  private server: Server | null = null
  private readonly tokens = new Map<string, IssuedToken>()
  /** 合言葉ごとの、送っている途中の依頼の数 */
  private readonly inflight = new Map<string, number>()
  /** プロジェクトごとの、その日の使った量（日付が変わったら空にする） */
  private readonly projectUsage = new Map<string, { day: string; usage: Usage }>()
  private readonly budget: RelayBudget
  private readonly maxBody: number
  private readonly maxResponse: number
  private readonly bodyTimeoutMs: number
  private readonly doFetch: typeof fetch

  constructor(private readonly opt: DecisionRelayOptions) {
    this.maxBody = opt.maxBodyBytes ?? RELAY_MAX_BODY_BYTES
    this.bodyTimeoutMs = opt.bodyTimeoutMs ?? RELAY_BODY_TIMEOUT_MS
    this.maxResponse = opt.maxResponseBytes ?? AI_RESPONSE_MAX_BYTES
    this.doFetch = opt.fetch ?? fetch
    this.budget = { ...RELAY_BUDGET, ...opt.budget }
  }

  get port(): number | null {
    const address = this.server?.address() as AddressInfo | null | undefined
    return address?.port ?? null
  }

  get running(): boolean {
    return this.port !== null
  }

  /** 127.0.0.1 の空いているポートで待ち受ける。起動済みならそのポート */
  async start(): Promise<number> {
    if (this.port !== null) return this.port
    const server = createServer((req, res) => void this.handle(req, res))
    // 画像付きの判定は時間がかかる。接続先の待ち時間より短く切らない
    server.requestTimeout = 0
    this.server = server
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
      // 中継があってもアプリの終了を止めない
      server.unref()
    })
    return this.port!
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.revokeAll()
    if (!server) return
    server.closeAllConnections?.()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private nowMs(): number {
    return (this.opt.now?.() ?? new Date()).getTime()
  }

  /**
   * Agent の起動ごとに合言葉を1つ出す。どの Agent の呼び出しかを記録に使う。
   * 合言葉はターミナル（sessionId）に結び付け、閉じたら・判定を無効にしたら無効にする（提供元・キー・モデルの変更では切らない）。
   * 出してから RELAY_TOKEN_MAX_AGE_MS で切れる
   */
  issue(meta: RelayTokenMeta = {}): string {
    const token = randomBytes(18).toString('base64url')
    const now = this.nowMs()
    this.tokens.set(token, { meta, issuedAt: now, usage: emptyUsage(), recent: [], revoked: false, active: new Set() })
    return token
  }

  /**
   * 合言葉を無効にし、受け付け済みで途中の依頼も切る（security-6 [2]）。
   * 表（tokens）から消すだけだと、本文を少しずつ送って待たせている依頼が、無効にしたあとで今の接続先とキーで送られる
   */
  private kill(token: string, issued: IssuedToken): void {
    this.tokens.delete(token)
    issued.revoked = true
    for (const controller of issued.active) controller.abort()
    issued.active.clear()
  }

  revoke(token: string): void {
    const issued = this.tokens.get(token)
    if (issued) this.kill(token, issued)
  }

  /** そのターミナルに渡した合言葉をすべて無効にする（ターミナルが閉じたとき） */
  revokeSession(sessionId: string): void {
    for (const [token, issued] of [...this.tokens]) if (issued.meta.sessionId === sessionId) this.kill(token, issued)
  }

  /** 出した合言葉をすべて無効にする（判定を無効にしたとき・設定を変えたとき・中継を止めたとき） */
  revokeAll(): void {
    for (const [token, issued] of [...this.tokens]) this.kill(token, issued)
  }

  /** 有効な合言葉なら、その情報を返す。切れていれば消して undefined */
  private accept(token: string): IssuedToken | undefined {
    const issued = this.tokens.get(token)
    if (!issued) return undefined
    const now = this.nowMs()
    if (now - issued.issuedAt > (this.opt.tokenMaxAgeMs ?? RELAY_TOKEN_MAX_AGE_MS)) {
      this.tokens.delete(token)
      return undefined
    }
    return issued
  }

  private today(): string {
    const at = this.opt.now?.() ?? new Date()
    return `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`
  }

  /**
   * そのプロジェクトの今日の使った量（日付が変わっていたら空から）。
   * 残した量（ledger）を毎回読み直し、多い方を使う（起動し直し・ほかの中継が数えた分を落とさない。security-6 [8]）
   */
  private projectUsageFor(projectId: string | undefined): Usage | null {
    if (!projectId) return null
    const day = this.today()
    let entry = this.projectUsage.get(projectId)
    if (entry?.day !== day) {
      entry = { day, usage: emptyUsage() }
      this.projectUsage.set(projectId, entry)
    }
    const saved = this.readLedger().get(projectId)
    if (saved?.day === day) {
      const u = entry.usage
      u.calls = Math.max(u.calls, saved.calls)
      // 残した費用には、送っている途中の予約も入っている
      u.usd = Math.max(u.usd, saved.usd - u.heldUsd)
      u.maxCallTokens = Math.max(u.maxCallTokens, saved.maxCallTokens)
      u.maxCallUsd = Math.max(u.maxCallUsd, saved.maxCallUsd)
    }
    return entry.usage
  }

  private readLedger(): Map<string, ProjectLedgerEntry> {
    if (!this.opt.ledger) return new Map()
    try {
      return this.opt.ledger.load()
    } catch {
      // 読めない（壊れた・権限）。メモリの量だけで数える（想定内。次の書き込みで直る）
      return new Map()
    }
  }

  /** プロジェクトの今日の量を残す。予約中の分は使ったものとして書く（応答の前に落ちても、起動し直したら数えている） */
  private writeLedger(projectId: string | undefined, usage: Usage | null): void {
    if (!this.opt.ledger || !projectId || !usage) return
    const day = this.today()
    const entries = this.readLedger()
    for (const [id, e] of entries) if (e.day !== day) entries.delete(id)
    const prev = entries.get(projectId)
    entries.delete(projectId)
    entries.set(projectId, {
      day,
      calls: Math.max(usage.calls, prev?.calls ?? 0),
      usd: Math.max(usage.usd + usage.heldUsd, prev?.usd ?? 0),
      maxCallTokens: Math.max(usage.maxCallTokens, prev?.maxCallTokens ?? 0),
      maxCallUsd: Math.max(usage.maxCallUsd, prev?.maxCallUsd ?? 0)
    })
    try {
      this.opt.ledger.save(entries)
    } catch (err) {
      // 書けない（ディスク・権限）。この起動の中ではメモリで数え続ける。パスを含みうるので種類だけ
      console.warn('[decision] プロジェクトの使用量を残せませんでした', (err as NodeJS.ErrnoException)?.code ?? typeof err)
    }
  }

  /**
   * 送る前に枠を予約する（同期で数えるので、同時に来た依頼でも枠を超えない）。
   * 合言葉の枠を使い切っていれば合言葉を無効にする。断るときは理由の種類を返す
   */
  private reserve(tokenKey: string, issued: IssuedToken): Reservation | { refused: Refusal } {
    const b = this.budget
    const now = this.nowMs()
    issued.recent = issued.recent.filter((at) => now - at < 60_000)
    const u = issued.usage
    const project = this.projectUsageFor(issued.meta.projectId)
    // 次の1回で見込む量。これまでの1回の最大（合言葉・プロジェクト）と、枠から決めた下限の大きい方（security-6 [1]）。
    // 最初の依頼（まだ応答を見ていない）でも 0 にしない。同時に来た最初の依頼が、何も押さえずに送られて枠を超えないように
    const heldTokens = Math.max(u.maxCallTokens, project?.maxCallTokens ?? 0, b.tokensPerToken / RELAY_RESERVE_FLOOR_DIVISOR)
    const heldUsd = Math.max(u.maxCallUsd, project?.maxCallUsd ?? 0, b.usdPerToken / RELAY_RESERVE_FLOOR_DIVISOR)
    // 使い切った（途中の依頼が無くても次の1回が収まらない）なら合言葉を無効にする。途中の依頼の分で収まらないだけなら待ってもらう
    const exhausted = u.calls >= b.callsPerToken || u.tokens + heldTokens > b.tokensPerToken || u.usd + heldUsd > b.usdPerToken
      || u.tokens >= b.tokensPerToken || u.usd >= b.usdPerToken
    if (exhausted) {
      this.tokens.delete(tokenKey)
      return { refused: 'token' }
    }
    if (u.tokens + u.heldTokens + heldTokens > b.tokensPerToken || u.usd + u.heldUsd + heldUsd > b.usdPerToken) return { refused: 'busy' }
    if (issued.recent.length >= b.callsPerMinute) return { refused: 'rate' }
    if (project && (project.calls >= b.callsPerProjectPerDay || project.usd + project.heldUsd + heldUsd > b.usdPerProjectPerDay)) return { refused: 'project' }
    u.calls++
    u.heldTokens += heldTokens
    u.heldUsd += heldUsd
    issued.recent.push(now)
    if (project) {
      project.calls++
      project.heldUsd += heldUsd
    }
    this.writeLedger(issued.meta.projectId, project)
    return { token: issued, project, projectId: issued.meta.projectId, heldTokens, heldUsd }
  }

  /**
   * 本文を読んで決めた1回の上限（tokens・usd）まで予約を増やす（security-7 [7]）。同期で数えるので、同時の依頼でも枠を超えない。
   * 合言葉・プロジェクトの残りに収まらなければ増やさずに断る（送らない）。予約が上限より大きければそのまま
   */
  private raise(r: Reservation, tokens: number, usd: number): Refusal | null {
    const b = this.budget
    const u = r.token.usage
    const extraTokens = Math.max(0, tokens - r.heldTokens)
    const extraUsd = Math.max(0, usd - r.heldUsd)
    // この1回だけで残りを超える（待っても収まらない）
    if (u.tokens + Math.max(tokens, r.heldTokens) > b.tokensPerToken || u.usd + Math.max(usd, r.heldUsd) > b.usdPerToken) return 'request'
    if (u.tokens + u.heldTokens + extraTokens > b.tokensPerToken || u.usd + u.heldUsd + extraUsd > b.usdPerToken) return 'busy'
    if (r.project && r.project.usd + r.project.heldUsd + extraUsd > b.usdPerProjectPerDay) return 'project'
    u.heldTokens += extraTokens
    u.heldUsd += extraUsd
    r.heldTokens += extraTokens
    r.heldUsd += extraUsd
    if (r.project) {
      r.project.heldUsd += extraUsd
      this.writeLedger(r.projectId, r.project)
    }
    return null
  }

  private refusalBody(kind: Refusal): Record<string, unknown> {
    const refusals: Record<Refusal, Record<string, unknown>> = {
      token: relayError('This terminal used up its decision-model budget, so Ferret ended its relay token. Open a new terminal tab to continue.', 'relay_budget_exhausted'),
      busy: relayError('This terminal is close to its decision-model budget. Wait for the previous requests to finish.', 'relay_budget_pending'),
      rate: relayError(`Too many decision requests in one minute (max ${this.budget.callsPerMinute}). Wait a minute and try again.`, 'relay_rate_limited'),
      project: relayError('This project reached today\'s decision-model budget in Ferret. Try again tomorrow.', 'relay_project_budget'),
      request: relayError('This request could use more than the remaining decision-model budget. Send a shorter state, fewer questions or fewer images, or open a new terminal tab.', 'relay_request_too_large')
    }
    return refusals[kind]
  }

  /**
   * 精算する量（security-6 [1]）。送っていなければ 0。送ったのに量が分からない（応答に無い・読めない・時間切れ・途中で切った）なら、
   * 予約した分を使ったものとする（応答の書き方しだいで、予約を 0 で消させない）。
   * 費用は、数えている接続先（単価を設定している・これまでに費用が返ってきた）でだけ予約の分にする。数えていない接続先は回数とトークン数の枠で止まる
   */
  private charged(r: Reservation, out: Outcome): { tokens: number; usd: number } {
    if (!out.dispatched) return { tokens: 0, usd: 0 }
    const costTracked = out.priced || r.token.usage.maxCallUsd > 0 || (r.project?.maxCallUsd ?? 0) > 0
    return {
      tokens: out.tokens ?? r.heldTokens,
      usd: out.usd ?? (costTracked ? r.heldUsd : 0)
    }
  }

  /** 応答の数で精算する（押さえた分を外し、実際の量を足す）。合言葉の枠を使い切ったら無効にする */
  private settle(tokenKey: string, r: Reservation, out: Outcome): void {
    const used = this.charged(r, out)
    const u = r.token.usage
    u.heldTokens = Math.max(0, u.heldTokens - r.heldTokens)
    u.heldUsd = Math.max(0, u.heldUsd - r.heldUsd)
    u.tokens += used.tokens
    u.usd += used.usd
    u.maxCallTokens = Math.max(u.maxCallTokens, used.tokens)
    u.maxCallUsd = Math.max(u.maxCallUsd, used.usd)
    if (r.project) {
      r.project.heldUsd = Math.max(0, r.project.heldUsd - r.heldUsd)
      r.project.usd += used.usd
      r.project.maxCallTokens = Math.max(r.project.maxCallTokens, used.tokens)
      r.project.maxCallUsd = Math.max(r.project.maxCallUsd, used.usd)
    }
    this.writeLedger(r.projectId, r.project)
    // 使い切った合言葉は、次の依頼で理由（relay_budget_exhausted）を返してから無効にする（reserve）
    void tokenKey
  }

  /** Agent に渡す URL（合言葉付き） */
  urlFor(token: string): string {
    if (this.port === null) throw new Error('relay is not running')
    return `http://127.0.0.1:${this.port}${RELAY_PATH}?t=${encodeURIComponent(token)}`
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== RELAY_PATH) return sendJson(res, 404, relayError('Not found. POST to /v1/systemone.', 'relay_not_found'))
    if (req.method !== 'POST') return sendJson(res, 405, relayError('Use POST.', 'relay_method'))
    const header = req.headers[RELAY_TOKEN_HEADER] ?? req.headers[LEGACY_RELAY_TOKEN_HEADER]
    const token = url.searchParams.get('t') ?? (typeof header === 'string' ? header : '')
    const issued = token ? this.accept(token) : undefined
    if (!issued) {
      req.resume()
      return sendJson(res, 401, relayError('Missing or invalid Ferret relay token. Use $FERRET_DECISION_URL exactly as given.', 'relay_unauthorized'))
    }
    // 端末内・LAN のモデルなら、回数・費用の枠をかけない（提供元の上限が無い）。読めない・例外はクラウドとみなす
    let local = false
    try {
      local = this.opt.localUpstream?.() === true
    } catch {
      // 設定を読めない（想定内）。枠をかける側に倒す
      local = false
    }
    // 1つの合言葉で同時に送れる数を絞る（写し取った合言葉で並べて呼び、費用やメモリを膨らませない）
    const inflight = this.inflight.get(token) ?? 0
    const maxConcurrent = local ? RELAY_MAX_CONCURRENT_LOCAL : RELAY_MAX_CONCURRENT_PER_TOKEN
    if (inflight >= maxConcurrent) {
      req.resume()
      return sendJson(res, 429, relayError(`Too many decision requests at once (max ${maxConcurrent}). Wait for the previous ones to finish.`, 'relay_too_many'))
    }
    // 総量の枠を送る前に予約する（security-5 [4]）。ローカルなら予約しない（接続先を決めたあとクラウドと分かれば forward で予約する）
    const held: { r: Reservation | null } = { r: null }
    if (!local) {
      const reservation = this.reserve(token, issued)
      if ('refused' in reservation) {
        req.resume()
        return sendJson(res, 429, this.refusalBody(reservation.refused))
      }
      held.r = reservation
    }
    this.inflight.set(token, inflight + 1)
    // 合言葉を無効にしたら、この依頼も切る（本文の途中でも、接続先の応答待ちでも。security-6 [2]）
    const controller = new AbortController()
    issued.active.add(controller)
    controller.signal.addEventListener('abort', () => { req.destroy(); res.destroy() }, { once: true })
    let outcome: Outcome = NOT_SENT
    try {
      outcome = await this.forward(req, res, token, issued, controller.signal, held)
    } finally {
      issued.active.delete(controller)
      if (held.r) this.settle(token, held.r, outcome)
      const left = (this.inflight.get(token) ?? 1) - 1
      if (left > 0) this.inflight.set(token, left)
      else this.inflight.delete(token)
    }
  }

  /** 送って応答を返す。精算のために、使ったトークン数と費用（分かった分）を返す */
  private async forward(req: IncomingMessage, res: ServerResponse, tokenKey: string, issued: IssuedToken, signal: AbortSignal, held: { r: Reservation | null }): Promise<Outcome> {
    const meta = issued.meta
    const none = NOT_SENT
    // 無効にした合言葉の依頼は、ここから先へ進めない（接続先とキーを決めない・送らない。security-6 [2]）
    const live = () => !issued.revoked && !signal.aborted
    const body = await this.readBody(req, res, signal)
    if (!body || !live()) return none
    const started = Date.now()
    const base = { kind: 'decision' as const, ...(meta.projectId ? { projectId: meta.projectId } : {}), ...(meta.agent ? { agent: meta.agent } : {}), requestBytes: body.length }
    let upstream: RelayUpstream
    try {
      upstream = await this.opt.upstream()
    } catch (err) {
      const message = err instanceof RelayConfigError ? err.message : 'Ferret could not prepare the decision API settings.'
      sendJson(res, 400, relayError(message, 'relay_config'))
      return none
    }
    // 接続先を決めているあいだ（キーの復号・確認）に無効にされたら、送らない
    if (!live()) return none
    // 形を確かめ、モデルを設定のものにし、1回で使いうる量の上限をまるごと予約する（security-7 [7]）。収まらなければ送らない
    const checked = checkDecisionRequest(body, upstream.model)
    if (!checked.ok) {
      sendJson(res, 400, relayError(checked.message, 'relay_invalid_request'))
      return none
    }
    const price = budgetPricing(upstream.url, upstream.pricing)
    // 端末内・LAN のモデルには枠をかけない。受け付けたときはローカルだったのに、実際の接続先がクラウドなら、ここで予約する（同期で数える）
    if (!isLocalModelEndpoint(upstream.url)) {
      if (!held.r) {
        const reservation = this.reserve(tokenKey, issued)
        if ('refused' in reservation) {
          sendJson(res, 429, this.refusalBody(reservation.refused))
          return none
        }
        held.r = reservation
      }
      const refused = this.raise(held.r, checked.inputTokens + checked.outputTokens, costOf({ input: checked.inputTokens, output: checked.outputTokens }, price))
      if (refused) {
        sendJson(res, 429, this.refusalBody(refused))
        return none
      }
    }
    // OpenAI の Decisions API へは、System One の形を写して送る（応答は System One の形へ戻す。openaiDecisions.ts）
    const wire = decisionWireFor(upstream.url)
    let sendBody: Buffer = checked.body
    let names: Record<string, string> = {}
    if (wire === 'openai-decisions') {
      const converted = toOpenAiDecisions(JSON.parse(checked.body.toString('utf8')) as Record<string, unknown>, upstream.model)
      if (!converted.ok) {
        sendJson(res, 400, relayError(converted.message, 'relay_invalid_request'))
        return none
      }
      sendBody = Buffer.from(JSON.stringify(converted.body), 'utf8')
      names = converted.names
    }
    const images = checked.images
    // 費用を数える接続先（単価を設定した・ローカルでない）。数えない（ローカル）なら回数とトークン数の枠で止まる
    const priced = price.inputPer1M > 0 || price.outputPer1M > 0
    const record = (status: number, extra: Partial<ApiCallRecord> = {}) => this.opt.onCall?.({
      ts: (this.opt.now?.() ?? new Date()).toISOString(), ...base, provider: upstream.provider, model: upstream.model,
      status, latencyMs: Date.now() - started, ...(images !== undefined ? { images } : {}), ...extra
    })
    let upstreamRes: Response
    try {
      upstreamRes = await this.doFetch(upstream.url, {
        method: 'POST',
        headers: { 'content-type': req.headers['content-type'] ?? 'application/json', ...upstream.headers },
        // Buffer は型の上で BodyInit にならない環境がある（DOM の型）。同じバイト列の Uint8Array で渡す
        body: Uint8Array.from(sendBody),
        // 時間切れと、合言葉を無効にしたときの両方で切る
        signal: AbortSignal.any([signal, AbortSignal.timeout(upstream.timeoutMs)]),
        // キーを付けた依頼は、確かめた接続元の外へのリダイレクトを追わない（security-7 [10]）
        redirect: 'error'
      })
    } catch (err) {
      const timeout = (err as { name?: string } | null)?.name === 'TimeoutError'
      record(0)
      sendJson(res, timeout ? 504 : 502, timeout
        ? relayError(`The decision API did not answer within ${Math.round(upstream.timeoutMs / 1000)}s.`, 'relay_upstream_timeout')
        : relayError('Ferret relay could not reach the decision API. Check that it is running and that the URL in Ferret settings is right.', 'relay_upstream_unreachable'))
      // 送ったあとの時間切れ・切断は、接続先が数えたかが分からない。予約の分で精算する
      return { dispatched: true, priced }
    }
    let out: Buffer
    try {
      out = await readBoundedBytes(upstreamRes, this.maxResponse)
    } catch (err) {
      if (err instanceof ResponseTooLargeError) {
        // 大きすぎる応答は溜めずに切る（設定した接続先が巨大な本文を返してもメモリを使い切らない）
        record(upstreamRes.status)
        sendJson(res, 502, relayError(`The decision API response was larger than ${Math.round(this.maxResponse / 1024 / 1024)}MB, so Ferret stopped reading it.`, 'relay_upstream_too_large'))
        return { dispatched: true, priced }
      }
      // 本文を読み切れなかった（途中で切れた）ときは、空で返す（想定内）
      out = Buffer.alloc(0)
    }
    let parsed: unknown
    // JSON でない応答（エラーページなど）はトークン数が分からないだけ（想定内）
    try { parsed = JSON.parse(out.toString('utf8')) } catch { parsed = undefined }
    let contentType = upstreamRes.headers.get('content-type')
    if (wire === 'openai-decisions' && upstreamRes.ok) {
      const mapped = fromOpenAiDecisions(parsed, names)
      if (mapped) {
        out = Buffer.from(JSON.stringify(mapped), 'utf8')
        contentType = 'application/json'
      }
    }
    const headers: Record<string, string> = { 'content-length': String(out.length) }
    if (contentType) headers['content-type'] = contentType
    if (!res.destroyed) {
      res.writeHead(upstreamRes.status, headers)
      res.end(out)
    }
    const usage = parsed === undefined ? {} : extractUsage(parsed)
    const estimated = usage.costUsd === undefined ? estimateCost(usage, upstream.pricing) : undefined
    const cost = usage.costUsd ?? estimated
    record(upstreamRes.status, {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.costUsd !== undefined ? { costUsd: usage.costUsd, costSource: 'provider' as const } : estimated !== undefined ? { costUsd: estimated, costSource: 'estimate' as const } : {})
    })
    const tokensKnown = usage.inputTokens !== undefined || usage.outputTokens !== undefined
    // 枠に数える費用。応答の費用・設定の単価の見積もりが無ければ、枠の単価（単価の分からない接続先は高めの既定）で見積もる
    const budgetUsd = cost ?? (tokensKnown ? costOf({ input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 }, price) : undefined)
    return {
      dispatched: true,
      priced,
      ...(tokensKnown ? { tokens: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) } : {}),
      ...(budgetUsd !== undefined ? { usd: budgetUsd } : {})
    }
  }

  /**
   * 上限を超えたら 413 を返して null。RELAY_BODY_TIMEOUT_MS までに届き終わらない・合言葉を無効にした・切れたときも null（security-6 [2]）。
   * 本文を少しずつ送って依頼を待たせ続け、予約と同時の数を持ち続けることはできない
   */
  private readBody(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = []
      let size = 0
      let over = false
      let done = false
      const onAbort = () => finish(null)
      const timer = setTimeout(() => {
        over = true
        chunks.length = 0
        res.setHeader('connection', 'close')
        sendJson(res, 408, relayError(`The request body did not arrive within ${Math.round(this.bodyTimeoutMs / 1000)}s.`, 'relay_body_timeout'))
        finish(null)
        // 返事を書き終えてから切る
        res.once('finish', () => req.destroy())
      }, this.bodyTimeoutMs)
      function finish(value: Buffer | null): void {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      }
      if (signal.aborted) return finish(null)
      signal.addEventListener('abort', onAbort, { once: true })
      req.on('data', (chunk: Buffer) => {
        if (over) return
        size += chunk.length
        if (size > this.maxBody) {
          over = true
          chunks.length = 0
          res.setHeader('connection', 'close')
          sendJson(res, 413, relayError(`Request body is larger than ${Math.round(this.maxBody / 1024 / 1024)}MB. Send smaller images.`, 'relay_too_large'))
          finish(null)
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => { if (!over) finish(Buffer.concat(chunks)) })
      req.on('error', () => finish(null))
      // 送り手が end の前に切った
      req.on('close', () => finish(null))
    })
  }
}
