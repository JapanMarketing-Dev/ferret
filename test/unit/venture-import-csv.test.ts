/**
 * 取り込みの CSV: 復号（BOM・UTF-16・Shift_JIS）、区切りの判定、RFC 4180 の引用符、改行、元の行番号
 */
import { describe, expect, it } from 'vitest'
import { decodeBytes, detectDelimiter, isBlankRow, parseCsv } from '../../src/shared/venture/import/csv'

const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const utf16le = (s: string, bom = true): Uint8Array => {
  const out = new Uint8Array((bom ? 2 : 0) + s.length * 2)
  let o = 0
  if (bom) {
    out[o++] = 0xff
    out[o++] = 0xfe
  }
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    out[o++] = c & 0xff
    out[o++] = c >> 8
  }
  return out
}
const utf16be = (s: string, bom = true): Uint8Array => {
  const le = utf16le(s, false)
  const out = new Uint8Array((bom ? 2 : 0) + le.length)
  let o = 0
  if (bom) {
    out[o++] = 0xfe
    out[o++] = 0xff
  }
  for (let i = 0; i < le.length; i += 2) {
    out[o++] = le[i + 1]
    out[o++] = le[i]
  }
  return out
}

describe('decodeBytes', () => {
  it('BOM の無い UTF-8', () => {
    expect(decodeBytes(utf8('a,b\n1,2'))).toEqual({ text: 'a,b\n1,2', encoding: 'utf-8' })
  })
  it('UTF-8 の BOM は外す', () => {
    const r = decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('日付,費用')]))
    expect(r).toEqual({ text: '日付,費用', encoding: 'utf-8' })
  })
  it('UTF-16LE（BOM 付き）。Google 広告のタブ区切り', () => {
    const r = decodeBytes(utf16le('Day\tCost\n2026-10-01\t1,234'))
    expect(r?.encoding).toBe('utf-16le')
    expect(r?.text).toBe('Day\tCost\n2026-10-01\t1,234')
  })
  it('UTF-16LE の日本語', () => {
    expect(decodeBytes(utf16le('日\t費用'))?.text).toBe('日\t費用')
  })
  it('UTF-16BE（BOM 付き）', () => {
    const r = decodeBytes(utf16be('Date,Clicks'))
    expect(r).toEqual({ text: 'Date,Clicks', encoding: 'utf-16be' })
  })
  it('BOM の無い UTF-16LE も ASCII が多ければ見分ける', () => {
    expect(decodeBytes(utf16le('Date,Clicks\n2026-10-01,3', false))?.encoding).toBe('utf-16le')
  })
  it('BOM の無い UTF-16BE も見分ける', () => {
    expect(decodeBytes(utf16be('Date,Clicks\n2026-10-01,3', false))?.text).toBe('Date,Clicks\n2026-10-01,3')
  })
  it('UTF-8 で読めなければ Shift_JIS（Excel で保存した日本語）', () => {
    // 「日付」の Shift_JIS
    const r = decodeBytes(new Uint8Array([0x93, 0xfa, 0x95, 0x74, 0x2c, 0x31]))
    expect(r).toEqual({ text: '日付,1', encoding: 'shift_jis' })
  })
  it('どれでも読めなければ null', () => {
    expect(decodeBytes(new Uint8Array([0xff, 0xff, 0xff, 0x80, 0xa0, 0xfd]))).toBeNull()
  })
  it('奇数バイトの UTF-16LE（BOM 付き）は壊れているので null', () => {
    expect(decodeBytes(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull()
  })
  it('空のバイト列は空の文字列', () => {
    expect(decodeBytes(new Uint8Array([]))).toEqual({ text: '', encoding: 'utf-8' })
  })
  it('BOM だけ', () => {
    expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf]))?.text).toBe('')
  })
})

describe('detectDelimiter', () => {
  it('カンマ', () => {
    expect(detectDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',')
  })
  it('タブ', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t')
  })
  it('セミコロン', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';')
  })
  it('タブ区切りの中の桁区切りのカンマには引っぱられない', () => {
    expect(detectDelimiter('Day\tImpr.\tCost\n2026-10-01\t1,234\t5,678,900\n2026-10-02\t12\t1,000')).toBe('\t')
  })
  it('表題と期間の2行が先にあってもタブ', () => {
    const text = 'Campaign report\nOctober 1, 2026 - October 31, 2026\nDay\tCampaign\tCost\n2026-10-01\tA\t1\n2026-10-02\tB\t2'
    expect(detectDelimiter(text)).toBe('\t')
  })
  it('引用符の中の区切りは数えない', () => {
    expect(detectDelimiter('"a;b;c",d\n"x;y;z",e\n"1;2",f')).toBe(',')
  })
  it('セミコロン区切りの欧州の小数のカンマには引っぱられない', () => {
    expect(detectDelimiter('date;spend\n2026-10-01;1,5\n2026-10-02;12\n2026-10-03;3,25')).toBe(';')
  })
  it('区切りが無ければカンマ（1列）', () => {
    expect(detectDelimiter('date\n2026-10-01')).toBe(',')
  })
  it('空の文字列はカンマ', () => {
    expect(detectDelimiter('')).toBe(',')
  })
  it('CRLF でも同じ', () => {
    expect(detectDelimiter('a\tb\r\n1\t2\r\n')).toBe('\t')
  })
})

