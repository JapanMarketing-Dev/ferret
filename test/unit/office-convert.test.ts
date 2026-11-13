import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { deflateRawSync } from 'node:zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ConvertFailedError, OOXML_TARGETS, OfficeConverter, SofficeMissingError, findSoffice, sofficeArgs, sofficeCandidates, targetExtension, type RunProcess } from '../../src/main/officeConvert'
import { guessInputExtension, ooxmlKindOf, openOfficeDocument, replaceContained, writeOfficeDocument } from '../../src/main/officeFiles'
import { screenQuitSaveEntries } from '@shared/quitUnsaved'
import { openZip } from '@shared/office/zip'

/** 小さな OOXML（種類の判定に使う部品だけ） */
function makeZip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content)
    const stored = deflateRawSync(data)
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(stored.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    chunks.push(local, nameBytes, stored)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt32LE(stored.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + stored.length
  }
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...chunks, cd, end])
}

const XLSX = makeZip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook/>' })
const XLSX2 = makeZip({ '[Content_Types].xml': '<Types/>', 'xl/workbook.xml': '<workbook><sheets/></workbook>' })
const DOCX = makeZip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': '<document/>' })
const PPTX = makeZip({ '[Content_Types].xml': '<Types/>', 'ppt/presentation.xml': '<presentation/>' })
const OLE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 1, 2, 3, 4])

/** soffice の代わり。--outdir に document.<拡張子> を書く。書く中身は produce で決める */
function fakeRun(produce: (target: string, input: Buffer) => Buffer | null, log: { target: string; input: string; args: string[] }[] = []): RunProcess {
  return async (_command, args) => {
    const target = args[args.indexOf('--convert-to') + 1]!
    const outDir = args[args.indexOf('--outdir') + 1]!
    const input = args[args.length - 1]!
    log.push({ target, input, args })
    const output = produce(target, await readFile(input))
    if (output) await writeFile(join(outDir, `document.${targetExtension(target)}`), output)
    return { code: output ? 0 : 1, timedOut: false, stderr: output ? '' : 'Error: source file could not be loaded' }
  }
}

