/**
 * minidump から「なぜ落ちたか」の手がかりだけを読む（例外の種類と、落ちた場所のモジュールの名前）。
 * minidump 本体（メモリの写し）は送らない（security-2 [13]）。ここで読んだ短い値だけをタグにする。
 *
 * 形式: https://learn.microsoft.com/en-us/windows/win32/api/minidumpapiset/
 * Crashpad は macOS・Linux でも同じ形で書く（例外の番号は OS ごとに意味が違うので SystemInfo で見分ける）
 */

export interface MinidumpCrash {
  /** 例外の番号（16進。例 0xc0000005） */
  code: string
  /** 例外の名前（分かるものだけ。例 access-violation・oom） */
  kind?: string
  /** 落ちた場所のモジュールのファイル名（パスは持たない。例 node.dll・pty.node） */
  module?: string
  /** 落ちた場所の、モジュールの先頭からの位置（16進。例 0x1a2b3c）。版ごとの symbols で関数に戻せる */
  offset?: string
  /** 落ちたモジュールの symbols を引くための ID（Windows の PDB の GUID＋age。breakpad の debug id の形） */
  debugId?: string
  /** 落ちたモジュールの code id（Windows の TimeDateStamp＋SizeOfImage） */
  codeId?: string
  /**
   * 落ちたプロセスの実行ファイルの名前（モジュールの一覧の先頭。小文字・パスなし。例 ferret・ferret.exe・headless_shell）。
   * Ferret の外のプログラムの報告を見分ける（macOS ではターミナルから起動したプログラムにも Ferret の crashpad が付く。FERRET-1X）
   */
  executable?: string
  /** 落ちたスレッドの名前（Chromium・Node が付けたもの。例 CrBrowserMain） */
  thread?: string
  /**
   * 落ちたスレッドのスタックの中で、読み込んだモジュールの中を指していた値（上から最大 STACK_LIMIT 件、`name+0xoffset`）。
   * 戻り先の候補で、symbols があれば呼ばれ方の手がかりになる。メモリの中身（文字列・データ）は持たない
   */
  stack?: string[]
}

const STREAM_THREAD_LIST = 3
const STREAM_MODULE_LIST = 4
const STREAM_EXCEPTION = 6
const STREAM_SYSTEM_INFO = 7
const STREAM_THREAD_NAMES = 24
const MODULE_SIZE = 108
const THREAD_SIZE = 48
const MAX_THREADS = 4096
/** スタックの中から拾うモジュールの位置の数 */
export const STACK_LIMIT = 20
/** スタックの中を読む量の上限（落ちたスレッドの先頭から） */
const STACK_SCAN_BYTES = 256 * 1024
const MAX_STREAMS = 256
const MAX_MODULES = 2000
const MAX_NAME_BYTES = 2048

/** Windows の例外の番号（NTSTATUS と Chromium の決まり） */
const WINDOWS_KINDS: Record<number, string> = {
  0xc0000005: 'access-violation',
  0xc00000fd: 'stack-overflow',
  0xc0000409: 'fast-fail',
  0xc0000374: 'heap-corruption',
  0xc0000017: 'no-memory',
  0xc000001d: 'illegal-instruction',
  0xc0000094: 'divide-by-zero',
  0x80000003: 'breakpoint',
  // Chromium の base::TerminateBecauseOutOfMemory（V8 のヒープの上限・確保の失敗）
  0xe0000008: 'oom',
  0xe06d7363: 'cpp-exception',
  // ウインドウのコールバックの中で起きた例外（STATUS_FATAL_USER_CALLBACK_EXCEPTION）
  0xc000041d: 'fatal-user-callback'
}

/** macOS の mach の例外の種類 */
const MAC_KINDS: Record<number, string> = { 1: 'bad-access', 2: 'bad-instruction', 3: 'arithmetic', 5: 'software', 6: 'breakpoint', 10: 'crash', 11: 'resource', 12: 'guard' }
/** Linux のシグナル */
const LINUX_KINDS: Record<number, string> = { 4: 'sigill', 5: 'sigtrap', 6: 'sigabrt', 7: 'sigbus', 8: 'sigfpe', 9: 'sigkill', 11: 'sigsegv' }

