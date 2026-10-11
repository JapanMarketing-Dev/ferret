/**
 * X の投稿画面（https://x.com/compose/post）に、内蔵ブラウザのタブから本文（スレッドも）と画像・動画を入れる。
 * X の API（有料）は使わない。利用者がログインしているタブを使い、最後の「ポスト」は利用者が押す。
 *
 * - ページの操作は DevTools Protocol（webContents.debugger）で行う。ファイルを入れる DOM.setFileInputFiles が要るため
 * - 文字は Input.insertText で入れる（X の入力欄は Draft.js の contenteditable で、value を書き換えても認識されない）。
 *   改行は Enter キーを送る（insertText の "\n" は Draft.js が段落として扱わないことがある）
 * - 画面の形が変わって入れられなければ { status: 'fallback' } を返す。本文だけの投稿画面（intent）を開くのは呼び出し側
 * - Electron に依存させない（単体テストで偽の WebContents を渡すため）
 */
import { isAbsolute } from 'node:path'
import { PUBLISH_LIMITS, type XComposeResult } from '@shared/publish'
import { X_MAX_PARTS, xIntentUrl } from '@shared/xPost'

export const X_COMPOSE_URL = 'https://x.com/compose/post'

/**
 * X の画面の目印。X が DOM を変えたらここを直す。
 * compose/post を直接開くとホームの上の投稿欄（インライン）になり、モーダル（[aria-modal]）は空のまま。
 * モーダルの中にあればそちらを、無ければページの最初のものを使う
 */
export const X_SELECTORS = {
  modal: '[aria-modal="true"]',
  /** i 番目（0 から）の入力欄。contenteditable の要素そのもの */
  textarea: (index: number) => `[data-testid="tweetTextarea_${index}"]`,
  /** スレッドに1件足す「+」。文字が空のうちは出ない（入れた後に出るかは X 次第） */
  addButton: '[data-testid="addButton"]',
  fileInput: 'input[data-testid="fileInput"]',
  fileInputFallback: 'input[type="file"]',
  /** 付けた画像・動画の見本の入れ物 */
  attachments: '[data-testid="attachments"]',
  /** ログインしていない画面のボタン */
  loginHint: '[data-testid="loginButton"], [data-testid="login"], [data-testid="google_sign_in_container"]'
} as const

/**
 * ログインを求められている URL（ログイン・新規登録の流れ、ログアウト時のトップ）。
 * 2026-10 の X は、ログアウト中に投稿画面を開くと /i/jf/onboarding/web?…&mode=login へ飛ばす（実機で確認）
 */
const LOGIN_PATHS = ['/login', '/i/flow/login', '/i/flow/signup', '/i/jf/onboarding']
const X_HOSTS = ['x.com', 'twitter.com']

/** 使う WebContents の部分（本番は Electron の WebContents をそのまま渡す） */
export interface ComposerContents {
  loadURL(url: string): Promise<void>
  getURL(): string
  isDestroyed(): boolean
  debugger: {
    attach(protocolVersion?: string): void
    detach(): void
    isAttached(): boolean
    sendCommand(method: string, commandParams?: any): Promise<any>
  }
}

export interface ComposerInput {
  parts: string[]
  /** 1件目に付ける画像・動画の絶対パス（種類・大きさの確認は呼び出し側） */
  mediaPaths: string[]
}

export interface ComposerOptions {
  /** 投稿画面が出るまで待つ長さ */
  timeoutMs?: number
  /** スレッドの欄が増える・メディアの見本が出るのを待つ長さ */
  stepTimeoutMs?: number
  /** 確かめる間隔 */
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_STEP_TIMEOUT_MS = 8_000
const DEFAULT_POLL_MS = 250

/** 入れられなかったときに開く、本文だけの投稿画面 */
export function composeFallbackUrl(parts: readonly string[]): string {
  return xIntentUrl(parts[0] ?? '')
}

/** X のログイン（または新規登録）を求められている URL か */
export function isXLoginUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  const host = url.hostname.replace(/^(www|mobile)\./, '')
  if (!X_HOSTS.includes(host)) return false
  const path = url.pathname.replace(/\/+$/, '')
  // ログアウトしているとトップ（/）に戻される。ログインしていればトップは /home
  if (path === '') return true
  return LOGIN_PATHS.some((p) => path === p || path.startsWith(`${p}/`))
}

