import { describe, expect, it } from 'vitest'
import { quickScreenStep, screenSourceForDisplay } from '../../src/shared/quickCapture'
import type { CaptureSourceInfo } from '../../src/shared/types'

const screen = (id: string, displayId?: string): CaptureSourceInfo => ({ id, kind: 'screen', name: id, thumbnail: '', ...(displayId ? { displayId } : {}) })
const win = (id: string): CaptureSourceInfo => ({ id, kind: 'window', name: id, thumbnail: '' })

describe('ワンクリック録画の画面収録の許可', () => {
  it('許可があればすぐ始める', () => {
    expect(quickScreenStep('granted')).toBe('start')
  })
  it('分からないときも試す（Windows・Linux は granted）', () => {
    expect(quickScreenStep('unknown')).toBe('start')
  })
  it('まだ聞いていなければ OS の確認を出す', () => {
    expect(quickScreenStep('not-determined')).toBe('ask')
  })
  it('断られていればシステム設定へ案内する', () => {
    expect(quickScreenStep('denied')).toBe('settings')
    expect(quickScreenStep('restricted')).toBe('settings')
  })
})

describe('Ferret の窓がある画面', () => {
  const sources = [win('window:1:0'), screen('screen:1:0', '1'), screen('screen:2:0', '2')]

  it('窓のあるディスプレイの画面全体', () => {
    expect(screenSourceForDisplay(sources, '2')?.id).toBe('screen:2:0')
  })
  it('ディスプレイが分からない・見つからないときは最初の画面', () => {
    expect(screenSourceForDisplay(sources, undefined)?.id).toBe('screen:1:0')
    expect(screenSourceForDisplay(sources, '99')?.id).toBe('screen:1:0')
  })
  it('ウインドウは選ばない。画面が無ければ null', () => {
    expect(screenSourceForDisplay([win('window:1:0')], '1')).toBeNull()
    expect(screenSourceForDisplay([], '1')).toBeNull()
  })
})