const MODULE_NAME = /^[A-Za-z0-9_.+-]{1,40}$/
const THREAD_NAME = /^[A-Za-z0-9 _.:#/-]{1,40}$/

/** 読めない・形が違うものは null（送るものを増やさない） */
export function parseMinidumpCrash(input: Uint8Array): MinidumpCrash | null {
  try {
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
    const len = input.byteLength
    const u32 = (at: number): number => {
      if (at < 0 || at + 4 > len) throw new RangeError('out of range')
      return view.getUint32(at, true)
    }
    const u64 = (at: number): bigint => {
      if (at < 0 || at + 8 > len) throw new RangeError('out of range')
      return view.getBigUint64(at, true)
    }
    if (len < 32 || u32(0) !== 0x504d444d) return null // 'MDMP'
    const streams = Math.min(u32(8), MAX_STREAMS)
    const dir = u32(12)
    let exceptionAt = -1
    let modulesAt = -1
    let threadsAt = -1
    let namesAt = -1
    let platformId = -1
    for (let i = 0; i < streams; i += 1) {
      const at = dir + i * 12
      const type = u32(at)
      const rva = u32(at + 8)
      if (type === STREAM_EXCEPTION) exceptionAt = rva
      else if (type === STREAM_MODULE_LIST) modulesAt = rva
      else if (type === STREAM_THREAD_LIST) threadsAt = rva
      else if (type === STREAM_THREAD_NAMES) namesAt = rva
      else if (type === STREAM_SYSTEM_INFO) platformId = u32(rva + 24)
    }
    if (exceptionAt < 0) return null
    // MINIDUMP_EXCEPTION_STREAM: ThreadId, align, MINIDUMP_EXCEPTION { Code, Flags, Record(u64), Address(u64), ... }
    const threadId = u32(exceptionAt)
    const rawCode = u32(exceptionAt + 8)
    const address = u64(exceptionAt + 24)
    const code = `0x${rawCode.toString(16).padStart(platformId === 2 || platformId < 0 ? 8 : 1, '0')}`
    const table = platformId === 0x8101 ? MAC_KINDS : platformId === 0x8201 ? LINUX_KINDS : WINDOWS_KINDS
    const kind = table[rawCode]
    const out: MinidumpCrash = { code, ...(kind ? { kind } : {}) }
    const modules = modulesAt >= 0 ? readModules(input, u32, u64, modulesAt) : []
    if (modules[0]?.name) out.executable = modules[0].name
    const hit = moduleAt(modules, address)
    // 名前の分からないモジュールの位置は、symbols を引けないので送らない
    if (hit?.module.name) {
      out.module = hit.module.name
      out.offset = `0x${hit.offset.toString(16)}`
      const ids = readModuleIds(input, u32, hit.module)
      if (ids.debugId) out.debugId = ids.debugId
      if (ids.codeId) out.codeId = ids.codeId
    }
    if (namesAt >= 0) {
      const name = readThreadName(input, u32, u64, namesAt, threadId)
      if (name) out.thread = name
    }
    if (threadsAt >= 0 && modules.length > 0) {
      const stack = scanStack(input, u32, u64, threadsAt, threadId, modules)
      if (stack.length > 0) out.stack = stack
    }
    return out
  } catch {
    // 壊れた・途中までの minidump（想定内）
    return null
  }
}

interface DumpModule {
  base: bigint
  size: bigint
  /** ファイル名（パスなし・小文字。形が違えば undefined） */
  name: string | undefined
  /** MINIDUMP_MODULE の位置（TimeDateStamp・CvRecord を読む） */
  at: number
}

type U32 = (at: number) => number
type U64 = (at: number) => bigint

function readModules(input: Uint8Array, u32: U32, u64: U64, modulesAt: number): DumpModule[] {
  const count = Math.min(u32(modulesAt), MAX_MODULES)
  const out: DumpModule[] = []
  for (let i = 0; i < count; i += 1) {
    const at = modulesAt + 4 + i * MODULE_SIZE
    out.push({ base: u64(at), size: BigInt(u32(at + 8)), name: readModuleName(input, u32, u32(at + 20)), at })
  }
  return out
}

function moduleAt(modules: readonly DumpModule[], address: bigint): { module: DumpModule; offset: bigint } | null {
  for (const module of modules) {
    if (address >= module.base && address < module.base + module.size) return { module, offset: address - module.base }
  }
  return null
}

const hex = (n: number, width: number): string => n.toString(16).toUpperCase().padStart(width, '0')

/**
 * symbols を引く ID。debug id は CodeView の RSDS（PDB の GUID と age）から breakpad の形（GUID の16進＋age）に、
 * code id は TimeDateStamp と SizeOfImage から作る。PDB のパス（ビルドした機械のパス）は読まない
 */
function readModuleIds(input: Uint8Array, u32: U32, module: DumpModule): { debugId?: string; codeId?: string } {
  const out: { debugId?: string; codeId?: string } = {}
  const stamp = u32(module.at + 16)
  const size = u32(module.at + 8)
  if (stamp) out.codeId = `${hex(stamp, 8)}${size.toString(16).toUpperCase()}`
  // MINIDUMP_MODULE の CvRecord（MINIDUMP_LOCATION_DESCRIPTOR）は先頭から 76 バイト目
  const cvSize = u32(module.at + 76)
  const cvRva = u32(module.at + 80)
  if (cvSize >= 24 && cvRva + 24 <= input.byteLength && u32(cvRva) === 0x53445352) { // 'RSDS'
    const view = new DataView(input.buffer, input.byteOffset + cvRva + 4, 20)
    const guid = hex(view.getUint32(0, true), 8) + hex(view.getUint16(4, true), 4) + hex(view.getUint16(6, true), 4)
      + Array.from({ length: 8 }, (_, i) => hex(view.getUint8(8 + i), 2)).join('')
    out.debugId = `${guid}${view.getUint32(16, true).toString(16).toUpperCase()}`
  }
  return out
}

/** MINIDUMP_THREAD_NAME_LIST から、落ちたスレッドの名前（形が決まりに合うものだけ） */
function readThreadName(input: Uint8Array, u32: U32, u64: U64, namesAt: number, threadId: number): string | undefined {
  const count = Math.min(u32(namesAt), MAX_THREADS)
  for (let i = 0; i < count; i += 1) {
    const at = namesAt + 4 + i * 12
    if (u32(at) !== threadId) continue
    const rva = Number(u64(at + 4))
    const bytes = u32(rva)
    if (bytes === 0 || bytes > 160 || bytes % 2 !== 0 || rva + 4 + bytes > input.byteLength) return undefined
    const name = new TextDecoder('utf-16le').decode(input.subarray(rva + 4, rva + 4 + bytes))
    return THREAD_NAME.test(name) ? name : undefined
  }
  return undefined
}

/**
 * 落ちたスレッドのスタック（MINIDUMP_THREAD の Stack）を8バイトずつ読み、読み込んだモジュールの中を指す値を
 * `name+0xoffset` にして上から STACK_LIMIT 件まで返す。名前の分からないモジュールは数えない。値そのもの（アドレス）は返さない
 */
function scanStack(input: Uint8Array, u32: U32, u64: U64, threadsAt: number, threadId: number, modules: readonly DumpModule[]): string[] {
  const count = Math.min(u32(threadsAt), MAX_THREADS)
  for (let i = 0; i < count; i += 1) {
    const at = threadsAt + 4 + i * THREAD_SIZE
    if (u32(at) !== threadId) continue
    // MINIDUMP_THREAD: ThreadId, SuspendCount, PriorityClass, Priority, Teb(u64), Stack { Start(u64), DataSize, Rva }, Context
    const dataSize = Math.min(u32(at + 32), STACK_SCAN_BYTES)
    const rva = u32(at + 36)
    const end = Math.min(rva + dataSize, input.byteLength)
    const out: string[] = []
    for (let p = rva; p + 8 <= end && out.length < STACK_LIMIT; p += 8) {
      const hit = moduleAt(modules, u64(p))
      if (hit?.module.name) out.push(`${hit.module.name}+0x${hit.offset.toString(16)}`)
    }
    return out
  }
  return []
}

/** MINIDUMP_STRING（バイト数＋UTF-16LE）からファイル名だけを取る */
function readModuleName(input: Uint8Array, u32: U32, rva: number): string | undefined {
  const bytes = u32(rva)
  if (bytes === 0 || bytes > MAX_NAME_BYTES || bytes % 2 !== 0 || rva + 4 + bytes > input.byteLength) return undefined
  const full = new TextDecoder('utf-16le').decode(input.subarray(rva + 4, rva + 4 + bytes))
  const name = full.split(/[\\/]/).pop() ?? ''
  return MODULE_NAME.test(name) ? name.toLowerCase() : undefined
}
