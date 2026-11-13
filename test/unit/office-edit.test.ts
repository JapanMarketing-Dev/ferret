import { deflateRawSync, inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { openZip, readZipDirectory } from '@shared/office/zip'
import { crc32, overlayZip, rewriteZip } from '@shared/office/zipWrite'
import { applyParagraphEdits, distributeText, escapeXmlText, readParagraphs } from '@shared/office/textEdit'
import { readTextParts, textChanges } from '@shared/office/textParts'
import { applyCellEdits, encodeCellInput, readSheetGrid, workbookAfterFormulaEdit, xlsxChanges, cellRef, cellKey } from '@shared/office/xlsxEdit'
import { convertibleOfficeOf, isLegacyOffice, officeKindOf, ooxmlKindFromNames, sniffContainer, extensionOf } from '@shared/office/kinds'
import { readWorkbook } from '@shared/office/xlsx'
import { hasEdits, textFormatRefs, updateEdit } from '@shared/office/editState'

/** テスト用の ZIP（偶数番目は無圧縮、奇数番目は deflate） */
function makeZip(files: Record<string, string | Uint8Array>, options: { dataDescriptor?: boolean } = {}): Uint8Array {
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  Object.entries(files).forEach(([name, content], index) => {
    const data = Buffer.from(content)
    const method = index % 2 === 1 ? 8 : 0
    const stored = method === 8 ? deflateRawSync(data) : data
    const nameBytes = Buffer.from(name)
    const crc = crc32(new Uint8Array(data))
    const flags = options.dataDescriptor ? 0x0008 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    if (!options.dataDescriptor) {
      local.writeUInt32LE(crc, 14)
      local.writeUInt32LE(stored.length, 18)
      local.writeUInt32LE(data.length, 22)
    }
    local.writeUInt16LE(nameBytes.length, 26)
    const descriptor = options.dataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0)
    if (options.dataDescriptor) {
      descriptor.writeUInt32LE(0x08074b50, 0)
      descriptor.writeUInt32LE(crc, 4)
      descriptor.writeUInt32LE(stored.length, 8)
      descriptor.writeUInt32LE(data.length, 12)
    }
    chunks.push(local, nameBytes, stored, descriptor)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(flags, 8)
    entry.writeUInt16LE(method, 10)
    entry.writeUInt16LE(0x6000, 12)
    entry.writeUInt16LE(0x5a21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(stored.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBytes)
    offset += local.length + nameBytes.length + stored.length + descriptor.length
  })
  const cd = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(Object.keys(files).length, 8)
  end.writeUInt16LE(Object.keys(files).length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return new Uint8Array(Buffer.concat([...chunks, cd, end]))
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
const docxBody = (inner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W_NS}><w:body>${inner}<w:sectPr/></w:body></w:document>`
const slide = (inner: string) => `<?xml version="1.0"?><p:sld ${A_NS}><p:cSld><p:spTree>${inner}</p:spTree></p:cSld></p:sld>`
const shape = (paragraphs: string) => `<p:sp><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`

describe('crc32', () => {
  it('matches known values', () => {
    expect(crc32(new Uint8Array())).toBe(0)
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
    expect(crc32(new TextEncoder().encode('a'))).toBe(0xe8b7be43)
  })
})

describe('rewriteZip', () => {
  it('replaces one part and copies the others byte for byte', async () => {
    const original = makeZip({ 'a.xml': '<a/>', 'img/b.bin': new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]), 'c.txt': 'keep' })
    const next = await rewriteZip(original, new Map([['a.xml', '<a>changed</a>']]))
    const zip = openZip(next)
    expect(zip.names()).toEqual(['a.xml', 'img/b.bin', 'c.txt'])
    expect(await zip.text('a.xml')).toBe('<a>changed</a>')
    expect([...(await zip.bytes('img/b.bin'))!]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(await zip.text('c.txt')).toBe('keep')
    // 触っていない部品の日時・CRC は元のまま
    const before = readZipDirectory(original)
    const after = readZipDirectory(next)
    expect(after[1]!.crc32).toBe(before[1]!.crc32)
    expect(after[1]!.modDate).toBe(before[1]!.modDate)
    expect(after[1]!.method).toBe(8)
    expect(after[0]!.crc32).toBe(crc32(new TextEncoder().encode('<a>changed</a>')))
  })

  it('deletes parts given null and appends new parts at the end', async () => {
    const original = makeZip({ 'a.xml': '<a/>', 'b.xml': '<b/>' })
    const next = await rewriteZip(original, new Map<string, string | null>([['a.xml', null], ['new/d.xml', '<d/>']]))
    const zip = openZip(next)
    expect(zip.names()).toEqual(['b.xml', 'new/d.xml'])
    expect(await zip.text('new/d.xml')).toBe('<d/>')
  })

  it('ignores deleting a part that does not exist', async () => {
    const original = makeZip({ 'a.xml': '<a/>' })
    const zip = openZip(await rewriteZip(original, new Map([['missing.xml', null]])))
    expect(zip.names()).toEqual(['a.xml'])
  })

  it('compresses big text and stores tiny parts', async () => {
    const big = 'x'.repeat(10_000)
    const next = await rewriteZip(makeZip({ 'a.xml': '<a/>' }), new Map([['a.xml', big], ['t', 'y']]))
    const dir = readZipDirectory(next)
    expect(dir[0]!.method).toBe(8)
    expect(dir[0]!.compressedSize).toBeLessThan(200)
    expect(dir[1]!.method).toBe(0)
    expect(await openZip(next).text('a.xml')).toBe(big)
    // Node の zlib でも読める（壊れた deflate を書いていない）
    const raw = next.subarray(30 + 5, 30 + 5 + dir[0]!.compressedSize)
    expect(inflateRawSync(raw).toString()).toBe(big)
  })

  it('handles archives that used data descriptors', async () => {
    const original = makeZip({ 'a.xml': '<a/>', 'b.xml': '<b>keep</b>' }, { dataDescriptor: true })
    const next = await rewriteZip(original, new Map([['a.xml', '<a>2</a>']]))
    const zip = openZip(next)
    expect(await zip.text('a.xml')).toBe('<a>2</a>')
    expect(await zip.text('b.xml')).toBe('<b>keep</b>')
    expect(readZipDirectory(next).every((e) => (e.flags & 0x0008) === 0)).toBe(true)
  })

  it('keeps unicode names', async () => {
    const next = await rewriteZip(makeZip({ 'media/画像.png': new Uint8Array([9]) }), new Map())
    expect(openZip(next).names()).toEqual(['media/画像.png'])
  })

  it('rejects data that is not a zip', async () => {
    await expect(rewriteZip(new Uint8Array([1, 2, 3]), new Map())).rejects.toThrow()
  })
})

describe('overlayZip', () => {
  it('serves overridden parts and falls back to the base', async () => {
    const base = openZip(makeZip({ 'a.xml': '<a/>', 'b.xml': '<b/>' }))
    const zip = overlayZip(base, new Map([['a.xml', '<a>new</a>']]))
    expect(await zip.text('a.xml')).toBe('<a>new</a>')
    expect(new TextDecoder().decode((await zip.bytes('a.xml'))!)).toBe('<a>new</a>')
    expect(await zip.text('b.xml')).toBe('<b/>')
    expect(zip.has('a.xml')).toBe(true)
    expect(zip.has('zzz')).toBe(false)
  })
})

describe('distributeText', () => {
  it('returns the same runs when nothing changed', () => {
    expect(distributeText(['ab', 'cd'], 'abcd')).toEqual(['ab', 'cd'])
  })
  it('edits only the run where the change is', () => {
    expect(distributeText(['Hello ', 'world'], 'Hello there')).toEqual(['Hello ', 'there'])
    expect(distributeText(['Hello ', 'world', '!'], 'Hello World!')).toEqual(['Hello ', 'World', '!'])
  })
  it('appends typed text to the run before the cursor', () => {
    expect(distributeText(['Bold', 'Plain'], 'BoldXPlain')).toEqual(['BoldX', 'Plain'])
    expect(distributeText(['ab'], 'abc')).toEqual(['abc'])
  })
  it('inserts at the start into the first run', () => {
    expect(distributeText(['ab', 'cd'], 'Xabcd')).toEqual(['Xab', 'cd'])
  })
  it('deletes across runs', () => {
    expect(distributeText(['abc', 'def', 'ghi'], 'abhi')).toEqual(['ab', '', 'hi'])
    expect(distributeText(['abc', 'def'], '')).toEqual(['', ''])
  })
  it('replaces across runs', () => {
    expect(distributeText(['abc', 'def'], 'aXf')).toEqual(['aX', 'f'])
  })
  it('handles empty runs', () => {
    expect(distributeText(['', 'abc'], 'abcd')).toEqual(['', 'abcd'])
    expect(distributeText(['', ''], 'x')).toEqual(['x', ''])
    expect(distributeText([], 'x')).toEqual([])
  })
  it('handles repeated characters', () => {
    expect(distributeText(['aa', 'aa'], 'aaa')).toEqual(['aa', 'a'])
    expect(distributeText(['aa', 'aa'], 'aaaaa').join('')).toBe('aaaaa')
  })
  it('does not split surrogate pairs', () => {
    const result = distributeText(['😀'], '😃')
    expect(result.join('')).toBe('😃')
  })
  it('keeps the joined text equal to the new text (many cases)', () => {
    const cases: [string[], string][] = [
      [['日本', '語の', '文章'], '日本語'], [['a', 'b', 'c'], 'cba'], [['x'], ''], [['', 'x', ''], 'yxy'], [['abc', 'abc'], 'abcXabc']
    ]
    for (const [runs, next] of cases) expect(distributeText(runs, next).join('')).toBe(next)
  })
})

describe('escapeXmlText', () => {
  it('escapes markup and drops invalid control characters', () => {
    expect(escapeXmlText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
    expect(escapeXmlText('x\u0001y\u000bz\tw\n')).toBe('xyz\tw\n')
  })
})

describe('Word paragraphs', () => {
  const doc = docxBody(
    '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>' +
    '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> and plain</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Line1</w:t><w:br/><w:t>Line2</w:t><w:tab/><w:t>T</w:t></w:r></w:p>' +
    '<w:p/>' +
    '<w:p><w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins><w:r><w:t>new</w:t></w:r></w:ins></w:p>' +
    '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>cell &amp; text</w:t></w:r></w:p></w:tc></w:tr></w:tbl>' +
    '<w:p><w:r><w:t>page</w:t><w:br w:type="page"/></w:r></w:p>'
  )

  it('reads paragraphs with breaks and tabs, skipping deleted text and pPr tabs', () => {
    const paragraphs = readParagraphs(doc, 'w')
    expect(paragraphs.map((p) => p.text)).toEqual(['Title', 'Bold and plain', 'Line1\nLine2\tT', '', 'new', 'cell & text', 'page'])
    expect(paragraphs[5]!.group).toBeGreaterThanOrEqual(0)
    expect(paragraphs[0]!.group).toBe(-1)
  })

  it('edits one run and keeps the formatting of the others', () => {
    const next = applyParagraphEdits(doc, 'w', new Map([[1, 'Bold and changed']]))
    expect(next).toContain('<w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r>')
    expect(next).toContain('<w:t xml:space="preserve"> and changed</w:t>')
    expect(readParagraphs(next, 'w')[1]!.text).toBe('Bold and changed')
  })

  it('adds xml:space="preserve" when needed', () => {
    const next = applyParagraphEdits(doc, 'w', new Map([[0, ' Title ']]))
    expect(next).toContain('<w:t xml:space="preserve"> Title </w:t>')
  })

  it('escapes markup in new text', () => {
    const next = applyParagraphEdits(doc, 'w', new Map([[0, '<b>&']]))
    expect(next).toContain('&lt;b&gt;&amp;')
    expect(readParagraphs(next, 'w')[0]!.text).toBe('<b>&')
  })

  it('keeps breaks when only the text around them changes', () => {
    const next = applyParagraphEdits(doc, 'w', new Map([[2, 'LineA\nLine2\tTT']]))
    expect(next).toContain('<w:t xml:space="preserve">LineA</w:t><w:br/><w:t>Line2</w:t><w:tab/><w:t xml:space="preserve">TT</w:t>')
  })

  it('rebuilds the paragraph when breaks are added or removed', () => {
    const removed = applyParagraphEdits(doc, 'w', new Map([[2, 'one line']]))
    expect(readParagraphs(removed, 'w')[2]!.text).toBe('one line')
    expect(removed).not.toContain('Line2')
    const added = applyParagraphEdits(doc, 'w', new Map([[1, 'Bold\nnext']]))
    expect(readParagraphs(added, 'w')[1]!.text).toBe('Bold\nnext')
    expect(added).toContain('<w:br/>')
  })

  it('adds a run to an empty paragraph', () => {
    const next = applyParagraphEdits(doc, 'w', new Map([[3, 'filled']]))
    expect(readParagraphs(next, 'w')[3]!.text).toBe('filled')
    expect(next).toContain('<w:p><w:r><w:t xml:space="preserve">filled</w:t></w:r></w:p>')
  })

  it('edits text in tables and keeps page breaks', () => {
    const next = applyParagraphEdits(doc, 'w', new Map([[5, 'cell'], [6, 'PAGE']]))
    expect(readParagraphs(next, 'w')[5]!.text).toBe('cell')
    expect(next).toContain('<w:t xml:space="preserve">PAGE</w:t><w:br w:type="page"/>')
  })

  it('ignores unknown indexes and unchanged text', () => {
    expect(applyParagraphEdits(doc, 'w', new Map([[99, 'x']]))).toBe(doc)
    expect(applyParagraphEdits(doc, 'w', new Map([[0, 'Title']]))).toBe(doc)
    expect(applyParagraphEdits(doc, 'w', new Map())).toBe(doc)
  })

  it('normalizes CRLF typed in the editor', () => {
    const next = applyParagraphEdits(doc, 'w', new Map([[2, 'Line1\r\nLine2\tT2']]))
    expect(readParagraphs(next, 'w')[2]!.text).toBe('Line1\nLine2\tT2')
  })

  it('does not double count text inside mc:Fallback', () => {
    const xml = docxBody('<w:p xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><w:r><mc:AlternateContent><mc:Choice><w:drawing><w:txbxContent><w:p><w:r><w:t>box</w:t></w:r></w:p></w:txbxContent></w:drawing></mc:Choice><mc:Fallback><w:pict><w:txbxContent><w:p><w:r><w:t>box</w:t></w:r></w:p></w:txbxContent></w:pict></mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>outer</w:t></w:r></w:p>')
    expect(readParagraphs(xml, 'w').map((p) => p.text)).toEqual(['outer', 'box'])
    const next = applyParagraphEdits(xml, 'w', new Map([[1, 'BOX'], [0, 'OUTER']]))
    expect(readParagraphs(next, 'w').map((p) => p.text)).toEqual(['OUTER', 'BOX'])
  })

  it('uses whatever prefix the document declares', () => {
    const xml = '<doc xmlns="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><body><p><r><t>plain</t></r></p></body></doc>'
    expect(readParagraphs(xml, 'w').map((p) => p.text)).toEqual(['plain'])
    expect(applyParagraphEdits(xml, 'w', new Map([[0, 'x']]))).toContain('<t xml:space="preserve">x</t>')
  })

  it('returns nothing when the namespace is missing', () => {
    expect(readParagraphs('<w:p><w:r><w:t>x</w:t></w:r></w:p>', 'w')).toEqual([])
  })

  it('reads entities, CDATA and self-closing text', () => {
    const xml = docxBody('<w:p><w:r><w:t>&#x3042;&lt;<![CDATA[<raw>]]></w:t><w:t/></w:r></w:p>')
    expect(readParagraphs(xml, 'w')[0]!.text).toBe('あ<<raw>')
    const next = applyParagraphEdits(xml, 'w', new Map([[0, 'あ<<raw>!']]))
    expect(readParagraphs(next, 'w')[0]!.text).toBe('あ<<raw>!')
  })

  it('skips comments and keeps them', () => {
    const xml = docxBody('<!-- <w:p><w:r><w:t>no</w:t></w:r></w:p> --><w:p><w:r><w:t>yes</w:t></w:r></w:p>')
    expect(readParagraphs(xml, 'w').map((p) => p.text)).toEqual(['yes'])
    expect(applyParagraphEdits(xml, 'w', new Map([[0, 'ok']]))).toContain('<!-- <w:p><w:r><w:t>no</w:t></w:r></w:p> -->')
  })
})

describe('PowerPoint paragraphs', () => {
  const xml = slide(
    shape('<a:p><a:r><a:rPr lang="ja-JP" b="1"/><a:t>Title</a:t></a:r></a:p>') +
    shape('<a:p><a:r><a:rPr lang="en-US"/><a:t>one</a:t></a:r><a:br><a:rPr lang="en-US"/></a:br><a:r><a:rPr lang="en-US"/><a:t>two</a:t></a:r></a:p><a:p><a:endParaRPr lang="en-US" sz="2000"/></a:p><a:p><a:fld id="{1}" type="slidenum"><a:t>3</a:t></a:fld></a:p>')
  )

  it('reads paragraphs and groups them by text box', () => {
    const paragraphs = readParagraphs(xml, 'a')
    expect(paragraphs.map((p) => p.text)).toEqual(['Title', 'one\ntwo', '', '3'])
    expect(paragraphs[0]!.group).not.toBe(paragraphs[1]!.group)
    expect(paragraphs[1]!.group).toBe(paragraphs[2]!.group)
  })

  it('edits text and keeps run properties', () => {
    const next = applyParagraphEdits(xml, 'a', new Map([[0, 'New title']]))
    expect(next).toContain('<a:rPr lang="ja-JP" b="1"/><a:t>New title</a:t>')
    expect(next).not.toContain('xml:space')
  })

  it('keeps a:br when only text changes', () => {
    const next = applyParagraphEdits(xml, 'a', new Map([[1, 'ONE\ntwo']]))
    expect(next).toContain('<a:t>ONE</a:t></a:r><a:br><a:rPr lang="en-US"/></a:br>')
  })

  it('splits the run when a new line is typed', () => {
    const next = applyParagraphEdits(xml, 'a', new Map([[0, 'A\nB']]))
    expect(next).toContain('<a:r><a:rPr lang="ja-JP" b="1"/><a:t>A</a:t></a:r><a:br/><a:r><a:rPr lang="ja-JP" b="1"/><a:t>B</a:t></a:r>')
    expect(readParagraphs(next, 'a')[0]!.text).toBe('A\nB')
  })

  it('joins lines when a break is removed', () => {
    const next = applyParagraphEdits(xml, 'a', new Map([[1, 'one two']]))
    expect(readParagraphs(next, 'a')[1]!.text).toBe('one two')
    expect(next).not.toContain('<a:br>')
  })

  it('fills an empty paragraph before a:endParaRPr with the same properties', () => {
    const next = applyParagraphEdits(xml, 'a', new Map([[2, 'added']]))
    expect(next).toContain('<a:p><a:r><a:rPr lang="en-US" sz="2000"/><a:t>added</a:t></a:r><a:endParaRPr lang="en-US" sz="2000"/></a:p>')
    expect(readParagraphs(next, 'a')[2]!.text).toBe('added')
  })

  it('fills an empty paragraph with several lines', () => {
    const next = applyParagraphEdits(xml, 'a', new Map([[2, 'x\ny']]))
    expect(readParagraphs(next, 'a')[2]!.text).toBe('x\ny')
  })

  it('ignores a:t outside paragraphs and runs', () => {
    expect(readParagraphs(slide('<a:t>loose</a:t>'), 'a')).toEqual([])
  })

  it('fills a self-closing paragraph', () => {
    const next = applyParagraphEdits(slide(shape('<a:p/>')), 'a', new Map([[0, 'z']]))
    expect(readParagraphs(next, 'a')[0]!.text).toBe('z')
  })

  it('does nothing for an empty edit of an empty paragraph', () => {
    const source = slide(shape('<a:p/>'))
    expect(applyParagraphEdits(source, 'a', new Map([[0, '']]))).toBe(source)
  })
})

describe('Word and PowerPoint parts', () => {
  it('lists slides in presentation order and patches only changed slides', async () => {
    const zip = openZip(makeZip({
      'ppt/presentation.xml': `<p:presentation ${A_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="257" r:id="rId3"/><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>`,
      'ppt/_rels/presentation.xml.rels': '<Relationships><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide2.xml"/></Relationships>',
      'ppt/slides/slide1.xml': slide(shape('<a:p><a:r><a:t>first file</a:t></a:r></a:p>')),
      'ppt/slides/slide2.xml': slide(shape('<a:p><a:r><a:t>shown first</a:t></a:r></a:p>'))
    }))
    const parts = await readTextParts('pptx', zip)
    expect(parts.map((p) => [p.part, p.slide, p.paragraphs[0]!.text])).toEqual([['ppt/slides/slide2.xml', 1, 'shown first'], ['ppt/slides/slide1.xml', 2, 'first file']])
    const changes = await textChanges(zip, parts, new Map([['ppt/slides/slide2.xml', new Map([[0, 'edited']])], ['ppt/slides/slide1.xml', new Map([[0, 'first file']])]]))
    expect([...changes.keys()]).toEqual(['ppt/slides/slide2.xml'])
    expect(changes.get('ppt/slides/slide2.xml')).toContain('<a:t>edited</a:t>')
  })

  it('reads the Word body and fails clearly without it', async () => {
    const zip = openZip(makeZip({ 'word/document.xml': docxBody('<w:p><w:r><w:t>x</w:t></w:r></w:p>') }))
    expect((await readTextParts('docx', zip))[0]!.paragraphs.map((p) => p.text)).toEqual(['x'])
    await expect(readTextParts('docx', openZip(makeZip({ 'a.xml': '<a/>' })))).rejects.toThrow()
    await expect(readTextParts('pptx', openZip(makeZip({ 'a.xml': '<a/>' })))).rejects.toThrow()
  })
})

const SHEET_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
const sheet = (data: string, extra = '') => `<?xml version="1.0"?><worksheet ${SHEET_NS}><dimension ref="A1:B2"/><sheetData>${data}</sheetData>${extra}</worksheet>`

describe('encodeCellInput', () => {
  it('encodes numbers, booleans, formulas, text and empty', () => {
    expect(encodeCellInput('')).toBeNull()
    expect(encodeCellInput('12')).toEqual({ type: null, inner: '<v>12</v>', formula: false })
    expect(encodeCellInput(' -1.5e3 ')!.inner).toBe('<v>-1500</v>')
    expect(encodeCellInput('.5')!.inner).toBe('<v>0.5</v>')
    expect(encodeCellInput('TRUE')).toEqual({ type: 'b', inner: '<v>1</v>', formula: false })
    expect(encodeCellInput('false')!.inner).toBe('<v>0</v>')
    expect(encodeCellInput('=SUM(A1:A2)')).toEqual({ type: null, inner: '<f>SUM(A1:A2)</f>', formula: true })
    expect(encodeCellInput('=')!.type).toBe('inlineStr')
    expect(encodeCellInput('a<b')!.inner).toBe('<is><t xml:space="preserve">a&lt;b</t></is>')
    expect(encodeCellInput('1,000')!.type).toBe('inlineStr')
    expect(encodeCellInput('1e999')!.type).toBe('inlineStr')
  })
  it('keeps text in text-formatted cells', () => {
    expect(encodeCellInput('007', true)!.type).toBe('inlineStr')
    expect(encodeCellInput('=A1', true)!.type).toBe('inlineStr')
  })
})

describe('applyCellEdits', () => {
  const xml = sheet('<row r="1" spans="1:2"><c r="A1" s="3" t="s"><v>0</v></c><c r="B1"><v>5</v></c></row><row r="3"><c r="B3"><f>A1*2</f><v>10</v></c></row>')

  it('replaces a value and keeps the style', () => {
    const { xml: next, formulas } = applyCellEdits(xml, new Map([['A1', 'hello']]))
    expect(next).toContain('<c r="A1" s="3" t="inlineStr"><is><t xml:space="preserve">hello</t></is></c><c r="B1"><v>5</v></c>')
    expect(next).not.toContain('spans=')
    expect(formulas).toBe(false)
  })

  it('inserts a cell in column order inside an existing row', () => {
    const next = applyCellEdits(xml, new Map([['C1', '7'], ['AA1', 'x']])).xml
    expect(next).toContain('<c r="B1"><v>5</v></c><c r="C1"><v>7</v></c><c r="AA1" t="inlineStr">')
  })

  it('inserts several cells at the same place in column order', () => {
    const base = sheet('<row r="1"><c r="A1"><v>1</v></c><c r="E1"><v>5</v></c></row>')
    const next = applyCellEdits(base, new Map([['D1', '4'], ['B1', '2'], ['C1', '3']])).xml
    expect(next).toContain('<c r="A1"><v>1</v></c><c r="B1"><v>2</v></c><c r="C1"><v>3</v></c><c r="D1"><v>4</v></c><c r="E1"><v>5</v></c>')
  })

  it('inserts before a cell that is also replaced', () => {
    const base = sheet('<row r="1"><c r="C1"><v>3</v></c></row>')
    const next = applyCellEdits(base, new Map([['A1', '1'], ['C1', '30']])).xml
    expect(next).toContain('<row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>30</v></c></row>')
  })

  it('creates rows in order', () => {
    const next = applyCellEdits(xml, new Map([['A2', 'two'], ['A5', '5'], ['A4', '4']])).xml
    const order = [...next.matchAll(/<row r="(\d+)"/g)].map((m) => m[1])
    expect(order).toEqual(['1', '2', '3', '4', '5'])
  })

  it('removes a cell without style and keeps a styled empty cell', () => {
    const next = applyCellEdits(xml, new Map([['B1', ''], ['A1', '']])).xml
    expect(next).toContain('<row r="1"><c r="A1" s="3"/></row>')
  })

  it('does not create cells for empty input', () => {
    expect(applyCellEdits(xml, new Map([['Z9', '']])).xml).not.toContain('Z9')
  })

  it('reports formulas when a formula is written or replaced', () => {
    expect(applyCellEdits(xml, new Map([['B3', '3']])).formulas).toBe(true)
    expect(applyCellEdits(xml, new Map([['C5', '=A1']])).formulas).toBe(true)
    expect(applyCellEdits(xml, new Map([['C5', '=A1']])).xml).toContain('<c r="C5"><f>A1</f></c>')
  })

  it('opens a self-closing sheetData and a self-closing row', () => {
    const empty = sheet('').replace('<sheetData></sheetData>', '<sheetData/>')
    const next = applyCellEdits(empty, new Map([['B2', 'x']])).xml
    expect(next).toContain('<sheetData><row r="2"><c r="B2" t="inlineStr">')
    const selfRow = applyCellEdits(sheet('<row r="1"/>'), new Map([['A1', '1']])).xml
    expect(selfRow).toContain('<row r="1"><c r="A1"><v>1</v></c></row>')
  })

  it('works with a prefixed namespace', () => {
    const prefixed = '<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1"><x:v>1</x:v></x:c></x:row></x:sheetData></x:worksheet>'
    const next = applyCellEdits(prefixed, new Map([['A1', 'a'], ['B1', '=A1']])).xml
    expect(next).toContain('<x:c r="A1" t="inlineStr"><x:is><x:t xml:space="preserve">a</x:t></x:is></x:c><x:c r="B1"><x:f>A1</x:f></x:c>')
  })

  it('handles rows and cells without r attributes', () => {
    const implicit = sheet('<row><c><v>1</v></c><c><v>2</v></c></row><row><c><v>3</v></c></row>')
    const next = applyCellEdits(implicit, new Map([['B1', '20'], ['A2', '30']])).xml
    expect(next).toContain('<c r="B1"><v>20</v></c>')
    expect(next).toContain('<c r="A2"><v>30</v></c>')
  })

  it('expands the dimension', () => {
    expect(applyCellEdits(xml, new Map([['D9', '1']])).xml).toContain('<dimension ref="A1:D9"/>')
    expect(applyCellEdits(xml, new Map([['A1', '1']])).xml).toContain('<dimension ref="A1:B2"/>')
  })

  it('keeps the rest of the sheet untouched', () => {
    const extra = '<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><conditionalFormatting sqref="A1"/>'
    const next = applyCellEdits(sheet('<row r="1"><c r="A1"><v>1</v></c></row>', extra), new Map([['A1', '2']])).xml
    expect(next.endsWith(`</sheetData>${extra}</worksheet>`)).toBe(true)
  })

  it('ignores bad references and empty edit lists', () => {
    expect(applyCellEdits(xml, new Map([['??', '1']])).xml).toBe(xml)
    expect(applyCellEdits(xml, new Map()).xml).toBe(xml)
  })

  it('fails on a sheet without sheetData', () => {
    expect(() => applyCellEdits('<worksheet/>', new Map([['A1', '1']]))).toThrow()
  })

  it('writes text-format cells as text', () => {
    expect(applyCellEdits(xml, new Map([['A1', '0123']]), new Set(['A1'])).xml).toContain('<t xml:space="preserve">0123</t>')
  })
})

describe('readSheetGrid', () => {
  const styles = [
    { numFmt: 'General', css: '', wrap: false },
    { numFmt: '0.00', css: '', wrap: false },
    { numFmt: '@', css: '', wrap: false }
  ]
  const book = { shared: ['shared text'], styles, date1904: false }

  it('reads values for editing and display', () => {
    const grid = readSheetGrid(sheet(
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>1.5</v></c><c r="C1" t="b"><v>1</v></c><c r="D1" t="e"><v>#DIV/0!</v></c></row>' +
      '<row r="2"><c r="A2"><f>B1*2</f><v>3</v></c><c r="B2" t="inlineStr"><is><t>inline</t></is></c><c r="C2" s="2" t="s"><v>0</v></c><c r="D2" t="str"><f t="shared" ref="D2:D3" si="0">A1</f><v>x</v></c></row>' +
      '<row r="3"><c r="D3" t="str"><f t="shared" si="0"/><v>y</v></c><c r="E3" s="1"/></row>'
    ), book)
    expect(grid.cells.get(cellKey(0, 0))).toMatchObject({ input: 'shared text', display: 'shared text', kind: 'string' })
    expect(grid.cells.get(cellKey(0, 1))).toMatchObject({ input: '1.5', display: '1.50', kind: 'number' })
    expect(grid.cells.get(cellKey(0, 2))).toMatchObject({ input: 'TRUE', kind: 'bool' })
    expect(grid.cells.get(cellKey(0, 3))).toMatchObject({ display: '#DIV/0!', kind: 'error' })
    expect(grid.cells.get(cellKey(1, 0))).toMatchObject({ input: '=B1*2', display: '3', kind: 'formula', locked: false })
    expect(grid.cells.get(cellKey(1, 1))!.input).toBe('inline')
    expect(grid.cells.get(cellKey(1, 2))!.textFormat).toBe(true)
    expect(grid.cells.get(cellKey(1, 3))).toMatchObject({ input: '=A1', locked: true })
    expect(grid.cells.get(cellKey(2, 3))).toMatchObject({ input: 'y', locked: false, kind: 'formula' })
    expect(grid.cells.has(cellKey(2, 4))).toBe(false)
    expect(grid.maxRow).toBe(2)
    expect(grid.maxCol).toBe(3)
    expect(grid.truncated).toBe(false)
  })

  it('marks sheets with cells beyond the limit', () => {
    const grid = readSheetGrid(sheet('<row r="999999"><c r="A999999"><v>1</v></c></row>'), book)
    expect(grid.truncated).toBe(true)
    expect(grid.cells.size).toBe(0)
  })

  it('reads an empty or missing sheet', () => {
    expect(readSheetGrid(null, book).maxRow).toBe(-1)
    expect(readSheetGrid(sheet(''), book).cells.size).toBe(0)
  })

  it('names cells', () => {
    expect(cellRef(0, 0)).toBe('A1')
    expect(cellRef(9, 27)).toBe('AB10')
  })
})

describe('workbookAfterFormulaEdit', () => {
  const rels = '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/></Relationships>'
  const types = '<Types><Override PartName="/xl/workbook.xml" ContentType="a"/><Override PartName="/xl/calcChain.xml" ContentType="b"/></Types>'

  it('drops calcChain and sets fullCalcOnLoad on an existing calcPr', () => {
    const out = workbookAfterFormulaEdit({ workbook: '<workbook><sheets/><calcPr calcId="191029"/></workbook>', workbookRels: rels, contentTypes: types })
    expect(out.workbook).toContain('<calcPr calcId="191029" fullCalcOnLoad="1"/>')
    expect(out.workbookRels).not.toContain('calcChain')
    expect(out.workbookRels).toContain('worksheet')
    expect(out.contentTypes).not.toContain('calcChain')
    expect(out.contentTypes).toContain('/xl/workbook.xml')
  })

  it('overwrites fullCalcOnLoad="0"', () => {
    expect(workbookAfterFormulaEdit({ workbook: '<workbook><calcPr fullCalcOnLoad="0"></calcPr></workbook>', workbookRels: null, contentTypes: null }).workbook).toContain('<calcPr fullCalcOnLoad="1">')
  })

  it('adds calcPr after definedNames or sheets', () => {
    expect(workbookAfterFormulaEdit({ workbook: '<workbook><sheets><sheet/></sheets><definedNames><definedName/></definedNames></workbook>', workbookRels: null, contentTypes: null }).workbook)
      .toBe('<workbook><sheets><sheet/></sheets><definedNames><definedName/></definedNames><calcPr fullCalcOnLoad="1"/></workbook>')
    expect(workbookAfterFormulaEdit({ workbook: '<workbook><sheets><sheet/></sheets></workbook>', workbookRels: null, contentTypes: null }).workbook)
      .toBe('<workbook><sheets><sheet/></sheets><calcPr fullCalcOnLoad="1"/></workbook>')
  })
})

describe('xlsxChanges', () => {
  const files = {
    '[Content_Types].xml': '<Types><Override PartName="/xl/calcChain.xml" ContentType="b"/></Types>',
    'xl/workbook.xml': `<workbook ${SHEET_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="One" sheetId="1" r:id="rId1"/><sheet name="Hidden" sheetId="2" state="hidden" r:id="rId2"/></sheets><calcPr calcId="1"/></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/calcChain" Target="calcChain.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': sheet('<row r="1"><c r="A1" t="s"><v>0</v></c></row>'),
    'xl/worksheets/sheet2.xml': sheet(''),
    'xl/calcChain.xml': '<calcChain/>',
    'xl/sharedStrings.xml': '<sst><si><t>old</t></si></sst>'
  }

  it('lists sheets with their parts', async () => {
    const book = await readWorkbook(openZip(makeZip(files)))
    expect(book.sheets).toEqual([{ name: 'One', hidden: false, part: 'xl/worksheets/sheet1.xml' }, { name: 'Hidden', hidden: true, part: 'xl/worksheets/sheet2.xml' }])
    expect(book.shared).toEqual(['old'])
  })

  it('patches values without touching the workbook', async () => {
    const zip = openZip(makeZip(files))
    const changes = await xlsxChanges(zip, [{ part: 'xl/worksheets/sheet1.xml', cells: new Map([['A1', 'new']]) }])
    expect([...changes.keys()]).toEqual(['xl/worksheets/sheet1.xml'])
  })

  it('drops calcChain when formulas are written', async () => {
    const zip = openZip(makeZip(files))
    const changes = await xlsxChanges(zip, [{ part: 'xl/worksheets/sheet2.xml', cells: new Map([['A1', '=1+1']]) }])
    expect(changes.get('xl/calcChain.xml')).toBeNull()
    expect(changes.get('xl/workbook.xml')).toContain('fullCalcOnLoad="1"')
    const written = openZip(await rewriteZip(makeZip(files), changes))
    expect(written.has('xl/calcChain.xml')).toBe(false)
    expect(await written.text('xl/worksheets/sheet2.xml')).toContain('<f>1+1</f>')
    expect(await written.text('xl/_rels/workbook.xml.rels')).not.toContain('calcChain')
  })

  it('skips sheets without edits and fails on a missing part', async () => {
    const zip = openZip(makeZip(files))
    expect((await xlsxChanges(zip, [{ part: 'xl/worksheets/sheet1.xml', cells: new Map() }])).size).toBe(0)
    await expect(xlsxChanges(zip, [{ part: 'xl/worksheets/nope.xml', cells: new Map([['A1', '1']]) }])).rejects.toThrow()
  })
})

describe('office kinds', () => {
  it('maps convertible formats', () => {
    expect(convertibleOfficeOf('old.XLS')).toEqual({ kind: 'xlsx', exportFilter: 'xls:MS Excel 97' })
    expect(convertibleOfficeOf('a/b/deck.ppt')!.kind).toBe('pptx')
    expect(convertibleOfficeOf('memo.doc')!.exportFilter).toBe('doc:MS Word 97')
    expect(convertibleOfficeOf('x.odt')!.kind).toBe('docx')
    expect(convertibleOfficeOf('x.ods')!.kind).toBe('xlsx')
    expect(convertibleOfficeOf('x.odp')!.kind).toBe('pptx')
    expect(convertibleOfficeOf('x.rtf')!.kind).toBe('docx')
    expect(convertibleOfficeOf('x.key')).toEqual({ kind: 'pptx', exportFilter: null })
    expect(convertibleOfficeOf('x.numbers')).toEqual({ kind: 'xlsx', exportFilter: null })
    expect(convertibleOfficeOf('x.pages')).toEqual({ kind: 'docx', exportFilter: null })
    expect(convertibleOfficeOf('x.xlsx')).toBeNull()
    expect(convertibleOfficeOf('x.txt')).toBeNull()
    expect(convertibleOfficeOf('.xls')).toBeNull()
    expect(convertibleOfficeOf('noext')).toBeNull()
  })

  it('keeps OOXML and legacy apart', () => {
    for (const path of ['a.doc', 'a.xls', 'a.ppt', 'a.odt', 'a.key']) {
      expect(isLegacyOffice(path)).toBe(true)
      expect(officeKindOf(path)).toBeNull()
    }
    for (const path of ['a.docx', 'a.xlsm', 'a.pptx']) expect(isLegacyOffice(path)).toBe(false)
  })

  it('reads extensions from posix and windows paths', () => {
    expect(extensionOf('dir.v2/file')).toBe('')
    expect(extensionOf('C:\\dir\\Book.XLS')).toBe('.xls')
  })

  it('sniffs containers', () => {
    expect(sniffContainer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0]))).toBe('zip')
    expect(sniffContainer(new Uint8Array([0x50, 0x4b, 0x05, 0x06]))).toBe('zip')
    expect(sniffContainer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe('ole')
    expect(sniffContainer(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toBe('other')
    expect(sniffContainer(new TextEncoder().encode('{\\rtf1'))).toBe('other')
    expect(sniffContainer(new Uint8Array())).toBe('other')
  })

  it('finds the OOXML kind from part names', () => {
    expect(ooxmlKindFromNames(['[Content_Types].xml', 'word/document.xml'])).toBe('docx')
    expect(ooxmlKindFromNames(['/xl/workbook.xml'])).toBe('xlsx')
    expect(ooxmlKindFromNames(['ppt/presentation.xml'])).toBe('pptx')
    expect(ooxmlKindFromNames(['content.xml', 'mimetype'])).toBeNull()
  })
})

describe('edit state', () => {
  it('adds, replaces and drops edits that return to the original', () => {
    let edits = updateEdit(new Map(), 'sheet1', 'A1', 'x', '')
    expect(hasEdits(edits)).toBe(true)
    edits = updateEdit(edits, 'sheet1', 'B1', '2', '1')
    expect([...edits.get('sheet1')!.keys()]).toEqual(['A1', 'B1'])
    const before = edits
    edits = updateEdit(edits, 'sheet1', 'A1', '', '')
    expect(before.get('sheet1')!.has('A1')).toBe(true)
    edits = updateEdit(edits, 'sheet1', 'B1', '1', '1')
    expect(edits.has('sheet1')).toBe(false)
    expect(hasEdits(edits)).toBe(false)
    expect(hasEdits(new Map([['p', new Map()]]))).toBe(false)
  })

  it('finds text-formatted cells among the edits', () => {
    const grid = readSheetGrid(sheet('<row r="1"><c r="A1" s="1" t="s"><v>0</v></c><c r="B1"><v>1</v></c></row>'), {
      shared: ['x'], styles: [{ numFmt: 'General', css: '', wrap: false }, { numFmt: '@', css: '', wrap: false }], date1904: false
    })
    expect([...textFormatRefs(grid, new Map([['A1', '01'], ['B1', '02'], ['C9', '3'], ['bad', '']]))]).toEqual(['A1'])
    expect(textFormatRefs(undefined, new Map([['A1', '1']])).size).toBe(0)
  })
})
