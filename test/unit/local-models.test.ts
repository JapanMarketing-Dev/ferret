/**
 * 端末内の Ollama のモデルを PC のメモリと GPU から選ぶ（判定: clef / clef-flash、整理: gpt-oss / qwen3）。
 * 根拠の大きさは src/shared/localModels.ts の先頭（ollama.com/library の tags、2026-10-03）
 */
import { describe, expect, it, vi } from 'vitest'
import {
  isAppleSilicon,
  parseNvidiaSmiVram,
  recommendDecisionModel,
  recommendLocalModels,
  recommendOrganizeModel,
  withRecommendedModel,
  type HardwareInfo
} from '@shared/localModels'
import { DEFAULT_DECISION_PREFERENCES, applyDecisionPreset, decisionSetupGuide, withLocalDecisionModel } from '@shared/decision'
import { LLM_API_PROVIDERS, LLM_PROVIDER_PRESETS, RECOMMENDED_ORGANIZE_PROVIDER } from '@shared/aiProviders'
import { checkLocalServer } from '../../src/main/localModels'

const GB = 1024 ** 3
const mac = (gb: number): HardwareInfo => ({ totalMemBytes: gb * GB, platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M3 Pro' })
const pc = (gb: number, vramGb?: number): HardwareInfo => ({ totalMemBytes: gb * GB, platform: 'win32', arch: 'x64', cpuModel: 'Intel(R) Core(TM) i7', ...(vramGb ? { gpuVramBytes: vramGb * GB } : {}) })

describe('判定モデル（clef / clef-flash）', () => {
  it('Apple Silicon はメモリ 36GB 以上で clef、それ未満は clef-flash', () => {
    expect(recommendDecisionModel(mac(8))).toBe('clef-flash')
    expect(recommendDecisionModel(mac(16))).toBe('clef-flash')
    expect(recommendDecisionModel(mac(24))).toBe('clef-flash')
    expect(recommendDecisionModel(mac(32))).toBe('clef-flash')
    expect(recommendDecisionModel(mac(36))).toBe('clef')
    expect(recommendDecisionModel(mac(64))).toBe('clef')
  })

  it('Windows・Linux は VRAM 24GB 級の GPU があるときだけ clef（メモリが多くても CPU なら clef-flash）', () => {
    expect(recommendDecisionModel(pc(128))).toBe('clef-flash')
    expect(recommendDecisionModel(pc(32, 12))).toBe('clef-flash')
    expect(recommendDecisionModel(pc(32, 23.99))).toBe('clef')
    expect(recommendDecisionModel(pc(64, 48))).toBe('clef')
    // VRAM が足りてもメモリが少なすぎれば無理をしない
    expect(recommendDecisionModel(pc(8, 24))).toBe('clef-flash')
  })

  it('Intel Mac は CPU で動くので clef-flash。Rosetta で x64 の版でも CPU 名で Apple Silicon と分かる', () => {
    expect(recommendDecisionModel({ totalMemBytes: 64 * GB, platform: 'darwin', arch: 'x64', cpuModel: 'Intel(R) Core(TM) i9' })).toBe('clef-flash')
    expect(isAppleSilicon({ platform: 'darwin', arch: 'x64', cpuModel: 'Apple M2 Max' })).toBe(true)
    expect(isAppleSilicon({ platform: 'linux', arch: 'arm64', cpuModel: 'Neoverse' })).toBe(false)
  })

  it('壊れた値でも落ちず、小さい方を選ぶ', () => {
    expect(recommendDecisionModel({ totalMemBytes: Number.NaN, platform: 'darwin', arch: 'arm64' })).toBe('clef-flash')
    expect(recommendDecisionModel({ totalMemBytes: -1, platform: 'linux', arch: 'x64', gpuVramBytes: Number.POSITIVE_INFINITY })).toBe('clef-flash')
  })
})

describe('整理のモデル（Ollama）', () => {
  it('メモリと GPU に合わせて qwen3:8b / gpt-oss:20b / gpt-oss:120b', () => {
    expect(recommendOrganizeModel(mac(16))).toBe('qwen3:8b')
    expect(recommendOrganizeModel(mac(32))).toBe('gpt-oss:20b')
    expect(recommendOrganizeModel(mac(128))).toBe('gpt-oss:120b')
    expect(recommendOrganizeModel(pc(16))).toBe('qwen3:8b')
    expect(recommendOrganizeModel(pc(16, 16))).toBe('gpt-oss:20b')
    expect(recommendOrganizeModel(pc(32))).toBe('gpt-oss:20b')
    expect(recommendOrganizeModel(pc(128, 80))).toBe('gpt-oss:120b')
    expect(recommendLocalModels(mac(48))).toEqual({ decision: 'clef', organize: 'gpt-oss:20b' })
  })

  it('推奨のモデルはどれも Ollama のプリセットの一覧にある', () => {
    const ids = LLM_PROVIDER_PRESETS.ollama.models.map((m) => m.id)
    for (const hw of [mac(8), mac(32), mac(192), pc(8), pc(32), pc(256, 96)]) expect(ids).toContain(recommendOrganizeModel(hw))
  })

  it('整理のおすすめは Ollama で、設定の選択欄の先頭', () => {
    expect(RECOMMENDED_ORGANIZE_PROVIDER).toBe('ollama')
    expect(LLM_API_PROVIDERS[0]).toBe('ollama')
  })

  it('推奨の印を付け替える（一覧に無ければ先頭に足す）', () => {
    const models = LLM_PROVIDER_PRESETS.ollama.models
    const marked = withRecommendedModel(models, 'qwen3:8b')
    expect(marked.filter((m) => m.recommended).map((m) => m.id)).toEqual(['qwen3:8b'])
    expect(marked).toHaveLength(models.length)
    expect(withRecommendedModel(models, 'other:1b')[0]).toEqual({ id: 'other:1b', recommended: true })
    expect(withRecommendedModel(models, undefined)).toEqual([...models])
  })
})

describe('判定モデルの設定に推奨を入れる', () => {
  it('Ollama でモデルを決めていないときだけ入れる', () => {
    expect(withLocalDecisionModel(DEFAULT_DECISION_PREFERENCES, 'clef').model).toBe('clef')
    expect(withLocalDecisionModel({ ...DEFAULT_DECISION_PREFERENCES, model: 'clef-flash' }, 'clef').model).toBe('clef-flash')
    expect(withLocalDecisionModel({ ...DEFAULT_DECISION_PREFERENCES, preset: 'cloudflare' }, 'clef').model).toBeUndefined()
    expect(withLocalDecisionModel(DEFAULT_DECISION_PREFERENCES, undefined)).toBe(DEFAULT_DECISION_PREFERENCES)
  })

  it('プリセットを選ぶと Ollama は推奨のモデル、Agent への指示文も同じモデルを落とさせる', () => {
    expect(applyDecisionPreset(DEFAULT_DECISION_PREFERENCES, 'ollama', 'clef').model).toBe('clef')
    expect(decisionSetupGuide(DEFAULT_DECISION_PREFERENCES, 'Ollama', 'clef').model).toBe('clef')
    expect(decisionSetupGuide(DEFAULT_DECISION_PREFERENCES, 'Ollama').model).toBe('clef-flash')
  })
})

describe('nvidia-smi の VRAM', () => {
  it('MiB の行からいちばん大きいものをバイトで', () => {
    expect(parseNvidiaSmiVram('24564\n8192\n')).toBe(24564 * 1024 * 1024)
    expect(parseNvidiaSmiVram('')).toBeUndefined()
    expect(parseNvidiaSmiVram('[N/A]\n')).toBeUndefined()
  })
})

describe('端末内のサーバーの確認（整理の前）', () => {
  const json = (body: unknown, ok = true) => vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response)

  it('動いていてモデルがあれば ok（:latest も同じとみなす）', async () => {
    expect(await checkLocalServer('http://localhost:11434/v1/', 'qwen3:8b', json({ data: [{ id: 'qwen3:8b' }] }))).toBe('ok')
    expect(await checkLocalServer('http://localhost:11434/v1', 'llama3.2', json({ data: [{ id: 'llama3.2:latest' }] }))).toBe('ok')
  })

  it('モデルが無ければ noModel、つながらない・エラーなら down', async () => {
    expect(await checkLocalServer('http://localhost:11434/v1', 'gpt-oss:20b', json({ data: [{ id: 'qwen3:8b' }] }))).toBe('noModel')
    expect(await checkLocalServer('http://localhost:11434/v1', 'gpt-oss:20b', json({}, false))).toBe('down')
    expect(await checkLocalServer('http://localhost:11434/v1', 'gpt-oss:20b', vi.fn(async () => { throw new TypeError('fetch failed') }))).toBe('down')
  })

  it('/models を聞く（キーは送らない）', async () => {
    const f = json({ data: [] })
    await checkLocalServer('http://localhost:1234/v1/', '', f)
    expect(f).toHaveBeenCalledWith('http://localhost:1234/v1/models', expect.not.objectContaining({ headers: expect.anything() }))
  })
})