/** 比べるために空白・見えない文字をそろえる */
export function normalizeComposerText(text: string): string {
  return text.normalize('NFC').replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim()
}

class ComposerError extends Error {}

/**
 * ページの中で動かす操作。{ op, selector, modal } を受け取る。モーダルの中を先に探す。
 * ここは文字列で持つ（main の型検査に DOM の型を入れないため）
 */
export const X_PAGE_OP = `function (a) {
  const modal = document.querySelector(a.modal);
  const el = (modal && modal.querySelector(a.selector)) || document.querySelector(a.selector);
  switch (a.op) {
    case 'exists': return !!el;
    case 'text': return el ? el.innerText : null;
    case 'click':
      if (!el || el.getAttribute('aria-disabled') === 'true' || el.disabled) return false;
      el.click();
      return true;
    case 'focus': {
      if (!el) return false;
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      return document.activeElement === el || el.contains(document.activeElement);
    }
  }
  return null;
}`

type PageOp = 'exists' | 'text' | 'click' | 'focus'

export async function fillXComposer(contents: ComposerContents, input: ComposerInput, opts: ComposerOptions = {}): Promise<XComposeResult> {
  const problem = inputProblem(input)
  if (problem) return { status: 'fallback', reason: problem }
  if (contents.isDestroyed()) return { status: 'fallback', reason: 'tab closed' }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const stepTimeoutMs = opts.stepTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const cdp = contents.debugger

  // ほかの誰か（DevTools など）が先に付けていれば、それを使って外さない
  const attachedHere = !cdp.isAttached()
  try {
    if (attachedHere) cdp.attach('1.3')
  } catch (err) {
    return { status: 'fallback', reason: `debugger attach failed: ${message(err)}` }
  }

  const alive = (): void => {
    if (contents.isDestroyed()) throw new ComposerError('tab closed')
  }
  const send = async (method: string, params?: Record<string, unknown>): Promise<any> => {
    alive()
    return cdp.sendCommand(method, params)
  }
  const page = async (op: PageOp, selector: string): Promise<unknown> => {
    const res = await send('Runtime.evaluate', {
      expression: `(${X_PAGE_OP})(${JSON.stringify({ op, selector, modal: X_SELECTORS.modal })})`,
      returnByValue: true,
      awaitPromise: false
    })
    if (res?.exceptionDetails) throw new ComposerError(`page script failed: ${res.exceptionDetails.text ?? 'exception'}`)
    return res?.result?.value
  }
  /** cond が真になるまで待つ。待った長さは間隔の合計で数える（テストで止まらないように） */
  const waitFor = async (cond: () => Promise<boolean>, limitMs: number): Promise<boolean> => {
    for (let waited = 0; ; waited += pollMs) {
      alive()
      if (await cond()) return true
      if (waited >= limitMs) return false
      await sleep(pollMs)
    }
  }

  try {
    // X は読み込み中に画面の中で URL を変えるので、読み込みの失敗（ERR_ABORTED など）は待つ側で判断する
    await contents.loadURL(X_COMPOSE_URL).catch(() => undefined)

    let login = false
    const ready = await waitFor(async () => {
      if (isXLoginUrl(contents.getURL())) {
        login = true
        return true
      }
      // 移動の途中は評価が失敗することがある。次の確認まで待つ
      const [composer, hint] = await Promise.all([
        page('exists', X_SELECTORS.textarea(0)).catch(() => false),
        page('exists', X_SELECTORS.loginHint).catch(() => false)
      ])
      if (composer === true) return true
      if (hint === true) {
        login = true
        return true
      }
      return false
    }, timeoutMs)
    if (login) return { status: 'login' }
    if (!ready) return { status: 'fallback', reason: 'composer did not appear' }

    // メディアは1件目にだけ付ける（1件目しか無いうちに入れる。欄が増えると付け先が変わるため）
    if (input.mediaPaths.length) await attachMedia(send, page, waitFor, input.mediaPaths, stepTimeoutMs)

    // 2件目からは「+」で欄を足す。「+」が出ない・欄が増えないときは、入れた分だけで返す
    // （画面側が parts の少なさを見て「残りはコピーして返信で」と案内する）
    let filled = 0
    for (let i = 0; i < input.parts.length; i++) {
      const selector = X_SELECTORS.textarea(i)
      if (i > 0) {
        const clicked = await waitFor(async () => (await page('click', X_SELECTORS.addButton)) === true, stepTimeoutMs)
        if (!clicked) break
        const added = await waitFor(async () => (await page('exists', selector)) === true, stepTimeoutMs)
        if (!added) break
      }
      if ((await page('focus', selector)) !== true) throw new ComposerError(`textarea ${i} could not be focused`)
      await typeText(send, input.parts[i] as string)
      filled = i + 1
    }

    // 入った文字を確かめる（X が文字を変えた・別の欄に入ったなど）
    for (let i = 0; i < filled; i++) {
      const actual = await page('text', X_SELECTORS.textarea(i))
      if (typeof actual !== 'string' || normalizeComposerText(actual) !== normalizeComposerText(input.parts[i] as string)) {
        throw new ComposerError(`text of part ${i + 1} did not match`)
      }
    }
    return { status: 'filled', parts: filled, media: input.mediaPaths.length }
  } catch (err) {
    return { status: 'fallback', reason: message(err) }
  } finally {
    if (attachedHere) {
      try {
        if (!contents.isDestroyed() && cdp.isAttached()) cdp.detach()
      } catch {
        // 閉じかけのタブは外せなくてよい
      }
    }
  }
}

