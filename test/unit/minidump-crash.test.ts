import { describe, expect, it } from 'vitest'
import { STACK_LIMIT, parseMinidumpCrash } from '../../src/shared/minidump'
import { NATIVE_CRASH_FLOW_LIMIT, isOwnExecutable, memoryBucket, minimizeNativeCrash, scrubEvent, shouldSendNativeCrash, uptimeBucket } from '../../src/shared/telemetry'

/**
 * main のネイティブのクラッシュ（FERRET-12、0.4.16 の Windows）は、minidump を捨てていたので原因が分からなかった。
 * minidump から例外の種類と落ちた場所のモジュール名だけを読み、落ちる前のメモリの量の区分と一緒にタグにする
 */

/** 例外・モジュール一覧・SystemInfo の3つの stream を持つ最小の minidump を作る */
function minidump(opts: { code: number; address: bigint; platformId?: number; modules?: Array<{ base: bigint; size: number; name: string }> }): Uint8Array {
  const modules = opts.modules ?? []
  const headerSize = 32
  const dirSize = 3 * 12
  const exceptionAt = headerSize + dirSize
  const exceptionSize = 168
  const systemAt = exceptionAt + exceptionSize
  const systemSize = 56
  const modulesAt = systemAt + systemSize
  const modulesSize = 4 + modules.length * 108
  let namesAt = modulesAt + modulesSize
  const names = modules.map((m) => {
    const bytes = Buffer.from(m.name, 'utf16le')
    const at = namesAt
    namesAt += 4 + bytes.length
    return { at, bytes }
  })
  const buf = Buffer.alloc(namesAt)
  buf.write('MDMP', 0, 'latin1')
  buf.writeUInt32LE(3, 8)
  buf.writeUInt32LE(headerSize, 12)
  const dir = (i: number, type: number, size: number, rva: number) => {
    buf.writeUInt32LE(type, headerSize + i * 12)
    buf.writeUInt32LE(size, headerSize + i * 12 + 4)
    buf.writeUInt32LE(rva, headerSize + i * 12 + 8)
  }
  dir(0, 6, exceptionSize, exceptionAt)
  dir(1, 7, systemSize, systemAt)
  dir(2, 4, modulesSize, modulesAt)
  buf.writeUInt32LE(opts.code, exceptionAt + 8)
  buf.writeBigUInt64LE(opts.address, exceptionAt + 24)
  buf.writeUInt32LE(opts.platformId ?? 2, systemAt + 24)
  buf.writeUInt32LE(modules.length, modulesAt)
  modules.forEach((m, i) => {
    const at = modulesAt + 4 + i * 108
    buf.writeBigUInt64LE(m.base, at)
    buf.writeUInt32LE(m.size, at + 8)
    buf.writeUInt32LE(names[i].at, at + 20)
    buf.writeUInt32LE(names[i].bytes.length, names[i].at)
    names[i].bytes.copy(buf, names[i].at + 4)
  })
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

const MODULES = [
  { base: 0x7ff600000000n, size: 0x1000000, name: 'C:\\Users\\someone\\AppData\\Local\\Programs\\Ferret\\Ferret.exe' },
  { base: 0x7ffa00000000n, size: 0x100000, name: 'C:\\Users\\someone\\AppData\\Local\\Programs\\Ferret\\resources\\app.asar.unpacked\\node_modules\\node-pty\\build\\Release\\pty.node' }
]

describe('minidump から落ちた理由を読む', () => {
  it('Windows のアクセス違反と、落ちた場所のモジュールのファイル名（パスは持たない）', () => {
    const out = parseMinidumpCrash(minidump({ code: 0xc0000005, address: 0x7ffa00000123n, modules: MODULES }))
    expect(out).toEqual({ code: '0xc0000005', kind: 'access-violation', executable: 'ferret.exe', module: 'pty.node', offset: '0x123' })
    expect(JSON.stringify(out)).not.toContain('someone')
  })

  it('Chromium のメモリ不足（0xe0000008）は oom', () => {
    expect(parseMinidumpCrash(minidump({ code: 0xe0000008, address: 0x7ff600000010n, modules: MODULES }))).toEqual({ code: '0xe0000008', kind: 'oom', executable: 'ferret.exe', module: 'ferret.exe', offset: '0x10' })
  })

  it('macOS と Linux は番号の意味が違う', () => {
    expect(parseMinidumpCrash(minidump({ code: 1, address: 0n, platformId: 0x8101 }))).toEqual({ code: '0x1', kind: 'bad-access' })
    expect(parseMinidumpCrash(minidump({ code: 11, address: 0n, platformId: 0x8201 }))).toEqual({ code: '0xb', kind: 'sigsegv' })
  })

  it('知らない番号は番号だけ、どのモジュールにも入らない番地はモジュール名なし', () => {
    expect(parseMinidumpCrash(minidump({ code: 0x12345678, address: 0x10n, modules: MODULES }))).toEqual({ code: '0x12345678', executable: 'ferret.exe' })
  })

  it('形の違うモジュール名は送らない', () => {
    const odd = [{ base: 0x1000n, size: 0x1000, name: 'C:\\x\\name with spaces.dll' }]
    expect(parseMinidumpCrash(minidump({ code: 0xc0000005, address: 0x1010n, modules: odd }))).toEqual({ code: '0xc0000005', kind: 'access-violation' })
  })

  it('minidump でないもの・途中で切れたものは null', () => {
    expect(parseMinidumpCrash(new Uint8Array(10))).toBeNull()
    expect(parseMinidumpCrash(new TextEncoder().encode('not a minidump at all, just text....'))).toBeNull()
    const full = minidump({ code: 0xc0000005, address: 0x7ffa00000123n, modules: MODULES })
    expect(parseMinidumpCrash(full.subarray(0, 80))).toBeNull()
  })
})

/**
 * 例外・スレッド一覧・スレッド名・モジュール一覧（CodeView 付き）を持つ minidump（FERRET-1Q の再発防止で読むようにしたもの）。
 * 落ちたスレッドは id 7、スタックは8バイトの値の並び
 */
function richMinidump(opts: { address: bigint; stack: bigint[]; threadName?: string; modules: Array<{ base: bigint; size: number; name: string; stamp?: number; guid?: number[]; age?: number }> }): Uint8Array {
  const parts: Buffer[] = []
  let cursor = 32 + 5 * 12
  const place = (b: Buffer): number => { const at = cursor; parts.push(b); cursor += b.length; return at }
  const str16 = (text: string): Buffer => { const body = Buffer.from(text, 'utf16le'); const b = Buffer.alloc(4 + body.length); b.writeUInt32LE(body.length, 0); body.copy(b, 4); return b }
  const exception = Buffer.alloc(168)
  exception.writeUInt32LE(7, 0)
  exception.writeUInt32LE(0xc0000005, 8)
  exception.writeBigUInt64LE(opts.address, 24)
  const exceptionAt = place(exception)
  const system = Buffer.alloc(56)
  system.writeUInt32LE(2, 24)
  const systemAt = place(system)
  const stackBytes = Buffer.alloc(opts.stack.length * 8)
  opts.stack.forEach((v, i) => stackBytes.writeBigUInt64LE(v, i * 8))
  const stackAt = place(stackBytes)
  const threads = Buffer.alloc(4 + 2 * 48)
  threads.writeUInt32LE(2, 0)
  threads.writeUInt32LE(3, 4) // ほかのスレッド（スタックなし）
  threads.writeUInt32LE(7, 4 + 48)
  threads.writeUInt32LE(stackBytes.length, 4 + 48 + 32)
  threads.writeUInt32LE(stackAt, 4 + 48 + 36)
  const threadsAt = place(threads)
  const nameAt = place(str16(opts.threadName ?? 'CrBrowserMain'))
  const names = Buffer.alloc(4 + 12)
  names.writeUInt32LE(1, 0)
  names.writeUInt32LE(7, 4)
  names.writeBigUInt64LE(BigInt(nameAt), 8)
  const namesAt = place(names)
  const moduleNames = opts.modules.map((m) => place(str16(m.name)))
  const cvs = opts.modules.map((m) => {
    if (!m.guid) return null
    const b = Buffer.alloc(24 + 12)
    b.write('RSDS', 0, 'latin1')
    Buffer.from(m.guid).copy(b, 4)
    b.writeUInt32LE(m.age ?? 1, 20)
    b.write('C:\\build\\electron.exe.pdb', 24, 'latin1')
    return { at: place(b), size: b.length }
  })
  const modules = Buffer.alloc(4 + opts.modules.length * 108)
  modules.writeUInt32LE(opts.modules.length, 0)
  opts.modules.forEach((m, i) => {
    const at = 4 + i * 108
    modules.writeBigUInt64LE(m.base, at)
    modules.writeUInt32LE(m.size, at + 8)
    modules.writeUInt32LE(m.stamp ?? 0, at + 16)
    modules.writeUInt32LE(moduleNames[i], at + 20)
    const cv = cvs[i]
    if (cv) { modules.writeUInt32LE(cv.size, at + 76); modules.writeUInt32LE(cv.at, at + 80) }
  })
  const modulesAt = place(modules)
  const head = Buffer.alloc(32 + 5 * 12)
  head.write('MDMP', 0, 'latin1')
  head.writeUInt32LE(5, 8)
  head.writeUInt32LE(32, 12)
  ;[[6, exceptionAt], [7, systemAt], [3, threadsAt], [24, namesAt], [4, modulesAt]].forEach(([type, rva], i) => {
    head.writeUInt32LE(type, 32 + i * 12)
    head.writeUInt32LE(rva, 32 + i * 12 + 8)
  })
  const buf = Buffer.concat([head, ...parts])
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

describe('minidump から落ちた場所の手がかりを読む（FERRET-1Q の再発防止）', () => {
  const guid = [0x78, 0x56, 0x34, 0x12, 0xbc, 0x9a, 0xf0, 0xde, 1, 2, 3, 4, 5, 6, 7, 8]
  const modules = [
    { base: 0x7ff600000000n, size: 0x9000000, name: 'C:\\Users\\someone\\AppData\\Local\\Programs\\Ferret\\Ferret.exe', stamp: 0x6543abcd, guid, age: 2 },
    { base: 0x7ffa00000000n, size: 0x100000, name: 'C:\\Windows\\System32\\ntdll.dll' }
  ]

  it('落ちた場所のオフセット・symbols の ID・スレッド名・スタックの中のモジュールの位置を返す', () => {
    const stack = [0x1234n, 0x7ff600001000n, 0xdeadbeefn, 0x7ffa00000040n, 0x7ff600abcdefn]
    const out = parseMinidumpCrash(richMinidump({ address: 0x7ff600000123n, stack, modules }))
    expect(out).toEqual({
      code: '0xc0000005', kind: 'access-violation', executable: 'ferret.exe', module: 'ferret.exe', offset: '0x123',
      debugId: '123456789ABCDEF001020304050607082', codeId: '6543ABCD9000000', thread: 'CrBrowserMain',
      stack: ['ferret.exe+0x1000', 'ntdll.dll+0x40', 'ferret.exe+0xabcdef']
    })
    // パス・PDB の場所・ユーザー名・アドレスそのものは出ない
    const text = JSON.stringify(out)
    for (const leak of ['someone', 'build', 'pdb', '7ff6', 'deadbeef']) expect(text).not.toContain(leak)
  })

  it('スタックから拾うのは上から STACK_LIMIT 件まで', () => {
    const stack = Array.from({ length: 50 }, (_, i) => 0x7ff600000000n + BigInt(i * 16))
    expect(parseMinidumpCrash(richMinidump({ address: 0x7ff600000123n, stack, modules }))?.stack).toHaveLength(STACK_LIMIT)
  })

  it('形の違うスレッド名は送らない', () => {
    expect(parseMinidumpCrash(richMinidump({ address: 0x7ff600000123n, stack: [], threadName: 'C:\\Users\\someone\\x', modules }))?.thread).toBeUndefined()
  })

  it('送るイベントでは contexts.crash にまとめ、Ferret の flow のパンくずだけを残す', () => {
    const dump = parseMinidumpCrash(richMinidump({ address: 0x7ff600000123n, stack: [0x7ff600001000n], modules }))
    const event = {
      level: 'fatal', platform: 'native', tags: { 'event.process': 'browser' }, contexts: {},
      breadcrumbs: [
        { category: 'electron', message: 'main-window.focus https://example.com/?token=abc' },
        { category: 'flow', message: 'update install', data: { method: 'nsis' }, timestamp: 1 },
        { category: 'flow', message: 'terminal exit', data: { exitCode: 0, kind: 'shell', path: 'C:\\Users\\someone' } },
        { category: 'flow', message: 'C:\\Users\\someone opened' }
      ]
    }
    const out = minimizeNativeCrash(event, dump) as unknown as { contexts: { crash: Record<string, unknown> }; breadcrumbs: Array<Record<string, unknown>> }
    expect(out.contexts.crash).toEqual({ location: 'ferret.exe+0x123', debug_id: '123456789ABCDEF001020304050607082', code_id: '6543ABCD9000000', thread: 'CrBrowserMain', stack: ['ferret.exe+0x1000'] })
    expect(out.breadcrumbs.map((b) => b.message)).toEqual(['update install', 'terminal exit'])
    const scrubbed = scrubEvent(out) as unknown as { contexts: { crash?: Record<string, unknown> } }
    // 送る直前の伏せ字でも落とさない（0.4.21〜0.6.2 は ALLOWED_CONTEXTS に無く、FERRET-1Q に場所が届かなかった）
    expect(scrubbed.contexts.crash).toEqual(out.contexts.crash)
    const text = JSON.stringify(scrubbed)
    for (const leak of ['someone', 'example.com', 'token']) expect(text).not.toContain(leak)
  })

  it('flow のパンくずは直近 NATIVE_CRASH_FLOW_LIMIT 件まで', () => {
    const breadcrumbs = Array.from({ length: 50 }, (_, i) => ({ category: 'flow', message: `step ${i}` }))
    const out = minimizeNativeCrash({ tags: {}, contexts: {}, breadcrumbs }, null) as unknown as { breadcrumbs: Array<{ message: string }> }
    expect(out.breadcrumbs).toHaveLength(NATIVE_CRASH_FLOW_LIMIT)
    expect(out.breadcrumbs.at(-1)?.message).toBe('step 49')
  })
})

describe('ネイティブのクラッシュに理由と落ちる前の様子を付ける', () => {
  const crash = (extra: Record<string, unknown> = {}) => ({
    level: 'fatal',
    platform: 'native',
    tags: { 'event.environment': 'native', 'event.process': 'browser', 'mem.rss': '1-2GB', 'mem.heap': '512MB-1GB', uptime: '1-4h', 'os.platform': 'win32', secret: 'x' },
    contexts: { electron: { details: { reason: 'unknown' } } },
    ...extra
  })

  it('例外の種類・モジュール・メモリと起動からの時間の区分をタグに、まとめ方にも種類を入れる', () => {
    const out = minimizeNativeCrash(crash(), { code: '0xc0000005', kind: 'access-violation', module: 'pty.node' }) as unknown as { message: string; fingerprint: string[]; tags: Record<string, string> }
    expect(out.tags).toMatchObject({ 'crash.code': '0xc0000005', 'crash.kind': 'access-violation', 'crash.module': 'pty.node', 'mem.rss': '1-2GB', 'mem.heap': '512MB-1GB', uptime: '1-4h' })
    expect(out.tags.secret).toBeUndefined()
    expect(out.message).toBe('Native crash (browser, unknown): access-violation in pty.node')
    expect(out.fingerprint).toEqual(['native-crash', 'browser', 'unknown', 'access-violation', 'pty.node'])
  })

  it('Electron の V8 のメモリ不足の注釈は oom にする（注釈の中身は送らない）', () => {
    const e = crash({ contexts: { electron: { details: { reason: 'oom' }, 'crashpad.electron.v8-oom.stack': '#0 /Users/someone/x.js' } } })
    const out = scrubEvent(minimizeNativeCrash(e)) as { tags: Record<string, string> }
    expect(out.tags['crash.kind']).toBe('oom')
    expect(JSON.stringify(out)).not.toContain('someone')
  })

  it('区分の形でないメモリの値は落とす', () => {
    const e = crash()
    e.tags['mem.rss'] = '/Users/someone'
    const out = minimizeNativeCrash(e) as { tags: Record<string, string> }
    expect(out.tags['mem.rss']).toBeUndefined()
  })

  it('区分の関数が返す値は全部そのまま通る', () => {
    const values = [...[10, 300, 700, 1500, 3000].map(memoryBucket), ...[10, 100, 1000, 7200, 20000, 100000].map(uptimeBucket)]
    for (const v of values) {
      const e = crash()
      e.tags['mem.rss'] = v
      e.tags.uptime = v
      const out = minimizeNativeCrash(e) as { tags: Record<string, string> }
      expect(out.tags['mem.rss']).toBe(v)
    }
  })
})

describe('外から止められた子のプロセスは送らない（FERRET-1V）', () => {
  const event = (proc: string, reason: string, exitCode?: number) => ({
    level: 'fatal',
    platform: 'native',
    tags: { 'event.environment': 'native', 'event.process': proc, 'exit.reason': reason, 'os.platform': 'darwin' },
    contexts: { electron: { details: { reason, ...(exitCode !== undefined ? { exitCode } : {}) } } }
  })

  it('Utility が SIGTERM で止められた（killed・exitCode 15）ものは送らない', () => {
    const out = minimizeNativeCrash(event('Utility', 'killed', 15), { code: '0x0', module: 'dyld' })
    expect(shouldSendNativeCrash(out)).toBe(false)
    expect(shouldSendNativeCrash(minimizeNativeCrash(event('GPU', 'clean-exit', 0)))).toBe(false)
  })

  it('落ちたもの・main のクラッシュは送る（main は理由が分からなくても送る）', () => {
    expect(shouldSendNativeCrash(minimizeNativeCrash(event('Utility', 'crashed', 11)))).toBe(true)
    expect(shouldSendNativeCrash(minimizeNativeCrash(event('renderer', 'oom')))).toBe(true)
    expect(shouldSendNativeCrash(minimizeNativeCrash(event('browser', 'killed')))).toBe(true)
    const main = minimizeNativeCrash({ level: 'fatal', platform: 'native', tags: { 'event.process': 'browser' }, contexts: { electron: { details: { reason: 'unknown' } } } }, { code: '0xc0000005', kind: 'access-violation', module: 'ferret.exe' })
    expect(shouldSendNativeCrash(scrubEvent(main))).toBe(true)
  })
})

describe('dyld で読み込みの途中に止められた子のプロセスは、プロセスが分からなくても送らない（FERRET-1W）', () => {
  const unknown = (dump: { code: string; module?: string; kind?: string }) => scrubEvent(minimizeNativeCrash({ level: 'fatal', platform: 'native', tags: { 'os.platform': 'darwin' }, contexts: { electron: { details: { reason: 'unknown' } } } }, dump))

  it('例外なし（0x0）で dyld の中なら送らない', () => {
    expect(shouldSendNativeCrash(unknown({ code: '0x0', module: 'dyld' }))).toBe(false)
  })

  it('dyld でも例外のあるもの・ほかのモジュール・main は送る', () => {
    expect(shouldSendNativeCrash(unknown({ code: '0x6', kind: 'abort', module: 'dyld' }))).toBe(true)
    expect(shouldSendNativeCrash(unknown({ code: '0x0', module: 'Electron Framework' }))).toBe(true)
    const main = minimizeNativeCrash({ level: 'fatal', platform: 'native', tags: { 'event.process': 'browser' }, contexts: { electron: { details: { reason: 'unknown' } } } }, { code: '0x0', module: 'dyld' })
    expect(shouldSendNativeCrash(scrubEvent(main))).toBe(true)
  })
})

describe('Ferret の外のプログラムの報告は送らない（FERRET-1X）', () => {
  // macOS では crashpad の受け口がターミナルから起動したプログラムにも引き継がれる
  const mac = 0x8101
  const external = (exe: string, module = exe) => minidump({
    code: 10, address: 0x2000n, platformId: mac,
    modules: [{ base: 0x1000n, size: 0x100, name: `/Users/me/Library/Caches/ms-playwright/${exe}` }, { base: 0x2000n, size: 0x100, name: `/usr/lib/${module}` }]
  })
  const unknown = (data: Uint8Array) => scrubEvent(minimizeNativeCrash({ level: 'fatal', platform: 'native', tags: { 'os.platform': 'darwin' }, contexts: { electron: { details: { reason: 'unknown' } } } }, parseMinidumpCrash(data)))

  it('モジュールの一覧の先頭を実行ファイルとして読む（パスは持たない・小文字）', () => {
    const out = parseMinidumpCrash(external('headless_shell', 'libsystem_kernel.dylib'))
    expect(out?.executable).toBe('headless_shell')
    expect(JSON.stringify(out)).not.toContain('/Users/me')
    expect(parseMinidumpCrash(external('Ferret'))?.executable).toBe('ferret')
  })

  it('実行ファイルが Ferret でなければ、プロセスが分からなくても送らない', () => {
    const event = unknown(external('headless_shell'))
    expect(event.tags).toMatchObject({ 'crash.exe': 'headless_shell' })
    expect(shouldSendNativeCrash(event)).toBe(false)
    expect(shouldSendNativeCrash(unknown(external('node')))).toBe(false)
    expect(shouldSendNativeCrash(unknown(external('python3.12')))).toBe(false)
  })

  it('Ferret（配布版・dev）の実行ファイルは送る', () => {
    for (const exe of ['Ferret', 'ferret', 'ferret.exe', 'Electron', 'electron.exe']) {
      expect(shouldSendNativeCrash(unknown(external(exe))), exe).toBe(true)
    }
  })

  it('helper（名前に空白）や実行ファイルの分からない報告は、これまでどおり送る', () => {
    const helper = minidump({ code: 1, address: 0x2000n, platformId: mac, modules: [{ base: 0x1000n, size: 0x100, name: '/Applications/Ferret.app/Contents/Frameworks/Ferret Helper (Renderer).app/Contents/MacOS/Ferret Helper (Renderer)' }, { base: 0x2000n, size: 0x100, name: 'Electron Framework' }] })
    expect(parseMinidumpCrash(helper)?.executable).toBeUndefined()
    expect(shouldSendNativeCrash(unknown(helper))).toBe(true)
    expect(shouldSendNativeCrash(unknown(minidump({ code: 1, address: 0x2000n, platformId: mac })))).toBe(true)
  })

  it('main（browser）は実行ファイルの名前に関係なく送る', () => {
    const main = minimizeNativeCrash({ level: 'fatal', platform: 'native', tags: { 'event.process': 'browser' }, contexts: { electron: { details: { reason: 'unknown' } } } }, parseMinidumpCrash(external('headless_shell')))
    expect(shouldSendNativeCrash(scrubEvent(main))).toBe(true)
  })

  it('isOwnExecutable は前後の違う名前を Ferret と見なさない', () => {
    expect(isOwnExecutable('ferret')).toBe(true)
    expect(isOwnExecutable('FERRET.EXE')).toBe(true)
    expect(isOwnExecutable('ferret-cli')).toBe(false)
    // 開発版（electron-builder.dev.cjs の executableName）も Ferret 自身
    expect(isOwnExecutable('Ferret-Dev.exe')).toBe(true)
    expect(isOwnExecutable('ferret-dev')).toBe(true)
    expect(isOwnExecutable('ferret-dev-cli')).toBe(false)
    expect(isOwnExecutable('electron-dev')).toBe(false)
    expect(isOwnExecutable('my-electron')).toBe(false)
    expect(isOwnExecutable('')).toBe(false)
  })
})
