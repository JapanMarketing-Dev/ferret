/**
 * 設定の「スマホから操作」に出す QR コード（src/shared/qrCode.ts）。
 * 作った QR は OpenCV の読み取りで全マスク・型番 1〜10 を確かめてある。ここでは表・規格の値・形の決まりと、確かめた出力（golden）を固定する
 */
import { describe, expect, it } from 'vitest'
import {
  QR_MAX_VERSION,
  addEccAndInterleave,
  alignmentPositions,
  chooseVersion,
  dataCodewords,
  encodeData,
  encodeQr,
  formatBits,
  penalty,
  qrSize,
  qrSvgPath,
  rawCodewords,
  rsDivisor,
  rsRemainder,
  versionBits
} from '@shared/qrCode'

/** 'hello'（型番 1・マスク 0）。OpenCV の QRCodeDetector で 'hello' と読めたもの */
const HELLO = [
  '#######..##...#######',
  '#.....#.##....#.....#',
  '#.###.#..#.##.#.###.#',
  '#.###.#...##..#.###.#',
  '#.###.#.##..#.#.###.#',
  '#.....#.....#.#.....#',
  '#######.#.#.#.#######',
  '..........###........',
  '#.#.#.#..#.#....#..#.',
  '..#.##....#...#....##',
  '.#.#..#.###.#...#####',
  '##..#.........#....#.',
  '.##.#.##..#.#.#.#....',
  '........####.#.#..###',
  '#######...##.###..###',
  '#.....#...####.##....',
  '#.###.#.#.##.###...##',
  '#.###.#..#....##..##.',
  '#.###.#.###.#...#.#.#',
  '#.....#..#....#.#..#.',
  '#######.###.#.##...##'
]

const rows = (modules: boolean[][]) => modules.map((r) => r.map((b) => (b ? '#' : '.')).join(''))

describe('QR の表と規格の値', () => {
  it('1辺のモジュール数は 4v+17', () => {
    expect(qrSize(1)).toBe(21)
    expect(qrSize(5)).toBe(37)
    expect(qrSize(10)).toBe(57)
  })

  it('語数は規格の表どおり（誤り訂正 M のデータの語数）', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(rawCodewords)).toEqual([26, 44, 70, 100, 134, 172, 196, 242, 292, 346])
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(dataCodewords)).toEqual([16, 28, 44, 64, 86, 108, 124, 154, 182, 216])
  })

  it('位置合わせパターンの座標は規格の表どおり', () => {
    expect(alignmentPositions(1)).toEqual([])
    expect(alignmentPositions(2)).toEqual([6, 18])
    expect(alignmentPositions(7)).toEqual([6, 22, 38])
    expect(alignmentPositions(10)).toEqual([6, 28, 50])
  })

  it('形式情報は規格の表（M・マスク 0〜7）どおり', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map(formatBits)).toEqual([0x5412, 0x5125, 0x5e7c, 0x5b4b, 0x45f9, 0x40ce, 0x4f97, 0x4aa0])
  })

  it('型番情報は規格の表どおり（7 = 0x07C94、10 = 0x0A4D3）', () => {
    expect(versionBits(7)).toBe(0x07c94)
    expect(versionBits(10)).toBe(0x0a4d3)
  })

  it('Reed-Solomon: 生成多項式と余り（データに余りを足すと割り切れる）', () => {
    expect(rsDivisor(1)).toEqual([1])
    const divisor = rsDivisor(10)
    expect(divisor).toHaveLength(10)
    const data = [0x40, 0x56, 0x86, 0x56, 0xc6, 0xc6, 0xf0, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec]
    const ecc = rsRemainder(data, divisor)
    expect(ecc).toHaveLength(10)
    expect(rsRemainder([...data, ...ecc], divisor)).toEqual(new Array(10).fill(0))
  })
})

describe('データの語', () => {
  it('バイトモード: モード 0100・文字数・本文・終端・埋め草（0xEC と 0x11 を交互）', () => {
    const words = encodeData(new TextEncoder().encode('hello'), 1)
    expect(words).toHaveLength(16)
    expect(words.slice(0, 7)).toEqual([0x40, 0x56, 0x86, 0x56, 0xc6, 0xc6, 0xf0])
    expect(words.slice(7)).toEqual([0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec])
  })

  it('型番 10 からは文字数を 16 ビットで書く', () => {
    const words = encodeData(new Uint8Array(200).fill(0x41), 10)
    expect(words[0]).toBe(0x40)
    expect(words[1]).toBe(0x0c)
    expect(words[2]).toBe(0x84)
  })

  it('ちょうど入る長さは型番を上げない・1 バイト増えたら上げる', () => {
    // 型番 1 の M は 16 語 = 128 ビット。4 + 8 + 8n <= 128 → n <= 14
    expect(chooseVersion(14)).toBe(1)
    expect(chooseVersion(15)).toBe(2)
    expect(chooseVersion(0)).toBe(1)
    expect(chooseVersion(213)).toBe(10)
    expect(chooseVersion(214)).toBeNull()
  })

  it('交互の並べ: 全部の語数は rawCodewords、短いブロックの空きは入らない', () => {
    for (const v of [1, 4, 5, 6, 9, 10]) {
      const data = Array.from({ length: dataCodewords(v) }, (_, i) => i & 0xff)
      expect(addEccAndInterleave(data, v)).toHaveLength(rawCodewords(v))
    }
  })
})

