import { describe, expect, it } from 'vitest'
import { pinMedia, pinnedMediaFor } from '../../src/main/pinnedMedia'

/**
 * 裏の処理（削った版・mtg の取り込み）が読む動画を、レビューのフォルダに固定して渡す口（pinnedMedia.ts）。
 * プロジェクトを切り替えても同じ動画を読めること（FERRET-2D）と、登録したものしか返さないことを確かめる
 */
describe('pinMedia / pinnedMediaFor', () => {
  it('登録したフォルダ・ファイル・種類だけを返し、release で閉じる。ほかの登録には響かない', () => {
    const a = pinMedia('/p/a/.ferret/reviews/1', '/p/a/.ferret/reviews/1/recording.webm', 'video/webm')
    const b = pinMedia('/p/b/.ferret/reviews/2', '/p/b/.ferret/reviews/2/meeting.mp4', 'video/mp4')
    expect(a.url).toMatch(/^ade-media:\/\/review\/pinned\/[0-9a-f]{32}$/)
    expect(a.url).not.toBe(b.url)
    expect(pinnedMediaFor(new URL(a.url).pathname)).toEqual({ dir: '/p/a/.ferret/reviews/1', file: '/p/a/.ferret/reviews/1/recording.webm', contentType: 'video/webm' })
    a.release()
    expect(pinnedMediaFor(new URL(a.url).pathname)).toBeNull()
    expect(pinnedMediaFor(new URL(b.url).pathname)?.contentType).toBe('video/mp4')
    b.release()
    b.release()
    expect(pinnedMediaFor(new URL(b.url).pathname)).toBeNull()
  })

  it('形の違う道（空・短い・大文字・続きがある・前に何かある・登録の無い合言葉）は引かない', () => {
    const a = pinMedia('/d', '/d/recording.webm', 'video/webm')
    const path = new URL(a.url).pathname
    for (const bad of ['', '/pinned/', '/pinned/zz', `/pinned/${'0'.repeat(32)}`, path.toUpperCase(), `${path}/x`, `/x${path}`, `${path}?a`, '/20261002-104012/recording.webm']) {
      expect(pinnedMediaFor(bad)).toBeNull()
    }
    a.release()
  })
})