describe('soffice の置き場所', () => {
  it('lists the usual places per platform', () => {
    expect(sofficeCandidates('darwin', {}, '/Users/taro')).toEqual([
      '/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/Users/taro/Applications/LibreOffice.app/Contents/MacOS/soffice',
      '/opt/homebrew/bin/soffice',
      '/usr/local/bin/soffice'
    ])
    expect(sofficeCandidates('win32', { ProgramFiles: 'D:\\Apps\\' }, '')[0]).toBe('D:\\Apps\\LibreOffice\\program\\soffice.exe')
    expect(sofficeCandidates('win32', {}, '')).toContain('C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe')
    expect(sofficeCandidates('linux', {}, '')).toContain('/usr/bin/soffice')
  })

  it('returns the first executable candidate, or null', async () => {
    const seen: string[] = []
    const found = await findSoffice({ platform: 'darwin', env: {}, home: '/h', searchPath: false, isExecutable: async (p) => { seen.push(p); return p === '/opt/homebrew/bin/soffice' } })
    expect(found).toBe('/opt/homebrew/bin/soffice')
    expect(seen[0]).toBe('/Applications/LibreOffice.app/Contents/MacOS/soffice')
    expect(await findSoffice({ platform: 'linux', env: {}, home: '/h', searchPath: false, isExecutable: async () => false })).toBeNull()
  })

  it('searches PATH but never inside the project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ferret-soffice-'))
    try {
      await mkdir(join(root, 'bin'))
      await writeFile(join(root, 'bin', 'soffice'), '#!/bin/sh\n', { mode: 0o755 })
      const found = await findSoffice({ platform: 'linux', env: { PATH: join(root, 'bin') }, home: '/nonexistent', root, isExecutable: async () => false })
      expect(found).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('soffice の引数', () => {
  it('uses a private profile, headless mode and puts the input last', () => {
    const args = sofficeArgs('/tmp/work/profile', 'xlsx:Calc MS Excel 2007 XML', '/tmp/work/job/out', '/tmp/work/job/document.xls')
    expect(args[0]).toBe(`-env:UserInstallation=${pathToFileURL('/tmp/work/profile').href}`)
    expect(args).toContain('--headless')
    expect(args).toContain('--norestore')
    expect(args.slice(args.indexOf('--convert-to'), args.indexOf('--convert-to') + 2)).toEqual(['--convert-to', 'xlsx:Calc MS Excel 2007 XML'])
    expect(args[args.length - 1]).toBe('/tmp/work/job/document.xls')
  })

  it('escapes spaces in the profile URL', () => {
    expect(sofficeArgs('/tmp/my work/p', 'docx', '/o', '/i')[0]).toBe(`-env:UserInstallation=${pathToFileURL('/tmp/my work/p').href}`)
    expect(sofficeArgs('/tmp/my work/p', 'docx', '/o', '/i')[0]).toContain('my%20work')
  })

  it('reads the extension of a target', () => {
    expect(targetExtension('xls:MS Excel 97')).toBe('xls')
    expect(targetExtension('DOCX')).toBe('docx')
    expect(() => targetExtension('../x')).toThrow(ConvertFailedError)
    expect(() => targetExtension('')).toThrow(ConvertFailedError)
  })

  it('names the OOXML targets explicitly', () => {
    expect(OOXML_TARGETS.xlsx.startsWith('xlsx:')).toBe(true)
    expect(OOXML_TARGETS.docx.startsWith('docx:')).toBe(true)
    expect(OOXML_TARGETS.pptx.startsWith('pptx:')).toBe(true)
  })
})

describe('OfficeConverter', () => {
  let work: string
  beforeEach(async () => { work = await mkdtemp(join(tmpdir(), 'ferret-convert-')) })
  afterEach(async () => { await rm(work, { recursive: true, force: true }) })

  it('converts through a copied input and cleans up the job folder', async () => {
    const log: { target: string; input: string; args: string[] }[] = []
    const converter = new OfficeConverter({ workDir: work, locate: async () => '/fake/soffice', run: fakeRun(() => XLSX, log) })
    const out = await converter.convert(new Uint8Array(OLE), '.XLS', 'xlsx')
    expect(Buffer.from(out).equals(XLSX)).toBe(true)
    expect(log[0]!.input.endsWith('document.xls')).toBe(true)
    expect(log[0]!.input.startsWith(work)).toBe(true)
    expect((await readdir(work)).filter((n) => n.startsWith('job-'))).toEqual([])
  })

  it('remembers results by key', async () => {
    const log: { target: string; input: string; args: string[] }[] = []
    const converter = new OfficeConverter({ workDir: work, locate: async () => '/fake/soffice', run: fakeRun(() => XLSX, log) })
    await converter.convert(new Uint8Array(OLE), '.xls', 'xlsx', 'a')
    const again = await converter.convert(new Uint8Array(OLE), '.xls', 'xlsx', 'a')
    expect(Buffer.from(again).equals(XLSX)).toBe(true)
    expect(log).toHaveLength(1)
    await converter.convert(new Uint8Array(OLE), '.xls', 'xlsx', 'b')
    await converter.convert(new Uint8Array(OLE), '.xls', 'xlsx')
    expect(log).toHaveLength(3)
  })

  it('forgets the oldest results beyond the limit', async () => {
    const log: { target: string; input: string; args: string[] }[] = []
    const converter = new OfficeConverter({ workDir: work, locate: async () => '/fake/soffice', run: fakeRun(() => XLSX, log) })
    for (let i = 0; i < 26; i += 1) await converter.convert(new Uint8Array(OLE), '.xls', 'xlsx', `k${i}`)
    expect((await readdir(join(work, 'cache'))).length).toBe(24)
    await converter.convert(new Uint8Array(OLE), '.xls', 'xlsx', 'k0')
    expect(log).toHaveLength(27)
    await converter.convert(new Uint8Array(OLE), '.xls', 'xlsx', 'k25')
    expect(log).toHaveLength(27)
  })

  it('runs one conversion at a time', async () => {
    let running = 0
    let most = 0
    const run: RunProcess = async (command, args, timeout) => {
      running += 1
      most = Math.max(most, running)
      await new Promise((r) => setTimeout(r, 5))
      running -= 1
      return fakeRun(() => XLSX)(command, args, timeout)
    }
    const converter = new OfficeConverter({ workDir: work, locate: async () => '/fake/soffice', run })
    await Promise.all([1, 2, 3].map(() => converter.convert(new Uint8Array(OLE), '.xls', 'xlsx')))
    expect(most).toBe(1)
  })

  it('keeps going after a failure', async () => {
    let calls = 0
    const converter = new OfficeConverter({ workDir: work, locate: async () => '/fake/soffice', run: fakeRun(() => (++calls === 1 ? null : XLSX)) })
    await expect(converter.convert(new Uint8Array(OLE), '.xls', 'xlsx')).rejects.toBeInstanceOf(ConvertFailedError)
    expect(Buffer.from(await converter.convert(new Uint8Array(OLE), '.xls', 'xlsx')).equals(XLSX)).toBe(true)
  })

  it('reports a missing soffice', async () => {
    const converter = new OfficeConverter({ workDir: work, locate: async () => null, run: fakeRun(() => XLSX) })
    await expect(converter.convert(new Uint8Array(OLE), '.xls', 'xlsx')).rejects.toBeInstanceOf(SofficeMissingError)
    expect(await converter.available()).toBe(false)
  })

  it('looks for soffice again after it was missing, and keeps a found path', async () => {
    let lookups = 0
    const converter = new OfficeConverter({ workDir: work, locate: async () => { lookups += 1; return '/fake/soffice' }, run: fakeRun(() => XLSX) })
    expect(await converter.available()).toBe(true)
    expect(await converter.available()).toBe(true)
    expect(lookups).toBe(1)
  })

  it('treats timeouts and empty output as failures', async () => {
    const timeout = new OfficeConverter({ workDir: work, locate: async () => '/s', run: async () => ({ code: null, timedOut: true, stderr: '' }) })
    await expect(timeout.convert(new Uint8Array(OLE), '.xls', 'xlsx')).rejects.toThrow(/timed out/)
    const empty = new OfficeConverter({ workDir: work, locate: async () => '/s', run: fakeRun(() => Buffer.alloc(0)) })
    await expect(empty.convert(new Uint8Array(OLE), '.xls', 'xlsx')).rejects.toBeInstanceOf(ConvertFailedError)
  })

  it('rejects odd input extensions and targets', async () => {
    const converter = new OfficeConverter({ workDir: work, locate: async () => '/s', run: fakeRun(() => XLSX) })
    await expect(converter.convert(new Uint8Array(OLE), 'xls', 'xlsx')).rejects.toBeInstanceOf(ConvertFailedError)
    await expect(converter.convert(new Uint8Array(OLE), '.x/y', 'xlsx')).rejects.toBeInstanceOf(ConvertFailedError)
    await expect(converter.convert(new Uint8Array(OLE), '.xls', '-x')).rejects.toBeInstanceOf(ConvertFailedError)
  })
})

describe('Office の文書を開く・書く（fs:openOffice・fs:writeOffice）', () => {
  let root: string
  let outside: string
  let work: string
  const log: { target: string; input: string; args: string[] }[] = []
  /** 変換の結果（古い形式 → OOXML、OOXML → 古い形式） */
  const produce = (target: string): Buffer | null => {
    const ext = targetExtension(target)
    if (ext === 'xlsx') return XLSX
    if (ext === 'docx') return DOCX
    if (ext === 'pptx') return PPTX
    return Buffer.concat([OLE, Buffer.from(ext)])
  }
  const converter = () => new OfficeConverter({ workDir: work, locate: async () => '/fake/soffice', run: fakeRun(produce, log) })

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'ferret-officefiles-'))
    outside = await mkdtemp(join(tmpdir(), 'ferret-officefiles-out-'))
    work = await mkdtemp(join(tmpdir(), 'ferret-officefiles-work-'))
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })
  beforeEach(() => { log.length = 0 })

  it('returns OOXML files as they are', async () => {
    await writeFile(join(root, 'book.xlsx'), XLSX)
    const result = await openOfficeDocument(root, 'book.xlsx', converter())
    expect(result).toMatchObject({ ok: true, kind: 'xlsx', source: 'native', saveBack: 'native' })
    expect(log).toHaveLength(0)
  })

  it('opens a legacy-named file that is really OOXML without converting', async () => {
    await writeFile(join(root, 'renamed.xls'), DOCX)
    const result = await openOfficeDocument(root, 'renamed.xls', converter())
    expect(result).toMatchObject({ ok: true, kind: 'docx', source: 'native', saveBack: 'native' })
    expect(log).toHaveLength(0)
  })

  it('converts legacy files and allows saving back when the format can be written', async () => {
    await writeFile(join(root, 'old.xls'), OLE)
    const result = await openOfficeDocument(root, 'old.xls', converter())
    expect(result).toMatchObject({ ok: true, kind: 'xlsx', source: 'converted', saveBack: 'convert' })
    expect(log[0]!.target).toBe(OOXML_TARGETS.xlsx)
    expect(log[0]!.input.endsWith('.xls')).toBe(true)
  })

  it('opens formats that cannot be written back as read-only', async () => {
    await writeFile(join(root, 'deck.key'), Buffer.from('PK\u0003\u0004 not ooxml'))
    const result = await openOfficeDocument(root, 'deck.key', converter())
    expect(result).toMatchObject({ ok: true, kind: 'pptx', source: 'converted', saveBack: 'none' })
  })

  it('converts an .xlsx that is not a zip, read-only', async () => {
    await writeFile(join(root, 'fake.xlsx'), OLE)
    const result = await openOfficeDocument(root, 'fake.xlsx', converter())
    expect(result).toMatchObject({ ok: true, kind: 'xlsx', source: 'converted', saveBack: 'none' })
    expect(log[0]!.input.endsWith('.xls')).toBe(true)
  })

  it('explains a missing LibreOffice and failed conversions', async () => {
    await writeFile(join(root, 'memo.doc'), OLE)
    const missing = new OfficeConverter({ workDir: work, locate: async () => null })
    expect(await openOfficeDocument(root, 'memo.doc', missing)).toMatchObject({ ok: false, reason: 'noConverter' })
    const broken = new OfficeConverter({ workDir: work, locate: async () => '/s', run: fakeRun(() => null) })
    expect(await openOfficeDocument(root, 'memo.doc', broken)).toMatchObject({ ok: false, reason: 'convertFailed' })
    // 変換の結果が違う種類（.docx のはずが .xlsx）
    const wrong = new OfficeConverter({ workDir: work, locate: async () => '/s', run: fakeRun(() => XLSX) })
    expect(await openOfficeDocument(root, 'memo.doc', wrong)).toMatchObject({ ok: false, reason: 'convertFailed' })
  })

  it('refuses other extensions, big files, outside paths and folders', async () => {
    await writeFile(join(root, 'notes.txt'), 'x')
    expect(await openOfficeDocument(root, 'notes.txt', converter())).toMatchObject({ ok: false, reason: 'unsupported' })
    await writeFile(join(root, 'huge.xls'), '')
    await truncate(join(root, 'huge.xls'), 50 * 1024 * 1024 + 1)
    expect(await openOfficeDocument(root, 'huge.xls', converter())).toMatchObject({ ok: false, reason: 'tooLarge' })
    await writeFile(join(outside, 'secret.xls'), OLE)
    await symlink(join(outside, 'secret.xls'), join(root, 'link.xls'))
    await expect(openOfficeDocument(root, 'link.xls', converter())).rejects.toThrow()
    await expect(openOfficeDocument(root, '../secret.xls', converter())).rejects.toThrow()
    await mkdir(join(root, 'dir.xls'))
    await expect(openOfficeDocument(root, 'dir.xls', converter())).rejects.toThrow()
    expect(log).toHaveLength(0)
  })

  it('writes edited OOXML in place, keeping the permissions and leaving no temp files', async () => {
    await mkdir(join(root, 'w'), { recursive: true })
    await writeFile(join(root, 'w', 'book.xlsx'), XLSX)
    await chmod(join(root, 'w', 'book.xlsx'), 0o640)
    const result = await writeOfficeDocument(root, 'w/book.xlsx', new Uint8Array(XLSX2), converter())
    expect(result.mtimeMs).toBeGreaterThan(0)
    expect((await readFile(join(root, 'w', 'book.xlsx'))).equals(XLSX2)).toBe(true)
    if (process.platform !== 'win32') expect((await stat(join(root, 'w', 'book.xlsx'))).mode & 0o777).toBe(0o640)
    expect(await readdir(join(root, 'w'))).toEqual(['book.xlsx'])
    expect(log).toHaveLength(0)
  })

  it('converts back to the legacy format before writing', async () => {
    await writeFile(join(root, 'back.xls'), OLE)
    await writeOfficeDocument(root, 'back.xls', new Uint8Array(XLSX2), converter())
    expect(log[0]!.target).toBe('xls:MS Excel 97')
    expect(log[0]!.input.endsWith('document.xlsx')).toBe(true)
    expect((await readFile(join(root, 'back.xls'))).equals(Buffer.concat([OLE, Buffer.from('xls')]))).toBe(true)
  })

  it('writes a legacy-named OOXML file directly', async () => {
    await writeFile(join(root, 'named.ppt'), PPTX)
    const next = makeZip({ 'ppt/presentation.xml': '<presentation><x/></presentation>' })
    await writeOfficeDocument(root, 'named.ppt', new Uint8Array(next), converter())
    expect((await readFile(join(root, 'named.ppt'))).equals(next)).toBe(true)
    expect(log).toHaveLength(0)
  })

  it('refuses bad content, mismatched kinds and read-only formats', async () => {
    await writeFile(join(root, 'k.xlsx'), XLSX)
    await expect(writeOfficeDocument(root, 'k.xlsx', new Uint8Array([1, 2, 3]), converter())).rejects.toThrow()
    await expect(writeOfficeDocument(root, 'k.xlsx', 'text', converter())).rejects.toThrow()
    await expect(writeOfficeDocument(root, 'k.xlsx', new Uint8Array(), converter())).rejects.toThrow()
    await expect(writeOfficeDocument(root, 'k.xlsx', new Uint8Array(DOCX), converter())).rejects.toThrow()
    expect((await readFile(join(root, 'k.xlsx'))).equals(XLSX)).toBe(true)
    await writeFile(join(root, 'r.key'), Buffer.from('PK\u0003\u0004 iwork'))
    await expect(writeOfficeDocument(root, 'r.key', new Uint8Array(PPTX), converter())).rejects.toThrow()
    await writeFile(join(root, 'mismatch.doc'), OLE)
    await expect(writeOfficeDocument(root, 'mismatch.doc', new Uint8Array(XLSX), converter())).rejects.toThrow()
    await writeFile(join(root, 'notzip.xlsx'), OLE)
    await expect(writeOfficeDocument(root, 'notzip.xlsx', new Uint8Array(XLSX), converter())).rejects.toThrow()
    await expect(writeOfficeDocument(root, 'n.txt', new Uint8Array(XLSX), converter())).rejects.toThrow()
    expect(log).toHaveLength(0)
  })

  it('does not write through links that leave the project', async () => {
    await writeFile(join(outside, 'target.xlsx'), XLSX)
    await symlink(join(outside, 'target.xlsx'), join(root, 'out.xlsx'))
    await expect(writeOfficeDocument(root, 'out.xlsx', new Uint8Array(XLSX2), converter())).rejects.toThrow()
    expect((await readFile(join(outside, 'target.xlsx'))).equals(XLSX)).toBe(true)
  })

  it('replaces the target of a link inside the project and keeps the link', async () => {
    await writeFile(join(root, 'real.xlsx'), XLSX)
    await symlink('real.xlsx', join(root, 'alias.xlsx'))
    await writeOfficeDocument(root, 'alias.xlsx', new Uint8Array(XLSX2), converter())
    expect((await lstat(join(root, 'alias.xlsx'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(root, 'alias.xlsx'))).toBe('real.xlsx')
    expect((await readFile(join(root, 'real.xlsx'))).equals(XLSX2)).toBe(true)
  })

  it('reports a missing LibreOffice and failed conversions when saving back', async () => {
    await writeFile(join(root, 'save.doc'), OLE)
    await expect(writeOfficeDocument(root, 'save.doc', new Uint8Array(DOCX), new OfficeConverter({ workDir: work, locate: async () => null }))).rejects.toThrow()
    await expect(writeOfficeDocument(root, 'save.doc', new Uint8Array(DOCX), new OfficeConverter({ workDir: work, locate: async () => '/s', run: fakeRun(() => null) }))).rejects.toThrow()
    expect((await readFile(join(root, 'save.doc'))).equals(OLE)).toBe(true)
  })

  it('replaceContained refuses files that are not regular', async () => {
    await mkdir(join(root, 'adir'), { recursive: true })
    await expect(replaceContained(root, join(root, 'adir'), new Uint8Array([1]))).rejects.toThrow()
  })
})