function inputProblem(input: ComposerInput): string | null {
  if (!Array.isArray(input.parts) || input.parts.length === 0) return 'no text'
  if (input.parts.length > X_MAX_PARTS) return 'too many parts'
  if (input.parts.some((p) => typeof p !== 'string' || !p.trim())) return 'empty part'
  if (!Array.isArray(input.mediaPaths)) return 'bad media'
  if (input.mediaPaths.length > PUBLISH_LIMITS.xImages) return 'too many media'
  if (input.mediaPaths.some((p) => typeof p !== 'string' || !isAbsolute(p))) return 'media path not absolute'
  return null
}

async function attachMedia(
  send: (method: string, params?: Record<string, unknown>) => Promise<any>,
  page: (op: PageOp, selector: string) => Promise<unknown>,
  waitFor: (cond: () => Promise<boolean>, limitMs: number) => Promise<boolean>,
  files: string[],
  stepTimeoutMs: number
): Promise<void> {
  const doc = await send('DOM.getDocument', { depth: 0 })
  const root = doc?.root?.nodeId
  if (typeof root !== 'number') throw new ComposerError('no document')
  let nodeId = 0
  const candidates = [X_SELECTORS.fileInput, X_SELECTORS.fileInputFallback]
  for (const selector of [...candidates.map((c) => `${X_SELECTORS.modal} ${c}`), ...candidates]) {
    const found = await send('DOM.querySelector', { nodeId: root, selector })
    if (typeof found?.nodeId === 'number' && found.nodeId > 0) {
      nodeId = found.nodeId
      break
    }
  }
  if (!nodeId) throw new ComposerError('file input not found')
  await send('DOM.setFileInputFiles', { files, nodeId })
  // 見本が出るのを待つ。目印が見つからなくても入っていることがあるので、失敗にはしない（最後は利用者が画面で見る）
  await waitFor(async () => (await page('exists', X_SELECTORS.attachments).catch(() => false)) === true, stepTimeoutMs)
}

/** フォーカスした欄に文字を入れる。改行は Enter を押す */
async function typeText(send: (method: string, params?: Record<string, unknown>) => Promise<any>, text: string): Promise<void> {
  const lines = text.normalize('NFC').replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', ...enter, text: '\r', unmodifiedText: '\r' })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter })
    }
    const line = lines[i] as string
    if (line) await send('Input.insertText', { text: line })
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
