import { describe, expect, it } from 'vitest'
import {
  X_COMPOSE_URL,
  X_PAGE_OP,
  X_SELECTORS,
  composeFallbackUrl,
  fillXComposer,
  isXLoginUrl,
  normalizeComposerText,
  type ComposerContents,
  type ComposerOptions
} from '../../src/main/publish/xComposer'
import { xIntentUrl } from '../../src/shared/xPost'

/** X の投稿画面に入れる処理（src/main/publish/xComposer.ts）。X にはつながず、偽の画面で確かめる */

interface FakeOptions {
  /** loadURL のあとの URL */
  urlAfterLoad?: string
  /** 投稿画面が出るまでの確認の回数（Infinity なら出ない） */
  composerAfterPolls?: number
  loginHint?: boolean
  fileInput?: 'testid' | 'type' | 'modal' | 'none'
  showAttachments?: boolean
  alreadyAttached?: boolean
  attachThrows?: boolean
  setFilesThrows?: boolean
  destroyed?: boolean
  /** 入れた文字を X が変えてしまう */
  mangleText?: (text: string) => string
  addButtonWorks?: boolean
  /** 「+」が押せるようになるまでの押す回数 */
  addButtonAfterTries?: number
}

interface Call { method: string; params?: any }

function fakeContents(o: FakeOptions = {}) {
  let url = 'about:blank'
  let attached = o.alreadyAttached ?? false
  let polls = 0
  const calls: Call[] = []
  const texts: string[] = []
  let textareas = 0
  let focused = -1
  let attachments = false
  let detachCount = 0
  let addTries = 0

  const composerReady = (): boolean => polls >= (o.composerAfterPolls ?? 0)

  const evaluate = (expression: string): unknown => {
    const m = /\)\((\{.*\})\)$/s.exec(expression)
    if (!m) throw new Error(`unexpected expression: ${expression}`)
    const { op, selector } = JSON.parse(m[1] as string) as { op: string; selector: string }
    const ta = /^\[data-testid="tweetTextarea_(\d+)"\]$/.exec(selector)
    const index = ta ? Number(ta[1]) : -1
    if (op === 'exists') {
      if (selector === X_SELECTORS.textarea(0)) {
        polls++
        if (composerReady() && textareas === 0) textareas = 1
      }
      if (ta) return index < textareas
      if (selector === X_SELECTORS.loginHint) return o.loginHint ?? false
      if (selector === X_SELECTORS.attachments) return attachments
      return false
    }
    if (op === 'click' && selector === X_SELECTORS.addButton) {
      if (o.addButtonWorks === false) return false
      if (addTries++ < (o.addButtonAfterTries ?? 0)) return false
      textareas++
      texts.push('')
      return true
    }
    if (op === 'focus') {
      if (!ta || index >= textareas) return false
      focused = index
      return true
    }
    if (op === 'text') {
      if (!ta || index >= textareas) return null
      const t = texts[index] ?? ''
      return o.mangleText ? o.mangleText(t) : t
    }
    throw new Error(`unexpected op ${op} ${selector}`)
  }

  const contents: ComposerContents = {
    async loadURL(next: string) {
      calls.push({ method: 'loadURL', params: next })
      url = o.urlAfterLoad ?? next
    },
    getURL: () => url,
    isDestroyed: () => o.destroyed ?? false,
    debugger: {
      attach() {
        if (o.attachThrows) throw new Error('Another debugger is already attached')
        attached = true
      },
      detach() {
        detachCount++
        attached = false
      },
      isAttached: () => attached,
      async sendCommand(method: string, params?: any) {
        calls.push({ method, params })
        if (!attached) throw new Error('not attached')
        switch (method) {
          case 'Runtime.evaluate':
            return { result: { value: evaluate(params.expression) } }
          case 'DOM.getDocument':
            return { root: { nodeId: 1 } }
          case 'DOM.querySelector':
            if (params.selector === `${X_SELECTORS.modal} ${X_SELECTORS.fileInput}` && o.fileInput === 'modal') return { nodeId: 44 }
            if (params.selector === X_SELECTORS.fileInput && (o.fileInput ?? 'testid') === 'testid') return { nodeId: 42 }
            if (params.selector === X_SELECTORS.fileInputFallback && o.fileInput === 'type') return { nodeId: 43 }
            return { nodeId: 0 }
          case 'DOM.setFileInputFiles':
            if (o.setFilesThrows) throw new Error('Not allowed')
            attachments = o.showAttachments ?? true
            return {}
          case 'Input.insertText':
            if (focused < 0) throw new Error('nothing focused')
            texts[focused] = (texts[focused] ?? '') + params.text
            return {}
          case 'Input.dispatchKeyEvent':
            if (params.type === 'keyDown' && params.key === 'Enter') texts[focused] = (texts[focused] ?? '') + '\n'
            return {}
          default:
            throw new Error(`unexpected ${method}`)
        }
      }
    }
  }
  if (textareas === 0) texts.push('')
  return {
    contents,
    calls,
    texts,
    get attached() { return attached },
    get detachCount() { return detachCount },
    methods: () => calls.map((c) => c.method)
  }
}

