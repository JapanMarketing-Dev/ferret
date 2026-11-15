import { describe, expect, it } from 'vitest'
import { joinProjectPath, planChangeRef, planScreenRef, reviewDirPath, reviewDocPath, reviewItemRef, valueRef, valueStepRef } from '../../src/shared/reviewRefs'

/** ビジュアルレビュー・価値ユースケースの「場所のコピー」の文（Agent に貼る） */
describe('reviewRefs', () => {
  it('プロジェクトのパスと相対パスをつなぐ（末尾の区切り・空を扱う）', () => {
    expect(joinProjectPath('/Users/me/app', '.ferret/value-usecases')).toBe('/Users/me/app/.ferret/value-usecases')
    expect(joinProjectPath('/Users/me/app/', '.ferret/visual-review/')).toBe('/Users/me/app/.ferret/visual-review')
    expect(joinProjectPath('/Users/me/app', '')).toBe('/Users/me/app')
    expect(joinProjectPath('', '.ferret/a.json')).toBe('.ferret/a.json')
    expect(joinProjectPath('/', '.ferret/a.json')).toBe('/.ferret/a.json') // ルートは区切りを重ねない
  })

  it('Windows のパスは \\ でつなぐ', () => {
    expect(joinProjectPath('C:\\work\\app', '.ferret/value-usecases/x.json')).toBe('C:\\work\\app\\.ferret\\value-usecases\\x.json')
    expect(joinProjectPath('C:\\work\\app\\', '.ferret')).toBe('C:\\work\\app\\.ferret')
    expect(joinProjectPath('\\\\server\\share', '.ferret')).toBe('\\\\server\\share\\.ferret')
    // / を含むならそのまま /（Windows でも / で書かれたパス・SSH のパス）
    expect(joinProjectPath('C:/work/app', '.ferret')).toBe('C:/work/app/.ferret')
  })

  it('全体（フォルダ）と文書1つのパス', () => {
    expect(reviewDirPath('/p', '.ferret/visual-review')).toBe('/p/.ferret/visual-review')
    expect(reviewDocPath('/p', '.ferret/value-usecases', 'invoice-app')).toBe('/p/.ferret/value-usecases/invoice-app.json')
  })

  it('価値・手順の位置と名前', () => {
    const doc = '/p/.ferret/value-usecases/a.json'
    expect(valueRef(doc, 1, { id: 'v2', name: '請求書を送る' })).toBe(`${doc} → values[1] (id: v2) "請求書を送る"`)
    expect(valueRef(doc, 0, {})).toBe(`${doc} → values[0]`)
    expect(valueStepRef(doc, 1, 2, { name: '請求書を送る' }, { screen: '送信', step: 3 })).toBe(`${doc} → values[1].flow[2] "請求書を送る / 送信"`)
    expect(valueStepRef(doc, 0, 0, {}, { step: 1 })).toBe(`${doc} → values[0].flow[0] "#1"`)
  })

  it('画面・変更の位置（番号は画面の上の通し番号）', () => {
    const doc = '/p/.ferret/visual-review/b.json'
    expect(planScreenRef(doc, 0, 'ホーム')).toBe(`${doc} → screens[0] "ホーム"`)
    expect(planScreenRef(doc, 2)).toBe(`${doc} → screens[2]`)
    expect(planChangeRef(doc, 1, 0, 4, 'ボタンを足す')).toBe(`${doc} → screens[1].annotations[0] "#4 ボタンを足す"`)
  })

  it('名前は1行にし、長ければ縮め、" を逃がす', () => {
    expect(reviewItemRef('/a.json', 'x', '一行目\n  二行目')).toBe('/a.json → x "一行目 二行目"')
    const long = reviewItemRef('/a.json', 'x', 'あ'.repeat(200))
    expect(long.length).toBeLessThan('/a.json → x ""'.length + 81)
    expect(long.endsWith('…"')).toBe(true)
    expect(reviewItemRef('/a.json', 'x', 'say "hi"')).toBe('/a.json → x "say \\"hi\\""')
    expect(reviewItemRef('/a.json', 'x', 'a\\b')).toBe('/a.json → x "a\\\\b"')
    expect(reviewItemRef('/a.json', 'x', '   ')).toBe('/a.json → x')
  })
})
