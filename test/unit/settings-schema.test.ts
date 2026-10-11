import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => '/tmp/ade-settings-schema-unit' } }))

import { sanitize } from '../../src/main/settings'
import { splitSettings } from '../../src/main/settingsFile'
import { SETTINGS_SCHEMA, validateAgainstSchema, type JsonSchema } from '@shared/settingsSchema'
import { DEFAULT_LAYOUT } from '@shared/layout'
import { DEFAULT_AGENT_PREFERENCES, DEFAULT_SPLIT_RATIO } from '@shared/types'

/**
 * settings.json のスキーマ（src/shared/settingsSchema.ts）と、型・sanitize（src/main/settings.ts）のずれを落とす。
 * Settings に項目を足したら、スキーマにも説明付きで足すこと。
 */

/** スキーマの上の階層の項目をすべて埋めた例。ここに無い項目をスキーマに足すと、下のテストが落ちる */
const FULL = {
  theme: 'dark',
  locale: 'ja',
  splitRatio: 0.5,
  layout: DEFAULT_LAYOUT,
  feedbackTargets: { visible: false, ratio: 0.7 },
  projects: [{ id: 'p1', name: 'app', folderPath: '/work/app', urls: [{ id: 'u1', label: 'local', url: 'http://localhost:3000' }] },
    { id: 'p2', name: 'remote', folderPath: '/work/remote', source: 'ssh', ssh: { host: 'me@gpu-box', path: '~/src/app' }, urls: [] },
    { id: 'p3', name: 'gh', folderPath: '/work/gh', source: 'github', remoteUrl: 'https://user:tok@github.com/o/r.git', urls: [] },
    { id: 'p4', name: 'broken', folderPath: '/work/b', source: 'ssh', urls: [] }],
  agents: { ...DEFAULT_AGENT_PREFERENCES, customAgents: [{ id: 'custom:mine', name: 'Mine', command: 'mine', args: '' }] },
  agentAccounts: { claude: { accounts: [], activeAccountId: null }, codex: { accounts: [], activeAccountId: null } },
  limitFailover: { enabled: true, thresholdPercent: 90, switchAccounts: true, agentOrder: ['claude', 'codex', 'gemini'], returnToPreferred: false },
  agentPrompt: 'Read {{path}}',
  orchestra: { shared: 'Security first', products: { p1: 'AWS tag team=shop' } },
  agentRequests: { items: [{ id: 'security', batch: true }, { id: 'sentry-setup', hidden: true }, { id: 'custom-1', title: 'Lint', text: 'Run the linter', custom: true }] },
  whisperModel: '/models/ggml-small.bin',
  capture: { captureMic: true, captureSystemAudio: false, transcription: 'compatible', language: 'en', keepDays: 7, stayFeedbackOnStop: true,
    sttEndpoints: { compatible: { baseUrl: 'http://localhost:8000/v1', model: 'whisper', apiKeyEnv: 'STT_KEY' } }, costLimitUsd: 2 },
  organizer: { runner: 'api:compatible', cliModels: { codex: 'gpt-5-codex' }, endpoints: { compatible: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3' } } },
  decision: { enabled: true, preset: 'cloudflare', model: 'clef-flash', accountId: 'abc', headers: { 'cf-aig-authorization': { env: 'CF_AIG_TOKEN' }, 'X-Team': 'ui' }, apiKeyEnv: 'CLOUDFLARE_API_TOKEN' },
  crashReports: false,
  crashReportsNoticeShown: true,
  github: { defaultOwner: 'acme-inc' },
  autoUpdate: false,
  mobileRemote: { enabled: true, port: 50000 },
  browserExtensions: [{ path: '/Users/me/ext/picker' }, { path: '/Users/me/ext/off', enabled: false }],
  onboarding: { completedAt: '2026-10-03T00:00:00.000Z' }
}

describe('settings.json のスキーマ', () => {
  it('スキーマの上の階層と、sanitize が settings.json に書く項目が一致する', () => {
    const written = Object.keys(splitSettings(sanitize(FULL)).config).sort()
    const declared = Object.keys(SETTINGS_SCHEMA.properties ?? {}).filter((k) => k !== '$schema').sort()
    expect(written).toEqual(declared)
  })

  it('やめた terminalClipboard（端末のコピーの確認）は読み込んでも書き戻さない', () => {
    const s = sanitize({ ...FULL, terminalClipboard: 'ask' } as Record<string, unknown>)
    expect('terminalClipboard' in s).toBe(false)
    expect('terminalClipboard' in splitSettings({ ...s, terminalClipboard: 'off' } as typeof s).config).toBe(false)
  })

  it('sanitize の出力（既定値・全部入り）はスキーマに通る', () => {
    expect(validateAgainstSchema(splitSettings(sanitize({})).config, SETTINGS_SCHEMA)).toEqual([])
    expect(validateAgainstSchema(splitSettings(sanitize(FULL)).config, SETTINGS_SCHEMA)).toEqual([])
  })

  it('スキーマの既定値は sanitize の既定値と同じ', () => {
    const defaults = sanitize({})
    const p = SETTINGS_SCHEMA.properties!
    expect(p.theme!.default).toBe(defaults.theme)
    expect(p.locale!.default).toBe(defaults.locale)
    expect(p.splitRatio!.default).toBe(DEFAULT_SPLIT_RATIO)
    expect(p.splitRatio!.default).toBe(defaults.splitRatio)
    expect(p.layout!.default).toEqual(defaults.layout)
    expect(p.agents!.default).toEqual(DEFAULT_AGENT_PREFERENCES)
    const capture = p.capture!.properties!
    const fallback = sanitize({ capture: {} }).capture!
    expect(capture.keepDays!.default).toBe(fallback.keepDays)
    expect(capture.transcription!.default).toBe(fallback.transcription)
    expect(capture.language!.default).toBe(fallback.language)
    expect(capture.captureMic!.default).toBe(fallback.captureMic)
  })

  it('すべての項目に英語の説明がある', () => {
    const missing: string[] = []
    const walk = (schema: JsonSchema, path: string) => {
      if (!schema.description) missing.push(path || '/')
      for (const [key, child] of Object.entries(schema.properties ?? {})) walk(child, `${path}/${key}`)
      if (schema.items) walk(schema.items, `${path}[]`)
      if (typeof schema.additionalProperties === 'object') walk(schema.additionalProperties, `${path}/*`)
    }
    walk(SETTINGS_SCHEMA, '')
    expect(missing).toEqual([])
  })

  it('ヘッダーは3つの接続先とも { env } を残し、スキーマに通る（古い headersEnv は { env } へ移す）', () => {
    const s = sanitize({ ...FULL,
      capture: { ...FULL.capture, sttEndpoints: { compatible: { baseUrl: 'http://localhost:8000/v1', headers: { Authorization: { env: 'STT_TOKEN' } } } } },
      organizer: { ...FULL.organizer, endpoints: { compatible: { baseUrl: 'http://localhost:11434/v1', headersEnv: { 'cf-aig-authorization': 'CF_AIG_TOKEN' } } } },
      decision: { ...FULL.decision, headersEnv: { 'X-Gateway': 'GW_TOKEN' } } })
    expect(s.capture?.sttEndpoints?.compatible?.headers).toEqual({ Authorization: { env: 'STT_TOKEN' } })
    expect(s.organizer?.endpoints?.compatible?.headers).toEqual({ 'cf-aig-authorization': { env: 'CF_AIG_TOKEN' } })
    expect(s.decision?.headers).toEqual({ 'cf-aig-authorization': { env: 'CF_AIG_TOKEN' }, 'X-Team': 'ui', 'X-Gateway': { env: 'GW_TOKEN' } })
    expect(JSON.stringify(s)).not.toContain('headersEnv')
    expect(validateAgainstSchema(splitSettings(s).config, SETTINGS_SCHEMA)).toEqual([])
  })

  it('型の違う値・知らない提供元を見つける', () => {
    expect(validateAgainstSchema({ theme: 'blue' }, SETTINGS_SCHEMA)[0]?.path).toBe('/theme')
    expect(validateAgainstSchema({ capture: { sttEndpoints: { nope: {} } } }, SETTINGS_SCHEMA)[0]?.path).toBe('/capture/sttEndpoints/nope')
    // 知らない上の階層の項目は許す（そのまま残す）
    expect(validateAgainstSchema({ myNote: 1 }, SETTINGS_SCHEMA)).toEqual([])
    // プロジェクトの取得元（local / github / ssh）
    expect(validateAgainstSchema({ projects: [{ id: 'r', folderPath: '/tmp/r', source: 'ssh', ssh: { host: 'gpu-box', path: '~/src/app' } },
      { id: 'g', folderPath: '/tmp/g', source: 'github', remoteUrl: 'https://github.com/o/r.git' }] }, SETTINGS_SCHEMA)).toEqual([])
    expect(validateAgainstSchema({ projects: [{ id: 'r', folderPath: '/tmp/r', source: 'ssh', ssh: { host: 'gpu-box' } }] }, SETTINGS_SCHEMA)[0]?.path).toBe('/projects/0/ssh')
  })
})