const fast: ComposerOptions = { timeoutMs: 100, stepTimeoutMs: 50, pollMs: 10, sleep: async () => undefined }

describe('fillXComposer', () => {
  it('1件・メディアなし：投稿画面を開いて本文を入れ、デバッガーを外す', async () => {
    const f = fakeContents()
    const result = await fillXComposer(f.contents, { parts: ['こんにちは Ferret'], mediaPaths: [] }, fast)
    expect(result).toEqual({ status: 'filled', parts: 1, media: 0 })
    expect(f.calls[0]).toEqual({ method: 'loadURL', params: X_COMPOSE_URL })
    expect(f.calls.filter((c) => c.method === 'Input.insertText').map((c) => c.params.text)).toEqual(['こんにちは Ferret'])
    expect(f.methods()).not.toContain('DOM.setFileInputFiles')
    expect(f.texts[0]).toBe('こんにちは Ferret')
    expect(f.detachCount).toBe(1)
    expect(f.attached).toBe(false)
  })

  it('投稿画面が出るまで何度か確かめて待つ', async () => {
    const f = fakeContents({ composerAfterPolls: 3 })
    const result = await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)
    expect(result.status).toBe('filled')
  })

  it('3件のスレッド：「+」を2回押し、順に入れ、行の間で Enter を押す', async () => {
    const f = fakeContents()
    const parts = ['1件目\n2行目', '2件目', '3件目\n\n空行のあと']
    const result = await fillXComposer(f.contents, { parts, mediaPaths: [] }, fast)
    expect(result).toEqual({ status: 'filled', parts: 3, media: 0 })
    const clicks = f.calls.filter((c) => c.method === 'Runtime.evaluate' && c.params.expression.includes('"op":"click"'))
    expect(clicks).toHaveLength(2)
    expect(clicks.every((c) => c.params.expression.includes('addButton'))).toBe(true)
    expect(f.calls.filter((c) => c.method === 'Input.insertText').map((c) => c.params.text)).toEqual(['1件目', '2行目', '2件目', '3件目', '空行のあと'])
    const enters = f.calls.filter((c) => c.method === 'Input.dispatchKeyEvent')
    // 1件目に1回、3件目に2回（空行）。押す・離すで2つずつ
    expect(enters).toHaveLength(6)
    expect(enters[0]?.params).toMatchObject({ type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    expect(enters[1]?.params).toMatchObject({ type: 'keyUp', key: 'Enter' })
    expect(f.texts).toEqual(parts)
  })

  it('CRLF の改行も Enter にする', async () => {
    const f = fakeContents()
    const result = await fillXComposer(f.contents, { parts: ['a\r\nb'], mediaPaths: [] }, fast)
    expect(result.status).toBe('filled')
    expect(f.texts[0]).toBe('a\nb')
  })

  it('メディアは setFileInputFiles で file input の nodeId に絶対パスのまま入れる（本文より先）', async () => {
    const f = fakeContents()
    const mediaPaths = ['/tmp/a.png', '/tmp/b.jpg']
    const result = await fillXComposer(f.contents, { parts: ['画像つき', '2件目'], mediaPaths }, fast)
    expect(result).toEqual({ status: 'filled', parts: 2, media: 2 })
    const set = f.calls.filter((c) => c.method === 'DOM.setFileInputFiles')
    expect(set).toEqual([{ method: 'DOM.setFileInputFiles', params: { files: mediaPaths, nodeId: 42 } }])
    expect(f.calls.filter((c) => c.method === 'DOM.querySelector').map((c) => c.params)).toEqual([
      { nodeId: 1, selector: `${X_SELECTORS.modal} ${X_SELECTORS.fileInput}` },
      { nodeId: 1, selector: `${X_SELECTORS.modal} ${X_SELECTORS.fileInputFallback}` },
      { nodeId: 1, selector: X_SELECTORS.fileInput }
    ])
    const methods = f.methods()
    expect(methods.indexOf('DOM.setFileInputFiles')).toBeLessThan(methods.indexOf('Input.insertText'))
  })

  it('モーダルの中の file input があればそちらを使う', async () => {
    const f = fakeContents({ fileInput: 'modal' })
    expect((await fillXComposer(f.contents, { parts: ['a'], mediaPaths: ['/tmp/a.png'] }, fast)).status).toBe('filled')
    expect(f.calls.find((c) => c.method === 'DOM.setFileInputFiles')?.params.nodeId).toBe(44)
  })

  it('data-testid の file input が無ければ input[type=file] を使う', async () => {
    const f = fakeContents({ fileInput: 'type' })
    const result = await fillXComposer(f.contents, { parts: ['a'], mediaPaths: ['/tmp/a.png'] }, fast)
    expect(result.status).toBe('filled')
    expect(f.calls.find((c) => c.method === 'DOM.setFileInputFiles')?.params.nodeId).toBe(43)
  })

  it('メディアの見本の目印が出なくても続ける', async () => {
    const f = fakeContents({ showAttachments: false })
    const result = await fillXComposer(f.contents, { parts: ['a'], mediaPaths: ['/tmp/a.mp4'] }, fast)
    expect(result).toEqual({ status: 'filled', parts: 1, media: 1 })
  })

  it('file input が見つからなければ fallback', async () => {
    const f = fakeContents({ fileInput: 'none' })
    const result = await fillXComposer(f.contents, { parts: ['a'], mediaPaths: ['/tmp/a.png'] }, fast)
    expect(result).toEqual({ status: 'fallback', reason: 'file input not found' })
    expect(f.detachCount).toBe(1)
  })

  it('setFileInputFiles が失敗したら fallback（デバッガーは外す）', async () => {
    const f = fakeContents({ setFilesThrows: true })
    const result = await fillXComposer(f.contents, { parts: ['a'], mediaPaths: ['/tmp/a.png'] }, fast)
    expect(result).toEqual({ status: 'fallback', reason: 'Not allowed' })
    expect(f.methods()).not.toContain('Input.insertText')
    expect(f.attached).toBe(false)
  })

  it.each([
    'https://x.com/i/flow/login?redirect_after_login=%2Fcompose%2Fpost',
    'https://x.com/login',
    'https://x.com/i/flow/signup',
    'https://x.com/'
  ])('ログインに飛ばされたら login（%s）', async (urlAfterLoad) => {
    const f = fakeContents({ urlAfterLoad, composerAfterPolls: Infinity })
    const result = await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)
    expect(result).toEqual({ status: 'login' })
    expect(f.methods()).not.toContain('Input.insertText')
    expect(f.detachCount).toBe(1)
  })

  it('URL はそのままでもログインのボタンが出ていれば login', async () => {
    const f = fakeContents({ composerAfterPolls: Infinity, loginHint: true })
    expect(await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)).toEqual({ status: 'login' })
  })

  it('投稿画面が出ないまま時間切れなら fallback', async () => {
    const f = fakeContents({ composerAfterPolls: Infinity })
    let slept = 0
    const result = await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, { ...fast, sleep: async (ms) => { slept += ms } })
    expect(result).toEqual({ status: 'fallback', reason: 'composer did not appear' })
    expect(slept).toBe(100)
    expect(f.detachCount).toBe(1)
  })

  it('loadURL が失敗（ERR_ABORTED など）しても画面が出れば続ける', async () => {
    const f = fakeContents()
    f.contents.loadURL = async () => { throw new Error('ERR_ABORTED (-3)') }
    expect((await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)).status).toBe('filled')
  })

  it('ほかで付けたデバッガーはそのまま使い、外さない', async () => {
    const f = fakeContents({ alreadyAttached: true })
    const result = await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)
    expect(result.status).toBe('filled')
    expect(f.detachCount).toBe(0)
    expect(f.attached).toBe(true)
  })

  it('ほかで付けたデバッガーは失敗しても外さない', async () => {
    const f = fakeContents({ alreadyAttached: true, setFilesThrows: true })
    expect((await fillXComposer(f.contents, { parts: ['a'], mediaPaths: ['/tmp/a.png'] }, fast)).status).toBe('fallback')
    expect(f.detachCount).toBe(0)
  })

  it('デバッガーを付けられなければ fallback（ページは開かない）', async () => {
    const f = fakeContents({ attachThrows: true })
    const result = await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)
    expect(result.status).toBe('fallback')
    expect(result.status === 'fallback' && result.reason).toMatch(/debugger attach failed/)
    expect(f.calls).toEqual([])
    expect(f.detachCount).toBe(0)
  })

  it('閉じたタブなら何もせず fallback', async () => {
    const f = fakeContents({ destroyed: true })
    expect(await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)).toEqual({ status: 'fallback', reason: 'tab closed' })
    expect(f.calls).toEqual([])
  })

  it('途中でタブが閉じたら fallback（閉じたタブのデバッガーは触らない）', async () => {
    const f = fakeContents()
    let destroyed = false
    f.contents.isDestroyed = () => destroyed
    const loadURL = f.contents.loadURL.bind(f.contents)
    f.contents.loadURL = async (u) => { await loadURL(u); destroyed = true }
    expect(await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)).toEqual({ status: 'fallback', reason: 'tab closed' })
    expect(f.detachCount).toBe(0)
  })

  it('入った文字が違えば fallback', async () => {
    const f = fakeContents({ mangleText: (t) => t.slice(0, -1) })
    const result = await fillXComposer(f.contents, { parts: ['abc', 'def'], mediaPaths: [] }, fast)
    expect(result).toEqual({ status: 'fallback', reason: 'text of part 1 did not match' })
  })

  it('空白・改行・見えない文字の違いは同じとみなす', async () => {
    const f = fakeContents({ mangleText: (t) => `${t.replace(/\n/g, '\n\n')}​ ` })
    expect((await fillXComposer(f.contents, { parts: ['a\nb'], mediaPaths: [] }, fast)).status).toBe('filled')
  })

  it('「+」が出なければ、1件目と添付だけ入れて入れた件数を返す', async () => {
    const f = fakeContents({ addButtonWorks: false })
    const result = await fillXComposer(f.contents, { parts: ['a', 'b', 'c'], mediaPaths: ['/tmp/a.png'] }, fast)
    expect(result).toEqual({ status: 'filled', parts: 1, media: 1 })
    expect(f.calls.filter((c) => c.method === 'Input.insertText').map((c) => c.params.text)).toEqual(['a'])
    expect(f.detachCount).toBe(1)
  })

  it('「+」が少し遅れて出れば待って押す', async () => {
    const f = fakeContents({ addButtonAfterTries: 3 })
    const result = await fillXComposer(f.contents, { parts: ['a', 'b'], mediaPaths: [] }, fast)
    expect(result).toEqual({ status: 'filled', parts: 2, media: 0 })
    expect(f.texts).toEqual(['a', 'b'])
  })

  it('/home に留まっていてもログイン扱いにしない（投稿欄が出れば入れる）', async () => {
    const f = fakeContents({ urlAfterLoad: 'https://x.com/home' })
    expect((await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)).status).toBe('filled')
  })

  it('/home で投稿欄もログインのボタンも無ければ、時間切れで fallback（login にしない）', async () => {
    const f = fakeContents({ urlAfterLoad: 'https://x.com/home', composerAfterPolls: Infinity })
    expect(await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)).toEqual({ status: 'fallback', reason: 'composer did not appear' })
  })

  it('ページのスクリプトが例外を出したら fallback', async () => {
    const f = fakeContents()
    const send = f.contents.debugger.sendCommand.bind(f.contents.debugger)
    f.contents.debugger.sendCommand = async (method, params) => {
      if (method === 'Runtime.evaluate' && params.expression.includes('"op":"focus"')) return { exceptionDetails: { text: 'Uncaught' } }
      return send(method, params)
    }
    expect(await fillXComposer(f.contents, { parts: ['a'], mediaPaths: [] }, fast)).toEqual({ status: 'fallback', reason: 'page script failed: Uncaught' })
  })

  it.each([
    [[], [], 'no text'],
    [['a', '  '], [], 'empty part'],
    [Array.from({ length: 26 }, () => 'a'), [], 'too many parts'],
    [['a'], ['/a.png', '/b.png', '/c.png', '/d.png', '/e.png'], 'too many media'],
    [['a'], ['a.png'], 'media path not absolute']
  ])('入力がおかしければ何もせず fallback（%#）', async (parts, mediaPaths, reason) => {
    const f = fakeContents()
    expect(await fillXComposer(f.contents, { parts, mediaPaths }, fast)).toEqual({ status: 'fallback', reason })
    expect(f.calls).toEqual([])
    expect(f.attached).toBe(false)
  })

  it('25件ちょうどは入れられる', async () => {
    const f = fakeContents()
    const parts = Array.from({ length: 25 }, (_, i) => `part ${i}`)
    expect(await fillXComposer(f.contents, { parts, mediaPaths: [] }, fast)).toEqual({ status: 'filled', parts: 25, media: 0 })
  })
})

