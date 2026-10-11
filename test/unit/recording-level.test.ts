import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { recordingLevel, setRecordingLevel, subscribeRecordingLevel } from '../../src/renderer/lib/recordingLevel'

/**
 * 録画中のマイクのレベル（100ms ごと）は App の state に置かない。届くたびに画面全体を描き直していた。
 * メーターだけが読む小さな入れ物の決まり
 */
describe('録画中のマイクのレベル', () => {
  it('変わったときだけ知らせ、同じ値・数でない値では知らせない', () => {
    let calls = 0
    const off = subscribeRecordingLevel(() => { calls += 1 })
    setRecordingLevel(0.25)
    expect(recordingLevel()).toBe(0.25)
    setRecordingLevel(0.25)
    setRecordingLevel(Number.NaN)
    setRecordingLevel(Number.POSITIVE_INFINITY)
    expect(recordingLevel()).toBe(0.25)
    expect(calls).toBe(1)
    setRecordingLevel(0)
    expect(calls).toBe(2)
    off()
    setRecordingLevel(0.5)
    expect(calls).toBe(2)
    setRecordingLevel(0)
  })

  it('App はレベルを state に持たず、メーターへ props で渡さない', () => {
    const app = readFileSync('src/renderer/App.tsx', 'utf8')
    expect(app).toContain('setRecordingLevel(data.rms)')
    expect(app).not.toMatch(/\[level, setLevel\]/)
    expect(app).not.toMatch(/level=\{level\}/)
  })

  it('録画の状態は、画面に出す状態と秒が同じなら前のものを使う', () => {
    const app = readFileSync('src/renderer/App.tsx', 'utf8')
    expect(app).toMatch(/recording:status', \(next\) => setRecordStatus\(\(cur\) => \(sameShownStatus\(cur, next\) \? cur : next\)\)\)/)
  })

  it('フッターは描画のたびに幅を測らない（依存なしの useLayoutEffect で evaluate しない）', () => {
    const bar = readFileSync('src/renderer/components/StatusBar.tsx', 'utf8')
    expect(bar).not.toMatch(/useLayoutEffect\(\(\) => \{ evaluate\(\) \}\)/)
  })
})

describe('起動の JS から外す画面', () => {
  it('設定・ダッシュボード・オンボーディング・mtg の取り込み・部品見本は App から直接読まない', () => {
    const app = readFileSync('src/renderer/App.tsx', 'utf8')
    for (const name of ['SettingsPage', 'OrchestraDashboard', 'OnboardingFlow', 'MeetingImportDialog', 'Gallery']) {
      expect(app, name).not.toMatch(new RegExp(`^import \\{[^}]*\\b${name}\\b[^}]*\\} from`, 'm'))
      expect(app, name).toContain(`m.${name} }`)
    }
    // その CSS はほかの部品も使うので先に読む
    expect(app).toContain("import './styles/settings.css'")
    expect(app).toContain("import './styles/cliTools.css'")
  })
})
