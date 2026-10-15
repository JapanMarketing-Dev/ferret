import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-settings-file-locks-unit' } }))

import { sanitize } from '../../src/main/settings'
import { SettingsFileStore, TRANSIENT_RETRY_DELAYS_MS, isTransientFsError, retryTransientSync, writeFileAtomicSync } from '../../src/main/settingsFile'

/**
 * issue #5「事前登録していたのにオーケストラやプロジェクトが出ないことがある」（Windows）。
 * Windows では他のプロセス（ウイルス対策・エディタ・Agent）がファイルを開いている間、読み取りや rename が EBUSY / EPERM で失敗する。
 * 1度の失敗で既定値（プロジェクト0件）で始め、終了時にそれで settings.json を上書きしていたのを防ぐ。
 */

let root: string
let dir: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ade-settings-locks-'))
  dir = join(root, 'cfg')
  mkdirSync(dir)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const projectsConfig = {
  projects: [
    { id: 'orch', name: 'All products', folderPath: 'C:\\work\\all', urls: [], orchestrator: true, editorWorkspace: true },
    { id: 'p1', name: 'app', folderPath: 'C:\\work\\app', urls: [] }
  ]
}
const configText = `${JSON.stringify(projectsConfig, null, 2)}\n`

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: resource busy or locked`), { code })
}

const noSleep = { platform: 'win32' as const, sleep: () => undefined }

function newStore(extra: Partial<ConstructorParameters<typeof SettingsFileStore>[0]> = {}): SettingsFileStore {
  return new SettingsFileStore({ dir, legacyFile: join(root, 'userData', 'settings.json'), sanitize, retry: noSleep, ...extra })
}

function tmpLeftovers(): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'))
}

describe('retryTransientSync', () => {
  it('Windows の EBUSY・EPERM・EACCES は待ってやり直し、成功した値を返す', () => {
    for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EAGAIN']) {
      const sleep = vi.fn()
      let calls = 0
      const value = retryTransientSync(() => {
        if (++calls < 3) throw errno(code)
        return 'ok'
      }, { platform: 'win32', sleep })
      expect(value).toBe('ok')
      expect(calls).toBe(3)
      expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([TRANSIENT_RETRY_DELAYS_MS[0], TRANSIENT_RETRY_DELAYS_MS[1]])
    }
  })

  it('やり直しの回数には上限があり、最後の失敗を投げる', () => {
    const sleep = vi.fn()
    let calls = 0
    expect(() => retryTransientSync(() => { calls++; throw errno('EBUSY') }, { platform: 'win32', sleep })).toThrow(/EBUSY/)
    expect(calls).toBe(TRANSIENT_RETRY_DELAYS_MS.length + 1)
    expect(sleep).toHaveBeenCalledTimes(TRANSIENT_RETRY_DELAYS_MS.length)
  })

  it('一時的でない失敗（ENOENT など）と、Windows 以外の EPERM・EACCES はやり直さない', () => {
    const sleep = vi.fn()
    let calls = 0
    expect(() => retryTransientSync(() => { calls++; throw errno('ENOENT') }, { platform: 'win32', sleep })).toThrow(/ENOENT/)
    expect(() => retryTransientSync(() => { calls++; throw errno('EPERM') }, { platform: 'darwin', sleep })).toThrow(/EPERM/)
    expect(() => retryTransientSync(() => { calls++; throw errno('EACCES') }, { platform: 'linux', sleep })).toThrow(/EACCES/)
    expect(() => retryTransientSync(() => { calls++; throw new Error('plain') }, { platform: 'win32', sleep })).toThrow('plain')
    expect(calls).toBe(4)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('isTransientFsError は null・コードの無い値でも落ちない', () => {
    expect(isTransientFsError(null)).toBe(false)
    expect(isTransientFsError(undefined)).toBe(false)
    expect(isTransientFsError({})).toBe(false)
    expect(isTransientFsError(errno('EBUSY'))).toBe(true)
  })
})

describe('writeFileAtomicSync（Windows で置き換え先を掴まれている）', () => {
  it('rename の EPERM をやり直して書き、一時ファイルを残さない', () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, 'old')
    let calls = 0
    writeFileAtomicSync(target, 'new', { ...noSleep, rename: (from, to) => {
      if (++calls <= 2) throw errno('EPERM')
      renameSync(from, to)
    } })
    expect(readFileSync(target, 'utf8')).toBe('new')
    expect(calls).toBe(3)
    expect(tmpLeftovers()).toEqual([])
  })

  it('掴まれたままなら投げ、元のファイルと一時ファイルの無い状態を保つ', () => {
    const target = join(dir, 'settings.json')
    writeFileSync(target, 'old')
    expect(() => writeFileAtomicSync(target, 'new', { ...noSleep, rename: () => { throw errno('EBUSY') } })).toThrow(/EBUSY/)
    expect(readFileSync(target, 'utf8')).toBe('old')
    expect(tmpLeftovers()).toEqual([])
  })

  it('同じミリ秒に続けて書いても一時ファイルの名前がぶつからない', () => {
    const names = new Set<string>()
    const target = join(dir, 'x.json')
    for (let i = 0; i < 20; i++) writeFileAtomicSync(target, String(i), { rename: (from, to) => { names.add(from); renameSync(from, to) } })
    expect(names.size).toBe(20)
    expect(readFileSync(target, 'utf8')).toBe('19')
  })
})

describe('起動時の読み込み（issue #5）', () => {
  it('settings.json が一時的に読めなくても、やり直してプロジェクトとオーケストラを読む', () => {
    writeFileSync(join(dir, 'settings.json'), configText)
    let reads = 0
    const store = newStore({ readFile: (path) => {
      if (++reads <= 3) throw errno('EBUSY')
      return readFileSync(path, 'utf8')
    } })
    const { settings, error } = store.load()
    expect(error).toBeNull()
    expect(settings.projects.map((p) => p.id)).toEqual(['orch', 'p1'])
    expect(settings.projects[0]!.orchestrator).toBe(true)
    expect(store.loaded).toBe(true)
  })

  it('読めないまま始めても settings.json を空の一覧で上書きせず、読めたら取り込んで書けるようになる', () => {
    writeFileSync(join(dir, 'settings.json'), configText)
    let locked = true
    const onExternalChange = vi.fn()
    const store = newStore({ onExternalChange, readFile: (path) => {
      if (locked) throw errno('EPERM')
      return readFileSync(path, 'utf8')
    } })
    const { settings } = store.load()
    expect(settings.projects).toEqual([])
    expect(store.loaded).toBe(false)

    // 終了時の保存・操作の保存。state.json だけを書き、利用者の settings.json は元のまま
    store.saveSync({ ...settings, theme: 'dark' })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(configText)
    expect(existsSync(join(dir, 'state.json'))).toBe(true)

    // まだ掴まれている間は「無い」扱い（作り直さない）
    expect(store.checkNow()).toBe('missing')
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(configText)

    // 放されたら、内容が前と同じでも取り込む
    locked = false
    expect(store.checkNow()).toBe('applied')
    expect(onExternalChange).toHaveBeenCalledTimes(1)
    expect((onExternalChange.mock.calls[0]![0] as typeof projectsConfig).projects.map((p) => p.id)).toEqual(['orch', 'p1'])
    expect(store.loaded).toBe(true)
    expect(store.checkNow()).toBe('unchanged')

    // 取り込んだ後の保存はプロジェクトを保ったまま書く
    const merged = sanitize({ ...projectsConfig, theme: 'dark' })
    store.saveSync(merged)
    const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(written.theme).toBe('dark')
    expect(written.projects.map((p: { id: string }) => p.id)).toEqual(['orch', 'p1'])
  })

  it('Windows 以外では EACCES をやり直さないが、それでも settings.json は上書きしない', () => {
    writeFileSync(join(dir, 'settings.json'), configText)
    let reads = 0
    const store = newStore({ retry: { platform: 'linux', sleep: () => undefined }, readFile: () => { reads++; throw errno('EACCES') } })
    const { settings } = store.load()
    expect(reads).toBe(1)
    store.saveSync(settings)
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(configText)
  })

  it('settings.schema.json を置き換えられなくても（エディタが開いている）設定は読む', () => {
    writeFileSync(join(dir, 'settings.json'), configText)
    // 置き換え先を中身のあるフォルダにして rename を必ず失敗させる
    mkdirSync(join(dir, 'settings.schema.json', 'blocker'), { recursive: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const store = newStore()
      const { settings, error } = store.load()
      expect(error).toBeNull()
      expect(settings.projects.map((p) => p.id)).toEqual(['orch', 'p1'])
      expect(store.loaded).toBe(true)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
    expect(tmpLeftovers()).toEqual([])
  })

  it('書きかけ（空・途中で切れた JSON）を読んだら、少し待って読み直す', () => {
    writeFileSync(join(dir, 'settings.json'), configText)
    const sleep = vi.fn()
    const reads = ['', configText.slice(0, 40)]
    const store = newStore({ retry: { platform: 'win32', sleep }, readFile: (path) => reads.shift() ?? readFileSync(path, 'utf8') })
    const { settings, error } = store.load()
    expect(error).toBeNull()
    expect(settings.projects.map((p) => p.id)).toEqual(['orch', 'p1'])
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('本当に壊れていれば読み直しは数回で諦め、エラーとして出し、上書きしない', () => {
    const broken = '{ "projects": [ '
    writeFileSync(join(dir, 'settings.json'), broken)
    const sleep = vi.fn()
    const store = newStore({ retry: { platform: 'win32', sleep } })
    const { settings, error } = store.load()
    expect(error?.kind).toBe('parse')
    expect(settings.projects).toEqual([])
    expect(sleep).toHaveBeenCalledTimes(3)
    store.saveSync({ ...settings, theme: 'dark' })
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(broken)
  })

  it('スキーマの違反（JSON としては読める）は書きかけではないので待たない', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...projectsConfig, theme: 42 }))
    const sleep = vi.fn()
    const { settings, error } = newStore({ retry: { platform: 'win32', sleep } }).load()
    expect(error?.kind).toBe('schema')
    expect(settings.projects.map((p) => p.id)).toEqual(['orch', 'p1'])
    expect(sleep).not.toHaveBeenCalled()
  })

  it('初回（settings.json が無い）は今までどおり作って書ける', () => {
    const store = newStore()
    const { settings } = store.load()
    expect(store.loaded).toBe(true)
    expect(existsSync(join(dir, 'settings.json'))).toBe(true)
    store.saveSync({ ...settings, theme: 'dark' })
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).theme).toBe('dark')
  })

  it('保存の rename が一時的に失敗しても、プロジェクトを書き残す（再起動で消えない）', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ projects: [] }))
    let fails = 2
    let attempts = 0
    const store = newStore({ retry: { ...noSleep, rename: (from, to) => {
      if (to.endsWith('settings.json')) {
        attempts++
        if (fails-- > 0) throw errno('EPERM')
      }
      renameSync(from, to)
    } } })
    const { settings } = store.load()
    store.saveSync(sanitize({ ...settings, ...projectsConfig }))
    expect(attempts).toBe(3)
    const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
    expect(written.projects.map((p: { id: string }) => p.id)).toEqual(['orch', 'p1'])
    expect(tmpLeftovers()).toEqual([])
  })

  it('保存が最後まで失敗したら投げ、「書いた」扱いにせず次の保存で書き直す', () => {
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ projects: [] }))
    let locked = true
    const store = newStore({ retry: { ...noSleep, rename: (from, to) => {
      if (locked && to.endsWith('settings.json')) throw errno('EBUSY')
      renameSync(from, to)
    } } })
    const { settings } = store.load()
    const next = sanitize({ ...settings, ...projectsConfig })
    expect(() => store.saveSync(next)).toThrow(/EBUSY/)
    locked = false
    store.saveSync(next)
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).projects).toHaveLength(2)
    expect(tmpLeftovers()).toEqual([])
  })
})