describe('isXLoginUrl', () => {
  it.each([
    ['https://x.com/login', true],
    ['https://x.com/i/flow/login?redirect_after_login=%2Fcompose%2Fpost', true],
    ['https://twitter.com/i/flow/signup', true],
    ['https://x.com/i/jf/onboarding/web?redirect_after_login=%2Fcompose%2Fpost&mode=login', true],
    ['https://x.com/i/jf/onboardingfoo', false],
    ['https://mobile.x.com/login/', true],
    ['https://x.com/', true],
    ['https://x.com', true],
    ['https://x.com/compose/post', false],
    ['https://x.com/home', false],
    ['https://x.com/loginfoo', false],
    ['https://example.com/login', false],
    ['about:blank', false],
    ['', false]
  ])('%s → %s', (url, expected) => {
    expect(isXLoginUrl(url)).toBe(expected)
  })
})

describe('composeFallbackUrl / normalizeComposerText', () => {
  it('1件目の本文で intent を開く', () => {
    expect(composeFallbackUrl(['一件目', '二件目'])).toBe(xIntentUrl('一件目'))
    expect(composeFallbackUrl([])).toBe(xIntentUrl(''))
  })

  it('空白をそろえる', () => {
    expect(normalizeComposerText('  a\n\n b‌\t')).toBe('a b')
    expect(normalizeComposerText('が')).toBe('が')
  })
})

