/**
 * 記録ファイルの読み書き（YAML の前置きつき Markdown・business.yaml・searches.jsonl）
 */
import { describe, expect, it } from 'vitest'
import { MAX_RECORD_BYTES, RecordParseError, dumpYaml, formatRecordFile, parseJsonl, parseRecordFile, parseYaml, splitFrontMatter } from '@shared/business/format'
import { emptyRecord } from '@shared/business/records'
import { RECORD_KIND_LIST } from '@shared/business/model'

const NOW = '2026-10-17T09:00:00.000Z'

describe('前置きと本文を分ける', () => {
  it('--- で囲んだ前置きと本文', () => {
    expect(splitFrontMatter('---\na: 1\n---\n本文\n')).toEqual({ front: 'a: 1\n', body: '本文\n' })
  })

  it('前置きの後の空行を1つ落とす', () => {
    expect(splitFrontMatter('---\na: 1\n---\n\n本文')).toEqual({ front: 'a: 1\n', body: '本文' })
  })

  it('BOM を落とす', () => {
    expect(splitFrontMatter('\uFEFF---\na: 1\n---\nb')).toEqual({ front: 'a: 1\n', body: 'b' })
  })

  it('CRLF・CR だけの改行も LF にそろえる', () => {
    expect(splitFrontMatter('---\r\na: 1\r\n---\r\n本文\r\n2行目')).toEqual({ front: 'a: 1\n', body: '本文\n2行目' })
    expect(splitFrontMatter('---\ra: 1\r---\rb')).toEqual({ front: 'a: 1\n', body: 'b' })
  })

  it('先頭が --- でなければ全体が本文', () => {
    expect(splitFrontMatter('本文\n---\na: 1\n---')).toEqual({ front: null, body: '本文\n---\na: 1\n---' })
    expect(splitFrontMatter(' ---\na: 1\n---')).toEqual({ front: null, body: ' ---\na: 1\n---' })
    expect(splitFrontMatter('')).toEqual({ front: null, body: '' })
  })

  it('閉じの --- が無ければ前置きなし', () => {
    expect(splitFrontMatter('---\na: 1\n')).toEqual({ front: null, body: '---\na: 1\n' })
  })

  it('閉じの --- で終わる（本文なし・最後の改行なし）', () => {
    expect(splitFrontMatter('---\na: 1\n---')).toEqual({ front: 'a: 1\n', body: '' })
  })

  it('空の前置き（---\\n---）も読む', () => {
    expect(splitFrontMatter('---\n---\n本文')).toEqual({ front: '', body: '本文' })
    expect(splitFrontMatter('---\n---')).toEqual({ front: '', body: '' })
  })

  it('本文の中の --- は本文のまま（最初の閉じだけを使う）', () => {
    expect(splitFrontMatter('---\na: 1\n---\n前\n---\n後\n')).toEqual({ front: 'a: 1\n', body: '前\n---\n後\n' })
  })

  it('「---x」「----」の行は閉じとみなさず、その後の本当の閉じを使う', () => {
    expect(splitFrontMatter('---\na: |\n  x\n---x\n---\nb')).toEqual({ front: 'a: |\n  x\n---x\n', body: 'b' })
    expect(splitFrontMatter('---\na: 1\n----\n---\nb').body).toBe('b')
  })

  it('閉じの --- の後ろの空白は許す', () => {
    expect(splitFrontMatter('---\na: 1\n---  \nb')).toEqual({ front: 'a: 1\n', body: 'b' })
  })
})

