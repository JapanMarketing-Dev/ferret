import { describe, expect, it } from 'vitest'
import { SETTINGS_SECTIONS, activeSectionAt, filterSettingsSections } from '../../src/renderer/lib/settingsSections'

const titles: Record<string, string> = { general: '一般', appearance: '外観', language: '言語', layout: 'レイアウト', recording: '録画', transcription: '文字起こし', agents: 'Agents', accounts: 'Accounts', cli: 'CLI', about: 'MOVIE-ADE について' }
const titleOf = (id: string) => titles[id] ?? id

describe('設定の検索', () => {
  it('空なら全部の節を一覧の順で返す', () => {
    expect(filterSettingsSections('', titleOf)).toEqual([...SETTINGS_SECTIONS])
    expect(filterSettingsSections('   ', titleOf)).toEqual([...SETTINGS_SECTIONS])
  })

  it('節の中の項目の言葉でも引ける（英語・日本語・大文字小文字・全角）', () => {
    expect(filterSettingsSections('mic', titleOf)).toEqual(['recording'])
    expect(filterSettingsSections('テーマ', titleOf)).toEqual(['appearance'])
    expect(filterSettingsSections('WHISPER', titleOf)).toEqual(['transcription'])
    expect(filterSettingsSections('ｇｉｔｈｕｂ', titleOf)).toEqual(['cli'])
  })

  it('今の言語の節の名前でも引ける', () => {
    expect(filterSettingsSections('一般', titleOf)).toEqual(['general'])
  })

  it('空白区切りはすべてを含む節だけ（AND）', () => {
    expect(filterSettingsSections('claude prompt', titleOf)).toEqual(['agents'])
    expect(filterSettingsSections('claude theme', titleOf)).toEqual([])
  })

  it('同じ言葉が複数の節にあれば、どれも一覧の順で出す', () => {
    expect(filterSettingsSections('言語', titleOf)).toEqual(['transcription', 'language'])
  })
})

describe('左の一覧の並び', () => {
  it('一番上にセットアップのチェックリスト、その下に一般 → Agent → 判定モデル', () => {
    expect(SETTINGS_SECTIONS.slice(0, 4)).toEqual(['setup', 'general', 'agents', 'verify'])
    expect(SETTINGS_SECTIONS).toEqual(['setup', 'general', 'agents', 'verify', 'orchestra', 'remote', 'recording', 'transcription', 'organize', 'accounts',
      'appearance', 'language', 'layout', 'extensions', 'browserProfiles', 'browserImport', 'cli', 'about'])
  })

  it('CLI の節は wrangler・ollama・インストールで引ける', () => {
    for (const word of ['wrangler', 'ollama', 'インストール', 'aws']) expect(filterSettingsSections(word, (id) => id)).toContain('cli')
  })

  it('スマホから操作の節は スマホ・tailscale・QR で引ける', () => {
    for (const word of ['スマホ', 'tailscale', 'QR', 'phone']) expect(filterSettingsSections(word, (id) => id)).toContain('remote')
  })

  it('チェックリストは「setup」「チェックリスト」で引ける', () => {
    expect(filterSettingsSections('checklist', (id) => id)).toEqual(['setup'])
    expect(filterSettingsSections('チェックリスト', (id) => id)).toEqual(['setup'])
  })
})

describe('読んでいる節', () => {
  it('上端を過ぎた最後の節を選び、どれも過ぎていなければ先頭', () => {
    expect(activeSectionAt([{ id: 'general', top: 0 }, { id: 'appearance', top: 300 }])).toBe('general')
    expect(activeSectionAt([{ id: 'general', top: -400 }, { id: 'appearance', top: 10 }, { id: 'language', top: 500 }])).toBe('appearance')
    expect(activeSectionAt([{ id: 'general', top: 80 }, { id: 'appearance', top: 400 }])).toBe('general')
    expect(activeSectionAt([])).toBeNull()
  })
})