describe('中身の見分け', () => {
  it('finds OOXML kinds and rejects other zips', () => {
    expect(ooxmlKindOf(new Uint8Array(XLSX))).toBe('xlsx')
    expect(ooxmlKindOf(new Uint8Array(DOCX))).toBe('docx')
    expect(ooxmlKindOf(new Uint8Array(PPTX))).toBe('pptx')
    expect(ooxmlKindOf(new Uint8Array(makeZip({ 'content.xml': '<x/>' })))).toBeNull()
    expect(ooxmlKindOf(new Uint8Array(OLE))).toBeNull()
    expect(ooxmlKindOf(new Uint8Array(Buffer.from('PK\u0003\u0004broken')))).toBeNull()
    expect(openZip(new Uint8Array(XLSX)).has('xl/workbook.xml')).toBe(true)
  })

  it('guesses what an .xlsx-named non-zip file really is', () => {
    expect(guessInputExtension(new TextEncoder().encode('{\\rtf1 hi'), 'docx')).toBe('.rtf')
    expect(guessInputExtension(new TextEncoder().encode('  <html><table>'), 'xlsx')).toBe('.xml')
    expect(guessInputExtension(new TextEncoder().encode('<html>'), 'docx')).toBe('.html')
    expect(guessInputExtension(new Uint8Array(OLE), 'docx')).toBe('.doc')
    expect(guessInputExtension(new Uint8Array(OLE), 'xlsx')).toBe('.xls')
    expect(guessInputExtension(new Uint8Array(OLE), 'pptx')).toBe('.ppt')
  })
})