describe('ページの中の操作（X_PAGE_OP）', () => {
  /** querySelector だけを持つ偽の要素・document */
  function el(name: string, children: Record<string, any> = {}) {
    return {
      name,
      innerText: name,
      clicked: 0,
      getAttribute: () => null,
      click() { this.clicked++ },
      querySelector: (s: string) => children[s] ?? null
    }
  }
  function run(doc: Record<string, any>, op: string, selector: string): unknown {
    const fn = new Function('document', `return (${X_PAGE_OP})`)(
      { querySelector: (s: string) => doc[s] ?? null }
    ) as (a: unknown) => unknown
    return fn({ op, selector, modal: X_SELECTORS.modal })
  }
  const ta = X_SELECTORS.textarea(0)

  it('モーダルの中にあればそちらを使う', () => {
    const modal = el('modal', { [ta]: el('in-modal') })
    expect(run({ [X_SELECTORS.modal]: modal, [ta]: el('inline') }, 'text', ta)).toBe('in-modal')
  })

  it('モーダルが空ならページの最初のものを使う', () => {
    expect(run({ [X_SELECTORS.modal]: el('empty modal'), [ta]: el('inline') }, 'text', ta)).toBe('inline')
    expect(run({ [ta]: el('inline') }, 'text', ta)).toBe('inline')
  })

  it('無ければ exists は false・text は null・click は false', () => {
    expect(run({}, 'exists', ta)).toBe(false)
    expect(run({}, 'text', ta)).toBeNull()
    expect(run({}, 'click', X_SELECTORS.addButton)).toBe(false)
  })

  it('押せないボタン（aria-disabled）は押さない', () => {
    const button = { ...el('add'), getAttribute: (n: string) => (n === 'aria-disabled' ? 'true' : null) }
    expect(run({ [X_SELECTORS.addButton]: button }, 'click', X_SELECTORS.addButton)).toBe(false)
    expect(button.clicked).toBe(0)
    const ok = el('add')
    expect(run({ [X_SELECTORS.addButton]: ok }, 'click', X_SELECTORS.addButton)).toBe(true)
    expect(ok.clicked).toBe(1)
  })
})
