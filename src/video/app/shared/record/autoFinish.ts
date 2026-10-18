/**
 * テイクを取り込んだあと、アプリが自分で動画を Agent に渡す（docs/13）。「動画を完成させて」（finish）の文を作り、
 * 今のプロジェクトの Agent へ送る（居なければ既定の Agent を起動してから。renderer の sendVideoPrompt）。
 * 判断（設定 `autopilot.autoStart`、同じテイクは1回だけ）は純粋な関数で、送る・知らせるは差し替えられる（IPC なしで確かめる）。
 * 旧 Solocut の lib/autoFinish.ts から移した。
 */

/** 生の設定の `autopilot.autoStart`。無い・壊れている・真偽値でないときは既定のオン */
export function autoStartEnabled(settings: Record<string, unknown> | null | undefined): boolean {
  const ap = settings?.autopilot
  if (!ap || typeof ap !== 'object' || Array.isArray(ap)) return true
  const v = (ap as Record<string, unknown>).autoStart
  return typeof v === 'boolean' ? v : true
}

export type AutoFinishDecision = { send: true } | { send: false; reason: 'disabled' | 'no-take' | 'already-sent' }

/** このテイクを今 Agent に渡すか */
export function decideAutoFinish(o: { autoStart: boolean; takeId: string | null | undefined; sent: ReadonlySet<string> }): AutoFinishDecision {
  if (!o.takeId) return { send: false, reason: 'no-take' }
  if (!o.autoStart) return { send: false, reason: 'disabled' }
  if (o.sent.has(o.takeId)) return { send: false, reason: 'already-sent' }
  return { send: true }
}

export interface AutoFinishDeps {
  /** 設定 autopilot.autoStart（今の値） */
  autoStart: () => boolean
  /** finish の文（変数を埋め、動画のフォルダの絶対パスを含めたもの） */
  render: (dir: string) => Promise<string>
  send: (text: string) => Promise<{ ok: boolean; message: string }>
  toast: (message: string, tone: 'success' | 'danger') => void
  /** このアプリの起動中に渡したテイク（モジュールに1つ。画面を切り替えても残る） */
  sent: Set<string>
  messages: { started: () => string; failed: (detail: string) => string }
}

export type AutoFinishOutcome = 'sent' | 'skipped' | 'failed'

/** 取り込んだばかりのテイクの finish の文を、多くても1回送る。例外は投げない */
export async function runAutoFinish(dir: string, takeId: string | null | undefined, deps: AutoFinishDeps): Promise<AutoFinishOutcome> {
  let autoStart: boolean
  try {
    autoStart = deps.autoStart()
  } catch {
    autoStart = true
  }
  const d = decideAutoFinish({ autoStart, takeId, sent: deps.sent })
  if (!d.send) return 'skipped'
  // 非同期の処理より前に印を付ける（同じテイクの停止・取り込みが重なっても2回送らない）
  deps.sent.add(takeId!)
  try {
    const text = await deps.render(dir)
    if (!text.trim()) throw new Error('empty prompt')
    const r = await deps.send(text)
    if (!r.ok) {
      deps.toast(deps.messages.failed(r.message), 'danger')
      return 'failed'
    }
    deps.toast(deps.messages.started(), 'success')
    return 'sent'
  } catch (e) {
    deps.toast(deps.messages.failed(e instanceof Error ? e.message : String(e)), 'danger')
    return 'failed'
  }
}

/** アプリの起動中に1つ */
export const sentTakes = new Set<string>()