describe('YAML を読む', () => {
  it('core スキーマ: yes・2026-10-17・on は文字のまま（YAML 1.1 の型にしない）', () => {
    expect(parseYaml('a: yes\nb: 2026-10-17\nc: on\nd: No\ne: 12:30\nf: 2026-10-17T10:00:00Z')).toEqual({ a: 'yes', b: '2026-10-17', c: 'on', d: 'No', e: '12:30', f: '2026-10-17T10:00:00Z' })
  })

  it('数・真偽値・null は core スキーマどおり', () => {
    expect(parseYaml('a: 1\nb: true\nc: null\nd: ~\ne: 1.5')).toEqual({ a: 1, b: true, c: null, d: null, e: 1.5 })
  })

  it('!!binary などの既知のタグでも任意の型を作らない', () => {
    const v = parseYaml('a: !!binary aGVsbG8=\nb: !!timestamp 2026-10-17\nc: !!set {x}') as Record<string, unknown>
    expect(typeof v.a).toBe('string')
    expect(typeof v.b).toBe('string')
    expect(v.b).toBe('2026-10-17')
    expect(v.c instanceof Set).toBe(false)
  })

  it('知らないタグ（!!js/function など）でも実行しない', () => {
    expect(() => parseYaml('a: !!js/function "function(){ globalThis.pwned = 1 }"')).not.toThrow()
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined()
  })

  it.each([
    ['閉じない一覧', 'a: [1'],
    ['閉じないまとまり', '{a: 1'],
    ['字下げの崩れ', 'a:\n  - b\n c: 1'],
    ['複数の文書', 'a: 1\n---\nb: 2'],
    ['タブの字下げ', 'a:\n\t- 1']
  ])('壊れた YAML（%s）は RecordParseError', (_name, text) => {
    expect(() => parseYaml(text)).toThrow(RecordParseError)
    expect(() => parseYaml(text)).toThrow(/YAML を読めません/)
  })

  it('同じキーが2回あれば後のもの（落とさない）', () => {
    expect(parseYaml('k: 1\nk: 2')).toEqual({ k: 2 })
  })

  it('空・コメントだけなら null', () => {
    expect(parseYaml('')).toBeNull()
    expect(parseYaml('# memo')).toBeNull()
  })

  it('一覧・文字だけの文書もそのまま返す（型へ寄せるのは records 側）', () => {
    expect(parseYaml('- 1\n- 2')).toEqual([1, 2])
    expect(parseYaml('"str"')).toBe('str')
  })

  it(`大きさの上限（${MAX_RECORD_BYTES / 1024}KB）を超えたら読まない`, () => {
    expect(() => parseYaml(`a: "${'x'.repeat(MAX_RECORD_BYTES)}"`)).toThrow(RecordParseError)
    expect(() => parseYaml(`a: "${'x'.repeat(MAX_RECORD_BYTES)}"`)).toThrow(/大きすぎる/)
  })

  it('上限はバイトで数える（日本語は1文字3バイト）', () => {
    const jp = `a: ${'あ'.repeat(Math.ceil(MAX_RECORD_BYTES / 3) + 10)}`
    expect(jp.length).toBeLessThan(MAX_RECORD_BYTES)
    expect(() => parseYaml(jp)).toThrow(/大きすぎる/)
  })

  it('上限ちょうど未満の日本語は読む', () => {
    const n = Math.floor((MAX_RECORD_BYTES - 10) / 3)
    expect((parseYaml(`a: ${'あ'.repeat(n)}`) as { a: string }).a).toHaveLength(n)
  })

  it('別名の爆発（billion laughs）は読まない', () => {
    const bomb = [
      'a: &a ["lol","lol","lol","lol","lol","lol","lol","lol","lol"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]'
    ].join('\n')
    const started = Date.now()
    expect(() => parseYaml(bomb)).toThrow(RecordParseError)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('少しの別名は読む', () => {
    expect(parseYaml('a: &x {v: 1}\nb: *x')).toEqual({ a: { v: 1 }, b: { v: 1 } })
  })

  it('深すぎる入れ子でも RecordParseError で止まる（落ちない）', () => {
    const deep = `${'['.repeat(20000)}${']'.repeat(20000)}`
    expect(() => parseYaml(deep)).toThrow(RecordParseError)
  })

  it('__proto__ キーは自分のキーとして読み、Object.prototype を汚さない', () => {
    const v = parseYaml('__proto__:\n  polluted: 1\nconstructor:\n  prototype:\n    polluted: 1') as Record<string, unknown>
    expect(Object.hasOwn(v, '__proto__')).toBe(true)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype)
  })
})

describe('記録ファイル全体を読む', () => {
  it('前置きが無ければ RecordParseError', () => {
    expect(() => parseRecordFile('本文だけ')).toThrow(RecordParseError)
    expect(() => parseRecordFile('---\na: 1')).toThrow(/先頭の --- /)
  })

  it('空の前置きは {}', () => {
    expect(parseRecordFile('---\n---\n本文')).toEqual({ data: {}, body: '本文' })
    expect(parseRecordFile('---\n  \n---\n')).toEqual({ data: {}, body: '' })
  })

  it('前置きが壊れていれば RecordParseError', () => {
    expect(() => parseRecordFile('---\na: [1\n---\n本文')).toThrow(RecordParseError)
  })

  it('本文を含めて大きすぎるファイルは読まない', () => {
    expect(() => parseRecordFile(`---\na: 1\n---\n${'x'.repeat(MAX_RECORD_BYTES)}`)).toThrow(/大きすぎる/)
  })
})

describe('書いてから読み直しても同じ', () => {
  const tricky = {
    U: 'U',
    yes: 'yes',
    No: 'No',
    on: 'on',
    off: 'OFF',
    y: 'y',
    date: '2026-10-17',
    dateTime: '2026-10-17T10:00:00Z',
    spaceTime: '2026-10-17 10:00:00',
    leadingZero: '0123',
    octal: '0o17',
    hex: '0x1F',
    exp: '1e3',
    underscore: '1_000',
    sexagesimal: '12:30',
    sexagesimal2: '1:20:30',
    plus: '+1',
    dot: '.5',
    inf: '.inf',
    nan: '.NaN',
    trueStr: 'true',
    nullStr: 'null',
    tilde: '~',
    eq: '=',
    merge: '<<',
    zero: '0',
    negZero: '-0',
    dashes: '---',
    dots: '...',
    colon: 'a: b',
    hash: '#c',
    dash: '- x',
    quote: "'q'",
    dquote: '"dq"',
    lead: ' lead',
    trail: 'trail ',
    empty: '',
    japanese: '日本語: です。「引用」',
    multiline: '1行目\n2行目\n\n4行目',
    multilineTrail: 'a\n',
    multilineDashes: 'x\n---\ny',
    emoji: '絵文字🙂',
    tab: 'a\tb',
    backslash: 'C:\\path\\to',
    percent: '%YAML',
    amp: '&anchor',
    star: '*alias',
    bang: '!tag',
    pipe: '|',
    gt: '>',
    brace: '{a: 1}',
    bracket: '[1, 2]',
    at: '@user',
    backtick: '`code`'
  }

  it('dumpYaml → parseYaml で、どの文字列も文字のまま戻る（型の取り違えなし）', () => {
    expect(parseYaml(dumpYaml(tricky))).toEqual(tricky)
  })

  it('YAML 1.1 なら別の型になる文字列は引用符で囲んで書く（Agent の YAML 読み手でも文字のまま）', () => {
    const out = dumpYaml({ a: 'yes', b: '2026-10-17', c: '12:30', d: 'on', e: '1_000', f: 'Y', g: '0123', h: '=' })
    expect(out).toBe('a: "yes"\nb: "2026-10-17"\nc: "12:30"\nd: "on"\ne: "1_000"\nf: "Y"\ng: "0123"\nh: "="\n')
  })

  it('普通の文字列は引用符なしのまま（人が読みやすい）', () => {
    expect(dumpYaml({ id: 'H01', name: '経理の月末統合', stage: '探索メモ', url: 'https://example.com/a?b=c' })).toBe('id: H01\nname: 経理の月末統合\nstage: 探索メモ\nurl: https://example.com/a?b=c\n')
  })

  it('U は引用符なしで書く（手で書くのと同じ）', () => {
    expect(dumpYaml({ score: 'U' })).toBe('score: U\n')
  })

  it('数・真偽値・null は型のまま戻る', () => {
    const v = { n: 0, f: 1.5, neg: -3, big: 1e12, t: true, fa: false, nil: null, list: [1, '1', true, 'true'] }
    expect(parseYaml(dumpYaml(v))).toEqual(v)
  })

  it('同じオブジェクトを2か所で使っても別名（&・*）にしない', () => {
    const shared = { score: 'U', evidence: [] }
    const out = dumpYaml({ D1: shared, D2: shared })
    expect(out).not.toMatch(/[&*]a\d/)
    expect(parseYaml(out)).toEqual({ D1: shared, D2: shared })
  })

  it('長い行を折り返さない', () => {
    const long = 'あ'.repeat(500)
    expect(dumpYaml({ long }).trim().split('\n')).toHaveLength(1)
  })

  it('記録ファイル: 書いて読むと data と本文が戻る（日本語・複数行）', () => {
    const data = { ...tricky, nested: { list: ['E01', 'E02'], inner: { score: 2, note: '2026-10-17' } } }
    const body = '# メモ\n\n本文の --- も残る\n---\n最後'
    const text = formatRecordFile(data, body)
    const back = parseRecordFile(text)
    expect(back.data).toEqual(data)
    expect(back.body).toBe(`${body}\n`)
  })

  it('記録ファイル: 本文が空なら閉じの --- で終わる', () => {
    expect(formatRecordFile({ a: 1 }, '')).toBe('---\na: 1\n---\n')
    expect(formatRecordFile({ a: 1 }, '  \n ')).toBe('---\na: 1\n---\n')
    expect(parseRecordFile(formatRecordFile({ a: 1 }, ''))).toEqual({ data: { a: 1 }, body: '' })
  })

  it('記録ファイル: 本文の CRLF は LF にする', () => {
    expect(formatRecordFile({}, 'a\r\nb')).toBe('---\n{}\n---\n\na\nb\n')
  })

  it('記録ファイル: 空の data でも読み直せる', () => {
    expect(parseRecordFile(formatRecordFile({}, 'x')).data).toEqual({})
  })

  it.each(RECORD_KIND_LIST)('%s の空の記録は、書いて読むと同じ', (kind) => {
    const rec = emptyRecord(kind, 'X01', NOW)
    expect(parseRecordFile(formatRecordFile(rec, '')).data).toEqual(JSON.parse(JSON.stringify(rec)))
  })

  it('値が「---」だけの行を書いても、前置きの閉じと取り違えない', () => {
    const data = { a: '---', list: ['---', '...'], m: '---\n---' }
    expect(parseRecordFile(formatRecordFile(data, '本文')).data).toEqual(data)
  })

  it('書いた結果を2回目に書き直しても変わらない（冪等）', () => {
    const once = formatRecordFile(tricky, '本文')
    const parsed = parseRecordFile(once)
    expect(formatRecordFile(parsed.data, parsed.body)).toBe(once)
  })
})

describe('searches.jsonl を読む', () => {
  it('1行1件。壊れた行は飛ばして数を返す', () => {
    const r = parseJsonl('{"query":"a"}\n{壊れ\n{"query":"b"}\n"文字"\n')
    expect(r.rows).toEqual([{ query: 'a' }, { query: 'b' }, '文字'])
    expect(r.broken).toBe(1)
  })

  it('空行・空白だけの行は数えない。CRLF も読む', () => {
    expect(parseJsonl('\n\n  \n{"a":1}\r\n\r\n{"a":2}\r\n')).toEqual({ rows: [{ a: 1 }, { a: 2 }], broken: 0 })
  })

  it('空の文字は 0 件', () => {
    expect(parseJsonl('')).toEqual({ rows: [], broken: 0 })
  })

  it('最後の maxLines 行だけ読む（末尾の改行は1行に数えない）', () => {
    const text = `${[1, 2, 3, 4, 5].map((n) => JSON.stringify({ n })).join('\n')}\n`
    expect(parseJsonl(text, 2).rows).toEqual([{ n: 4 }, { n: 5 }])
    expect(parseJsonl(text, 5).rows).toHaveLength(5)
    expect(parseJsonl(text, 100).rows).toHaveLength(5)
  })

  it('maxLines が 0・負・NaN なら何も読まない', () => {
    const text = '{"a":1}\n{"a":2}'
    expect(parseJsonl(text, 0)).toEqual({ rows: [], broken: 0 })
    expect(parseJsonl(text, -1)).toEqual({ rows: [], broken: 0 })
    expect(parseJsonl(text, Number.NaN)).toEqual({ rows: [], broken: 0 })
  })

  it('maxLines の範囲外の壊れた行は数えない', () => {
    expect(parseJsonl('壊れ\n{"a":1}', 1)).toEqual({ rows: [{ a: 1 }], broken: 0 })
  })

  it('既定は 5000 行', () => {
    const text = Array.from({ length: 6000 }, (_, i) => `{"i":${i}}`).join('\n')
    const r = parseJsonl(text)
    expect(r.rows).toHaveLength(5000)
    expect(r.rows[0]).toEqual({ i: 1000 })
  })

  it('__proto__ を含む行でも Object.prototype を汚さない', () => {
    parseJsonl('{"__proto__":{"polluted":1}}')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})