describe('parseCsv', () => {
  it('普通の CSV と1始まりの行番号', () => {
    expect(parseCsv('a,b\n1,2\n3,4').rows).toEqual([
      { line: 1, cells: ['a', 'b'] },
      { line: 2, cells: ['1', '2'] },
      { line: 3, cells: ['3', '4'] }
    ])
  })
  it('末尾の改行のあとに空の行を作らない', () => {
    expect(parseCsv('a,b\n1,2\n').rows).toHaveLength(2)
  })
  it('CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n').rows.map((r) => r.cells)).toEqual([['a', 'b'], ['1', '2']])
  })
  it('CR だけの改行（古い Mac）', () => {
    expect(parseCsv('a,b\r1,2\r3,4').rows.map((r) => r.line)).toEqual([1, 2, 3])
  })
  it('改行が混ざっていても行番号は元のまま', () => {
    expect(parseCsv('a\n1\r\n2\r3').rows.map((r) => [r.line, r.cells[0]])).toEqual([[1, 'a'], [2, '1'], [3, '2'], [4, '3']])
  })
  it('引用符の中のカンマ', () => {
    expect(parseCsv('name,cost\n"Brand, JP","1,234"').rows[1].cells).toEqual(['Brand, JP', '1,234'])
  })
  it('"" は " 1つ', () => {
    expect(parseCsv('a\n"say ""hi"""').rows[1].cells).toEqual(['say "hi"'])
  })
  it('引用符の中の改行は値に入り、次の行の行番号は2つ進む', () => {
    const t = parseCsv('a,b\n"x\ny",1\nz,2')
    expect(t.rows[1]).toEqual({ line: 2, cells: ['x\ny', '1'] })
    expect(t.rows[2]).toEqual({ line: 4, cells: ['z', '2'] })
  })
  it('引用符の中の CRLF はそのまま値に入り、1行と数える', () => {
    const t = parseCsv('a\r\n"x\r\ny"\r\nz')
    expect(t.rows[1].cells[0]).toBe('x\r\ny')
    expect(t.rows[2].line).toBe(4)
  })
  it('値の途中の " は文字のまま', () => {
    expect(parseCsv('a,b\n5" screen,2').rows[1].cells).toEqual(['5" screen', '2'])
  })
  it('閉じた引用符のあとの文字は値に足す', () => {
    expect(parseCsv('a\n"x"y').rows[1].cells).toEqual(['xy'])
  })
  it('閉じない引用符はファイルの終わりまで', () => {
    expect(parseCsv('a,b\n"open,1\n2').rows[1].cells).toEqual(['open,1\n2'])
  })
  it('空の値', () => {
    expect(parseCsv('a,b,c\n,,').rows[1].cells).toEqual(['', '', ''])
  })
  it('空の引用符', () => {
    expect(parseCsv('a,b\n"",x').rows[1].cells).toEqual(['', 'x'])
  })
  it('末尾が区切りなら空の値が1つ増える', () => {
    expect(parseCsv('a,b,\n1,2,').rows.map((r) => r.cells.length)).toEqual([3, 3])
  })
  it('空行は [""]', () => {
    const rows = parseCsv('a\n\nb').rows
    expect(rows[1]).toEqual({ line: 2, cells: [''] })
    expect(rows[2].line).toBe(3)
  })
  it('先頭の U+FEFF を外す', () => {
    expect(parseCsv('﻿Date,Clicks\n2026-10-01,1').rows[0].cells[0]).toBe('Date')
  })
  it('区切りを渡せばそれを使う', () => {
    const t = parseCsv('a;b,c', ';')
    expect(t.delimiter).toBe(';')
    expect(t.rows[0].cells).toEqual(['a', 'b,c'])
  })
  it('タブ区切りの自動判定', () => {
    const t = parseCsv('Day\tCost\n2026-10-01\t1,234')
    expect(t.delimiter).toBe('\t')
    expect(t.rows[1].cells).toEqual(['2026-10-01', '1,234'])
  })
  it('空の文字列は行なし', () => {
    expect(parseCsv('').rows).toEqual([])
  })
  it('改行だけは空行1つ', () => {
    expect(parseCsv('\n').rows).toEqual([{ line: 1, cells: [''] }])
  })
  it('引用符で終わる最後の行（改行なし）', () => {
    expect(parseCsv('a\n""').rows).toHaveLength(2)
  })
  it('行ごとに列の数が違ってもそのまま', () => {
    expect(parseCsv('a,b,c\n1\n1,2,3,4').rows.map((r) => r.cells.length)).toEqual([3, 1, 4])
  })
  it('値の前後の空白は残す（読み取り側で外す）', () => {
    expect(parseCsv('a,b\n 1 , 2 ').rows[1].cells).toEqual([' 1 ', ' 2 '])
  })
})

describe('isBlankRow', () => {
  it('空白だけの値は空行', () => {
    expect(isBlankRow({ line: 1, cells: ['', '  ', '\t'] })).toBe(true)
  })
  it('値が1つでもあれば空行でない', () => {
    expect(isBlankRow({ line: 1, cells: ['', 'x'] })).toBe(false)
  })
})
