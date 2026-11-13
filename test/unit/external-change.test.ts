import { describe, expect, it } from 'vitest'
import { LatestRequests, decideExternalChange, diskStampChanged, filesToRecheck } from '../../src/renderer/editor/externalChange'

/** 開いているファイルへの外部の変更の取り込み（Agent が書き換えた Markdown が、開き直すまで古いままにならない） */

const open = [
  { id: '/p/README.md', root: '/p', path: 'README.md' },
  { id: '/p/docs/仕様.md', root: '/p', path: 'docs/仕様.md'.normalize('NFC') },
  { id: '/p/.ferret/human.md', root: '/p', path: '.ferret/human.md' },
  { id: '/q/README.md', root: '/q', path: 'README.md' }
]

describe('filesToRecheck（通知で確かめ直すタブ）', () => {
  it('変わったパスの、今のプロジェクトのタブだけ', () => {
    expect(filesToRecheck(open, '/p', { paths: ['README.md', 'other.ts'] }).map((f) => f.id)).toEqual(['/p/README.md'])
  })

  it('別のプロジェクトの同じ名前のファイルは確かめない', () => {
    expect(filesToRecheck(open, '/q', { paths: ['docs/仕様.md'] })).toEqual([])
  })

  it('日本語の名前は NFC / NFD の違いを無視して比べる（濁点・半濁点）', () => {
    const nfd = 'docs/仕様.md'.normalize('NFD')
    expect(filesToRecheck(open, '/p', { paths: [nfd] }).map((f) => f.id)).toEqual(['/p/docs/仕様.md'])
    const tabNfd = [{ id: 'x', root: '/p', path: 'ガイド.md'.normalize('NFD') }]
    expect(filesToRecheck(tabNfd, '/p', { paths: ['ガイド.md'.normalize('NFC')] })).toHaveLength(1)
  })

  it('通知が多すぎて捨てられた（overflow）ときは、今のプロジェクトのタブを全部確かめる', () => {
    expect(filesToRecheck(open, '/p', { paths: [], overflow: true }).map((f) => f.id)).toEqual(['/p/README.md', '/p/docs/仕様.md', '/p/.ferret/human.md'])
  })

  it('プロジェクトが無い・空の通知なら何もしない', () => {
    expect(filesToRecheck(open, null, { paths: ['README.md'] })).toEqual([])
    expect(filesToRecheck(open, '/p', { paths: [] })).toEqual([])
    expect(filesToRecheck([], '/p', { paths: ['README.md'], overflow: true })).toEqual([])
  })

  it('前後だけ一致する別のパスは拾わない', () => {
    expect(filesToRecheck(open, '/p', { paths: ['docs/README.md', 'README.md.bak', 'readme.md'] })).toEqual([])
  })
})

describe('decideExternalChange（読み直した内容の扱い）', () => {
  it('未保存の変更が無ければ差し替える（ソース・プレビューとも）', () => {
    expect(decideExternalChange({ saved: 'a', draft: 'a' }, 'b')).toEqual({ kind: 'reload' })
    expect(decideExternalChange({ saved: 'a', draft: undefined }, 'b')).toEqual({ kind: 'reload' })
  })

  it('中身が同じなら何もしない（自分の保存の通知）', () => {
    expect(decideExternalChange({ saved: 'a', draft: 'a' }, 'a')).toEqual({ kind: 'none' })
    expect(decideExternalChange({ saved: 'a', draft: 'a-editing' }, 'a')).toEqual({ kind: 'none' })
  })

  it('未保存の変更があれば上書きせずに知らせる（今までの衝突の扱い）', () => {
    expect(decideExternalChange({ saved: 'a', draft: 'mine' }, 'theirs')).toEqual({ kind: 'conflict' })
  })

  it('未保存の変更と同じ内容が書かれたら保存済みにする（保存の直後の通知も含む）', () => {
    expect(decideExternalChange({ saved: 'a', draft: 'b' }, 'b')).toEqual({ kind: 'adopt' })
  })

  it('消えた・変わったと出していて、最後に見た内容に戻ったら知らせを下ろす', () => {
    expect(decideExternalChange({ saved: 'a', draft: 'a', external: 'deleted' }, 'a')).toEqual({ kind: 'restored' })
    expect(decideExternalChange({ saved: 'a', draft: 'x', external: 'changed' }, 'a')).toEqual({ kind: 'restored' })
  })

  it('空のファイル・空にされたファイルも差し替える', () => {
    expect(decideExternalChange({ saved: '', draft: '' }, '# new')).toEqual({ kind: 'reload' })
    expect(decideExternalChange({ saved: '# old', draft: '# old' }, '')).toEqual({ kind: 'reload' })
  })

  it('改行の違い（CRLF）だけでも別の内容として扱う', () => {
    expect(decideExternalChange({ saved: 'a\n', draft: 'a\n' }, 'a\r\n')).toEqual({ kind: 'reload' })
  })
})

describe('diskStampChanged（前に出ているタブの見回り）', () => {
  it('日時か大きさが変われば確かめる', () => {
    expect(diskStampChanged({ mtimeMs: 1, size: 10 }, { mtimeMs: 2, size: 10 })).toBe(true)
    expect(diskStampChanged({ mtimeMs: 1, size: 10 }, { mtimeMs: 1, size: 11 })).toBe(true)
    expect(diskStampChanged({ mtimeMs: 1, size: 10 }, { mtimeMs: 1, size: 10 })).toBe(false)
  })

  it('最後が分からなければ確かめる（開いた直後）', () => {
    expect(diskStampChanged(undefined, { mtimeMs: 0, size: 0 })).toBe(true)
  })
})

describe('LatestRequests（前の読み込みの答えで上書きしない）', () => {
  it('後から頼んだものだけが生きる', () => {
    const r = new LatestRequests()
    const first = r.begin('a')
    const second = r.begin('a')
    expect(r.isLatest('a', first)).toBe(false)
    expect(r.isLatest('a', second)).toBe(true)
  })

  it('ファイルごとに別に数える', () => {
    const r = new LatestRequests()
    const a = r.begin('a')
    const b = r.begin('b')
    expect(r.isLatest('a', a)).toBe(true)
    expect(r.isLatest('b', b)).toBe(true)
  })

  it('閉じた（forget）ファイルの答えは捨てる。開き直しても前の番号とは重ならない', () => {
    const r = new LatestRequests()
    const old = r.begin('a')
    r.forget('a')
    expect(r.isLatest('a', old)).toBe(false)
    const reopened = r.begin('a')
    expect(reopened).not.toBe(old)
    expect(r.isLatest('a', old)).toBe(false)
    expect(r.isLatest('a', reopened)).toBe(true)
  })

  it('知らないファイルは生きていない', () => {
    expect(new LatestRequests().isLatest('x', 1)).toBe(false)
  })
})