describe('encodeQr', () => {
  it('確かめた出力（hello）と同じ', () => {
    const qr = encodeQr('hello')
    expect(qr.version).toBe(1)
    expect(qr.mask).toBe(0)
    expect(rows(qr.modules)).toEqual(HELLO)
  })

  it('3 つの角に位置検出パターン、6 行目・6 列目にタイミングパターン、左下の黒の1つ', () => {
    const qr = encodeQr('http://192.168.1.23:47615/#t=' + 'A'.repeat(43))
    const m = qr.modules
    const n = qr.size
    expect(qr.version).toBe(5)
    for (const [x0, y0] of [[0, 0], [n - 7, 0], [0, n - 7]] as const) {
      for (let i = 0; i < 7; i++) {
        expect(m[y0]![x0 + i]).toBe(true)
        expect(m[y0 + 6]![x0 + i]).toBe(true)
        expect(m[y0 + i]![x0]).toBe(true)
        expect(m[y0 + i]![x0 + 6]).toBe(true)
      }
      expect(m[y0 + 1]![x0 + 1]).toBe(false)
      expect(m[y0 + 3]![x0 + 3]).toBe(true)
    }
    for (let i = 8; i < n - 8; i++) {
      expect(m[6]![i]).toBe(i % 2 === 0)
      expect(m[i]![6]).toBe(i % 2 === 0)
    }
    expect(m[n - 8]![8]).toBe(true)
  })

  it('左上と右上・左下の形式情報は同じ値', () => {
    const qr = encodeQr('format check', { mask: 5 })
    const m = qr.modules
    const n = qr.size
    const bits = formatBits(5)
    const at = (x: number, y: number) => (m[y]![x] ? 1 : 0)
    const first = [at(8, 0), at(8, 1), at(8, 2), at(8, 3), at(8, 4), at(8, 5), at(8, 7), at(8, 8), at(7, 8), at(5, 8), at(4, 8), at(3, 8), at(2, 8), at(1, 8), at(0, 8)]
    const second = [...Array.from({ length: 8 }, (_, i) => at(n - 1 - i, 8)), ...Array.from({ length: 7 }, (_, i) => at(8, n - 7 + i))]
    const expected = Array.from({ length: 15 }, (_, i) => (bits >>> i) & 1)
    expect(first).toEqual(expected)
    expect(second).toEqual(expected)
  })

  it('型番 7 以上は型番情報を 2 か所に書く', () => {
    const qr = encodeQr('v'.repeat(130))
    expect(qr.version).toBeGreaterThanOrEqual(7)
    const bits = versionBits(qr.version)
    for (let i = 0; i < 18; i++) {
      const a = qr.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      const want = ((bits >>> i) & 1) === 1
      expect(qr.modules[b]![a]).toBe(want)
      expect(qr.modules[a]![b]).toBe(want)
    }
  })

  it('マスクを選ばせると、8 種のうち減点が最も少ないもの', () => {
    const text = 'http://100.101.102.103:47615/#t=abc'
    const auto = encodeQr(text)
    const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) => penalty(encodeQr(text, { mask }).modules))
    expect(scores[auto.mask]).toBe(Math.min(...scores))
  })

  it('同じ文字列からはいつも同じ QR（決定的）', () => {
    expect(rows(encodeQr('same').modules)).toEqual(rows(encodeQr('same').modules))
  })

  it('日本語（UTF-8 のバイト）も入る', () => {
    const qr = encodeQr('スマホから操作')
    expect(qr.version).toBe(2)
  })

  it('空の文字列は型番 1', () => {
    expect(encodeQr('').version).toBe(1)
  })

  it('長すぎる・不正なマスクは例外', () => {
    expect(() => encodeQr('x'.repeat(214))).toThrow(RangeError)
    expect(() => encodeQr('ok', { mask: 8 })).toThrow(RangeError)
    expect(() => encodeQr('ok', { mask: -1 })).toThrow(RangeError)
    expect(() => encodeQr('ok', { mask: 1.5 })).toThrow(RangeError)
    expect(QR_MAX_VERSION).toBe(10)
  })
})

describe('qrSvgPath', () => {
  it('横に続く黒を1本にまとめ、余白の分ずらす', () => {
    expect(qrSvgPath({ modules: [[true, true, false, true]] }, 4)).toBe('M4 4h2v1h-2zM7 4h1v1h-1z')
    expect(qrSvgPath({ modules: [[false], [true]] }, 0)).toBe('M0 1h1v1h-1z')
  })

  it('白だけなら空', () => {
    expect(qrSvgPath({ modules: [[false, false], [false, false]] })).toBe('')
  })

  it('黒のモジュールの数と path の面積が一致する', () => {
    const qr = encodeQr('count me')
    const dark = qr.modules.flat().filter(Boolean).length
    const area = [...qrSvgPath(qr).matchAll(/h(\d+)v1/g)].reduce((sum, m) => sum + Number(m[1]), 0)
    expect(area).toBe(dark)
  })
})