describe('「保存して終了」の Office の文書', () => {
  const limits = { maxBytes: 100, maxTotalBytes: 100, byteLength: (s: string) => s.length }
  const expected = [{ root: '/p', path: 'book.xlsx' }, { root: '/p', path: 'a.md' }]

  it('counts files the renderer saved itself', () => {
    const screened = screenQuitSaveEntries([{ root: '/p', path: 'book.xlsx', saved: true }, { root: '/p', path: 'a.md', content: 'x' }], expected, limits)
    expect(screened.saved).toEqual([{ root: '/p', path: 'book.xlsx' }])
    expect(screened.accepted).toEqual([{ root: '/p', path: 'a.md', content: 'x' }])
    expect(screened.missing).toEqual([])
  })

  it('ignores saved marks for files that were not asked about, duplicates and odd values', () => {
    const screened = screenQuitSaveEntries([
      { root: '/p', path: 'other.xlsx', saved: true },
      { root: '/p', path: 'book.xlsx', saved: 'yes' },
      { root: '/p', path: 'book.xlsx', saved: true, content: 'both' },
      { root: '/p', path: 'a.md', saved: true },
      { root: '/p', path: 'a.md', saved: true }
    ], expected, limits)
    expect(screened.saved).toEqual([{ root: '/p', path: 'a.md' }])
    expect(screened.accepted).toEqual([{ root: '/p', path: 'book.xlsx', content: 'both' }])
    expect(screened.missing).toEqual([])
  })
})
