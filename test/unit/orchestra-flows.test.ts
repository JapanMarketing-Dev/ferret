/**
 * 0.6.6 の通しの確認：
 * - 全体で録った1回のフィードバックを、プロダクトごとに分けて各 Agent へ同時に送る（src/main/productSplitSend.ts）
 * - Chrome の書き出しと同じ形の CSV を、IPC の入口（src/main/browserImport/ipc.ts）から見つけて取り込み、書き出し直して同期する
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const trashed: string[] = []
vi.mock('electron', () => ({
  Menu: { buildFromTemplate: () => ({ popup: () => undefined }) },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { trashItem: async (path: string) => { trashed.push(path) } }
}))

import { t } from '../../src/shared/i18n'
import { sendSplitByProduct } from '../../src/main/productSplitSend'
import { browserImportHandlers } from '../../src/main/browserImport/ipc'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

describe('1回の録画をプロダクトごとに分けて送る（通し）', () => {
  const products = [
    { id: 'shop', name: 'acme-shop', folderPath: '/w/acme-shop', urls: [{ url: 'http://localhost:3000/' }] },
    { id: 'crm', name: 'acme-crm', folderPath: '/w/acme-crm', urls: [{ url: 'http://localhost:4000/' }] },
    { id: 'blog', name: 'acme-blog', folderPath: '/w/acme-blog', urls: [{ url: 'http://localhost:5000/' }] }
  ]
  // 録画の途中で acme-shop → acme-crm → (ウインドウを映した) → acme-blog → 知らないページ と帯のタブを切り替えた
  const items = [
    { id: 'a', index: 1, t: 1000, include: true, context: { url: 'http://localhost:3000/cart' } },
    { id: 'b', index: 2, t: 5000, include: true, context: { url: 'http://localhost:4000/deals' } },
    { id: 'c', index: 3, t: 6000, include: true, context: {} },
    { id: 'd', index: 4, t: 9000, include: true, context: { url: 'http://localhost:5000/' } },
    { id: 'e', index: 5, t: 9500, include: false, context: { url: 'http://localhost:5000/x' } },
    { id: 'f', index: 6, t: 12000, include: true, context: { url: 'https://example.org/' } }
  ]
  const tt = (key: string, values?: Record<string, string | number>) => t(key as Parameters<typeof t>[0], values)

  it('Agent のいるプロダクトへは直接、いないプロダクトと分からない指摘は全体の Agent へ。全部を同時に送る', async () => {
    const sent: Array<{ id: string; text: string }> = []
    let inFlight = 0
    let maxInFlight = 0
    const agents: Record<string, string> = { '/w/acme-shop': 'term-shop', '/w/acme-crm': 'term-crm', '/orchestra': 'term-top' }
    const result = await sendSplitByProduct({
      resolveTarget: async (folder) => agents[folder] ?? null,
      send: async (id, text) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 20))
        inFlight--
        sent.push({ id, text })
        return { ok: true, message: 'ok' }
      },
      t: tt
    }, { products, items, pending: new Set(['a', 'b', 'c', 'd', 'e', 'f']), orchestraFolder: '/orchestra', instruction: 'Read feedback.md', feedbackPath: '/orchestra/.ferret/reviews/r1/feedback.md' })

    expect(result).toMatchObject({ ok: true })
    expect(maxInFlight).toBe(3)
    const byId = Object.fromEntries(sent.map((s) => [s.id, s.text]))
    expect(Object.keys(byId).sort()).toEqual(['term-crm', 'term-shop', 'term-top'])
    expect(byId['term-shop']).toContain('#1')
    expect(byId['term-shop']).not.toContain('#2')
    expect(byId['term-shop']).toContain('/orchestra/.ferret/reviews/r1/feedback.md')
    // URL の無い指摘（#3）は直前のプロダクト（acme-crm）のもの
    expect(byId['term-crm']).toContain('#2, #3')
    // acme-blog は Agent がいないので全体へ。外した #5 は送らない。知らないページの #6 は「分からない」として全体へ
    expect(byId['term-top']).toContain('acme-blog (/w/acme-blog): #4')
    expect(byId['term-top']).not.toContain('#5')
    expect(byId['term-top']).toMatch(/#6/)
    expect(byId['term-top']).toMatch(/acme-shop.*#1/)
    for (const text of Object.values(byId)) expect(text).not.toContain('{{')
  })

  it('送れなかった Agent があれば知らせる。どこにも Agent が居なければ noAgent。プロダクトが1つも決まらなければ null', async () => {
    const partial = await sendSplitByProduct({
      resolveTarget: async (folder) => (folder === '/w/acme-shop' ? 'term-shop' : folder === '/orchestra' ? 'term-top' : null),
      send: async (id) => (id === 'term-top' ? { ok: false, message: 'busy' } : { ok: true, message: 'ok' }),
      t: tt
    }, { products, items, pending: new Set(['a', 'd']), orchestraFolder: '/orchestra', instruction: 'x', feedbackPath: '/f.md' })
    expect(partial).toMatchObject({ ok: true, message: 'busy' })

    const none = await sendSplitByProduct({ resolveTarget: async () => null, send: async () => ({ ok: true, message: '' }), t: tt },
      { products, items, pending: new Set(['d']), orchestraFolder: '/orchestra', instruction: 'x', feedbackPath: '/f.md' })
    expect(none).toEqual({ ok: false, message: tt('terminal.send.noAgent') })

    const unmatched = await sendSplitByProduct({ resolveTarget: async () => 'x', send: async () => ({ ok: true, message: '' }), t: tt },
      { products, items, pending: new Set(['f']), orchestraFolder: '/orchestra', instruction: 'x', feedbackPath: '/f.md' })
    expect(unmatched).toBeNull()
  })
})

describe('Chrome の書き出しの CSV で同期する（IPC の入口から）', () => {
  // テストの値は実行時につなぐ（本物の鍵や値に見えないように）
  const pw = (n: number) => ['fake', 'value', String(n)].join('-')
  const chromeCsv = (rows: Array<[string, string, string]>) =>
    `name,url,username,password,note\n${rows.map(([url, user, pass]) => `${new URL(url).hostname},${url},${user},${pass},`).join('\n')}\n`

  it('ダウンロードの書き出しを見つけて取り込み、書き出し直すと消した・変えたものが反映され、CSV をごみ箱へ移せる', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferret-pwsync-'))
    dirs.push(root)
    const downloads = join(root, 'Downloads')
    await mkdir(downloads)
    const old = join(downloads, 'Old Passwords.csv')
    await writeFile(old, chromeCsv([['https://old.example/', 'x', pw(0)]]))
    const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    await utimes(old, longAgo, longAgo)
    await writeFile(join(downloads, 'report.csv'), 'a,b\n1,2\n')
    const file = join(downloads, 'Chrome Passwords.csv')
    await writeFile(file, chromeCsv([
      ['https://accounts.example.com/signin', 'alice', pw(1)],
      ['https://shop.example.net/login', 'bob', pw(2)],
      ['android://hash@com.example.app/', 'carol', pw(3)]
    ]))
    const changed = vi.fn()
    let pageUrl = 'https://login.example.com/'
    const contents = {
      isDestroyed: () => false,
      getURL: () => pageUrl,
      mainFrame: { get url() { return pageUrl } },
      executeJavaScriptInIsolatedWorld: async () => true
    }
    const h = browserImportHandlers({
      window: () => null,
      pageContents: () => contents as never,
      userDataDir: () => root,
      isPackaged: false,
     
      notifyChanged: changed,
      exportDirs: () => [downloads, join(root, 'Desktop')]
    })

    const found = await h['browserImport:findExports']() as Array<{ key: string; name: string }>
    expect(found.map((f) => f.name)).toEqual(['Chrome Passwords.csv'])
    const first = await h['browserImport:importPasswords'](found[0]!.key) as { added: number; removed: number; skipped: number; file: string }
    expect(first).toMatchObject({ added: 2, removed: 0, skipped: 1 })
    expect(changed).toHaveBeenCalledTimes(1)
    // 別のサブドメインで保存したものは、ホスト名を付けて出す
    expect(await h['passwords:forPage']()).toMatchObject({ origin: 'https://login.example.com', hasPasswordField: true, accounts: [{ username: 'alice', site: 'accounts.example.com' }] })

    // Chrome で bob を消し、alice のパスワードを変えてから書き出し直した
    await writeFile(file, chromeCsv([['https://accounts.example.com/signin', 'alice', pw(9)]]))
    const again = await h['browserImport:importPasswords'](first.file) as { added: number; updated: number; removed: number }
    expect(again).toMatchObject({ added: 0, updated: 1, removed: 1 })
    expect((await h['browserImport:status']() as { passwords: { count: number } }).passwords.count).toBe(1)
    pageUrl = 'https://shop.example.net/login'
    expect((await h['passwords:forPage']() as { accounts: unknown[] }).accounts).toEqual([])

    expect(await h['browserImport:trashExport'](first.file)).toBe(true)
    expect(trashed).toEqual([file])
    // 見つけた・選んだもの以外はごみ箱へ移さない
    expect(await h['browserImport:trashExport']('not-a-key')).toBe(false)
  })
})

describe('依頼の雛形「Agent に全部書き出してもらう」（通し）', () => {
  it('全体から押すと、全プロダクトを並行して集め human.md の表に書く依頼が、全体の Agent に1回で届く', async () => {
    const { sendAgentRequestsTo } = await import('../../src/main/agentRequestSend')
    const id = 'human-checklist'
    const sent: Array<{ id: string; text: string }> = []
    const result = await sendAgentRequestsTo({
      resolveTarget: async (folder) => (folder === '/all-products' ? 'term-top' : null),
      send: async (terminal, text) => { sent.push({ id: terminal, text }); return { ok: true, message: 'ok' } },
      noAgentMessage: 'no agent'
    }, { ids: [id], prefs: undefined, lang: 'en', project: { editorWorkspace: true }, folder: '/all-products' })
    expect(result).toEqual({ ok: true, message: 'ok' })
    expect(sent).toHaveLength(1)
    expect(sent[0]!.id).toBe('term-top')
    for (const word of ['one subagent per included product', 'Inside each product too', 'human.md', '| No. | Product | URL | What to check |', 'top of the All products dashboard']) expect(sent[0]!.text).toContain(word)
    // Agent が居なければ、画面に既定の Agent を開かせる（noAgent）。隠した・知らない依頼は送らない
    expect(await sendAgentRequestsTo({ resolveTarget: async () => null, send: async () => ({ ok: true, message: '' }), noAgentMessage: 'no agent' },
      { ids: [id], prefs: undefined, lang: 'en', project: { editorWorkspace: true }, folder: '/all-products' })).toEqual({ ok: false, message: 'no agent', noAgent: true })
    expect(await sendAgentRequestsTo({ resolveTarget: async () => 'x', send: async () => ({ ok: true, message: '' }), noAgentMessage: '' },
      { ids: ['nope'], prefs: undefined, lang: 'en', project: undefined, folder: null })).toBe('empty')
  })
})
